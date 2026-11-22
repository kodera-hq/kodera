"""Public signed Stripe webhook endpoint (`POST /api/v1/billing/webhooks/stripe`) against PostgreSQL.

Covers:
- Exempt from OIDC bearer tokens; strictly authenticated via `Stripe-Signature` HMAC-SHA256
  (`t=...,v1=...`) with 300-second replay window and constant-time comparison.
- Missing `KODERA_STRIPE_WEBHOOK_SECRET` -> `503 service-unavailable`.
- Missing/malformed `Stripe-Signature` or invalid JSON -> `400 malformed-request`.
- Invalid signature, tampered payload bytes, livemode mismatch, or stale timestamp (`> 300s`) ->
  `401 unauthenticated`.
- Closed 4-event G4 surface (`checkout.session.completed`, `checkout.session.expired`,
  `payment_intent.succeeded`, `charge.refunded`): every other Stripe event type
  (`customer.subscription.*`, `invoice.payment_failed`, etc.) returns `200`
  `{"status": "ignored_event_type"}` with zero Core business-state mutations.
- Strict Core financial binding: `checkout.session.completed` and `payment_intent.succeeded`
  settle only persisted Core `PaymentLink` -> `Invoice` rows with exact amount/currency/org/sub
  invariants, derive seat quotas strictly from `CapacityTier.seats_included * subscription.quantity`
  (never webhook `metadata`), and block stale/same-second out-of-order invoices from clearing
  newer unpaid/overdue dunning.
- Re-delivery of an identical `stripe_event_id` -> `200` `{"status": "duplicate"}` without
  double-applying database mutations or audit rows.
"""

from __future__ import annotations

import hashlib
import hmac
import itertools
import json
import time

import pytest
from django.db import connection
from django.test import Client
from test_billing_orders import offer, place, world

import apps.billing.payments as payments_package
from apps.billing.models import (
    DunningCase,
    Invoice,
    Order,
    Payment,
    PaymentLink,
    StripeWebhookDelivery,
    Subscription,
)
from apps.billing.payments import services as payments
from apps.billing.payments.stripe import StripeProvider
from apps.workspaces.models import Workspace, WorkspaceQuota

pytestmark = pytest.mark.django_db(transaction=True)

WEBHOOK_URL = "/api/v1/billing/webhooks/stripe"
WEBHOOK_ALIAS_URL = "/api/v1/webhooks/stripe"
STRIPE_SECRET = "rk_" + "test_" + "SyntheticNotAKeyWebhook0"
WEBHOOK_SECRET = "wh" + "sec_" + "synthetic-hmac-01"
WRONG_WEBHOOK_SECRET = "wh" + "sec_" + "wrong-secret-01"
WRONG_ALIAS_WEBHOOK_SECRET = "wh" + "sec_" + "wrong-alias-01"
_seq = itertools.count(1)


class _StubStripeTransport:
    def __call__(self, method, url, headers, body):
        idx = next(_seq)
        return (
            200,
            json.dumps(
                {
                    "id": f"cs_test_webhook_{idx}",
                    "url": f"https://checkout.stripe.invalid/c/{idx}",
                    "expires_at": int(time.time()) + 3600,
                }
            ).encode("utf-8"),
        )


@pytest.fixture
def stripe_webhook_world(settings, monkeypatch):
    transport = _StubStripeTransport()
    provider = StripeProvider(
        secret_key=STRIPE_SECRET,
        webhook_secret=WEBHOOK_SECRET,
        transport=transport,
    )
    settings.KODERA_PAYMENT_PROVIDER = "stripe"
    settings.KODERA_STRIPE_SECRET_KEY = STRIPE_SECRET
    settings.KODERA_STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
    settings.KODERA_PAYMENT_RETURN_ORIGINS = frozenset({"https://app.localhost"})
    monkeypatch.setattr(payments_package, "_stripe", lambda secret_key, webhook_secret: provider)

    w = world()
    Workspace.objects.create(organisation=w.organisation)
    placed = place(w, offer(), quantity=10)
    link = payments.create_payment_link(
        invoice_id=placed.invoice.id,
        organisation_id=w.organisation.id,
        return_url="https://app.localhost/billing",
    ).link
    return Client(), w, placed, link


def _sign_stripe_body(
    raw_body: bytes, *, secret: str = WEBHOOK_SECRET, timestamp: int | None = None
) -> str:
    ts = int(time.time()) if timestamp is None else timestamp
    mac = hmac.new(
        secret.encode("utf-8"),
        f"{ts}.".encode("ascii") + raw_body,
        hashlib.sha256,
    ).hexdigest()
    return f"t={ts},v1={mac}"


def _post_webhook(
    client: Client,
    payload: dict[str, object],
    *,
    url: str = WEBHOOK_URL,
    secret: str = WEBHOOK_SECRET,
    timestamp: int | None = None,
    signature_override: str | None = None,
    include_default_api_version: bool = True,
):
    body_payload = (
        {"api_version": "2024-06-20", **payload}
        if include_default_api_version and "api_version" not in payload
        else payload
    )
    raw = json.dumps(body_payload, separators=(",", ":")).encode("utf-8")
    sig = (
        signature_override
        if signature_override is not None
        else _sign_stripe_body(raw, secret=secret, timestamp=timestamp)
    )
    return client.post(
        url,
        data=raw,
        content_type="application/json",
        HTTP_STRIPE_SIGNATURE=sig,
    )


def _audit_count(organisation_id, action: str) -> int:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT COUNT(*) FROM audit_auditevent WHERE organisation_id = %s AND action = %s",
            [organisation_id, action],
        )
        row = cursor.fetchone()
        return 0 if row is None else int(row[0])


def test_webhook_secret_missing_and_signature_refusals(stripe_webhook_world, settings):
    client, _, _, _ = stripe_webhook_world
    sample_event = {
        "id": "evt_sig_guard_001",
        "type": "checkout.session.completed",
        "api_version": "2024-06-20",
        "created": int(time.time()),
        "data": {"object": {"id": "cs_none", "payment_status": "paid"}},
    }

    # 1. Unconfigured webhook secret -> 503
    settings.KODERA_STRIPE_WEBHOOK_SECRET = None
    res_503 = _post_webhook(client, sample_event)
    assert res_503.status_code == 503
    assert res_503.headers["Retry-After"] == "30"
    settings.KODERA_STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET

    # 2. Missing Stripe-Signature header -> 400
    res_missing = client.post(
        WEBHOOK_URL,
        data=json.dumps(sample_event).encode("utf-8"),
        content_type="application/json",
    )
    assert res_missing.status_code == 400

    # 3. Malformed Stripe-Signature header -> 400
    res_malformed = _post_webhook(client, sample_event, signature_override="v1=deadbeef")
    assert res_malformed.status_code == 400

    # 4. Wrong HMAC secret -> 401
    res_wrong_secret = _post_webhook(client, sample_event, secret=WRONG_WEBHOOK_SECRET)
    assert res_wrong_secret.status_code == 401

    # 5. Tampered body bytes with valid signature from original body -> 401
    original_bytes = json.dumps(sample_event).encode("utf-8")
    valid_sig = _sign_stripe_body(original_bytes)
    tampered_bytes = original_bytes.replace(b"paid", b"free")
    res_tampered = client.post(
        WEBHOOK_URL,
        data=tampered_bytes,
        content_type="application/json",
        HTTP_STRIPE_SIGNATURE=valid_sig,
    )
    assert res_tampered.status_code == 401

    # 6. Stale timestamp (> 300s old) -> 401
    stale_ts = int(time.time()) - 305
    res_stale = _post_webhook(client, sample_event, timestamp=stale_ts)
    assert res_stale.status_code == 401

    assert StripeWebhookDelivery.objects.count() == 0


def test_checkout_subscription_lifecycle_quota_sync_and_duplicate_idempotency(
    stripe_webhook_world,
):
    client, w, placed, link = stripe_webhook_world
    org_id = w.organisation.id
    sub_id = placed.subscription.id
    invoice = Invoice.objects.get(id=placed.invoice.id)

    # 1. checkout.session.completed (no OIDC Authorization header!) -> activates subscription + quota + invoice
    checkout_evt = {
        "id": "evt_checkout_0001",
        "type": "checkout.session.completed",
        "created": int(time.time()),
        "data": {
            "object": {
                "id": link.provider_ref,
                "payment_intent": "pi_synth_0001",
                "payment_status": "paid",
                "amount_total": invoice.total_incl_vat_minor,
                "currency": "eur",
                "subscription": "sub_stripe_live_0001",
                "metadata": {
                    "organisation_id": str(org_id),
                    "subscription_id": str(sub_id),
                },
            }
        },
    }
    res_checkout = _post_webhook(client, checkout_evt)
    assert res_checkout.status_code == 200
    assert res_checkout.json() == {
        "received": True,
        "event_id": "evt_checkout_0001",
        "event_type": "checkout.session.completed",
        "status": "applied",
    }

    sub = Subscription.objects.get(id=sub_id)
    assert sub.state == "active"
    assert Order.objects.get(id=placed.order.id).state == "paid"
    assert Invoice.objects.get(id=placed.invoice.id).state == "paid"
    quota = WorkspaceQuota.objects.get(workspace__organisation_id=org_id)
    assert quota.seats == 150 * sub.quantity

    # Re-deliver exact same checkout event -> 200 duplicate, no extra state change
    res_dup = _post_webhook(client, checkout_evt)
    assert res_dup.status_code == 200
    assert res_dup.json()["status"] == "duplicate"
    assert StripeWebhookDelivery.objects.filter(stripe_event_id="evt_checkout_0001").count() == 1

    # 2. Non-G4 Stripe subscription/invoice events are strictly ignored (`ignored_event_type`)
    #    with zero Core mutations and `organisation_id = None` on the delivery row.
    non_g4_events = [
        {
            "id": "evt_sub_updated_0002",
            "type": "customer.subscription.updated",
            "created": int(time.time()) + 10,
            "data": {
                "object": {
                    "id": "sub_stripe_live_0001",
                    "status": "active",
                    "quantity": 24,
                    "cancel_at_period_end": True,
                    "metadata": {
                        "organisation_id": str(org_id),
                        "subscription_id": str(sub_id),
                    },
                }
            },
        },
        {
            "id": "evt_inv_failed_0003",
            "type": "invoice.payment_failed",
            "created": int(time.time()) + 20,
            "data": {
                "object": {
                    "id": "in_stripe_0003",
                    "subscription": "sub_stripe_live_0001",
                    "payment_intent": "pi_failed_0003",
                    "billing_reason": "subscription_cycle",
                    "amount_due": 448_800,
                    "metadata": {
                        "organisation_id": str(org_id),
                        "subscription_id": str(sub_id),
                    },
                }
            },
        },
        {
            "id": "evt_sub_deleted_0004",
            "type": "customer.subscription.deleted",
            "created": int(time.time()) + 30,
            "data": {
                "object": {
                    "id": "sub_stripe_live_0001",
                    "status": "canceled",
                    "metadata": {
                        "organisation_id": str(org_id),
                        "subscription_id": str(sub_id),
                    },
                }
            },
        },
        {
            "id": "evt_unknown_type_0005",
            "type": "customer.created",
            "created": int(time.time()) + 40,
            "data": {"object": {"id": "cus_unknown_0005"}},
        },
    ]
    for evt in non_g4_events:
        res_ignored = _post_webhook(client, evt)
        assert res_ignored.status_code == 200
        assert res_ignored.json() == {
            "received": True,
            "event_id": evt["id"],
            "event_type": evt["type"],
            "status": "ignored_event_type",
        }
        delivery = StripeWebhookDelivery.objects.get(stripe_event_id=evt["id"])
        assert delivery.outcome == "ignored_event_type"
        assert delivery.organisation_id is None

    # Re-delivering an ignored event still deduplicates cleanly by stripe_event_id
    res_ign_dup = _post_webhook(client, non_g4_events[1])
    assert res_ign_dup.status_code == 200
    assert res_ign_dup.json()["status"] == "duplicate"

    sub.refresh_from_db()
    quota.refresh_from_db()
    assert sub.state == "active"
    assert sub.quantity == 10
    assert sub.cancel_at_period_end is False
    assert sub.cancelled_at is None
    assert quota.seats == 150 * 10
    assert DunningCase.objects.filter(subscription_id=sub_id).count() == 0
    assert _audit_count(org_id, "payment.failed") == 0
    assert _audit_count(org_id, "subscription.cancelled") == 0


def test_webhook_alias_route_and_checkout_session_expired(stripe_webhook_world, settings):
    client, w, placed, link = stripe_webhook_world
    org_id = w.organisation.id

    # Alias route `/api/v1/webhooks/stripe` enforces identical HMAC & 503 guards without OIDC auth.
    sample = {
        "id": "evt_alias_guard_01",
        "type": "checkout.session.expired",
        "api_version": "2024-06-20",
        "created": int(time.time()),
        "data": {"object": {"id": link.provider_ref}},
    }
    settings.KODERA_STRIPE_WEBHOOK_SECRET = None
    assert _post_webhook(client, sample, url=WEBHOOK_ALIAS_URL).status_code == 503
    settings.KODERA_STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET

    assert (
        client.post(
            WEBHOOK_ALIAS_URL,
            data=json.dumps(sample).encode("utf-8"),
            content_type="application/json",
        ).status_code
        == 400
    )
    assert (
        _post_webhook(
            client,
            sample,
            url=WEBHOOK_ALIAS_URL,
            secret=WRONG_ALIAS_WEBHOOK_SECRET,
        ).status_code
        == 401
    )
    assert (
        _post_webhook(
            client,
            sample,
            url=WEBHOOK_ALIAS_URL,
            timestamp=int(time.time()) - 305,
        ).status_code
        == 401
    )

    # Valid signed `checkout.session.expired` on alias marks active PaymentLink expired.
    res_exp = _post_webhook(client, sample, url=WEBHOOK_ALIAS_URL)
    assert res_exp.status_code == 200
    assert res_exp.json() == {
        "received": True,
        "event_id": "evt_alias_guard_01",
        "event_type": "checkout.session.expired",
        "status": "applied",
    }
    link.refresh_from_db()
    assert link.state == "expired"
    assert Invoice.objects.get(id=placed.invoice.id).state == "issued"

    # Cross-route deduplication: re-delivering same event_id to canonical URL returns duplicate.
    res_dup = _post_webhook(client, sample, url=WEBHOOK_URL)
    assert res_dup.status_code == 200
    assert res_dup.json()["status"] == "duplicate"

    # Unknown checkout session expires cleanly with 200 unmatched (never 500 or org attribution).
    unknown_exp = {
        "id": "evt_unknown_expired_02",
        "type": "checkout.session.expired",
        "created": int(time.time()),
        "data": {
            "object": {
                "id": "cs_test_unknown_9999",
                "metadata": {"organisation_id": str(org_id)},
            }
        },
    }
    res_unknown = _post_webhook(client, unknown_exp, url=WEBHOOK_ALIAS_URL)
    assert res_unknown.status_code == 200
    assert res_unknown.json()["status"] == "unmatched"
    assert (
        StripeWebhookDelivery.objects.get(stripe_event_id="evt_unknown_expired_02").organisation_id
        is None
    )


def test_g4_payment_intent_succeeded_and_charge_refunded_preserve_facturx_invoice(
    stripe_webhook_world,
):
    client, w, placed, link = stripe_webhook_world
    org_id = w.organisation.id
    sub_id = placed.subscription.id
    invoice_before = Invoice.objects.get(id=placed.invoice.id)
    original_number = invoice_before.number
    original_issued_at = invoice_before.issued_at
    total_minor = invoice_before.total_incl_vat_minor

    # 1. `payment_intent.succeeded` arriving FIRST on `/api/v1/webhooks/stripe` reconciles the
    #    PaymentLink, Invoice, Order, Subscription, and WorkspaceQuota cleanly.
    pi_evt = {
        "id": "evt_pi_succeeded_0001",
        "type": "payment_intent.succeeded",
        "created": int(time.time()),
        "data": {
            "object": {
                "id": "pi_g4_mode_payment_0001",
                "amount": total_minor,
                "amount_received": total_minor,
                "currency": "eur",
                "customer": "cus_g4_0001",
                "status": "succeeded",
                "metadata": {
                    "core_invoice_id": str(invoice_before.id),
                    "organisation_id": str(org_id),
                },
            }
        },
    }
    res_pi = _post_webhook(client, pi_evt, url=WEBHOOK_ALIAS_URL)
    assert res_pi.status_code == 200
    assert res_pi.json() == {
        "received": True,
        "event_id": "evt_pi_succeeded_0001",
        "event_type": "payment_intent.succeeded",
        "status": "applied",
    }

    invoice_paid = Invoice.objects.get(id=invoice_before.id)
    assert invoice_paid.state == "paid"
    assert invoice_paid.amount_paid_minor == total_minor
    assert invoice_paid.number == original_number
    assert invoice_paid.issued_at == original_issued_at
    assert invoice_paid.paid_at is not None
    paid_at_snapshot = invoice_paid.paid_at
    assert Order.objects.get(id=placed.order.id).state == "paid"
    assert Subscription.objects.get(id=sub_id).state == "active"
    assert PaymentLink.objects.get(id=link.id).state == "used"
    assert Invoice.objects.filter(organisation_id=org_id).count() == 1
    assert _audit_count(org_id, "invoice.paid") == 1

    # 2. `checkout.session.completed` arriving AFTER `payment_intent.succeeded` does NOT
    #    double-mark or double-increment `amount_paid_minor`.
    cs_after_evt = {
        "id": "evt_cs_after_pi_0002",
        "type": "checkout.session.completed",
        "created": int(time.time()) + 2,
        "data": {
            "object": {
                "id": link.provider_ref,
                "payment_intent": "pi_g4_mode_payment_0001",
                "payment_status": "paid",
                "amount_total": total_minor,
                "currency": "eur",
                "metadata": {
                    "organisation_id": str(org_id),
                    "subscription_id": str(sub_id),
                },
            }
        },
    }
    res_cs = _post_webhook(client, cs_after_evt, url=WEBHOOK_ALIAS_URL)
    assert res_cs.status_code == 200
    invoice_after_cs = Invoice.objects.get(id=invoice_before.id)
    assert invoice_after_cs.amount_paid_minor == total_minor
    assert invoice_after_cs.paid_at == paid_at_snapshot
    assert _audit_count(org_id, "invoice.paid") == 1

    # 3. Another `payment_intent.succeeded` delivery on an already-paid invoice reconciles
    #    reference idempotently (`ignored` + `payment.reconciled`) without mutating Invoice/Order.
    pi_late_evt = {
        "id": "evt_pi_late_reconcile_0003",
        "type": "payment_intent.succeeded",
        "created": int(time.time()) + 4,
        "data": {
            "object": {
                "id": "pi_g4_mode_payment_0001",
                "amount": total_minor,
                "amount_received": total_minor,
                "currency": "eur",
                "customer": "cus_g4_0001",
                "metadata": {"core_invoice_id": str(invoice_before.id)},
            }
        },
    }
    res_pi_late = _post_webhook(client, pi_late_evt, url=WEBHOOK_URL)
    assert res_pi_late.status_code == 200
    assert res_pi_late.json()["status"] == "ignored"
    assert _audit_count(org_id, "payment.reconciled") == 1
    assert _audit_count(org_id, "invoice.paid") == 1

    # 4. `charge.refunded` records `payment.refunded` audit event & marks Payment `reversed`
    #    WITHOUT mutating the immutable Factur-X 380 Invoice!
    refund_evt = {
        "id": "evt_charge_refunded_0004",
        "type": "charge.refunded",
        "created": int(time.time()) + 10,
        "data": {
            "object": {
                "id": "ch_g4_0004",
                "payment_intent": "pi_g4_mode_payment_0001",
                "amount": total_minor,
                "amount_refunded": total_minor,
                "currency": "eur",
                "refunded": True,
                "metadata": {"core_invoice_id": str(invoice_before.id)},
            }
        },
    }
    res_ref = _post_webhook(client, refund_evt, url=WEBHOOK_ALIAS_URL)
    assert res_ref.status_code == 200
    assert res_ref.json() == {
        "received": True,
        "event_id": "evt_charge_refunded_0004",
        "event_type": "charge.refunded",
        "status": "applied",
    }

    payment_row = Payment.objects.get(provider="stripe", provider_ref="pi_g4_mode_payment_0001")
    assert payment_row.state == "reversed"
    assert _audit_count(org_id, "payment.refunded") == 1

    # Statutory Factur-X 380 accounting fields stay immutable while collection state reopens.
    invoice_after_refund = Invoice.objects.get(id=invoice_before.id)
    assert invoice_after_refund.state == "issued"
    assert invoice_after_refund.number == original_number
    assert invoice_after_refund.issued_at == original_issued_at
    assert invoice_after_refund.paid_at is None
    assert invoice_after_refund.total_excl_vat_minor == invoice_before.total_excl_vat_minor
    assert invoice_after_refund.vat_amount_minor == invoice_before.vat_amount_minor
    assert invoice_after_refund.total_incl_vat_minor == total_minor
    assert invoice_after_refund.amount_paid_minor == 0

    # Re-delivering `charge.refunded` (same event_id AND distinct event_id) writes no extra audit row.
    res_ref_dup = _post_webhook(client, refund_evt, url=WEBHOOK_URL)
    assert res_ref_dup.status_code == 200
    assert res_ref_dup.json()["status"] == "duplicate"
    assert _audit_count(org_id, "payment.refunded") == 1

    refund_evt_second_id = {**refund_evt, "id": "evt_charge_refunded_0005"}
    res_ref_ignored = _post_webhook(client, refund_evt_second_id, url=WEBHOOK_ALIAS_URL)
    assert res_ref_ignored.status_code == 200
    assert res_ref_ignored.json()["status"] == "ignored"
    assert _audit_count(org_id, "payment.refunded") == 1


def test_webhook_livemode_guard_rejects_mismatched_mode_before_db_write(
    stripe_webhook_world, settings
):
    client, _, _, link = stripe_webhook_world
    settings.KODERA_STRIPE_EXPECTED_LIVEMODE = True

    test_mode_evt = {
        "id": "evt_livemode_guard_test_01",
        "type": "checkout.session.expired",
        "livemode": False,
        "created": int(time.time()),
        "data": {"object": {"id": link.provider_ref}},
    }
    res_rejected = _post_webhook(client, test_mode_evt, url=WEBHOOK_URL)
    assert res_rejected.status_code == 401
    assert res_rejected.headers["WWW-Authenticate"] == "Stripe-Signature"
    assert (
        StripeWebhookDelivery.objects.filter(stripe_event_id="evt_livemode_guard_test_01").count()
        == 0
    )

    live_mode_evt = {
        **test_mode_evt,
        "id": "evt_livemode_guard_live_02",
        "livemode": True,
    }
    res_accepted = _post_webhook(client, live_mode_evt, url=WEBHOOK_URL)
    assert res_accepted.status_code == 200
    assert res_accepted.json()["status"] == "applied"
    assert (
        StripeWebhookDelivery.objects.filter(stripe_event_id="evt_livemode_guard_live_02").count()
        == 1
    )


def test_stripe_checkout_session_never_enables_invoice_creation():
    """G4 §6: Stripe Checkout runs strictly in `mode=payment` without `invoice_creation`,
    preserving Kodera Core as sole Factur-X EN 16931 (`380`/`381`) legal invoice authority."""
    import urllib.parse
    from datetime import UTC, datetime, timedelta
    from uuid import uuid4

    from apps.billing.payments.port import LinkRequest

    captured_calls: list[tuple[str, str, dict[str, list[str]]]] = []

    def capturing_transport(method, url, headers, body):
        parsed = urllib.parse.parse_qs(body.decode("utf-8"), keep_blank_values=True)
        captured_calls.append((method, url, parsed))
        return (
            200,
            json.dumps(
                {
                    "id": "cs_test_g4_no_invoice_01",
                    "url": "https://checkout.stripe.invalid/c/g4",
                    "expires_at": int(time.time()) + 3600,
                }
            ).encode("utf-8"),
        )

    provider = StripeProvider(
        secret_key=STRIPE_SECRET,
        webhook_secret=WEBHOOK_SECRET,
        transport=capturing_transport,
    )
    provider.create_link(
        LinkRequest(
            invoice_id=uuid4(),
            invoice_number="KODERA-2026-00042",
            amount_minor=180_000,
            currency="EUR",
            expires_at=datetime.now(UTC) + timedelta(hours=2),
            return_url="https://app.localhost/billing",
            locale="fr",
        )
    )
    assert len(captured_calls) == 1
    method, url, params = captured_calls[0]
    assert method == "POST"
    assert url.endswith("/v1/checkout/sessions")
    assert params.get("mode") == ["payment"]
    assert not any(key.startswith("invoice_creation") for key in params)


def test_checkout_session_completed_strict_core_financial_binding_and_metadata_spoof_refusal(
    stripe_webhook_world,
):
    """G4 P1: signed `checkout.session.completed` never activates a subscription, clears dunning,
    or derives `WorkspaceQuota.seats` from webhook `metadata` unless bound to a persisted Core
    `PaymentLink` -> `Invoice` with matching amount, currency, org, invoice, subscription, and
    customer invariants."""
    from uuid import uuid4

    client, w, placed, link = stripe_webhook_world
    org_id = w.organisation.id
    sub = Subscription.objects.get(id=placed.subscription.id)
    sub.state = "past_due"
    sub.save(update_fields=["state", "updated_at"])
    dunning = DunningCase.objects.create(subscription=sub, state="past_due")
    ws = Workspace.objects.get(organisation_id=org_id)
    quota, _ = WorkspaceQuota.objects.update_or_create(
        workspace=ws,
        defaults={"policy_ref": "dunning:hold", "seats": 0},
    )
    invoice = Invoice.objects.get(id=placed.invoice.id)
    total_minor = invoice.total_incl_vat_minor

    # 1. Unmatched checkout session (no PaymentLink) with valid-looking metadata + spoofed seats
    res_unmatched = _post_webhook(
        client,
        {
            "id": "evt_bind_unmatched_01",
            "type": "checkout.session.completed",
            "created": int(time.time()),
            "data": {
                "object": {
                    "id": "cs_test_unmatched_spoof_01",
                    "payment_intent": "pi_unmatched_01",
                    "payment_status": "paid",
                    "amount_total": total_minor,
                    "currency": "eur",
                    "metadata": {
                        "organisation_id": str(org_id),
                        "subscription_id": str(sub.id),
                        "core_invoice_id": str(invoice.id),
                        "seats": "999999",
                    },
                }
            },
        },
    )
    assert res_unmatched.status_code == 200
    assert res_unmatched.json()["status"] == "unmatched"

    # 2. Unpaid & no_payment_required statuses on bound PaymentLink must NOT settle or activate
    res_unpaid = _post_webhook(
        client,
        {
            "id": "evt_bind_unpaid_02",
            "type": "checkout.session.completed",
            "created": int(time.time()),
            "data": {
                "object": {
                    "id": link.provider_ref,
                    "payment_intent": "pi_unpaid_02",
                    "payment_status": "unpaid",
                    "amount_total": total_minor,
                    "currency": "eur",
                }
            },
        },
    )
    assert res_unpaid.status_code == 200
    assert res_unpaid.json()["status"] == "ignored"

    res_no_pay = _post_webhook(
        client,
        {
            "id": "evt_bind_nopay_03",
            "type": "checkout.session.completed",
            "created": int(time.time()),
            "data": {
                "object": {
                    "id": link.provider_ref,
                    "payment_intent": "pi_nopay_03",
                    "payment_status": "no_payment_required",
                    "amount_total": 0,
                    "currency": "eur",
                }
            },
        },
    )
    assert res_no_pay.status_code == 200
    assert res_no_pay.json()["status"] == "mismatch"

    # 3. Amount, currency, organisation_id, subscription_id, and invoice_id mismatches -> mismatch
    mismatch_payloads = [
        ("evt_bind_amt_04", {"amount_total": total_minor - 1, "currency": "eur"}),
        ("evt_bind_cur_05", {"amount_total": total_minor, "currency": "usd"}),
        (
            "evt_bind_org_06",
            {
                "amount_total": total_minor,
                "currency": "eur",
                "metadata": {"organisation_id": str(uuid4())},
            },
        ),
        (
            "evt_bind_sub_07",
            {
                "amount_total": total_minor,
                "currency": "eur",
                "metadata": {"subscription_id": str(uuid4())},
            },
        ),
        (
            "evt_bind_inv_08",
            {
                "amount_total": total_minor,
                "currency": "eur",
                "metadata": {"core_invoice_id": str(uuid4())},
            },
        ),
    ]
    for evt_id, overrides in mismatch_payloads:
        res_mm = _post_webhook(
            client,
            {
                "id": evt_id,
                "type": "checkout.session.completed",
                "created": int(time.time()),
                "data": {
                    "object": {
                        "id": link.provider_ref,
                        "payment_intent": f"pi_{evt_id}",
                        "payment_status": "paid",
                        **overrides,
                    }
                },
            },
        )
        assert res_mm.status_code == 200
        assert res_mm.json()["status"] == "mismatch"

    # Verify ZERO Payment rows, invoice still issued, subscription still past_due, dunning open, quota 0
    assert Payment.objects.filter(organisation_id=org_id).count() == 0
    assert Invoice.objects.get(id=invoice.id).state == "issued"
    assert PaymentLink.objects.get(id=link.id).state == "active"
    sub.refresh_from_db()
    dunning.refresh_from_db()
    quota.refresh_from_db()
    assert sub.state == "past_due"
    assert dunning.state == "past_due"
    assert quota.seats == 0

    # 4. Valid Core-bound checkout with spoofed `metadata.seats = "999999"` reconciles invoice,
    #    clears dunning, activates subscription, and derives seats strictly from Core tier * quantity!
    res_valid = _post_webhook(
        client,
        {
            "id": "evt_bind_valid_09",
            "type": "checkout.session.completed",
            "created": int(time.time()),
            "data": {
                "object": {
                    "id": link.provider_ref,
                    "payment_intent": "pi_valid_bound_09",
                    "payment_status": "paid",
                    "amount_total": total_minor,
                    "currency": "eur",
                    "client_reference_id": str(invoice.id),
                    "metadata": {
                        "organisation_id": str(org_id),
                        "subscription_id": str(sub.id),
                        "core_invoice_id": str(invoice.id),
                        "seats": "999999",
                    },
                }
            },
        },
    )
    assert res_valid.status_code == 200
    assert res_valid.json()["status"] == "applied"
    assert Invoice.objects.get(id=invoice.id).state == "paid"
    assert Payment.objects.get(provider="stripe", provider_ref="pi_valid_bound_09").state == (
        "succeeded"
    )
    sub.refresh_from_db()
    dunning.refresh_from_db()
    quota.refresh_from_db()
    assert sub.state == "active"
    assert dunning.state == "current"
    assert quota.seats == 150 * sub.quantity


def test_out_of_order_and_same_second_stale_invoice_settlement_never_clears_newer_unpaid_dunning(
    stripe_webhook_world,
):
    """G4 P1/P2: settling an older invoice when a newer unpaid/overdue Core invoice exists on the
    same subscription (including two invoices issued at the exact same timestamp, ordered by UUIDv7)
    marks only the older invoice paid and keeps the subscription `past_due` with dunning open."""
    from datetime import UTC, datetime, timedelta

    import time_machine

    from apps.billing.models import InvoiceLine

    client, w, _, _ = stripe_webhook_world
    frozen_instant = datetime(2026, 11, 14, 15, 0, 0, tzinfo=UTC)

    with time_machine.travel(frozen_instant, tick=False):
        w2 = world()
        ws2 = Workspace.objects.create(organisation=w2.organisation)
        placed2 = place(w2, offer(), quantity=4)
        inv_older = Invoice.objects.get(id=placed2.invoice.id)
        older_line = InvoiceLine.objects.get(invoice=inv_older, position=1)
        sub = Subscription.objects.get(id=placed2.subscription.id)

        # Issue a newer overdue invoice on the EXACT SAME subscription & exact same created_at!
        inv_newer = Invoice.objects.create(
            organisation=w2.organisation,
            subscription=sub,
            order=None,
            number=None,
            state="draft",
            currency=inv_older.currency,
            vat_regime=inv_older.vat_regime,
            vat_mention=inv_older.vat_mention,
            issuer_legal_name=inv_older.issuer_legal_name,
            issuer_address=inv_older.issuer_address,
            issuer_country=inv_older.issuer_country,
            issuer_siren=inv_older.issuer_siren,
            issuer_vat_number=inv_older.issuer_vat_number,
            customer_legal_name=inv_older.customer_legal_name,
            customer_address_line1=inv_older.customer_address_line1,
            customer_address_line2=inv_older.customer_address_line2,
            customer_postal_code=inv_older.customer_postal_code,
            customer_city=inv_older.customer_city,
            customer_country=inv_older.customer_country,
            customer_siren=inv_older.customer_siren,
            customer_vat_number=inv_older.customer_vat_number,
            total_excl_vat_minor=inv_older.total_excl_vat_minor,
            vat_amount_minor=inv_older.vat_amount_minor,
            total_incl_vat_minor=inv_older.total_incl_vat_minor,
            amount_paid_minor=0,
        )
        InvoiceLine.objects.create(
            invoice=inv_newer,
            position=1,
            description=older_line.description,
            plan_code=older_line.plan_code,
            plan_version=older_line.plan_version,
            pack_code=older_line.pack_code,
            capacity_tier_code=older_line.capacity_tier_code,
            quantity=older_line.quantity,
            unit_amount_minor=older_line.unit_amount_minor,
            total_excl_vat_minor=older_line.total_excl_vat_minor,
            vat_rate_bp=older_line.vat_rate_bp,
            vat_amount_minor=older_line.vat_amount_minor,
            period_start=older_line.period_start,
            period_end=older_line.period_end,
        )
        inv_newer.number = "KODERA-2026-89999"
        inv_newer.state = "issued"
        inv_newer.issued_at = frozen_instant
        inv_newer.due_at = frozen_instant + timedelta(days=30)
        inv_newer.save()
        inv_newer.state = "overdue"
        inv_newer.save(update_fields=["state", "updated_at"])

    assert inv_older.created_at == inv_newer.created_at
    assert inv_newer.id > inv_older.id

    sub.state = "past_due"
    sub.save(update_fields=["state", "updated_at"])
    dunning = DunningCase.objects.create(subscription=sub, state="past_due")
    quota, _ = WorkspaceQuota.objects.update_or_create(
        workspace=ws2,
        defaults={"policy_ref": "dunning:past_due", "seats": 0},
    )

    link_older = payments.create_payment_link(
        invoice_id=inv_older.id,
        organisation_id=w2.organisation.id,
        return_url="https://app.localhost/billing",
    ).link
    link_newer = payments.create_payment_link(
        invoice_id=inv_newer.id,
        organisation_id=w2.organisation.id,
        return_url="https://app.localhost/billing",
    ).link

    # 1. Out-of-order settlement of `inv_older` while `inv_newer` (same created_at, higher UUIDv7)
    #    is still `overdue`: `inv_older` becomes `paid`, but subscription stays `past_due`,
    #    dunning stays `past_due`, and quota stays `0`!
    res_older = _post_webhook(
        client,
        {
            "id": "evt_ooo_older_01",
            "type": "checkout.session.completed",
            "created": int(time.time()),
            "data": {
                "object": {
                    "id": link_older.provider_ref,
                    "payment_intent": "pi_ooo_older_01",
                    "payment_status": "paid",
                    "amount_total": inv_older.total_incl_vat_minor,
                    "currency": "eur",
                }
            },
        },
    )
    assert res_older.status_code == 200
    assert res_older.json()["status"] == "applied"
    assert Invoice.objects.get(id=inv_older.id).state == "paid"
    assert Invoice.objects.get(id=inv_newer.id).state == "overdue"
    sub.refresh_from_db()
    dunning.refresh_from_db()
    quota.refresh_from_db()
    assert sub.state == "past_due"
    assert dunning.state == "past_due"
    assert quota.seats == 0

    # 2. Now settle `inv_newer`: zero unpaid/overdue invoices remain -> subscription activates,
    #    dunning clears to `current`, and quota updates to tier capacity!
    res_newer = _post_webhook(
        client,
        {
            "id": "evt_ooo_newer_02",
            "type": "checkout.session.completed",
            "created": int(time.time()) + 2,
            "data": {
                "object": {
                    "id": link_newer.provider_ref,
                    "payment_intent": "pi_ooo_newer_02",
                    "payment_status": "paid",
                    "amount_total": inv_newer.total_incl_vat_minor,
                    "currency": "eur",
                }
            },
        },
    )
    assert res_newer.status_code == 200
    assert res_newer.json()["status"] == "applied"
    assert Invoice.objects.get(id=inv_newer.id).state == "paid"
    sub.refresh_from_db()
    dunning.refresh_from_db()
    quota.refresh_from_db()
    assert sub.state == "active"
    assert dunning.state == "current"
    assert quota.seats == 150 * sub.quantity


def test_stripe_webhook_api_version_allowlist_and_e133_acacia_snapshot_shapes(
    stripe_webhook_world,
):
    """Public HTTP webhook ingress pins `ALLOWED_STRIPE_API_VERSIONS`
    (`2024-06-20` and `2024-12-18.acacia` matching E-133), rejecting missing or unrecognized
    `api_version` fail-closed (`400`) before any DB write while reconciling all 4 authorized G4
    events cleanly under both pinned versions."""
    from apps.billing.payments.stripe import API_VERSION as OUTBOUND_API_VERSION
    from apps.billing.payments.stripe_webhook import ALLOWED_STRIPE_API_VERSIONS

    assert OUTBOUND_API_VERSION == "2024-06-20"
    assert ALLOWED_STRIPE_API_VERSIONS == frozenset({"2024-06-20", "2024-12-18.acacia"})

    client, w, placed, link = stripe_webhook_world
    base_envelope = {
        "object": "event",
        "type": "checkout.session.completed",
        "created": int(time.time()),
        "livemode": False,
        "pending_webhooks": 1,
        "request": {"id": None, "idempotency_key": None},
        "data": {
            "object": {
                "id": link.provider_ref,
                "object": "checkout.session",
                "mode": "payment",
                "payment_intent": "pi_ver_rejected_00",
                "payment_status": "paid",
                "amount_total": Invoice.objects.get(id=placed.invoice.id).total_incl_vat_minor,
                "currency": "eur",
            }
        },
    }

    # 1. Missing or unrecognized `api_version` -> 400 fail-closed BEFORE any DB write!
    res_missing = _post_webhook(
        client,
        {**base_envelope, "id": "evt_apiver_missing_01"},
        include_default_api_version=False,
    )
    assert res_missing.status_code == 400

    for idx, bad_version in enumerate((None, 20240620, "2022-11-15", "2025-01-27.acacia"), start=2):
        res_bad = _post_webhook(
            client,
            {
                **base_envelope,
                "id": f"evt_apiver_bad_0{idx}",
                "api_version": bad_version,
            },
            include_default_api_version=False,
        )
        assert res_bad.status_code == 400

    assert StripeWebhookDelivery.objects.count() == 0
    assert Payment.objects.filter(organisation_id=w.organisation.id).count() == 0
    assert Invoice.objects.get(id=placed.invoice.id).state == "issued"
    assert PaymentLink.objects.get(id=link.id).state == "active"

    # 2. Both `"2024-06-20"` and `"2024-12-18.acacia"` (exact E-133 snapshot envelope) reconcile
    #    all 4 authorized G4 collection events cleanly against persisted Core ledger rows.
    for slug_tag, api_ver in (("legacy202406", "2024-06-20"), ("e133acacia", "2024-12-18.acacia")):
        # 2a. `checkout.session.expired` + `checkout.session.completed` + `charge.refunded`
        w_cs = world()
        Workspace.objects.create(organisation=w_cs.organisation)
        placed_cs = place(w_cs, offer(), quantity=3)
        inv_cs = Invoice.objects.get(id=placed_cs.invoice.id)
        link_exp = payments.create_payment_link(
            invoice_id=inv_cs.id,
            organisation_id=w_cs.organisation.id,
            return_url="https://app.localhost/billing",
        ).link

        exp_res = _post_webhook(
            client,
            {
                "id": f"evt_{slug_tag}_cs_exp",
                "object": "event",
                "api_version": api_ver,
                "created": int(time.time()),
                "livemode": False,
                "pending_webhooks": 1,
                "request": {"id": None, "idempotency_key": None},
                "type": "checkout.session.expired",
                "data": {
                    "object": {
                        "id": link_exp.provider_ref,
                        "object": "checkout.session",
                        "mode": "payment",
                        "status": "expired",
                        "payment_status": "unpaid",
                        "amount_total": inv_cs.total_incl_vat_minor,
                        "currency": "eur",
                        "client_reference_id": str(inv_cs.id),
                        "metadata": {"core_invoice_id": str(inv_cs.id)},
                    }
                },
            },
            url=WEBHOOK_ALIAS_URL,
            include_default_api_version=False,
        )
        assert exp_res.status_code == 200
        assert exp_res.json()["status"] == "applied"
        assert PaymentLink.objects.get(id=link_exp.id).state == "expired"

        link_live = payments.create_payment_link(
            invoice_id=inv_cs.id,
            organisation_id=w_cs.organisation.id,
            return_url="https://app.localhost/billing",
        ).link
        pi_cs_ref = f"pi_{slug_tag}_cs_01"
        cs_res = _post_webhook(
            client,
            {
                "id": f"evt_{slug_tag}_cs_ok",
                "object": "event",
                "api_version": api_ver,
                "created": int(time.time()) + 1,
                "livemode": False,
                "pending_webhooks": 1,
                "request": {"id": None, "idempotency_key": None},
                "type": "checkout.session.completed",
                "data": {
                    "object": {
                        "id": link_live.provider_ref,
                        "object": "checkout.session",
                        "mode": "payment",
                        "status": "complete",
                        "payment_status": "paid",
                        "payment_intent": pi_cs_ref,
                        "customer": f"cus_{slug_tag}_01",
                        "amount_subtotal": inv_cs.total_incl_vat_minor,
                        "amount_total": inv_cs.total_incl_vat_minor,
                        "currency": "eur",
                        "client_reference_id": str(inv_cs.id),
                        "metadata": {"core_invoice_id": str(inv_cs.id)},
                    }
                },
            },
            url=WEBHOOK_ALIAS_URL,
            include_default_api_version=False,
        )
        assert cs_res.status_code == 200
        assert cs_res.json()["status"] == "applied"
        assert Invoice.objects.get(id=inv_cs.id).state == "paid"
        assert Subscription.objects.get(id=placed_cs.subscription.id).state == "active"

        ref_res = _post_webhook(
            client,
            {
                "id": f"evt_{slug_tag}_ch_ref",
                "object": "event",
                "api_version": api_ver,
                "created": int(time.time()) + 5,
                "livemode": False,
                "pending_webhooks": 1,
                "request": {"id": None, "idempotency_key": None},
                "type": "charge.refunded",
                "data": {
                    "object": {
                        "id": f"ch_{slug_tag}_01",
                        "object": "charge",
                        "payment_intent": pi_cs_ref,
                        "customer": f"cus_{slug_tag}_01",
                        "amount": inv_cs.total_incl_vat_minor,
                        "amount_captured": inv_cs.total_incl_vat_minor,
                        "amount_refunded": inv_cs.total_incl_vat_minor,
                        "currency": "eur",
                        "paid": True,
                        "refunded": True,
                        "status": "succeeded",
                        "metadata": {"core_invoice_id": str(inv_cs.id)},
                    }
                },
            },
            url=WEBHOOK_URL,
            include_default_api_version=False,
        )
        assert ref_res.status_code == 200
        assert ref_res.json()["status"] == "applied"
        assert Payment.objects.get(provider="stripe", provider_ref=pi_cs_ref).state == "reversed"

        # 2b. Direct `payment_intent.succeeded` first-settlement under `api_ver`
        w_pi = world()
        Workspace.objects.create(organisation=w_pi.organisation)
        placed_pi = place(w_pi, offer(), quantity=2)
        inv_pi = Invoice.objects.get(id=placed_pi.invoice.id)
        payments.create_payment_link(
            invoice_id=inv_pi.id,
            organisation_id=w_pi.organisation.id,
            return_url="https://app.localhost/billing",
        )
        pi_direct_ref = f"pi_{slug_tag}_direct_02"
        pi_res = _post_webhook(
            client,
            {
                "id": f"evt_{slug_tag}_pi_ok",
                "object": "event",
                "api_version": api_ver,
                "created": int(time.time()) + 2,
                "livemode": False,
                "pending_webhooks": 1,
                "request": {"id": None, "idempotency_key": None},
                "type": "payment_intent.succeeded",
                "data": {
                    "object": {
                        "id": pi_direct_ref,
                        "object": "payment_intent",
                        "amount": inv_pi.total_incl_vat_minor,
                        "amount_received": inv_pi.total_incl_vat_minor,
                        "currency": "eur",
                        "customer": f"cus_{slug_tag}_02",
                        "status": "succeeded",
                        "latest_charge": f"ch_{slug_tag}_02",
                        "metadata": {"core_invoice_id": str(inv_pi.id)},
                    }
                },
            },
            url=WEBHOOK_ALIAS_URL,
            include_default_api_version=False,
        )
        assert pi_res.status_code == 200
        assert pi_res.json()["status"] == "applied"
        assert Invoice.objects.get(id=inv_pi.id).state == "paid"
        assert Subscription.objects.get(id=placed_pi.subscription.id).state == "active"


@pytest.mark.parametrize(
    "bad_timestamp",
    [
        "\u00b2",  # superscript two (`str.isdigit()` is True, `int()` raises ValueError)
        "\u0661\u0667\u0660\u0660",  # Arabic-Indic digits
        "\uff11\uff17\uff10\uff10",  # fullwidth digits
    ],
)
def test_stripe_signature_non_ascii_digits_rejected_with_400(
    stripe_webhook_world,
    bad_timestamp: str,
):
    """Regression guard for `stripe-signature-digit-parser-proof.json`: non-ASCII Unicode digits
    in `Stripe-Signature: t=...` fail closed with HTTP 400 (`malformed-request`), never 500."""
    client, _, _, link = stripe_webhook_world
    raw = json.dumps(
        {
            "id": "evt_unicode_ts_guard_01",
            "type": "checkout.session.expired",
            "api_version": "2024-12-18.acacia",
            "created": int(time.time()),
            "data": {"object": {"id": link.provider_ref}},
        },
        separators=(",", ":"),
    ).encode("utf-8")

    sig_header = f"t={bad_timestamp},v1={'a' * 64}"
    for target_url in (WEBHOOK_URL, WEBHOOK_ALIAS_URL):
        res = client.post(
            target_url,
            data=raw,
            content_type="application/json",
            HTTP_STRIPE_SIGNATURE=sig_header,
        )
        assert res.status_code == 400
        assert res["Content-Type"].startswith("application/problem+json")
        assert res.json()["type"] == "https://kodera.io/problems/malformed-request"

    assert (
        StripeWebhookDelivery.objects.filter(stripe_event_id="evt_unicode_ts_guard_01").count() == 0
    )


def test_early_charge_refunded_before_payment_is_retained_and_drained_equivalently(
    stripe_webhook_world,
):
    """`charge.refunded` arriving BEFORE `checkout.session.completed` or
    `payment_intent.succeeded` is retained in `billing_providerevent(outcome='deferred')`
    (`status='deferred'`) and drained atomically when `Payment` is created, producing the
    exact same final `Payment`, `Invoice`, `Subscription`, `DunningCase`, `WorkspaceQuota`,
    and audit state as canonical in-order delivery (`success -> refund`)."""
    from apps.billing.models import ProviderEvent

    client, _, _, _ = stripe_webhook_world
    shared_offer = offer()

    def _seed_scenario_tenant(tag: str):
        w_t = world()
        ws_t = Workspace.objects.create(organisation=w_t.organisation)
        placed_t = place(w_t, shared_offer, quantity=3)
        sub_t = Subscription.objects.get(id=placed_t.subscription.id)
        sub_t.state = "past_due"
        sub_t.save(update_fields=["state", "updated_at"])
        DunningCase.objects.create(subscription=sub_t, state="past_due")
        WorkspaceQuota.objects.update_or_create(
            workspace=ws_t,
            defaults={"policy_ref": "dunning:hold", "seats": 0},
        )
        inv_t = Invoice.objects.get(id=placed_t.invoice.id)
        link_t = payments.create_payment_link(
            invoice_id=inv_t.id,
            organisation_id=w_t.organisation.id,
            return_url="https://app.localhost/billing",
        ).link
        return w_t, ws_t, placed_t, inv_t, link_t

    def _snapshot(w_t, placed_t, inv_t, pi_ref: str) -> tuple[object, ...]:
        pay_row = Payment.objects.get(provider="stripe", provider_ref=pi_ref)
        inv_row = Invoice.objects.get(id=inv_t.id)
        sub_row = Subscription.objects.get(id=placed_t.subscription.id)
        dun_row = DunningCase.objects.get(subscription_id=sub_row.id)
        quota_row = WorkspaceQuota.objects.get(workspace__organisation_id=w_t.organisation.id)
        with connection.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM audit_auditevent WHERE organisation_id = %s AND action = %s",
                [w_t.organisation.id, "payment.refunded"],
            )
            refund_audits = int(cur.fetchone()[0])
            cur.execute(
                "SELECT COUNT(*) FROM audit_auditevent WHERE organisation_id = %s AND action = %s",
                [w_t.organisation.id, "invoice.paid"],
            )
            paid_audits = int(cur.fetchone()[0])
        return (
            pay_row.state,
            pay_row.allocated,
            pay_row.amount_minor,
            inv_row.state,
            inv_row.amount_paid_minor,
            inv_row.total_incl_vat_minor,
            sub_row.state,
            dun_row.state,
            quota_row.policy_ref,
            quota_row.seats,
            refund_audits,
            paid_audits,
        )

    # --- Scenario A1: `charge.refunded` -> `checkout.session.completed` -> refund redeliveries ---
    w_a1, _, placed_a1, inv_a1, link_a1 = _seed_scenario_tenant("a1")
    pi_a1 = "pi_early_cs_0001"
    refund_evt_a1 = {
        "id": "evt_early_ref_cs_01",
        "type": "charge.refunded",
        "created": int(time.time()),
        "data": {
            "object": {
                "id": "ch_early_cs_01",
                "payment_intent": pi_a1,
                "amount": inv_a1.total_incl_vat_minor,
                "amount_refunded": inv_a1.total_incl_vat_minor,
                "currency": "eur",
                "refunded": True,
                "metadata": {"core_invoice_id": str(inv_a1.id)},
            }
        },
    }
    res_early_a1 = _post_webhook(client, refund_evt_a1, url=WEBHOOK_URL)
    assert res_early_a1.status_code == 200
    assert res_early_a1.json()["status"] == "deferred"
    assert (
        ProviderEvent.objects.filter(
            provider="stripe",
            event_id="evt_early_ref_cs_01",
            outcome="deferred",
        ).count()
        == 1
    )
    assert Payment.objects.filter(provider="stripe", provider_ref=pi_a1).count() == 0

    cs_evt_a1 = {
        "id": "evt_late_cs_01",
        "type": "checkout.session.completed",
        "created": int(time.time()) + 2,
        "data": {
            "object": {
                "id": link_a1.provider_ref,
                "payment_intent": pi_a1,
                "payment_status": "paid",
                "amount_total": inv_a1.total_incl_vat_minor,
                "currency": "eur",
                "metadata": {
                    "organisation_id": str(w_a1.organisation.id),
                    "subscription_id": str(placed_a1.subscription.id),
                    "core_invoice_id": str(inv_a1.id),
                },
            }
        },
    }
    res_cs_a1 = _post_webhook(client, cs_evt_a1, url=WEBHOOK_ALIAS_URL)
    assert res_cs_a1.status_code == 200
    assert res_cs_a1.json()["status"] == "applied"
    assert (
        ProviderEvent.objects.get(provider="stripe", event_id="evt_early_ref_cs_01").outcome
        == "applied"
    )

    # Redeliveries (same event_id AND distinct event_id) do not double-apply or fail
    assert _post_webhook(client, refund_evt_a1, url=WEBHOOK_URL).json()["status"] == "duplicate"
    assert (
        _post_webhook(
            client,
            {**refund_evt_a1, "id": "evt_early_ref_cs_02"},
            url=WEBHOOK_ALIAS_URL,
        ).json()["status"]
        == "ignored"
    )
    snap_a1 = _snapshot(w_a1, placed_a1, inv_a1, pi_a1)
    assert snap_a1[0] == "reversed"
    assert snap_a1[3] == "issued"
    assert snap_a1[4] == 0
    assert snap_a1[6] == "past_due"  # Reversed subscription downgraded from active
    assert snap_a1[7] == "past_due"  # DunningCase placed in past_due
    assert str(snap_a1[8]).endswith(":past_due")

    # --- Scenario A2: `charge.refunded` -> `payment_intent.succeeded` -> refund redelivery ---
    w_a2, _, placed_a2, inv_a2, _ = _seed_scenario_tenant("a2")
    pi_a2 = "pi_early_pi_0002"
    refund_evt_a2 = {
        "id": "evt_early_ref_pi_01",
        "type": "charge.refunded",
        "created": int(time.time()),
        "data": {
            "object": {
                "id": "ch_early_pi_01",
                "payment_intent": pi_a2,
                "amount": inv_a2.total_incl_vat_minor,
                "amount_refunded": inv_a2.total_incl_vat_minor,
                "currency": "eur",
                "refunded": True,
                "metadata": {"core_invoice_id": str(inv_a2.id)},
            }
        },
    }
    assert (
        _post_webhook(client, refund_evt_a2, url=WEBHOOK_ALIAS_URL).json()["status"] == "deferred"
    )

    pi_evt_a2 = {
        "id": "evt_late_pi_01",
        "type": "payment_intent.succeeded",
        "created": int(time.time()) + 2,
        "data": {
            "object": {
                "id": pi_a2,
                "amount": inv_a2.total_incl_vat_minor,
                "amount_received": inv_a2.total_incl_vat_minor,
                "currency": "eur",
                "status": "succeeded",
                "metadata": {
                    "core_invoice_id": str(inv_a2.id),
                    "organisation_id": str(w_a2.organisation.id),
                },
            }
        },
    }
    assert _post_webhook(client, pi_evt_a2, url=WEBHOOK_URL).json()["status"] == "applied"
    assert _post_webhook(client, refund_evt_a2, url=WEBHOOK_URL).json()["status"] == "duplicate"
    snap_a2 = _snapshot(w_a2, placed_a2, inv_a2, pi_a2)

    # --- Scenario B: Canonical in-order `checkout.session.completed` -> `charge.refunded` ---
    w_b, _, placed_b, inv_b, link_b = _seed_scenario_tenant("b")
    pi_b = "pi_inorder_cs_0003"
    cs_evt_b = {
        "id": "evt_inorder_cs_01",
        "type": "checkout.session.completed",
        "created": int(time.time()),
        "data": {
            "object": {
                "id": link_b.provider_ref,
                "payment_intent": pi_b,
                "payment_status": "paid",
                "amount_total": inv_b.total_incl_vat_minor,
                "currency": "eur",
                "metadata": {
                    "organisation_id": str(w_b.organisation.id),
                    "subscription_id": str(placed_b.subscription.id),
                    "core_invoice_id": str(inv_b.id),
                },
            }
        },
    }
    assert _post_webhook(client, cs_evt_b, url=WEBHOOK_URL).json()["status"] == "applied"
    assert Subscription.objects.get(id=placed_b.subscription.id).state == "active"

    refund_evt_b = {
        "id": "evt_inorder_ref_01",
        "type": "charge.refunded",
        "created": int(time.time()) + 3,
        "data": {
            "object": {
                "id": "ch_inorder_01",
                "payment_intent": pi_b,
                "amount": inv_b.total_incl_vat_minor,
                "amount_refunded": inv_b.total_incl_vat_minor,
                "currency": "eur",
                "refunded": True,
                "metadata": {"core_invoice_id": str(inv_b.id)},
            }
        },
    }
    assert _post_webhook(client, refund_evt_b, url=WEBHOOK_ALIAS_URL).json()["status"] == "applied"
    snap_b = _snapshot(w_b, placed_b, inv_b, pi_b)

    assert snap_a1 == snap_a2 == snap_b

    # --- Partial early refund (`refunded=False`) reopens invoice & moves subscription to past_due ---
    w_p, _, placed_p, inv_p, link_p = _seed_scenario_tenant("partial")
    pi_p = "pi_early_partial_0004"
    partial_ref_evt = {
        "id": "evt_early_partial_01",
        "type": "charge.refunded",
        "created": int(time.time()),
        "data": {
            "object": {
                "id": "ch_early_partial_01",
                "payment_intent": pi_p,
                "amount": inv_p.total_incl_vat_minor,
                "amount_refunded": 1000,
                "currency": "eur",
                "refunded": False,
                "metadata": {"core_invoice_id": str(inv_p.id)},
            }
        },
    }
    assert _post_webhook(client, partial_ref_evt, url=WEBHOOK_URL).json()["status"] == "deferred"
    assert (
        _post_webhook(
            client,
            {
                "id": "evt_late_partial_cs_01",
                "type": "checkout.session.completed",
                "created": int(time.time()) + 2,
                "data": {
                    "object": {
                        "id": link_p.provider_ref,
                        "payment_intent": pi_p,
                        "payment_status": "paid",
                        "amount_total": inv_p.total_incl_vat_minor,
                        "currency": "eur",
                        "metadata": {"core_invoice_id": str(inv_p.id)},
                    }
                },
            },
            url=WEBHOOK_URL,
        ).json()["status"]
        == "applied"
    )
    assert Payment.objects.get(provider="stripe", provider_ref=pi_p).state == "succeeded"
    inv_p_after = Invoice.objects.get(id=inv_p.id)
    assert inv_p_after.state == "issued"
    assert inv_p_after.amount_paid_minor == inv_p.total_incl_vat_minor - 1000
    assert Subscription.objects.get(id=placed_p.subscription.id).state == "past_due"
    with connection.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) FROM audit_auditevent WHERE organisation_id = %s AND action = %s",
            [w_p.organisation.id, "payment.refunded"],
        )
        assert int(cur.fetchone()[0]) == 1


@pytest.mark.parametrize("refund_fraction", [(1, 2), (1, 1)])
def test_charge_refunded_partial_and_full_keep_dunning_past_due_and_allow_repayment(
    settings, refund_fraction
):
    """BUG-0009 regression: both partial (50%) and full (100%) `charge.refunded` webhooks reopen a
    paid invoice (`issued`/`overdue`), prevent `schedule_subscription()` from auto-clearing a
    `past_due` subscription before or after `due_at`, advance dunning proposals once overdue, and
    allow full re-settlement of the unpaid remainder via a fresh `PaymentLink`."""
    from datetime import timedelta

    import time_machine
    from django.utils import timezone

    from apps.billing.dunning_scheduler import schedule_subscription
    from apps.billing.models import DunningAction, DunningCase
    from apps.billing.payments.services import effective_owed_minor

    settings.KODERA_STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
    settings.KODERA_STRIPE_EXPECTED_LIVEMODE = None

    num, den = refund_fraction
    label = f"r{num}of{den}"
    bw = world()
    Workspace.objects.create(organisation=bw.organisation)
    placed = place(bw, offer(), quantity=4)
    inv = Invoice.objects.get(id=placed.invoice.id)
    total = int(inv.total_incl_vat_minor)
    refund_amount = (total * num) // den
    assert 0 < refund_amount <= total

    link_1 = PaymentLink.objects.create(
        organisation=bw.organisation,
        invoice=inv,
        provider="stripe",
        provider_ref=f"cs_test_bug0009_{label}_1",
        url=f"https://checkout.stripe.test/c/pay/cs_test_bug0009_{label}_1",
        state="active",
        amount_minor=total,
        currency=inv.currency,
        expires_at=timezone.now() + timedelta(days=7),
    )
    DunningCase.objects.get_or_create(subscription=placed.subscription)
    client = Client()
    pi_1 = f"pi_bug0009_{label}_1"

    # 1. Initial full payment settles invoice and activates subscription
    assert (
        _post_webhook(
            client,
            {
                "id": f"evt_bug0009_{label}_cs1",
                "type": "checkout.session.completed",
                "created": int(time.time()),
                "data": {
                    "object": {
                        "id": link_1.provider_ref,
                        "payment_intent": pi_1,
                        "payment_status": "paid",
                        "amount_total": total,
                        "currency": inv.currency.lower(),
                        "metadata": {"core_invoice_id": str(inv.id)},
                    }
                },
            },
            url=WEBHOOK_URL,
        ).json()["status"]
        == "applied"
    )
    assert Invoice.objects.get(id=inv.id).state == "paid"
    assert Subscription.objects.get(id=placed.subscription.id).state == "active"

    # 2. Refund (50% or 100%) reopens invoice and moves subscription & dunning case to `past_due`
    assert (
        _post_webhook(
            client,
            {
                "id": f"evt_bug0009_{label}_ref1",
                "type": "charge.refunded",
                "created": int(time.time()) + 5,
                "data": {
                    "object": {
                        "id": f"ch_bug0009_{label}_1",
                        "payment_intent": pi_1,
                        "amount": total,
                        "amount_refunded": refund_amount,
                        "currency": inv.currency.lower(),
                        "refunded": refund_amount == total,
                        "metadata": {"core_invoice_id": str(inv.id)},
                    }
                },
            },
            url=WEBHOOK_URL,
        ).json()["status"]
        == "applied"
    )
    inv_reopened = Invoice.objects.get(id=inv.id)
    assert inv_reopened.state == "issued"
    assert inv_reopened.paid_at is None
    assert inv_reopened.amount_paid_minor == total - refund_amount
    assert effective_owed_minor(inv_reopened) == refund_amount
    assert Subscription.objects.get(id=placed.subscription.id).state == "past_due"
    assert DunningCase.objects.get(subscription=placed.subscription).state == "past_due"

    # Replaying or re-invoking `_apply_g4_refund_to_payment` with the same or non-advancing
    # cumulative `amount_refunded` is idempotently ignored and NEVER double-decrements `amount_paid_minor`!
    from django.db import transaction

    from apps.billing.payments.stripe_webhook import _apply_g4_refund_to_payment

    pay_1 = Payment.objects.get(provider="stripe", provider_ref=pi_1)
    with transaction.atomic():
        assert (
            _apply_g4_refund_to_payment(
                invoice=inv_reopened,
                payment=pay_1,
                event_id=f"evt_bug0009_{label}_ref1",
                occurred_at=timezone.now(),
                amount_refunded=refund_amount,
                currency=inv.currency,
                charge_id=f"ch_bug0009_{label}_1",
                pi_id=pi_1,
                meta={"core_invoice_id": str(inv.id)},
                data_obj={},
            )
            == "ignored"
        )
    assert Invoice.objects.get(id=inv.id).amount_paid_minor == total - refund_amount

    # 3. Running `schedule_subscription()` BEFORE `due_at` MUST NOT auto-reactivate subscription!
    assert schedule_subscription(placed.subscription.id) is None
    assert Subscription.objects.get(id=placed.subscription.id).state == "past_due"
    assert DunningCase.objects.get(subscription=placed.subscription).state == "past_due"

    # 4. Once past `due_at` (+ 8 days), `schedule_subscription()` marks invoice `overdue` and prepares `reminder_1`
    assert inv_reopened.due_at is not None
    with time_machine.travel(inv_reopened.due_at + timedelta(days=8), tick=False):
        action = schedule_subscription(placed.subscription.id)
    assert action is not None
    assert isinstance(action, DunningAction)
    assert action.step == "reminder_1"
    assert Invoice.objects.get(id=inv.id).state == "overdue"
    assert Subscription.objects.get(id=placed.subscription.id).state == "past_due"

    # 5. Re-settlement via a fresh `PaymentLink` for the exact unpaid remainder (`refund_amount`)
    inv_overdue = Invoice.objects.get(id=inv.id)
    owed_now = effective_owed_minor(inv_overdue)
    assert owed_now == refund_amount
    link_2 = PaymentLink.objects.create(
        organisation=bw.organisation,
        invoice=inv_overdue,
        provider="stripe",
        provider_ref=f"cs_test_bug0009_{label}_2",
        url=f"https://checkout.stripe.test/c/pay/cs_test_bug0009_{label}_2",
        state="active",
        amount_minor=owed_now,
        currency=inv_overdue.currency,
        expires_at=timezone.now() + timedelta(days=7),
    )
    pi_2 = f"pi_bug0009_{label}_2"
    assert (
        _post_webhook(
            client,
            {
                "id": f"evt_bug0009_{label}_cs2",
                "type": "checkout.session.completed",
                "created": int(time.time()) + 10,
                "data": {
                    "object": {
                        "id": link_2.provider_ref,
                        "payment_intent": pi_2,
                        "payment_status": "paid",
                        "amount_total": owed_now,
                        "currency": inv_overdue.currency.lower(),
                        "metadata": {"core_invoice_id": str(inv.id)},
                    }
                },
            },
            url=WEBHOOK_URL,
        ).json()["status"]
        == "applied"
    )
    inv_settled = Invoice.objects.get(id=inv.id)
    assert inv_settled.state == "paid"
    assert inv_settled.paid_at is not None
    assert inv_settled.amount_paid_minor == total
    assert effective_owed_minor(inv_settled) == 0
    assert Subscription.objects.get(id=placed.subscription.id).state == "active"
    assert DunningCase.objects.get(subscription=placed.subscription).state == "current"
