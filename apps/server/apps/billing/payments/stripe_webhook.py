"""Signed Stripe webhook verification, idempotent deduplication, and subscription sync.

Authenticates strictly via `Stripe-Signature` HMAC-SHA256 (`t=...,v1=...`) with a 300-second
replay window and `hmac.compare_digest` constant-time verification. Deduplicates every event
atomically via `StripeWebhookDelivery.stripe_event_id` (`INSERT ... ON CONFLICT DO NOTHING`)
so re-delivered webhooks return `200` without double-applying state mutations.
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
from django.db import connection, transaction

from apps.workspaces.services import sync_subscription_quota
from core.db.ids import new_uuid7

from .. import events
from ..actors import Actor
from ..models import (
    MAX_QUANTITY,
    CapacityTier,
    DunningCase,
    Invoice,
    Order,
    Payment,
    PaymentLink,
    StripeWebhookDelivery,
    Subscription,
)
from ..money import line_amounts
from ..services import set_invoice_state
from ..states import ORDER_TRANSITIONS, PAYMENT_TRANSITIONS, SUBSCRIPTION_TRANSITIONS
from .port import ProviderEvent as PortEvent
from .services import reconcile
from .stripe import SIGNATURE_HEADER, TOLERANCE_S, _translate as translate_port_event

MAX_WEBHOOK_BYTES = 65_536
SYSTEM = Actor("system", None)
_HEX_DIGEST_RE = re.compile(r"[0-9a-fA-F]{64}\Z")
_EVENT_ID_RE = re.compile(r"[A-Za-z0-9_-]{3,255}\Z")
_EVENT_TYPE_RE = re.compile(r"[a-z0-9][a-z0-9._-]{1,127}\Z")


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
) -> tuple[str, str, bool, datetime, dict[str, Any]]:
    try:
        decoded = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise StripeWebhookMalformedError("invalid-json") from exc
    if not isinstance(decoded, dict):
        raise StripeWebhookMalformedError("event-not-object")

    event_id = decoded.get("id")
    event_type = decoded.get("type")
    created = decoded.get("created")
    livemode = decoded.get("livemode", False)
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

    obj = data.get("object")
    if not isinstance(obj, dict):
        raise StripeWebhookMalformedError("invalid-event-object")
    try:
        occurred_at = datetime.fromtimestamp(created, UTC)
    except (OverflowError, OSError, ValueError) as exc:
        raise StripeWebhookMalformedError("invalid-event-timestamp") from exc
    return event_id, event_type, livemode, occurred_at, obj


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


def _metadata_of(data_obj: Mapping[str, Any]) -> Mapping[str, Any]:
    meta = data_obj.get("metadata")
    if isinstance(meta, Mapping):
        return meta
    sub_details = data_obj.get("subscription_details")
    if isinstance(sub_details, Mapping):
        nested = sub_details.get("metadata")
        if isinstance(nested, Mapping):
            return nested
    return {}


def _positive_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 1:
        return value
    if isinstance(value, str) and value.isdigit():
        parsed = int(value)
        return parsed if parsed >= 1 else None
    return None


def _resolve_seat_quota(subscription: Subscription, meta: Mapping[str, Any]) -> int:
    explicit_seats = _positive_int(meta.get("seats"))
    if explicit_seats is not None:
        return explicit_seats
    tier_seats = (
        CapacityTier.objects.filter(code=subscription.capacity_tier_code)
        .values_list("seats_included", flat=True)
        .first()
    )
    if tier_seats is not None and tier_seats >= 1:
        return int(tier_seats) * int(subscription.quantity)
    return int(subscription.quantity)


def _lock_subscription(data_obj: Mapping[str, Any]) -> Subscription | None:
    meta = _metadata_of(data_obj)
    sub_id = _extract_uuid(meta, "core_subscription_id", "subscription_id")
    if sub_id is not None:
        found = Subscription.objects.select_for_update().filter(id=sub_id).first()
        if found is not None:
            return found

    inv_id = _extract_uuid(meta, "core_invoice_id", "invoice_id") or _extract_uuid(
        data_obj, "client_reference_id"
    )
    if inv_id is not None:
        invoice = Invoice.objects.filter(id=inv_id).first()
        if invoice is not None and invoice.subscription_id is not None:
            found = (
                Subscription.objects.select_for_update().filter(id=invoice.subscription_id).first()
            )
            if found is not None:
                return found

    org_id = _extract_uuid(meta, "core_organisation_id", "organisation_id")
    if org_id is not None:
        active_or_pending = (
            Subscription.objects.select_for_update()
            .filter(organisation_id=org_id)
            .exclude(state="cancelled")
            .order_by("-created_at", "-id")
            .first()
        )
        if active_or_pending is not None:
            return active_or_pending
        return (
            Subscription.objects.select_for_update()
            .filter(organisation_id=org_id)
            .order_by("-created_at", "-id")
            .first()
        )
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


def _mark_dunning_past_due(subscription: Subscription) -> None:
    case = DunningCase.objects.select_for_update().filter(subscription=subscription).first()
    if case is None:
        DunningCase.objects.create(subscription=subscription, state="past_due")
    elif case.state == "current":
        case.state = "past_due"
        case.save(update_fields=["state", "updated_at"])


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
    occurred_at: datetime,
    data_obj: Mapping[str, Any],
) -> tuple[str, UUID | None]:
    outcome = "unmatched"
    organisation_id: UUID | None = None

    # 1. Reconcile Core invoice/payment-link Checkout sessions when applicable.
    session_id = data_obj.get("id")
    has_known_link = (
        isinstance(session_id, str)
        and PaymentLink.objects.filter(provider="stripe", provider_ref=session_id).exists()
    )
    port_event: PortEvent | None = None
    if has_known_link or data_obj.get("payment_intent"):
        try:
            port_event = translate_port_event(
                "checkout.session.completed", event_id, occurred_at, data_obj
            )
        except (KeyError, TypeError, ValueError):
            port_event = None
    if port_event is not None and has_known_link:
        outcome = reconcile(provider_name="stripe", event=port_event)

    # 2. Synchronize workspace subscription and seat quota when session names a subscription/org.
    subscription = _lock_subscription(data_obj)
    if subscription is not None:
        organisation_id = subscription.organisation_id
        meta = _metadata_of(data_obj)
        paid = data_obj.get("payment_status") in ("paid", "no_payment_required")
        if paid and "active" in SUBSCRIPTION_TRANSITIONS.get(subscription.state, frozenset()):
            subscription.state = "active"
            subscription.save(update_fields=["state", "updated_at"])
        if subscription.state == "active":
            _clear_dunning_if_needed(subscription, event_id)
            sync_subscription_quota(
                organisation_id=subscription.organisation_id,
                policy_ref=f"subscription:{subscription.plan_code}:active",
                seats=_resolve_seat_quota(subscription, meta),
            )
        if outcome == "unmatched":
            outcome = "applied"
    elif outcome != "unmatched":
        link = (
            PaymentLink.objects.filter(provider="stripe", provider_ref=str(session_id)).first()
            if isinstance(session_id, str)
            else None
        )
        if link is not None:
            organisation_id = link.organisation_id

    return outcome, organisation_id


def _handle_checkout_expired(
    *,
    data_obj: Mapping[str, Any],
) -> tuple[str, UUID | None]:
    session_id = data_obj.get("id")
    if not isinstance(session_id, str) or not session_id.strip():
        raise StripeWebhookMalformedError("invalid-event-object")

    meta = _metadata_of(data_obj)
    link = (
        PaymentLink.objects.select_for_update()
        .filter(provider="stripe", provider_ref=session_id.strip())
        .first()
    )
    if link is not None:
        if link.state == "active":
            link.state = "expired"
            link.save(update_fields=["state", "updated_at"])
            return "applied", link.organisation_id
        return "ignored", link.organisation_id

    inv_id = _extract_uuid(meta, "core_invoice_id", "invoice_id") or _extract_uuid(
        data_obj, "client_reference_id"
    )
    if inv_id is not None:
        org_from_inv = (
            Invoice.objects.filter(id=inv_id).values_list("organisation_id", flat=True).first()
        )
        if org_from_inv is not None:
            return "ignored", org_from_inv

    return "ignored", _extract_uuid(meta, "core_organisation_id", "organisation_id")


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

    known_invoice_id = (
        Payment.objects.filter(provider="stripe", provider_ref=pi_id)
        .values_list("invoice_id", flat=True)
        .first()
    )
    inv_id = known_invoice_id or _extract_uuid(meta, "core_invoice_id", "invoice_id")
    if inv_id is None:
        org_id = _extract_uuid(meta, "core_organisation_id", "organisation_id")
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=org_id,
            target=("payment", f"stripe:{pi_id}"),
            metadata={
                "provider": "stripe",
                "event_id": event_id,
                "reason": "unknown_payment",
            },
        )
        return "unmatched", org_id

    # Lock Invoice before Payment, matching apps.billing.payments.services._locate lock order.
    invoice = Invoice.objects.select_for_update().filter(id=inv_id).first()
    if invoice is None:
        org_id = _extract_uuid(meta, "core_organisation_id", "organisation_id")
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=org_id,
            target=("payment", f"stripe:{pi_id}"),
            metadata={
                "provider": "stripe",
                "event_id": event_id,
                "reason": "unknown_invoice",
            },
        )
        return "unmatched", org_id

    organisation_id = invoice.organisation_id
    payment = (
        Payment.objects.select_for_update().filter(provider="stripe", provider_ref=pi_id).first()
    )

    # Already settled (e.g. checkout.session.completed ran first): reconcile reference
    # idempotently without double-marking or mutating the paid Factur-X 380 invoice or order.
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

    link = (
        PaymentLink.objects.filter(id=payment.payment_link_id).first()
        if payment is not None and payment.payment_link_id is not None
        else (
            PaymentLink.objects.filter(
                provider="stripe",
                invoice=invoice,
                state__in=("active", "used"),
            )
            .order_by("-created_at", "-id")
            .first()
            or PaymentLink.objects.filter(provider="stripe", invoice=invoice)
            .order_by("-created_at", "-id")
            .first()
        )
    )

    if link is not None:
        reconciled = reconcile(
            provider_name="stripe",
            event=PortEvent(
                event_id=event_id,
                kind="payment.succeeded",
                payment_ref=pi_id,
                link_ref=link.provider_ref,
                amount_minor=raw_amount,
                currency=currency,
                occurred_at=occurred_at,
                customer_ref=customer_ref,
            ),
        )
        outcome = "applied" if reconciled == "duplicate" else reconciled
    else:
        owed_minor = invoice.total_incl_vat_minor - invoice.amount_paid_minor
        if invoice.state not in ("issued", "overdue") or (raw_amount, currency) != (
            owed_minor,
            invoice.currency,
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
                    "reason": "amount_or_state",
                },
            )
            return "mismatch", organisation_id

        if payment is None:
            payment = Payment.objects.create(
                organisation_id=organisation_id,
                invoice=invoice,
                payment_link=None,
                provider="stripe",
                provider_ref=pi_id,
                state="succeeded",
                amount_minor=raw_amount,
                currency=currency,
                last_event_at=occurred_at,
                provider_customer_ref=customer_ref,
                allocated=True,
            )
        else:
            payment.state = "succeeded"
            payment.last_event_at = occurred_at
            payment.allocated = True
            if customer_ref is not None:
                payment.provider_customer_ref = customer_ref
            payment.save(
                update_fields=[
                    "state",
                    "last_event_at",
                    "allocated",
                    "provider_customer_ref",
                    "updated_at",
                ]
            )
        events.record(
            "payment.received",
            actor=SYSTEM,
            organisation_id=organisation_id,
            target=("payment", payment.id),
            metadata={
                "provider": "stripe",
                "event_id": event_id,
                "invoice_id": str(invoice.id),
                "amount_minor": raw_amount,
            },
        )
        invoice.amount_paid_minor += raw_amount
        invoice.save(update_fields=["amount_paid_minor", "updated_at"])
        set_invoice_state(invoice, "paid", actor=SYSTEM)
        order = Order.objects.select_for_update().filter(invoices=invoice).first()
        if order is not None and "paid" in ORDER_TRANSITIONS.get(order.state, frozenset()):
            order.state = "paid"
            order.save(update_fields=["state", "updated_at"])
        outcome = "applied"

    if invoice.subscription_id is not None:
        subscription = (
            Subscription.objects.select_for_update().filter(id=invoice.subscription_id).first()
        )
        if subscription is not None:
            if outcome == "applied" and "active" in SUBSCRIPTION_TRANSITIONS.get(
                subscription.state, frozenset()
            ):
                subscription.state = "active"
                subscription.save(update_fields=["state", "updated_at"])
            if subscription.state == "active":
                _clear_dunning_if_needed(subscription, event_id)
                sync_subscription_quota(
                    organisation_id=subscription.organisation_id,
                    policy_ref=f"subscription:{subscription.plan_code}:active",
                    seats=_resolve_seat_quota(subscription, meta),
                )

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
    payment = (
        Payment.objects.select_for_update().filter(provider="stripe", provider_ref=pi_id).first()
        if pi_id is not None
        else None
    )
    inv_id = (
        payment.invoice_id
        if payment is not None
        else _extract_uuid(meta, "core_invoice_id", "invoice_id")
    )
    # Read-only lookup: issued/paid Factur-X 380 invoices in Core are never mutated on refund.
    invoice = Invoice.objects.filter(id=inv_id).first() if inv_id is not None else None

    if payment is not None:
        organisation_id = payment.organisation_id
        if payment.state == "reversed":
            return "ignored", organisation_id
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
            return "mismatch", organisation_id

        is_full_refund = amount_refunded == payment.amount_minor
        if is_full_refund and "reversed" in PAYMENT_TRANSITIONS.get(payment.state, frozenset()):
            payment.state = "reversed"
            payment.last_event_at = occurred_at
            payment.save(update_fields=["state", "last_event_at", "updated_at"])
        elif payment.last_event_at is None or occurred_at > payment.last_event_at:
            payment.last_event_at = occurred_at
            payment.save(update_fields=["last_event_at", "updated_at"])

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
                "currency": currency,
                "partial": not is_full_refund,
            },
        )
        return "applied", organisation_id

    if invoice is not None:
        if currency != invoice.currency or amount_refunded <= 0:
            events.record(
                "payment.reconciliation_mismatch",
                actor=SYSTEM,
                organisation_id=invoice.organisation_id,
                target=("invoice", invoice.id),
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
            return "mismatch", invoice.organisation_id

        events.record(
            "payment.refunded",
            actor=SYSTEM,
            organisation_id=invoice.organisation_id,
            target=("invoice", invoice.id),
            metadata={
                "provider": "stripe",
                "event_id": event_id,
                "charge_id": charge_id or "",
                "payment_intent": pi_id or "",
                "invoice_id": str(invoice.id),
                "amount_refunded_minor": amount_refunded,
                "currency": currency,
            },
        )
        return "applied", invoice.organisation_id

    org_id = _extract_uuid(meta, "core_organisation_id", "organisation_id")
    events.record(
        "payment.reconciliation_mismatch",
        actor=SYSTEM,
        organisation_id=org_id,
        target=("payment", f"stripe:{pi_id or charge_id}"),
        metadata={
            "provider": "stripe",
            "event_id": event_id,
            "reason": "unknown_payment",
        },
    )
    return "unmatched", org_id


def _extract_stripe_subscription_quantity(data_obj: Mapping[str, Any]) -> int | None:
    direct = _positive_int(data_obj.get("quantity"))
    if direct is not None and direct <= MAX_QUANTITY:
        return direct
    items = data_obj.get("items")
    if isinstance(items, Mapping):
        rows = items.get("data")
        if isinstance(rows, list) and rows and isinstance(rows[0], Mapping):
            nested = _positive_int(rows[0].get("quantity"))
            if nested is not None and nested <= MAX_QUANTITY:
                return nested
    return None


def _handle_subscription_updated(
    *,
    event_id: str,
    occurred_at: datetime,
    data_obj: Mapping[str, Any],
) -> tuple[str, UUID | None]:
    subscription = _lock_subscription(data_obj)
    if subscription is None:
        return "unmatched", None

    meta = _metadata_of(data_obj)
    stripe_status = str(data_obj.get("status") or "").strip().lower()
    status_map = {
        "active": "active",
        "trialing": "active",
        "past_due": "past_due",
        "unpaid": "past_due",
        "paused": "suspended",
        "canceled": "cancelled",
        "incomplete_expired": "cancelled",
    }
    target_state = status_map.get(stripe_status)
    changed_fields: list[str] = []

    cancel_at_end = data_obj.get("cancel_at_period_end")
    if isinstance(cancel_at_end, bool) and subscription.cancel_at_period_end != cancel_at_end:
        subscription.cancel_at_period_end = cancel_at_end
        changed_fields.append("cancel_at_period_end")

    p_start = data_obj.get("current_period_start")
    p_end = data_obj.get("current_period_end")
    if (
        not isinstance(p_start, bool)
        and not isinstance(p_end, bool)
        and isinstance(p_start, int)
        and isinstance(p_end, int)
        and p_end > p_start > 0
    ):
        new_start = datetime.fromtimestamp(p_start, UTC)
        new_end = datetime.fromtimestamp(p_end, UTC)
        if (subscription.current_period_start, subscription.current_period_end) != (
            new_start,
            new_end,
        ):
            subscription.current_period_start = new_start
            subscription.current_period_end = new_end
            changed_fields.extend(["current_period_start", "current_period_end"])

    new_qty = _extract_stripe_subscription_quantity(data_obj)
    if new_qty is not None and new_qty != subscription.quantity:
        recalculated = line_amounts(
            unit_amount_minor=subscription.unit_amount_minor,
            quantity=new_qty,
            vat_rate_bp=subscription.vat_rate_bp,
        )
        subscription.quantity = new_qty
        subscription.total_excl_vat_minor = recalculated.net_minor
        subscription.vat_amount_minor = recalculated.vat_minor
        subscription.total_incl_vat_minor = recalculated.gross_minor
        changed_fields.extend(
            [
                "quantity",
                "total_excl_vat_minor",
                "vat_amount_minor",
                "total_incl_vat_minor",
            ]
        )

    cancelled_now = False
    if target_state is not None and target_state != subscription.state:
        allowed_targets = SUBSCRIPTION_TRANSITIONS.get(subscription.state, frozenset())
        can_pause = subscription.state == "active" and target_state == "suspended"
        if target_state in allowed_targets or can_pause:
            subscription.state = target_state
            changed_fields.append("state")
            if target_state == "cancelled":
                subscription.cancelled_at = occurred_at
                changed_fields.append("cancelled_at")
                cancelled_now = True

    if changed_fields:
        changed_fields.append("updated_at")
        subscription.save(update_fields=list(dict.fromkeys(changed_fields)))

    if cancelled_now:
        events.record(
            "subscription.cancelled",
            actor=SYSTEM,
            organisation_id=subscription.organisation_id,
            target=("subscription", subscription.id),
            metadata={"provider": "stripe", "event_id": event_id},
        )
    elif subscription.state == "active":
        _clear_dunning_if_needed(subscription, event_id)
    elif subscription.state == "past_due":
        _mark_dunning_past_due(subscription)

    seats = (
        0
        if subscription.state in ("cancelled", "suspended")
        else _resolve_seat_quota(subscription, meta)
    )
    sync_subscription_quota(
        organisation_id=subscription.organisation_id,
        policy_ref=f"subscription:{subscription.plan_code}:{subscription.state}",
        seats=seats,
    )
    return "applied", subscription.organisation_id


def _handle_subscription_deleted(
    *,
    event_id: str,
    occurred_at: datetime,
    data_obj: Mapping[str, Any],
) -> tuple[str, UUID | None]:
    subscription = _lock_subscription(data_obj)
    if subscription is None:
        return "unmatched", None

    if subscription.state != "cancelled":
        subscription.state = "cancelled"
        subscription.cancelled_at = occurred_at
        subscription.cancel_at_period_end = False
        subscription.save(
            update_fields=["state", "cancelled_at", "cancel_at_period_end", "updated_at"]
        )
        events.record(
            "subscription.cancelled",
            actor=SYSTEM,
            organisation_id=subscription.organisation_id,
            target=("subscription", subscription.id),
            metadata={"provider": "stripe", "event_id": event_id},
        )

    sync_subscription_quota(
        organisation_id=subscription.organisation_id,
        policy_ref=f"subscription:{subscription.plan_code}:cancelled",
        seats=0,
    )
    return "applied", subscription.organisation_id


def _handle_invoice_payment_failed(
    *,
    event_id: str,
    occurred_at: datetime,
    data_obj: Mapping[str, Any],
) -> tuple[str, UUID | None]:
    meta = _metadata_of(data_obj)
    inv_id = _extract_uuid(meta, "core_invoice_id", "invoice_id")
    invoice = (
        Invoice.objects.select_for_update().filter(id=inv_id).first()
        if inv_id is not None
        else None
    )
    subscription = _lock_subscription(data_obj)
    if subscription is None and invoice is not None and invoice.subscription_id is not None:
        subscription = (
            Subscription.objects.select_for_update().filter(id=invoice.subscription_id).first()
        )

    if invoice is None and subscription is None:
        return "unmatched", None

    organisation_id = (
        subscription.organisation_id if subscription is not None else invoice.organisation_id  # type: ignore[union-attr]
    )

    if (
        invoice is not None
        and invoice.state == "issued"
        and invoice.due_at is not None
        and invoice.due_at <= occurred_at
    ):
        set_invoice_state(invoice, "overdue", actor=SYSTEM)

    if subscription is not None:
        if "past_due" in SUBSCRIPTION_TRANSITIONS.get(subscription.state, frozenset()):
            subscription.state = "past_due"
            subscription.save(update_fields=["state", "updated_at"])
        _mark_dunning_past_due(subscription)
        sync_subscription_quota(
            organisation_id=subscription.organisation_id,
            policy_ref=f"subscription:{subscription.plan_code}:{subscription.state}",
            seats=_resolve_seat_quota(subscription, meta),
        )

    amount_due = data_obj.get("amount_due")
    safe_amount = (
        amount_due
        if not isinstance(amount_due, bool) and isinstance(amount_due, int) and amount_due >= 0
        else 0
    )
    target: tuple[str, UUID | str] = (
        ("invoice", invoice.id) if invoice is not None else ("subscription", subscription.id)  # type: ignore[union-attr]
    )
    events.record(
        "payment.failed",
        actor=SYSTEM,
        organisation_id=organisation_id,
        target=target,
        metadata={
            "provider": "stripe",
            "event_id": event_id,
            "amount_minor": safe_amount,
        },
    )
    return "applied", organisation_id


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
    event_id, event_type, livemode, occurred_at, data_obj = _parse_event_envelope(raw_body)
    expected_livemode = getattr(settings, "KODERA_STRIPE_EXPECTED_LIVEMODE", None)
    if expected_livemode is not None:
        if not isinstance(expected_livemode, bool):
            raise StripeWebhookSecretMissingError()
        if livemode is not expected_livemode:
            raise StripeWebhookSignatureError("livemode-mismatch")

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
        if event_type == "checkout.session.completed":
            outcome, organisation_id = _handle_checkout_completed(
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
        elif event_type == "customer.subscription.updated":
            outcome, organisation_id = _handle_subscription_updated(
                event_id=event_id,
                occurred_at=occurred_at,
                data_obj=data_obj,
            )
        elif event_type == "customer.subscription.deleted":
            outcome, organisation_id = _handle_subscription_deleted(
                event_id=event_id,
                occurred_at=occurred_at,
                data_obj=data_obj,
            )
        elif event_type == "invoice.payment_failed":
            outcome, organisation_id = _handle_invoice_payment_failed(
                event_id=event_id,
                occurred_at=occurred_at,
                data_obj=data_obj,
            )
        else:
            try:
                port_event = translate_port_event(event_type, event_id, occurred_at, data_obj)
            except (KeyError, TypeError, ValueError) as exc:
                raise StripeWebhookMalformedError("invalid-event-object") from exc
            if port_event is None:
                outcome = "ignored"
            else:
                reconciled = reconcile(provider_name="stripe", event=port_event)
                outcome = "applied" if reconciled == "duplicate" else reconciled

        delivery.outcome = outcome
        delivery.organisation_id = organisation_id
        delivery.save(update_fields=["outcome", "organisation_id"])
        return StripeWebhookReceipt(
            event_id=event_id,
            event_type=event_type,
            status=outcome,
        )
