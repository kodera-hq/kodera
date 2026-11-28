"""Signed Stripe webhook verification, idempotent deduplication, and G4 / H3.1 reconciliation.

Authenticates strictly via `Stripe-Signature` HMAC-SHA256 (`t=...,v1=...`) with a 300-second
replay window and `hmac.compare_digest` constant-time verification. Deduplicates every event
atomically via `StripeWebhookDelivery.stripe_event_id` (`INSERT ... ON CONFLICT DO NOTHING`)
so re-delivered webhooks return `200` without double-applying state mutations.

Under the G4 & H3.1 commercial architecture (`mode=payment`, Core = sole Factur-X EN 16931 invoice
and credit-note authority for B2B subscriptions and Volet A community boosts; Stripe Connect
destination split for Volet B VIP passes), the public HTTP ingress enforces an explicit pinned
`api_version` allowlist (`2024-06-20`, `2024-12-18.acacia`, and `2025-02-24.acacia`), failing
closed (`400`) before database writes on missing or unrecognized versions. Every non-collection
event type is recorded as `ignored_event_type` (and any event tagged with a foreign
`metadata[samourai_project]` != `kodera` is recorded as `ignored`) with zero mutations to Core
billing, dunning, or workspace quota tables.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db import connection, models, transaction
from django.utils import timezone

from apps.workspaces.services import sync_subscription_quota
from core.db.ids import new_uuid7

from .. import events
from ..actors import Actor
from ..models import (
    DunningCase,
    Invoice,
    Payment,
    PaymentLink,
    ProviderEvent as ProviderEventRecord,
    StripeWebhookDelivery,
    Subscription,
    VipMembershipEntitlement,
    WorkspaceBoostGrant,
)
from ..services import credit_note_series, set_invoice_state
from ..states import PAYMENT_TRANSITIONS, SUBSCRIPTION_TRANSITIONS
from .port import ProviderEvent as PortEvent
from .services import (
    connect_checkout_binding_matches_runtime,
    direct_checkout_binding_matches_runtime,
    effective_owed_minor,
    expected_stripe_binding,
    reconcile,
    subscription_has_blocking_unpaid_invoice,
)
from .stripe import (
    SIGNATURE_HEADER,
    SUPPORTED_EVENT_API_VERSIONS,
    TOLERANCE_S,
    _translate as translate_port_event,
    is_foreign_samourai_project,
)

MAX_WEBHOOK_BYTES = 65_536
MAX_DEFERRED_STRIPE_REFUNDS = 10_000
MAX_DEFERRED_PER_PAYMENT = 16
SYSTEM = Actor("system", None)
_HEX_DIGEST_RE = re.compile(r"[0-9a-fA-F]{64}\Z")
_EVENT_ID_RE = re.compile(r"[A-Za-z0-9_-]{3,255}\Z")
_EVENT_TYPE_RE = re.compile(r"[a-z0-9][a-z0-9._-]{1,127}\Z")
ALLOWED_STRIPE_API_VERSIONS: frozenset[str] = SUPPORTED_EVENT_API_VERSIONS
G4_COLLECTION_EVENTS = frozenset(
    {
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed",
        "checkout.session.expired",
        "payment_intent.succeeded",
        "charge.refunded",
        "charge.dispute.created",
    }
)


class StripeWebhookSecretMissingError(Exception):
    """`KODERA_STRIPE_WEBHOOK_SECRET` is unset or invalid (`503 service-unavailable`)."""


class StripeWebhookMalformedError(Exception):
    """Missing/malformed header, oversized body, or invalid event envelope (`400`)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class StripeWebhookSignatureError(Exception):
    """Invalid HMAC-SHA256 signature or stale timestamp outside 300s window (`401`)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True, slots=True)
class StripeWebhookReceipt:
    event_id: str
    event_type: str
    status: str

    def to_dict(self) -> dict[str, object]:
        return {
            "received": True,
            "event_id": self.event_id,
            "event_type": self.event_type,
            "status": self.status,
        }


def _configured_webhook_secret() -> str:
    raw = getattr(settings, "KODERA_STRIPE_WEBHOOK_SECRET", None)
    if not isinstance(raw, str):
        raise StripeWebhookSecretMissingError()
    secret = raw.strip()
    if not secret.startswith("whsec_") or len(secret) < 10:
        raise StripeWebhookSecretMissingError()
    return secret


def verify_stripe_signature(
    *,
    raw_body: bytes,
    signature_header: str | None,
    webhook_secret: str,
    clock: Callable[[], float] = time.time,
) -> None:
    """Verify `Stripe-Signature` (`t=<ts>,v1=<hmac>`) in constant time with 300s tolerance."""
    if not signature_header or not isinstance(signature_header, str):
        raise StripeWebhookMalformedError("missing-signature-header")
    if len(signature_header) > 2048:
        raise StripeWebhookMalformedError("malformed-signature-header")

    timestamp: str | None = None
    v1_signatures: list[str] = []
    for part in signature_header.split(","):
        key, sep, value = part.strip().partition("=")
        if sep != "=" or not key:
            raise StripeWebhookMalformedError("malformed-signature-header")
        if key == "t":
            if timestamp is not None:
                raise StripeWebhookMalformedError("duplicate-signature-timestamp")
            timestamp = value
        elif key == "v1":
            v1_signatures.append(value)

    if (
        timestamp is None
        or not timestamp.isascii()
        or not timestamp.isdigit()
        or len(timestamp) > 20
        or not v1_signatures
        or any(_HEX_DIGEST_RE.fullmatch(sig) is None for sig in v1_signatures)
    ):
        raise StripeWebhookMalformedError("malformed-signature-header")

    signed_payload = timestamp.encode("ascii") + b"." + raw_body
    expected_hex = hmac.new(
        webhook_secret.encode("utf-8"),
        signed_payload,
        hashlib.sha256,
    ).hexdigest()
    expected_bytes = expected_hex.encode("ascii")

    matched = any(
        hmac.compare_digest(expected_bytes, candidate.lower().encode("ascii"))
        for candidate in v1_signatures
    )
    if not matched:
        raise StripeWebhookSignatureError("invalid-signature")

    parsed_ts = int(timestamp)
    if abs(clock() - parsed_ts) > TOLERANCE_S:
        raise StripeWebhookSignatureError("stale-timestamp")


def _parse_event_envelope(
    raw_body: bytes,
) -> tuple[str, str, bool, bool, datetime, dict[str, Any]]:
    try:
        decoded = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise StripeWebhookMalformedError("invalid-json") from exc
    if not isinstance(decoded, dict):
        raise StripeWebhookMalformedError("event-not-object")

    event_id = decoded.get("id")
    event_type = decoded.get("type")
    api_version = decoded.get("api_version")
    created = decoded.get("created")
    has_livemode = "livemode" in decoded
    livemode = decoded["livemode"] if has_livemode else False
    data = decoded.get("data")
    if (
        not isinstance(event_id, str)
        or _EVENT_ID_RE.fullmatch(event_id) is None
        or not isinstance(event_type, str)
        or _EVENT_TYPE_RE.fullmatch(event_type) is None
        or isinstance(created, bool)
        or not isinstance(created, int)
        or created < 0
        or not isinstance(livemode, bool)
        or not isinstance(data, dict)
    ):
        raise StripeWebhookMalformedError("invalid-event-envelope")
    if not isinstance(api_version, str) or api_version not in ALLOWED_STRIPE_API_VERSIONS:
        raise StripeWebhookMalformedError("unsupported-api-version")

    obj = data.get("object")
    if not isinstance(obj, dict):
        raise StripeWebhookMalformedError("invalid-event-object")
    try:
        occurred_at = datetime.fromtimestamp(created, UTC)
    except (OverflowError, OSError, ValueError) as exc:
        raise StripeWebhookMalformedError("invalid-event-timestamp") from exc
    return event_id, event_type, livemode, has_livemode, occurred_at, obj


def _verify_expected_livemode(*, livemode: bool, has_livemode: bool) -> None:
    expected_livemode = getattr(settings, "KODERA_STRIPE_EXPECTED_LIVEMODE", None)
    if expected_livemode is None:
        return
    if not isinstance(expected_livemode, bool):
        raise StripeWebhookSecretMissingError()
    if not has_livemode:
        raise StripeWebhookMalformedError("missing-livemode")
    if livemode is not expected_livemode:
        raise StripeWebhookSignatureError("livemode-mismatch")


def _extract_uuid(mapping: Mapping[str, Any] | None, *keys: str) -> UUID | None:
    if not isinstance(mapping, Mapping):
        return None
    for key in keys:
        raw = mapping.get(key)
        if isinstance(raw, str) and raw:
            try:
                return UUID(raw)
            except ValueError:
                continue
    return None


def _has_nonempty_key(mapping: Mapping[str, Any] | None, *keys: str) -> bool:
    if not isinstance(mapping, Mapping):
        return False
    for key in keys:
        raw = mapping.get(key)
        if raw is not None and raw != "":
            return True
    return False


def _metadata_of(data_obj: Mapping[str, Any]) -> Mapping[str, Any]:
    meta = data_obj.get("metadata")
    if isinstance(meta, Mapping):
        return meta
    return {}


def _is_foreign_project_metadata(data_obj: Mapping[str, Any]) -> bool:
    """Return True when `metadata[samourai_project]` is present with any value other than `'kodera'`."""
    return is_foreign_samourai_project(data_obj)


def _resolve_seat_quota(subscription: Subscription) -> int:
    """Derive seat quota strictly from Core's persisted subscription tier and quantity."""
    from apps.billing.sovereign_settlement import resolve_subscription_seat_quota

    return resolve_subscription_seat_quota(subscription)


def _validate_bound_metadata(
    meta: Mapping[str, Any],
    data_obj: Mapping[str, Any],
    *,
    invoice: Invoice,
    customer_ref: str | None,
    payment: Payment | None = None,
) -> str | None:
    """Verify optional provider metadata / customer attributes against Core's persisted invoice."""
    if _has_nonempty_key(meta, "core_organisation_id", "organisation_id"):
        claimed_org = _extract_uuid(meta, "core_organisation_id", "organisation_id")
        if claimed_org != invoice.organisation_id:
            return "organisation_mismatch"

    if _has_nonempty_key(meta, "core_invoice_id", "invoice_id"):
        claimed_inv = _extract_uuid(meta, "core_invoice_id", "invoice_id")
        if claimed_inv != invoice.id:
            return "invoice_mismatch"

    if _has_nonempty_key(data_obj, "client_reference_id"):
        claimed_client_ref = _extract_uuid(data_obj, "client_reference_id")
        if claimed_client_ref != invoice.id:
            return "client_reference_mismatch"

    if _has_nonempty_key(meta, "core_subscription_id", "subscription_id"):
        claimed_sub = _extract_uuid(meta, "core_subscription_id", "subscription_id")
        if claimed_sub is None or claimed_sub != invoice.subscription_id:
            return "subscription_mismatch"

    if customer_ref is not None and customer_ref != "":
        if (
            payment is not None
            and payment.provider_customer_ref
            and payment.provider_customer_ref != customer_ref
        ):
            return "customer_mismatch"
        cross_org_conflict = (
            Payment.objects.filter(provider="stripe", provider_customer_ref=customer_ref)
            .exclude(organisation_id=invoice.organisation_id)
            .exists()
        )
        if cross_org_conflict:
            return "customer_mismatch"

    return None


def _clear_dunning_if_needed(subscription: Subscription, event_id: str) -> None:
    case = DunningCase.objects.select_for_update().filter(subscription=subscription).first()
    if case is not None and case.state != "current":
        case.state = "current"
        case.episode = new_uuid7()
        case.save(update_fields=["state", "episode", "updated_at"])
        events.record(
            "dunning.cleared",
            actor=SYSTEM,
            organisation_id=subscription.organisation_id,
            target=("subscription", subscription.id),
            metadata={"provider": "stripe", "event_id": event_id},
        )


def _lock_stripe_payment_ref(payment_ref: str) -> None:
    """Serialize early refund deferral and payment creation for the same Stripe payment ref."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended('stripe_payment_ref:' || %s, 0))",
            [payment_ref],
        )


def _sync_settled_subscription(
    *,
    invoice: Invoice,
    event_id: str,
) -> None:
    """Activate subscription, clear dunning, and sync quota strictly when the settled invoice
    has no newer unpaid or overdue Core invoice blocking reactivation."""
    if invoice.subscription_id is None:
        return
    subscription = (
        Subscription.objects.select_for_update().filter(id=invoice.subscription_id).first()
    )
    if subscription is None:
        return
    if subscription_has_blocking_unpaid_invoice(subscription, settled_invoice=invoice):
        return
    if "active" in SUBSCRIPTION_TRANSITIONS.get(subscription.state, frozenset()):
        subscription.state = "active"
        subscription.save(update_fields=["state", "updated_at"])
    if subscription.state == "active":
        from apps.billing.sovereign_settlement import sync_organisation_plan_tier_for_subscription

        _clear_dunning_if_needed(subscription, event_id)
        sync_organisation_plan_tier_for_subscription(subscription)


def _sync_reversed_subscription(*, invoice: Invoice) -> None:
    """Transition subscription and dunning to `past_due` whenever net settled invoice coverage
    falls short of `total_incl_vat_minor` after a partial or full refund."""
    if invoice.subscription_id is None:
        return
    if effective_owed_minor(invoice) == 0:
        return
    subscription = (
        Subscription.objects.select_for_update().filter(id=invoice.subscription_id).first()
    )
    if subscription is None:
        return
    if "past_due" in SUBSCRIPTION_TRANSITIONS.get(subscription.state, frozenset()):
        subscription.state = "past_due"
        subscription.save(update_fields=["state", "updated_at"])
    case = DunningCase.objects.select_for_update().filter(subscription=subscription).first()
    if case is not None and case.state == "current":
        case.state = "past_due"
        case.save(update_fields=["state", "updated_at"])
    if subscription.state == "past_due" and not subscription_has_blocking_unpaid_invoice(
        subscription, settled_invoice=invoice
    ):
        from apps.billing.boosts import recompute_workspace_boost_quota
        from apps.billing.sovereign_settlement import resolve_subscription_storage_quota_bytes
        from apps.workspaces.selectors import workspace_id_for

        ws_id = workspace_id_for(organisation_id=subscription.organisation_id)
        if ws_id is not None:
            recompute_workspace_boost_quota(
                organisation_id=subscription.organisation_id,
                workspace_id=ws_id,
            )
        else:
            sync_subscription_quota(
                organisation_id=subscription.organisation_id,
                policy_ref=f"subscription:{subscription.plan_code}:past_due",
                seats=_resolve_seat_quota(subscription),
                media_bytes=resolve_subscription_storage_quota_bytes(subscription),
                update_storage=True,
            )


def _validate_deferrable_metadata(
    meta: Mapping[str, Any],
    data_obj: Mapping[str, Any],
) -> str | None:
    """Reject syntactically invalid scope UUIDs on early refunds before deferring."""
    if (
        _has_nonempty_key(meta, "core_organisation_id", "organisation_id")
        and _extract_uuid(meta, "core_organisation_id", "organisation_id") is None
    ):
        return "organisation_mismatch"
    if (
        _has_nonempty_key(meta, "core_invoice_id", "invoice_id")
        and _extract_uuid(meta, "core_invoice_id", "invoice_id") is None
    ):
        return "invoice_mismatch"
    if (
        _has_nonempty_key(data_obj, "client_reference_id")
        and _extract_uuid(data_obj, "client_reference_id") is None
    ):
        return "client_reference_mismatch"
    if (
        _has_nonempty_key(meta, "core_subscription_id", "subscription_id")
        and _extract_uuid(meta, "core_subscription_id", "subscription_id") is None
    ):
        return "subscription_mismatch"
    if _has_nonempty_key(meta, "boost_grant_id") and _extract_uuid(meta, "boost_grant_id") is None:
        return "boost_grant_mismatch"
    if (
        _has_nonempty_key(meta, "vip_entitlement_id")
        and _extract_uuid(meta, "vip_entitlement_id") is None
    ):
        return "vip_entitlement_mismatch"
    if (
        _has_nonempty_key(meta, "kodera_marketplace_entitlement_id", "marketplace_entitlement_id")
        and _extract_uuid(meta, "kodera_marketplace_entitlement_id", "marketplace_entitlement_id")
        is None
    ):
        return "marketplace_entitlement_mismatch"
    return None


def _encode_deferred_refund_context(
    *,
    charge_id: str | None,
    meta: Mapping[str, Any],
    data_obj: Mapping[str, Any],
    event_kind: str = "refund",
) -> str:
    ctx: dict[str, str] = {"charge_id": charge_id or "", "event_kind": event_kind}
    org_id = _extract_uuid(meta, "core_organisation_id", "organisation_id")
    inv_id = _extract_uuid(meta, "core_invoice_id", "invoice_id")
    sub_id = _extract_uuid(meta, "core_subscription_id", "subscription_id")
    boost_id = _extract_uuid(meta, "boost_grant_id")
    vip_id = _extract_uuid(meta, "vip_entitlement_id")
    mkt_id = _extract_uuid(meta, "kodera_marketplace_entitlement_id", "marketplace_entitlement_id")
    client_ref = _extract_uuid(data_obj, "client_reference_id")
    if org_id is not None:
        ctx["core_organisation_id"] = str(org_id)
    if inv_id is not None:
        ctx["core_invoice_id"] = str(inv_id)
    if sub_id is not None:
        ctx["core_subscription_id"] = str(sub_id)
    if boost_id is not None:
        ctx["boost_grant_id"] = str(boost_id)
    if vip_id is not None:
        ctx["vip_entitlement_id"] = str(vip_id)
    if mkt_id is not None:
        ctx["marketplace_entitlement_id"] = str(mkt_id)
    if client_ref is not None:
        ctx["client_reference_id"] = str(client_ref)
    return json.dumps(ctx, separators=(",", ":"), sort_keys=True)


def _decode_deferred_refund_context(
    encoded: str | None,
) -> tuple[str | None, dict[str, str], dict[str, str]]:
    if not encoded:
        return None, {}, {}
    try:
        parsed = json.loads(encoded)
    except ValueError:
        return None, {}, {}
    if not isinstance(parsed, dict):
        return None, {}, {}
    raw_charge = parsed.get("charge_id")
    charge_id = raw_charge if isinstance(raw_charge, str) and raw_charge else None
    meta: dict[str, str] = {}
    data_obj: dict[str, str] = {}
    raw_kind = parsed.get("event_kind")
    if isinstance(raw_kind, str) and raw_kind in ("refund", "dispute"):
        meta["_event_kind"] = raw_kind
    for key in (
        "core_organisation_id",
        "core_invoice_id",
        "core_subscription_id",
        "boost_grant_id",
        "vip_entitlement_id",
        "marketplace_entitlement_id",
    ):
        val = parsed.get(key)
        if isinstance(val, str) and val:
            meta[key] = val
    client_ref = parsed.get("client_reference_id")
    if isinstance(client_ref, str) and client_ref:
        data_obj["client_reference_id"] = client_ref
    return charge_id, meta, data_obj


def _previous_applied_refund_minor(payment: Payment) -> int:
    if payment.state == "reversed":
        return int(payment.amount_minor)
    raw_prev = ProviderEventRecord.objects.filter(
        provider=payment.provider,
        payment_ref=payment.provider_ref,
        kind="payment.reversed",
        outcome="applied",
    ).aggregate(max_ref=models.Max("amount_minor"))["max_ref"]
    return int(raw_prev) if isinstance(raw_prev, int) else 0


def _record_applied_refund_event(
    *,
    event_id: str,
    payment_ref: str,
    amount_refunded: int,
    currency: str,
    occurred_at: datetime,
) -> bool:
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO billing_providerevent"
            " (id, provider, event_id, kind, payment_ref, link_ref, customer_ref,"
            " amount_minor, currency, occurred_at, outcome)"
            " VALUES (%s, 'stripe', %s, 'payment.reversed', %s, NULL, NULL, %s, %s, %s, 'applied')"
            " ON CONFLICT (provider, event_id) DO NOTHING RETURNING id",
            [new_uuid7(), event_id, payment_ref, amount_refunded, currency, occurred_at],
        )
        return cursor.fetchone() is not None


def _record_applied_succeeded_event(
    *,
    event_id: str,
    payment_ref: str,
    link_ref: str | None,
    amount_minor: int,
    currency: str,
    occurred_at: datetime,
) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO billing_providerevent"
            " (id, provider, event_id, kind, payment_ref, link_ref, customer_ref,"
            " amount_minor, currency, occurred_at, outcome)"
            " VALUES (%s, 'stripe', %s, 'payment.succeeded', %s, %s, NULL, %s, %s, %s, 'applied')"
            " ON CONFLICT (provider, event_id) DO NOTHING",
            [new_uuid7(), event_id, payment_ref, link_ref, amount_minor, currency, occurred_at],
        )


def _apply_g4_refund_to_payment(
    *,
    invoice: Invoice,
    payment: Payment,
    event_id: str,
    occurred_at: datetime,
    amount_refunded: int,
    currency: str,
    charge_id: str | None,
    pi_id: str | None,
    meta: Mapping[str, Any],
    data_obj: Mapping[str, Any],
    deferred_event_row: ProviderEventRecord | None = None,
) -> str:
    """Apply a verified G4 partial or full refund against a locked `Invoice` and `Payment`."""
    if not connection.in_atomic_block:
        raise RuntimeError("_apply_g4_refund_to_payment must execute inside transaction.atomic()")
    invoice = Invoice.objects.select_for_update().get(id=invoice.id)
    payment = Payment.objects.select_for_update().get(id=payment.id)
    organisation_id = payment.organisation_id
    mismatch_reason = _validate_bound_metadata(
        meta,
        data_obj,
        invoice=invoice,
        customer_ref=None,
    )
    if mismatch_reason is not None:
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=organisation_id,
            target=("payment", payment.id),
            metadata={
                "provider": "stripe",
                "event_id": event_id,
                "charge_id": charge_id or "",
                "payment_intent": pi_id or "",
                "reason": mismatch_reason,
            },
        )
        return "mismatch"

    if (
        currency != payment.currency
        or amount_refunded <= 0
        or amount_refunded > payment.amount_minor
    ):
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=organisation_id,
            target=("payment", payment.id),
            metadata={
                "provider": "stripe",
                "event_id": event_id,
                "charge_id": charge_id or "",
                "payment_intent": pi_id or "",
                "amount_refunded_minor": amount_refunded,
                "currency": currency,
                "reason": "refund_amount_or_currency",
            },
        )
        return "mismatch"

    prev_refunded = _previous_applied_refund_minor(payment)
    if amount_refunded <= prev_refunded:
        return "ignored"

    delta_refunded = amount_refunded - prev_refunded
    if deferred_event_row is not None:
        claimed = (
            ProviderEventRecord.objects.filter(id=deferred_event_row.id, outcome="deferred").update(
                outcome="applied"
            )
            == 1
        )
        if not claimed:
            return "ignored"
        deferred_event_row.outcome = "applied"
    elif not _record_applied_refund_event(
        event_id=event_id,
        payment_ref=payment.provider_ref,
        amount_refunded=amount_refunded,
        currency=currency,
        occurred_at=occurred_at,
    ):
        return "ignored"

    was_allocated = payment.allocated
    is_full_refund = amount_refunded == payment.amount_minor
    if is_full_refund and "reversed" in PAYMENT_TRANSITIONS.get(payment.state, frozenset()):
        payment.state = "reversed"
        payment.allocated = False
        payment.last_event_at = (
            occurred_at
            if payment.last_event_at is None
            else max(payment.last_event_at, occurred_at)
        )
        payment.save(update_fields=["state", "allocated", "last_event_at", "updated_at"])
    elif payment.last_event_at is None or occurred_at > payment.last_event_at:
        payment.last_event_at = occurred_at
        payment.save(update_fields=["last_event_at", "updated_at"])

    invoice_state_before = invoice.state
    invoice_paid_at_before = None if invoice.paid_at is None else invoice.paid_at.isoformat()
    if was_allocated:
        invoice.amount_paid_minor = max(0, int(invoice.amount_paid_minor) - delta_refunded)
        invoice.save(update_fields=["amount_paid_minor", "updated_at"])

    net_owed = effective_owed_minor(invoice)
    after_state = invoice.state
    if net_owed > 0 and invoice.state == "paid":
        overdue = invoice.due_at is not None and invoice.due_at <= timezone.now()
        after_state = "overdue" if overdue else "issued"
        set_invoice_state(invoice, after_state, actor=SYSTEM)
    elif net_owed > 0 and invoice.state == "issued" and invoice.due_at is not None:
        if invoice.due_at <= timezone.now():
            after_state = "overdue"
            set_invoice_state(invoice, after_state, actor=SYSTEM)

    if net_owed > 0:
        _sync_reversed_subscription(invoice=invoice)

    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT public.billing_issue_invoice_refund_credit_note(%s, %s, %s)",
            [payment.id, credit_note_series(), amount_refunded],
        )
        note_id = cursor.fetchone()[0]

    events.record(
        "payment.refunded",
        actor=SYSTEM,
        organisation_id=organisation_id,
        target=("payment", payment.id),
        metadata={
            "provider": "stripe",
            "event_id": event_id,
            "charge_id": charge_id or "",
            "payment_intent": pi_id or "",
            "invoice_id": str(payment.invoice_id),
            "amount_refunded_minor": amount_refunded,
            "delta_refunded_minor": delta_refunded,
            "credit_note_status": "issued"
            if note_id is not None
            else "credit_note_ceiling_reached",
            "currency": currency,
            "partial": not is_full_refund,
            "invoice_state_before": invoice_state_before,
            "invoice_state_after": after_state,
            "invoice_paid_at": invoice_paid_at_before,
        },
    )
    return "applied"


def _drain_deferred_stripe_refunds(*, invoice: Invoice, payment: Payment) -> None:
    """Replay bounded deferred `charge.refunded` rows once Core's `Payment` has been reconciled."""
    deferred_rows = list(
        ProviderEventRecord.objects.select_for_update()
        .filter(provider="stripe", payment_ref=payment.provider_ref, outcome="deferred")
        .order_by("occurred_at", "id")
    )
    for row in deferred_rows:
        charge_id, meta, data_obj = _decode_deferred_refund_context(row.link_ref)
        ref_outcome = _apply_g4_refund_to_payment(
            invoice=invoice,
            payment=payment,
            event_id=row.event_id,
            occurred_at=row.occurred_at,
            amount_refunded=int(row.amount_minor),
            currency=row.currency,
            charge_id=charge_id,
            pi_id=payment.provider_ref,
            meta=meta,
            data_obj=data_obj,
            deferred_event_row=row,
        )
        if row.outcome != ref_outcome:
            row.outcome = ref_outcome
            row.save(update_fields=["outcome"])
        StripeWebhookDelivery.objects.filter(stripe_event_id=row.event_id).update(
            outcome=ref_outcome,
            organisation_id=invoice.organisation_id,
        )


def _drain_deferred_h31_refunds(*, pi_id: str) -> None:
    """Replay bounded deferred `charge.refunded` and `charge.dispute.created` rows on settlement."""
    deferred_rows = list(
        ProviderEventRecord.objects.select_for_update()
        .filter(provider="stripe", payment_ref=pi_id, outcome="deferred")
        .order_by("occurred_at", "id")
    )
    for row in deferred_rows:
        charge_id, meta, _data_obj = _decode_deferred_refund_context(row.link_ref)
        claimed = (
            ProviderEventRecord.objects.filter(id=row.id, outcome="deferred").update(
                outcome="applied"
            )
            == 1
        )
        if not claimed:
            continue
        if meta.get("_event_kind") == "dispute":
            res = _try_handle_h31_charge_disputed(
                event_id=row.event_id,
                occurred_at=row.occurred_at,
                pi_id=pi_id,
                dispute_id=charge_id or row.event_id,
                raw_amount=int(row.amount_minor),
                currency=row.currency,
                meta=meta,
            )
        else:
            res = _try_handle_h31_charge_refunded(
                event_id=row.event_id,
                occurred_at=row.occurred_at,
                pi_id=pi_id,
                charge_id=charge_id,
                amount_refunded=int(row.amount_minor),
                currency=row.currency,
                already_recorded_event=True,
                meta=meta,
            )
        if res is None:
            ref_outcome = "unmatched"
            org_id: UUID | None = None
        else:
            ref_outcome, org_id = res
        if ref_outcome != "applied":
            ProviderEventRecord.objects.filter(id=row.id).update(outcome=ref_outcome)
        StripeWebhookDelivery.objects.filter(stripe_event_id=row.event_id).update(
            outcome=ref_outcome,
            organisation_id=org_id,
        )


def _insert_delivery_once(
    *,
    event_id: str,
    event_type: str,
    livemode: bool,
    occurred_at: datetime,
) -> StripeWebhookDelivery | None:
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO billing_stripewebhookdelivery"
            " (id, stripe_event_id, event_type, livemode, occurred_at, outcome, organisation_id)"
            " VALUES (%s, %s, %s, %s, %s, 'received', NULL)"
            " ON CONFLICT (stripe_event_id) DO NOTHING RETURNING id",
            [new_uuid7(), event_id, event_type, livemode, occurred_at],
        )
        row = cursor.fetchone()
    if row is None:
        return None
    return StripeWebhookDelivery.objects.get(id=row[0])


def _handle_checkout_completed(
    *,
    event_id: str,
    event_type: str,
    occurred_at: datetime,
    data_obj: Mapping[str, Any],
) -> tuple[str, UUID | None]:
    raw_session_id = data_obj.get("id")
    if not isinstance(raw_session_id, str) or not raw_session_id.strip():
        raise StripeWebhookMalformedError("invalid-event-object")
    session_id = raw_session_id.strip()

    link = PaymentLink.objects.filter(provider="stripe", provider_ref=session_id).first()
    if link is None:
        h31_outcome = _try_handle_h31_checkout_completed(
            event_id=event_id,
            event_type=event_type,
            occurred_at=occurred_at,
            session_id=session_id,
            data_obj=data_obj,
        )
        if h31_outcome is not None:
            return h31_outcome
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=None,
            target=("payment_link", f"stripe:{session_id}"),
            metadata={
                "provider": "stripe",
                "event_id": event_id,
                "reason": "unknown_checkout_session",
            },
        )
        return "unmatched", None

    if not direct_checkout_binding_matches_runtime(link.stripe_account_id, link.stripe_livemode):
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=link.organisation_id,
            target=("payment_link", f"stripe:{session_id}"),
            metadata={
                "provider": "stripe",
                "event_id": event_id,
                "invoice_id": str(link.invoice_id),
                "reason": "platform_or_livemode_mismatch",
            },
        )
        return "mismatch", link.organisation_id

    payment_status = data_obj.get("payment_status")
    if event_type in {"checkout.session.completed", "checkout.session.async_payment_succeeded"}:
        if event_type == "checkout.session.completed" and payment_status == "unpaid":
            return "ignored", link.organisation_id
        if payment_status != "paid":
            events.record(
                "payment.reconciliation_mismatch",
                actor=SYSTEM,
                organisation_id=link.organisation_id,
                target=("payment_link", f"stripe:{session_id}"),
                metadata={
                    "provider": "stripe",
                    "event_id": event_id,
                    "invoice_id": str(link.invoice_id),
                    "reason": "checkout_not_paid",
                },
            )
            return "mismatch", link.organisation_id

    try:
        port_event = translate_port_event(event_type, event_id, occurred_at, data_obj)
    except (KeyError, TypeError, ValueError) as exc:
        raise StripeWebhookMalformedError("invalid-event-object") from exc
    if port_event is None:
        raise StripeWebhookMalformedError("invalid-event-object")

    # Lock Stripe payment_ref advisory fence first, then Invoice before Payment.
    _lock_stripe_payment_ref(port_event.payment_ref)
    invoice = Invoice.objects.select_for_update().get(id=link.invoice_id)
    organisation_id = invoice.organisation_id

    existing_payment = (
        Payment.objects.select_for_update()
        .filter(provider="stripe", provider_ref=port_event.payment_ref)
        .first()
    )
    meta = _metadata_of(data_obj)
    mismatch_reason = _validate_bound_metadata(
        meta,
        data_obj,
        invoice=invoice,
        customer_ref=port_event.customer_ref,
        payment=existing_payment,
    )
    if mismatch_reason is not None:
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=organisation_id,
            target=("payment", f"stripe:{port_event.payment_ref}"),
            metadata={
                "provider": "stripe",
                "event_id": event_id,
                "invoice_id": str(invoice.id),
                "reason": mismatch_reason,
            },
        )
        return "mismatch", organisation_id

    if (port_event.amount_minor, port_event.currency) != (link.amount_minor, link.currency) or (
        port_event.currency != invoice.currency
    ):
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=organisation_id,
            target=("payment", f"stripe:{port_event.payment_ref}"),
            metadata={
                "provider": "stripe",
                "event_id": event_id,
                "invoice_id": str(invoice.id),
                "reason": "amount_or_currency",
            },
        )
        return "mismatch", organisation_id

    if (
        Payment.objects.filter(provider="stripe", provider_ref=port_event.payment_ref)
        .exclude(invoice_id=invoice.id)
        .exists()
    ):
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=organisation_id,
            target=("payment", f"stripe:{port_event.payment_ref}"),
            metadata={
                "provider": "stripe",
                "event_id": event_id,
                "invoice_id": str(invoice.id),
                "reason": "payment_intent_invoice_mismatch",
            },
        )
        return "mismatch", organisation_id

    was_already_paid = invoice.state == "paid"
    reconciled = reconcile(provider_name="stripe", event=port_event, drain_deferred=False)
    outcome = "applied" if reconciled == "duplicate" else reconciled
    invoice.refresh_from_db()

    if outcome == "applied" and not was_already_paid and invoice.state == "paid":
        _sync_settled_subscription(invoice=invoice, event_id=event_id)

    payment = (
        Payment.objects.select_for_update()
        .filter(provider="stripe", provider_ref=port_event.payment_ref)
        .first()
    )
    if payment is not None:
        _drain_deferred_stripe_refunds(invoice=invoice, payment=payment)

    return outcome, organisation_id


def _handle_checkout_async_payment_failed(
    *,
    event_id: str,
    occurred_at: datetime,
    data_obj: Mapping[str, Any],
) -> tuple[str, UUID | None]:
    raw_session_id = data_obj.get("id")
    if not isinstance(raw_session_id, str) or not raw_session_id.strip():
        raise StripeWebhookMalformedError("invalid-event-object")
    session_id = raw_session_id.strip()

    link = PaymentLink.objects.filter(provider="stripe", provider_ref=session_id).first()
    if link is None:
        h31_cancelled = _try_handle_h31_checkout_cancelled(session_id=session_id)
        if h31_cancelled is not None:
            return h31_cancelled
        return "unmatched", None
    if not direct_checkout_binding_matches_runtime(link.stripe_account_id, link.stripe_livemode):
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=link.organisation_id,
            target=("payment_link", f"stripe:{session_id}"),
            metadata={
                "provider": "stripe",
                "event_id": event_id,
                "invoice_id": str(link.invoice_id),
                "reason": "platform_or_livemode_mismatch",
            },
        )
        return "mismatch", link.organisation_id

    try:
        port_event = translate_port_event(
            "checkout.session.async_payment_failed", event_id, occurred_at, data_obj
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise StripeWebhookMalformedError("invalid-event-object") from exc
    if port_event is None:
        raise StripeWebhookMalformedError("invalid-event-object")

    _lock_stripe_payment_ref(port_event.payment_ref)
    invoice = Invoice.objects.select_for_update().get(id=link.invoice_id)
    existing_payment = (
        Payment.objects.select_for_update()
        .filter(provider="stripe", provider_ref=port_event.payment_ref)
        .first()
    )
    mismatch_reason = _validate_bound_metadata(
        _metadata_of(data_obj),
        data_obj,
        invoice=invoice,
        customer_ref=port_event.customer_ref,
        payment=existing_payment,
    )
    if (port_event.amount_minor, port_event.currency) != (link.amount_minor, link.currency) or (
        port_event.currency != invoice.currency
    ):
        mismatch_reason = "amount_or_currency"
    if existing_payment is not None and existing_payment.invoice_id != invoice.id:
        mismatch_reason = "payment_intent_invoice_mismatch"
    if mismatch_reason is not None:
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=invoice.organisation_id,
            target=("payment", f"stripe:{port_event.payment_ref}"),
            metadata={
                "provider": "stripe",
                "event_id": event_id,
                "invoice_id": str(invoice.id),
                "reason": mismatch_reason,
            },
        )
        return "mismatch", invoice.organisation_id
    outcome = reconcile(provider_name="stripe", event=port_event, drain_deferred=False)
    invoice.refresh_from_db()
    if outcome == "applied" and effective_owed_minor(invoice) > 0:
        _sync_reversed_subscription(invoice=invoice)
    return ("applied" if outcome == "duplicate" else outcome), invoice.organisation_id


def _handle_checkout_expired(
    *,
    data_obj: Mapping[str, Any],
) -> tuple[str, UUID | None]:
    raw_session_id = data_obj.get("id")
    if not isinstance(raw_session_id, str) or not raw_session_id.strip():
        raise StripeWebhookMalformedError("invalid-event-object")
    session_id = raw_session_id.strip()

    link = (
        PaymentLink.objects.select_for_update()
        .filter(provider="stripe", provider_ref=session_id)
        .first()
    )
    if link is None:
        h31_cancelled = _try_handle_h31_checkout_cancelled(session_id=session_id)
        if h31_cancelled is not None:
            return h31_cancelled
        return "unmatched", None
    if not (
        link.stripe_account_id is None and link.stripe_livemode is None
    ) and not direct_checkout_binding_matches_runtime(link.stripe_account_id, link.stripe_livemode):
        return "mismatch", link.organisation_id
    if link.state == "active":
        link.state = "expired"
        link.save(update_fields=["state", "updated_at"])
        return "applied", link.organisation_id
    return "ignored", link.organisation_id


def _handle_payment_intent_succeeded(
    *,
    event_id: str,
    occurred_at: datetime,
    data_obj: Mapping[str, Any],
) -> tuple[str, UUID | None]:
    raw_pi = data_obj.get("id")
    raw_amount = (
        data_obj.get("amount_received") if "amount_received" in data_obj else data_obj.get("amount")
    )
    raw_currency = data_obj.get("currency")
    if (
        not isinstance(raw_pi, str)
        or not raw_pi.strip()
        or isinstance(raw_amount, bool)
        or not isinstance(raw_amount, int)
        or raw_amount <= 0
        or not isinstance(raw_currency, str)
        or len(raw_currency.strip()) != 3
    ):
        raise StripeWebhookMalformedError("invalid-event-object")

    pi_id = raw_pi.strip()
    currency = raw_currency.strip().upper()
    raw_customer = data_obj.get("customer")
    customer_ref = (
        raw_customer.strip() if isinstance(raw_customer, str) and raw_customer.strip() else None
    )
    meta = _metadata_of(data_obj)

    _lock_stripe_payment_ref(pi_id)

    h31_pi = _try_handle_h31_payment_intent_succeeded(
        event_id=event_id,
        occurred_at=occurred_at,
        pi_id=pi_id,
        raw_amount=raw_amount,
        currency=currency,
        meta=meta,
    )
    if h31_pi is not None:
        return h31_pi

    existing_payment = Payment.objects.filter(provider="stripe", provider_ref=pi_id).first()
    link: PaymentLink | None = None
    exp_acct, exp_live = expected_stripe_binding()
    if existing_payment is not None:
        inv_id = existing_payment.invoice_id
        if existing_payment.payment_link_id is not None:
            link = PaymentLink.objects.filter(id=existing_payment.payment_link_id).first()
        else:
            link = (
                PaymentLink.objects.filter(provider="stripe", invoice_id=inv_id)
                .order_by("-created_at", "-id")
                .first()
            )
    else:
        meta_inv_id = _extract_uuid(meta, "core_invoice_id", "invoice_id")
        if meta_inv_id is not None:
            base_links = PaymentLink.objects.filter(provider="stripe", invoice_id=meta_inv_id)
            bound_links = base_links
            if exp_acct is not None or exp_live is not None:
                if exp_acct is not None:
                    bound_links = bound_links.filter(stripe_account_id=exp_acct)
                if exp_live is not None:
                    bound_links = bound_links.filter(stripe_livemode=exp_live)
            else:
                bound_links = bound_links.filter(
                    stripe_account_id__isnull=True, stripe_livemode__isnull=True
                )
            link = (
                bound_links.filter(state="active").order_by("-created_at", "-id").first()
                or bound_links.filter(state="used").order_by("-created_at", "-id").first()
                or bound_links.order_by("-created_at", "-id").first()
                or base_links.order_by("-created_at", "-id").first()
            )
        if meta_inv_id is None or link is None:
            events.record(
                "payment.reconciliation_mismatch",
                actor=SYSTEM,
                organisation_id=None,
                target=("payment", f"stripe:{pi_id}"),
                metadata={
                    "provider": "stripe",
                    "event_id": event_id,
                    "reason": "unknown_payment",
                },
            )
            return "unmatched", None
        inv_id = link.invoice_id

    if link is not None and not direct_checkout_binding_matches_runtime(
        link.stripe_account_id, link.stripe_livemode
    ):
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=link.organisation_id,
            target=("payment", f"stripe:{pi_id}"),
            metadata={
                "provider": "stripe",
                "event_id": event_id,
                "invoice_id": str(link.invoice_id),
                "reason": "platform_or_livemode_mismatch",
            },
        )
        return "mismatch", link.organisation_id

    # Lock Invoice before Payment, matching apps.billing.payments.services._locate lock order.
    invoice = Invoice.objects.select_for_update().filter(id=inv_id).first()
    if invoice is None:
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=None,
            target=("payment", f"stripe:{pi_id}"),
            metadata={
                "provider": "stripe",
                "event_id": event_id,
                "reason": "unknown_invoice",
            },
        )
        return "unmatched", None

    organisation_id = invoice.organisation_id
    payment = (
        Payment.objects.select_for_update().filter(provider="stripe", provider_ref=pi_id).first()
    )

    mismatch_reason = _validate_bound_metadata(
        meta,
        data_obj,
        invoice=invoice,
        customer_ref=customer_ref,
        payment=payment,
    )
    if mismatch_reason is not None:
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=organisation_id,
            target=("payment", f"stripe:{pi_id}"),
            metadata={
                "provider": "stripe",
                "event_id": event_id,
                "invoice_id": str(invoice.id),
                "reason": mismatch_reason,
            },
        )
        return "mismatch", organisation_id

    expected_source = payment if payment is not None else link
    if expected_source is None:
        return "unmatched", None
    if (raw_amount, currency) != (expected_source.amount_minor, expected_source.currency) or (
        currency != invoice.currency
    ):
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=organisation_id,
            target=("payment", f"stripe:{pi_id}"),
            metadata={
                "provider": "stripe",
                "event_id": event_id,
                "invoice_id": str(invoice.id),
                "reason": "amount_or_currency",
            },
        )
        return "mismatch", organisation_id

    if (payment is not None and payment.state in ("succeeded", "reversed")) or (
        invoice.state == "paid"
    ):
        if (
            payment is not None
            and customer_ref is not None
            and payment.provider_customer_ref != customer_ref
        ):
            payment.provider_customer_ref = customer_ref
            payment.save(update_fields=["provider_customer_ref", "updated_at"])
        events.record(
            "payment.reconciled",
            actor=SYSTEM,
            organisation_id=organisation_id,
            target=("payment", payment.id) if payment is not None else ("invoice", invoice.id),
            metadata={
                "provider": "stripe",
                "event_id": event_id,
                "payment_intent": pi_id,
                "invoice_id": str(invoice.id),
                "amount_minor": raw_amount,
                "currency": currency,
            },
        )
        return "ignored", organisation_id

    was_already_paid = invoice.state == "paid"
    reconciled = reconcile(
        provider_name="stripe",
        event=PortEvent(
            event_id=event_id,
            kind="payment.succeeded",
            payment_ref=pi_id,
            link_ref=None if link is None else link.provider_ref,
            amount_minor=raw_amount,
            currency=currency,
            occurred_at=occurred_at,
            customer_ref=customer_ref,
        ),
        drain_deferred=False,
    )
    outcome = "applied" if reconciled == "duplicate" else reconciled
    invoice.refresh_from_db()

    if outcome == "applied" and not was_already_paid and invoice.state == "paid":
        _sync_settled_subscription(invoice=invoice, event_id=event_id)

    reconciled_payment = (
        Payment.objects.select_for_update().filter(provider="stripe", provider_ref=pi_id).first()
    )
    if reconciled_payment is not None:
        _drain_deferred_stripe_refunds(invoice=invoice, payment=reconciled_payment)

    return outcome, organisation_id


def _handle_charge_refunded(
    *,
    event_id: str,
    occurred_at: datetime,
    data_obj: Mapping[str, Any],
) -> tuple[str, UUID | None]:
    raw_charge = data_obj.get("id")
    raw_pi = data_obj.get("payment_intent")
    amount_refunded = data_obj.get("amount_refunded")
    raw_currency = data_obj.get("currency")

    charge_id = raw_charge.strip() if isinstance(raw_charge, str) and raw_charge.strip() else None
    pi_id = raw_pi.strip() if isinstance(raw_pi, str) and raw_pi.strip() else None
    if (
        (charge_id is None and pi_id is None)
        or isinstance(amount_refunded, bool)
        or not isinstance(amount_refunded, int)
        or amount_refunded < 0
        or not isinstance(raw_currency, str)
        or len(raw_currency.strip()) != 3
    ):
        raise StripeWebhookMalformedError("invalid-event-object")

    currency = raw_currency.strip().upper()
    meta = _metadata_of(data_obj)

    if pi_id is None:
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=None,
            target=("payment", f"stripe:{charge_id}"),
            metadata={
                "provider": "stripe",
                "event_id": event_id,
                "reason": "unknown_payment",
            },
        )
        return "unmatched", None

    _lock_stripe_payment_ref(pi_id)

    h31_refund = _try_handle_h31_charge_refunded(
        event_id=event_id,
        occurred_at=occurred_at,
        pi_id=pi_id,
        charge_id=charge_id,
        amount_refunded=amount_refunded,
        currency=currency,
        meta=meta,
    )
    if h31_refund is not None:
        return h31_refund

    existing_payment = Payment.objects.filter(provider="stripe", provider_ref=pi_id).first()
    if existing_payment is None:
        meta_mismatch = _validate_deferrable_metadata(meta, data_obj)
        if meta_mismatch is not None or amount_refunded <= 0:
            events.record(
                "payment.reconciliation_mismatch",
                actor=SYSTEM,
                organisation_id=None,
                target=("payment", f"stripe:{pi_id}"),
                metadata={
                    "provider": "stripe",
                    "event_id": event_id,
                    "charge_id": charge_id or "",
                    "payment_intent": pi_id,
                    "reason": meta_mismatch or "refund_amount_or_currency",
                },
            )
            return "mismatch", None

        total_deferred = ProviderEventRecord.objects.filter(
            provider="stripe", outcome="deferred"
        ).count()
        per_payment_deferred = ProviderEventRecord.objects.filter(
            provider="stripe", payment_ref=pi_id, outcome="deferred"
        ).count()
        if (
            total_deferred >= MAX_DEFERRED_STRIPE_REFUNDS
            or per_payment_deferred >= MAX_DEFERRED_PER_PAYMENT
        ):
            events.record(
                "payment.reconciliation_mismatch",
                actor=SYSTEM,
                organisation_id=None,
                target=("payment", f"stripe:{pi_id}"),
                metadata={
                    "provider": "stripe",
                    "event_id": event_id,
                    "charge_id": charge_id or "",
                    "payment_intent": pi_id,
                    "reason": "deferred_refund_limit_exceeded",
                },
            )
            return "mismatch", None

        encoded_ctx = _encode_deferred_refund_context(
            charge_id=charge_id,
            meta=meta,
            data_obj=data_obj,
        )
        with connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO billing_providerevent"
                " (id, provider, event_id, kind, payment_ref, link_ref, customer_ref,"
                " amount_minor, currency, occurred_at, outcome)"
                " VALUES (%s, 'stripe', %s, 'payment.reversed', %s, %s, NULL, %s, %s, %s, 'deferred')"
                " ON CONFLICT (provider, event_id) DO NOTHING",
                [new_uuid7(), event_id, pi_id, encoded_ctx, amount_refunded, currency, occurred_at],
            )
        return "deferred", None

    invoice = Invoice.objects.select_for_update().get(id=existing_payment.invoice_id)
    payment = Payment.objects.select_for_update().get(id=existing_payment.id)
    if payment.payment_link_id is not None:
        bound_link = PaymentLink.objects.filter(id=payment.payment_link_id).first()
        if bound_link is not None and not direct_checkout_binding_matches_runtime(
            bound_link.stripe_account_id, bound_link.stripe_livemode
        ):
            return "mismatch", payment.organisation_id
    outcome = _apply_g4_refund_to_payment(
        invoice=invoice,
        payment=payment,
        event_id=event_id,
        occurred_at=occurred_at,
        amount_refunded=amount_refunded,
        currency=currency,
        charge_id=charge_id,
        pi_id=pi_id,
        meta=meta,
        data_obj=data_obj,
    )
    return outcome, payment.organisation_id


def receive_stripe_webhook(
    *,
    raw_body: bytes,
    headers: Mapping[str, str],
    clock: Callable[[], float] = time.time,
) -> StripeWebhookReceipt:
    """Verify, deduplicate, and process an inbound Stripe webhook HTTP payload."""
    webhook_secret = _configured_webhook_secret()
    if len(raw_body) > MAX_WEBHOOK_BYTES:
        raise StripeWebhookMalformedError("payload-too-large")

    sig_header = next(
        (val for key, val in headers.items() if key.lower() == SIGNATURE_HEADER.lower()),
        None,
    )
    verify_stripe_signature(
        raw_body=raw_body,
        signature_header=sig_header,
        webhook_secret=webhook_secret,
        clock=clock,
    )
    event_id, event_type, livemode, has_livemode, occurred_at, data_obj = _parse_event_envelope(
        raw_body
    )
    _verify_expected_livemode(livemode=livemode, has_livemode=has_livemode)

    with transaction.atomic():
        delivery = _insert_delivery_once(
            event_id=event_id,
            event_type=event_type,
            livemode=livemode,
            occurred_at=occurred_at,
        )
        if delivery is None:
            return StripeWebhookReceipt(
                event_id=event_id,
                event_type=event_type,
                status="duplicate",
            )

        organisation_id: UUID | None = None
        if _is_foreign_project_metadata(data_obj):
            outcome = "ignored"
        elif event_type in {
            "checkout.session.completed",
            "checkout.session.async_payment_succeeded",
        }:
            outcome, organisation_id = _handle_checkout_completed(
                event_id=event_id,
                event_type=event_type,
                occurred_at=occurred_at,
                data_obj=data_obj,
            )
        elif event_type == "checkout.session.async_payment_failed":
            outcome, organisation_id = _handle_checkout_async_payment_failed(
                event_id=event_id,
                occurred_at=occurred_at,
                data_obj=data_obj,
            )
        elif event_type == "checkout.session.expired":
            outcome, organisation_id = _handle_checkout_expired(
                data_obj=data_obj,
            )
        elif event_type == "payment_intent.succeeded":
            outcome, organisation_id = _handle_payment_intent_succeeded(
                event_id=event_id,
                occurred_at=occurred_at,
                data_obj=data_obj,
            )
        elif event_type == "charge.refunded":
            outcome, organisation_id = _handle_charge_refunded(
                event_id=event_id,
                occurred_at=occurred_at,
                data_obj=data_obj,
            )
        elif event_type == "charge.dispute.created":
            outcome, organisation_id = _handle_charge_dispute_created(
                event_id=event_id,
                occurred_at=occurred_at,
                data_obj=data_obj,
            )
        else:
            outcome = "ignored_event_type"

        delivery.outcome = outcome
        delivery.organisation_id = organisation_id
        delivery.save(update_fields=["outcome", "organisation_id"])
        return StripeWebhookReceipt(
            event_id=event_id,
            event_type=event_type,
            status=outcome,
        )


def _try_handle_h31_checkout_cancelled(
    *,
    session_id: str,
) -> tuple[str, UUID | None] | None:
    from django.apps import apps as django_apps

    from .. import boosts, vip_connect

    boost = WorkspaceBoostGrant.objects.filter(stripe_checkout_session_id=session_id).first()
    if boost is not None:
        if not (
            boost.stripe_account_id is None and boost.stripe_livemode is None
        ) and not direct_checkout_binding_matches_runtime(
            boost.stripe_account_id, boost.stripe_livemode
        ):
            return "mismatch", boost.organisation_id
        cancelled = boosts.cancel_pending_boost_grant(grant_id=boost.id)
        return ("applied" if cancelled else "ignored"), boost.organisation_id

    vip = VipMembershipEntitlement.objects.filter(stripe_checkout_session_id=session_id).first()
    if vip is not None:
        if not (
            vip.stripe_account_id is None and vip.stripe_livemode is None
        ) and not connect_checkout_binding_matches_runtime(
            vip.stripe_account_id, vip.stripe_livemode
        ):
            return "mismatch", vip.organisation_id
        cancelled = vip_connect.cancel_pending_vip_entitlement(entitlement_id=vip.id)
        return ("applied" if cancelled else "ignored"), vip.organisation_id

    if django_apps.is_installed("apps.extensions"):
        from apps.extensions import marketplace as extension_marketplace

        mkt_cancelled = extension_marketplace.try_cancel_stripe_checkout_session(
            session_id=session_id
        )
        if mkt_cancelled is not None:
            return mkt_cancelled

    return None


def _try_handle_h31_checkout_completed(
    *,
    event_id: str,
    event_type: str,
    occurred_at: datetime,
    session_id: str,
    data_obj: Mapping[str, Any],
) -> tuple[str, UUID | None] | None:
    from django.apps import apps as django_apps

    from .. import boosts, vip_connect

    boost = WorkspaceBoostGrant.objects.filter(stripe_checkout_session_id=session_id).first()
    vip = (
        None
        if boost is not None
        else VipMembershipEntitlement.objects.filter(stripe_checkout_session_id=session_id).first()
    )
    meta = _metadata_of(data_obj)
    has_meta_mkt = _has_nonempty_key(
        meta, "kodera_marketplace_entitlement_id", "marketplace_entitlement_id"
    )
    meta_mkt_id = _extract_uuid(
        meta, "kodera_marketplace_entitlement_id", "marketplace_entitlement_id"
    )
    if (
        meta_mkt_id is None
        and meta.get("kodera_checkout_kind") == "extension_marketplace"
        and _has_nonempty_key(data_obj, "client_reference_id")
    ):
        has_meta_mkt = True
        meta_mkt_id = _extract_uuid(data_obj, "client_reference_id")

    mkt_org_id: UUID | None = None
    if boost is None and vip is None and django_apps.is_installed("apps.extensions"):
        from apps.extensions import marketplace as extension_marketplace

        mkt_org_id = extension_marketplace.find_marketplace_entitlement_organisation(
            session_id=session_id,
            meta_entitlement_id=meta_mkt_id,
        )

    if boost is None and vip is None and mkt_org_id is None:
        return None

    org_id = (
        boost.organisation_id
        if boost is not None
        else vip.organisation_id
        if vip is not None
        else mkt_org_id
    )
    if org_id is None:
        return None
    if boost is not None and not direct_checkout_binding_matches_runtime(
        boost.stripe_account_id, boost.stripe_livemode
    ):
        return "mismatch", org_id
    if vip is not None and not connect_checkout_binding_matches_runtime(
        vip.stripe_account_id, vip.stripe_livemode
    ):
        return "mismatch", org_id

    payment_status = data_obj.get("payment_status")
    if event_type in {"checkout.session.completed", "checkout.session.async_payment_succeeded"}:
        if event_type == "checkout.session.completed" and (
            payment_status == "unpaid"
            or (mkt_org_id is not None and payment_status == "processing")
        ):
            return "ignored", org_id
        if payment_status != "paid":
            events.record(
                "payment.reconciliation_mismatch",
                actor=SYSTEM,
                organisation_id=org_id,
                target=("payment_link", f"stripe:{session_id}"),
                metadata={
                    "provider": "stripe",
                    "event_id": event_id,
                    "reason": "checkout_not_paid",
                },
            )
            return "mismatch", org_id

    raw_pi = data_obj.get("payment_intent")
    raw_amount = data_obj.get("amount_total")
    raw_currency = data_obj.get("currency")
    if (
        not isinstance(raw_pi, str)
        or not raw_pi.strip()
        or isinstance(raw_amount, bool)
        or not isinstance(raw_amount, int)
        or not isinstance(raw_currency, str)
    ):
        raise StripeWebhookMalformedError("invalid-event-object")
    pi_id = raw_pi.strip()
    currency = raw_currency.strip().upper()

    _lock_stripe_payment_ref(pi_id)

    if boost is not None:
        if (raw_amount, currency) != (boost.gross_amount_minor, boost.currency):
            return "mismatch", org_id
        boosts.activate_boost_grant(
            grant_id=boost.id,
            payment_intent_id=pi_id,
            settled_at=occurred_at,
        )
        _record_applied_succeeded_event(
            event_id=event_id,
            payment_ref=pi_id,
            link_ref=session_id,
            amount_minor=raw_amount,
            currency=currency,
            occurred_at=occurred_at,
        )
        _drain_deferred_h31_refunds(pi_id=pi_id)
        return "applied", org_id

    if vip is not None:
        if (raw_amount, currency) != (vip.total_incl_vat_minor, vip.currency):
            return "mismatch", org_id
        vip_connect.activate_vip_entitlement(
            entitlement_id=vip.id,
            stripe_event_id=event_id,
            payment_intent_id=pi_id,
            settled_at=occurred_at,
        )
        _record_applied_succeeded_event(
            event_id=event_id,
            payment_ref=pi_id,
            link_ref=session_id,
            amount_minor=raw_amount,
            currency=currency,
            occurred_at=occurred_at,
        )
        _drain_deferred_h31_refunds(pi_id=pi_id)
        return "applied", org_id

    if mkt_org_id is not None:
        from apps.extensions import marketplace as extension_marketplace

        mkt_res = extension_marketplace.try_settle_stripe_checkout_session(
            session_id=session_id,
            event_type=event_type,
            payment_status=payment_status,
            payment_intent_id=pi_id,
            amount_minor=raw_amount,
            currency=currency,
            meta_entitlement_id=meta_mkt_id,
            has_meta_entitlement=has_meta_mkt,
        )
        if mkt_res is None:
            return None
        mkt_outcome, mkt_org, settled_id = mkt_res
        if mkt_outcome == "applied" and settled_id is not None:
            events.record(
                "payment.received",
                actor=SYSTEM,
                organisation_id=mkt_org,
                target=("marketplace_entitlement", settled_id),
                metadata={
                    "provider": "stripe",
                    "event_id": event_id,
                    "payment_intent": pi_id,
                    "amount_minor": raw_amount,
                    "currency": currency,
                },
            )
            _record_applied_succeeded_event(
                event_id=event_id,
                payment_ref=pi_id,
                link_ref=session_id,
                amount_minor=raw_amount,
                currency=currency,
                occurred_at=occurred_at,
            )
            _drain_deferred_h31_refunds(pi_id=pi_id)
        return mkt_outcome, mkt_org

    return None


def _try_handle_h31_payment_intent_succeeded(
    *,
    event_id: str,
    occurred_at: datetime,
    pi_id: str,
    raw_amount: int,
    currency: str,
    meta: Mapping[str, Any],
) -> tuple[str, UUID | None] | None:
    from django.apps import apps as django_apps

    from .. import boosts, vip_connect

    meta_boost_id = _extract_uuid(meta, "boost_grant_id")
    meta_vip_id = _extract_uuid(meta, "vip_entitlement_id")

    boost = WorkspaceBoostGrant.objects.filter(stripe_payment_intent_id=pi_id).first()
    if boost is None and meta_boost_id is not None:
        boost = WorkspaceBoostGrant.objects.filter(id=meta_boost_id).first()

    if boost is not None:
        if not direct_checkout_binding_matches_runtime(
            boost.stripe_account_id, boost.stripe_livemode
        ):
            return "mismatch", boost.organisation_id
        if meta_boost_id is not None and meta_boost_id != boost.id:
            return "mismatch", boost.organisation_id
        if _has_nonempty_key(meta, "core_invoice_id"):
            claimed_inv = _extract_uuid(meta, "core_invoice_id")
            if claimed_inv != boost.invoice_id:
                return "mismatch", boost.organisation_id
        if (raw_amount, currency) != (boost.gross_amount_minor, boost.currency):
            return "mismatch", boost.organisation_id
        if boost.state != "pending_payment":
            events.record(
                "payment.reconciled",
                actor=SYSTEM,
                organisation_id=boost.organisation_id,
                target=("boost_grant", boost.id),
                metadata={
                    "provider": "stripe",
                    "event_id": event_id,
                    "payment_intent": pi_id,
                    "amount_minor": raw_amount,
                    "currency": currency,
                },
            )
            return "ignored", boost.organisation_id
        boosts.activate_boost_grant(
            grant_id=boost.id,
            payment_intent_id=pi_id,
            settled_at=occurred_at,
        )
        _record_applied_succeeded_event(
            event_id=event_id,
            payment_ref=pi_id,
            link_ref=boost.stripe_checkout_session_id,
            amount_minor=raw_amount,
            currency=currency,
            occurred_at=occurred_at,
        )
        _drain_deferred_h31_refunds(pi_id=pi_id)
        return "applied", boost.organisation_id

    vip = VipMembershipEntitlement.objects.filter(stripe_payment_intent_id=pi_id).first()
    if vip is None and meta_vip_id is not None:
        vip = VipMembershipEntitlement.objects.filter(id=meta_vip_id).first()

    if vip is not None:
        if not connect_checkout_binding_matches_runtime(vip.stripe_account_id, vip.stripe_livemode):
            return "mismatch", vip.organisation_id
        if meta_vip_id is not None and meta_vip_id != vip.id:
            return "mismatch", vip.organisation_id
        if _has_nonempty_key(meta, "workspace_id"):
            claimed_ws = _extract_uuid(meta, "workspace_id")
            if claimed_ws != vip.workspace_id:
                return "mismatch", vip.organisation_id
        if (raw_amount, currency) != (vip.total_incl_vat_minor, vip.currency):
            return "mismatch", vip.organisation_id
        if vip.state != "pending_payment":
            events.record(
                "payment.reconciled",
                actor=SYSTEM,
                organisation_id=vip.organisation_id,
                target=("vip_entitlement", vip.id),
                metadata={
                    "provider": "stripe",
                    "event_id": event_id,
                    "payment_intent": pi_id,
                    "amount_minor": raw_amount,
                    "currency": currency,
                },
            )
            return "ignored", vip.organisation_id
        vip_connect.activate_vip_entitlement(
            entitlement_id=vip.id,
            stripe_event_id=event_id,
            payment_intent_id=pi_id,
            settled_at=occurred_at,
        )
        _record_applied_succeeded_event(
            event_id=event_id,
            payment_ref=pi_id,
            link_ref=vip.stripe_checkout_session_id,
            amount_minor=raw_amount,
            currency=currency,
            occurred_at=occurred_at,
        )
        _drain_deferred_h31_refunds(pi_id=pi_id)
        return "applied", vip.organisation_id

    if django_apps.is_installed("apps.extensions"):
        from apps.extensions import marketplace as extension_marketplace

        has_meta_mkt = _has_nonempty_key(
            meta, "kodera_marketplace_entitlement_id", "marketplace_entitlement_id"
        )
        meta_mkt_id = _extract_uuid(
            meta, "kodera_marketplace_entitlement_id", "marketplace_entitlement_id"
        )
        has_meta_ws = _has_nonempty_key(meta, "workspace_id")
        meta_ws_id = _extract_uuid(meta, "workspace_id")
        mkt_pi_res = extension_marketplace.try_settle_stripe_payment_intent(
            payment_intent_id=pi_id,
            amount_minor=raw_amount,
            currency=currency,
            meta_entitlement_id=meta_mkt_id,
            meta_workspace_id=meta_ws_id,
            has_meta_entitlement=has_meta_mkt,
            has_meta_workspace=has_meta_ws,
        )
        if mkt_pi_res is not None:
            mkt_outcome, mkt_org, mkt_id, mkt_session_ref = mkt_pi_res
            if mkt_outcome == "applied" and mkt_id is not None:
                events.record(
                    "payment.received",
                    actor=SYSTEM,
                    organisation_id=mkt_org,
                    target=("marketplace_entitlement", mkt_id),
                    metadata={
                        "provider": "stripe",
                        "event_id": event_id,
                        "payment_intent": pi_id,
                        "amount_minor": raw_amount,
                        "currency": currency,
                    },
                )
                _record_applied_succeeded_event(
                    event_id=event_id,
                    payment_ref=pi_id,
                    link_ref=mkt_session_ref,
                    amount_minor=raw_amount,
                    currency=currency,
                    occurred_at=occurred_at,
                )
                _drain_deferred_h31_refunds(pi_id=pi_id)
            elif mkt_outcome == "ignored" and mkt_id is not None:
                events.record(
                    "payment.reconciled",
                    actor=SYSTEM,
                    organisation_id=mkt_org,
                    target=("marketplace_entitlement", mkt_id),
                    metadata={
                        "provider": "stripe",
                        "event_id": event_id,
                        "payment_intent": pi_id,
                        "amount_minor": raw_amount,
                        "currency": currency,
                    },
                )
            return mkt_outcome, mkt_org

    return None


def _try_handle_h31_charge_refunded(
    *,
    event_id: str,
    occurred_at: datetime,
    pi_id: str,
    charge_id: str | None,
    amount_refunded: int,
    currency: str,
    already_recorded_event: bool = False,
    meta: Mapping[str, Any] | None = None,
) -> tuple[str, UUID | None] | None:
    from django.apps import apps as django_apps

    from .. import boosts, vip_connect

    boost = WorkspaceBoostGrant.objects.filter(stripe_payment_intent_id=pi_id).first()
    if boost is not None:
        if not direct_checkout_binding_matches_runtime(
            boost.stripe_account_id, boost.stripe_livemode
        ):
            return "mismatch", boost.organisation_id
        if (
            currency != boost.currency
            or amount_refunded <= 0
            or amount_refunded > boost.gross_amount_minor
        ):
            return "mismatch", boost.organisation_id
        if not already_recorded_event:
            _record_applied_refund_event(
                event_id=event_id,
                payment_ref=pi_id,
                amount_refunded=amount_refunded,
                currency=currency,
                occurred_at=occurred_at,
            )
        try:
            updated_grant, note, _ = boosts.refund_boost_grant(
                grant_id=boost.id,
                cumulative_refunded_gross_minor=amount_refunded,
                refunded_at=occurred_at,
            )
        except boosts.BoostValidationError:
            events.record(
                "payment.reconciliation_mismatch",
                actor=SYSTEM,
                organisation_id=boost.organisation_id,
                target=("boost_grant", boost.id),
                metadata={
                    "provider": "stripe",
                    "event_id": event_id,
                    "charge_id": charge_id or "",
                    "payment_intent": pi_id,
                    "amount_refunded_minor": amount_refunded,
                    "reason": "incoherent_boost_refund_amount",
                },
            )
            return "mismatch", boost.organisation_id
        applied = note is not None or (
            boost.invoice_id is None and updated_grant.refunded_gross_minor == amount_refunded
        )
        return ("applied" if applied else "ignored"), boost.organisation_id

    vip = VipMembershipEntitlement.objects.filter(stripe_payment_intent_id=pi_id).first()
    if vip is not None:
        if not connect_checkout_binding_matches_runtime(vip.stripe_account_id, vip.stripe_livemode):
            return "mismatch", vip.organisation_id
        if (
            currency != vip.currency
            or amount_refunded <= 0
            or amount_refunded > vip.total_incl_vat_minor
        ):
            return "mismatch", vip.organisation_id
        if not already_recorded_event:
            _record_applied_refund_event(
                event_id=event_id,
                payment_ref=pi_id,
                amount_refunded=amount_refunded,
                currency=currency,
                occurred_at=occurred_at,
            )
        try:
            _, entry, _ = vip_connect.refund_vip_entitlement(
                entitlement_id=vip.id,
                stripe_event_id=event_id,
                charge_id=charge_id or pi_id,
                cumulative_refunded_incl_vat_minor=amount_refunded,
                occurred_at=occurred_at,
            )
        except boosts.BoostValidationError:
            return "mismatch", vip.organisation_id
        return ("applied" if entry is not None else "ignored"), vip.organisation_id

    if django_apps.is_installed("apps.extensions"):
        from apps.extensions import marketplace as extension_marketplace

        has_meta_mkt = _has_nonempty_key(
            meta, "kodera_marketplace_entitlement_id", "marketplace_entitlement_id"
        )
        meta_mkt_id = _extract_uuid(
            meta, "kodera_marketplace_entitlement_id", "marketplace_entitlement_id"
        )
        mkt_ref = extension_marketplace.try_revoke_stripe_marketplace_entitlement(
            payment_intent_id=pi_id,
            amount_minor=amount_refunded,
            currency=currency,
            occurred_at=occurred_at,
            terminal_state="refunded",
            meta_entitlement_id=meta_mkt_id,
            has_meta_entitlement=has_meta_mkt,
        )
        if mkt_ref is not None:
            mkt_outcome, mkt_org, mkt_id = mkt_ref
            if mkt_outcome != "mismatch" and not already_recorded_event:
                _record_applied_refund_event(
                    event_id=event_id,
                    payment_ref=pi_id,
                    amount_refunded=amount_refunded,
                    currency=currency,
                    occurred_at=occurred_at,
                )
            if mkt_outcome == "applied" and mkt_id is not None:
                events.record(
                    "payment.refunded",
                    actor=SYSTEM,
                    organisation_id=mkt_org,
                    target=("marketplace_entitlement", mkt_id),
                    metadata={
                        "provider": "stripe",
                        "event_id": event_id,
                        "charge_id": charge_id or "",
                        "payment_intent": pi_id,
                        "amount_refunded_minor": amount_refunded,
                        "currency": currency,
                    },
                )
            return mkt_outcome, mkt_org

    return None


def _try_handle_h31_charge_disputed(
    *,
    event_id: str,
    occurred_at: datetime,
    pi_id: str,
    dispute_id: str,
    raw_amount: int,
    currency: str,
    meta: Mapping[str, Any] | None = None,
    raw_fee: Any = None,
) -> tuple[str, UUID | None] | None:
    from django.apps import apps as django_apps

    from .. import boosts, vip_connect

    vip = VipMembershipEntitlement.objects.filter(stripe_payment_intent_id=pi_id).first()
    if vip is not None:
        if not connect_checkout_binding_matches_runtime(vip.stripe_account_id, vip.stripe_livemode):
            return "mismatch", vip.organisation_id
        if currency != vip.currency or raw_amount > vip.total_incl_vat_minor:
            return "mismatch", vip.organisation_id
        dispute_fee = (
            int(raw_fee)
            if isinstance(raw_fee, int) and not isinstance(raw_fee, bool) and raw_fee >= 0
            else vip_connect.DEFAULT_STRIPE_DISPUTE_FEE_MINOR
        )
        vip_connect.record_vip_dispute_created(
            entitlement_id=vip.id,
            stripe_event_id=event_id,
            dispute_id=dispute_id,
            dispute_fee_minor=dispute_fee,
            occurred_at=occurred_at,
        )
        return "applied", vip.organisation_id

    boost = WorkspaceBoostGrant.objects.filter(stripe_payment_intent_id=pi_id).first()
    if boost is not None:
        if not direct_checkout_binding_matches_runtime(
            boost.stripe_account_id, boost.stripe_livemode
        ):
            return "mismatch", boost.organisation_id
        if currency != boost.currency or raw_amount > boost.gross_amount_minor:
            return "mismatch", boost.organisation_id
        boosts.dispute_boost_grant(
            grant_id=boost.id,
            dispute_id=dispute_id,
            occurred_at=occurred_at,
        )
        return "applied", boost.organisation_id

    if django_apps.is_installed("apps.extensions"):
        from apps.extensions import marketplace as extension_marketplace

        has_meta_mkt = _has_nonempty_key(
            meta, "kodera_marketplace_entitlement_id", "marketplace_entitlement_id"
        )
        meta_mkt_id = _extract_uuid(
            meta, "kodera_marketplace_entitlement_id", "marketplace_entitlement_id"
        )
        mkt_disp = extension_marketplace.try_revoke_stripe_marketplace_entitlement(
            payment_intent_id=pi_id,
            amount_minor=raw_amount,
            currency=currency,
            occurred_at=occurred_at,
            terminal_state="revoked",
            meta_entitlement_id=meta_mkt_id,
            has_meta_entitlement=has_meta_mkt,
        )
        if mkt_disp is not None:
            mkt_outcome, mkt_org, mkt_id = mkt_disp
            if mkt_outcome == "applied" and mkt_id is not None:
                events.record(
                    "payment.refunded",
                    actor=SYSTEM,
                    organisation_id=mkt_org,
                    target=("marketplace_entitlement", mkt_id),
                    metadata={
                        "provider": "stripe",
                        "event_id": event_id,
                        "dispute_id": dispute_id,
                        "payment_intent": pi_id,
                        "amount_minor": raw_amount,
                        "currency": currency,
                    },
                )
            return mkt_outcome, mkt_org

    return None


def _handle_charge_dispute_created(
    *,
    event_id: str,
    occurred_at: datetime,
    data_obj: Mapping[str, Any],
) -> tuple[str, UUID | None]:
    raw_dispute_id = data_obj.get("id")
    raw_pi = data_obj.get("payment_intent")
    raw_amount = data_obj.get("amount")
    raw_currency = data_obj.get("currency")
    raw_status = str(data_obj.get("status", ""))

    dispute_id = (
        raw_dispute_id.strip()
        if isinstance(raw_dispute_id, str) and raw_dispute_id.strip()
        else None
    )
    pi_id = raw_pi.strip() if isinstance(raw_pi, str) and raw_pi.strip() else None
    if (
        dispute_id is None
        or pi_id is None
        or isinstance(raw_amount, bool)
        or not isinstance(raw_amount, int)
        or raw_amount <= 0
        or not isinstance(raw_currency, str)
        or len(raw_currency.strip()) != 3
    ):
        raise StripeWebhookMalformedError("invalid-event-object")

    if raw_status.startswith("warning_"):
        return "ignored", None

    currency = raw_currency.strip().upper()
    meta = _metadata_of(data_obj)
    _lock_stripe_payment_ref(pi_id)

    h31_disp = _try_handle_h31_charge_disputed(
        event_id=event_id,
        occurred_at=occurred_at,
        pi_id=pi_id,
        dispute_id=dispute_id,
        raw_amount=raw_amount,
        currency=currency,
        meta=meta,
        raw_fee=data_obj.get("dispute_fee_minor"),
    )
    if h31_disp is not None:
        return h31_disp

    existing_payment = Payment.objects.filter(provider="stripe", provider_ref=pi_id).first()
    if existing_payment is None:
        meta_mismatch = _validate_deferrable_metadata(meta, data_obj)
        if meta_mismatch is not None:
            events.record(
                "payment.reconciliation_mismatch",
                actor=SYSTEM,
                organisation_id=None,
                target=("payment", f"stripe:{pi_id}"),
                metadata={
                    "provider": "stripe",
                    "event_id": event_id,
                    "dispute_id": dispute_id,
                    "payment_intent": pi_id,
                    "reason": meta_mismatch,
                },
            )
            return "mismatch", None

        total_deferred = ProviderEventRecord.objects.filter(
            provider="stripe", outcome="deferred"
        ).count()
        per_payment_deferred = ProviderEventRecord.objects.filter(
            provider="stripe", payment_ref=pi_id, outcome="deferred"
        ).count()
        if (
            total_deferred >= MAX_DEFERRED_STRIPE_REFUNDS
            or per_payment_deferred >= MAX_DEFERRED_PER_PAYMENT
        ):
            return "mismatch", None

        encoded_ctx = _encode_deferred_refund_context(
            charge_id=dispute_id,
            meta=meta,
            data_obj=data_obj,
            event_kind="dispute",
        )
        with connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO billing_providerevent"
                " (id, provider, event_id, kind, payment_ref, link_ref, customer_ref,"
                " amount_minor, currency, occurred_at, outcome)"
                " VALUES (%s, 'stripe', %s, 'payment.reversed', %s, %s, NULL, %s, %s, %s, 'deferred')"
                " ON CONFLICT (provider, event_id) DO NOTHING",
                [new_uuid7(), event_id, pi_id, encoded_ctx, raw_amount, currency, occurred_at],
            )
        return "deferred", None

    invoice = Invoice.objects.select_for_update().get(id=existing_payment.invoice_id)
    if existing_payment.payment_link_id is not None:
        bound_link = PaymentLink.objects.filter(id=existing_payment.payment_link_id).first()
        if bound_link is not None and not direct_checkout_binding_matches_runtime(
            bound_link.stripe_account_id, bound_link.stripe_livemode
        ):
            return "mismatch", existing_payment.organisation_id
    reconciled = reconcile(
        provider_name="stripe",
        event=PortEvent(
            event_id=event_id,
            kind="payment.reversed",
            payment_ref=pi_id,
            link_ref=None,
            amount_minor=raw_amount,
            currency=currency,
            occurred_at=occurred_at,
        ),
        drain_deferred=False,
    )
    invoice.refresh_from_db()
    if effective_owed_minor(invoice) > 0:
        _sync_reversed_subscription(invoice=invoice)
    return ("applied" if reconciled == "duplicate" else reconciled), invoice.organisation_id


class OfflineWebhookDeduplicator:
    """In-memory signed Stripe webhook verifier + deduplicator for `-m 'not django_db'` tests."""

    def __init__(self, *, webhook_secret: str) -> None:
        self._webhook_secret = webhook_secret
        self._seen_event_ids: dict[str, str] = {}

    def receive(
        self,
        *,
        raw_body: bytes,
        headers: Mapping[str, str],
        handler: Callable[[str, str, datetime, Mapping[str, Any]], str],
        clock: Callable[[], float] = time.time,
    ) -> StripeWebhookReceipt:
        if len(raw_body) > MAX_WEBHOOK_BYTES:
            raise StripeWebhookMalformedError("payload-too-large")
        sig_header = next(
            (val for key, val in headers.items() if key.lower() == SIGNATURE_HEADER.lower()),
            None,
        )
        verify_stripe_signature(
            raw_body=raw_body,
            signature_header=sig_header,
            webhook_secret=self._webhook_secret,
            clock=clock,
        )
        event_id, event_type, livemode, has_livemode, occurred_at, data_obj = _parse_event_envelope(
            raw_body
        )
        _verify_expected_livemode(livemode=livemode, has_livemode=has_livemode)
        if event_id in self._seen_event_ids:
            return StripeWebhookReceipt(
                event_id=event_id,
                event_type=event_type,
                status="duplicate",
            )
        if _is_foreign_project_metadata(data_obj):
            self._seen_event_ids[event_id] = "ignored"
            return StripeWebhookReceipt(
                event_id=event_id,
                event_type=event_type,
                status="ignored",
            )
        if event_type not in G4_COLLECTION_EVENTS:
            self._seen_event_ids[event_id] = "ignored_event_type"
            return StripeWebhookReceipt(
                event_id=event_id,
                event_type=event_type,
                status="ignored_event_type",
            )
        outcome = handler(event_id, event_type, occurred_at, data_obj)
        self._seen_event_ids[event_id] = outcome
        return StripeWebhookReceipt(
            event_id=event_id,
            event_type=event_type,
            status=outcome,
        )
