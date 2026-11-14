"""Public signed Stripe webhook endpoint (`POST /api/v1/billing/webhooks/stripe`) against PostgreSQL.

Covers:
- Exempt from OIDC bearer tokens; strictly authenticated via `Stripe-Signature` HMAC-SHA256
  (`t=...,v1=...`) with 300-second replay window and constant-time comparison.
- Missing `KODERA_STRIPE_WEBHOOK_SECRET` -> `503 service-unavailable`.
- Missing/malformed `Stripe-Signature` or invalid JSON -> `400 malformed-request`.
- Invalid signature, tampered payload bytes, or stale timestamp (`> 300s`) -> `401 unauthenticated`.
- `checkout.session.completed` -> `200`, activates pending `Subscription`, reconciles linked
  `Invoice` / `PaymentLink`, and syncs `WorkspaceQuota` seat capacity.
- `customer.subscription.updated` -> `200`, updates seat `quantity`, minor-unit net/tax/gross
  amounts, `cancel_at_period_end`, and `WorkspaceQuota` seats.
- `invoice.payment_failed` -> `200`, marks `Subscription` `past_due`, opens `DunningCase`, and
  emits `payment.failed` audit event.
- `customer.subscription.deleted` -> `200`, cancels `Subscription`, zeros `WorkspaceQuota` seats,
  and emits `subscription.cancelled` audit event.
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
):
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
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

    # 2. customer.subscription.updated -> updates seat quantity + minor amounts + WorkspaceQuota
    updated_evt = {
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
    }
    res_upd = _post_webhook(client, updated_evt)
    assert res_upd.status_code == 200
    assert res_upd.json()["status"] == "applied"
    sub.refresh_from_db()
    quota.refresh_from_db()
    assert sub.quantity == 24
    assert sub.cancel_at_period_end is True
    assert sub.total_excl_vat_minor == sub.unit_amount_minor * 24
    assert quota.seats == 150 * 24

    # 3. invoice.payment_failed -> transitions Subscription to past_due + opens DunningCase + payment.failed audit
    failed_evt = {
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
    }
    res_fail = _post_webhook(client, failed_evt)
    assert res_fail.status_code == 200
    assert res_fail.json()["status"] == "applied"
    sub.refresh_from_db()
    assert sub.state == "past_due"
    dunning = DunningCase.objects.get(subscription_id=sub_id)
    assert dunning.state == "past_due"
    assert _audit_count(org_id, "payment.failed") >= 1

    failed_audit_before = _audit_count(org_id, "payment.failed")
    res_fail_dup = _post_webhook(client, failed_evt)
    assert res_fail_dup.status_code == 200
    assert res_fail_dup.json()["status"] == "duplicate"
    assert _audit_count(org_id, "payment.failed") == failed_audit_before

    # 4. customer.subscription.deleted -> cancels Subscription, zeros WorkspaceQuota seats
    deleted_evt = {
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
    }
    res_del = _post_webhook(client, deleted_evt)
    assert res_del.status_code == 200
    assert res_del.json()["status"] == "applied"
    sub.refresh_from_db()
    quota.refresh_from_db()
    assert sub.state == "cancelled"
    assert sub.cancelled_at is not None
    assert quota.seats == 0
    assert _audit_count(org_id, "subscription.cancelled") == 1


def test_webhook_alias_route_and_checkout_session_expired(stripe_webhook_world, settings):
    client, w, placed, link = stripe_webhook_world
    org_id = w.organisation.id

    # Alias route `/api/v1/webhooks/stripe` enforces identical HMAC & 503 guards without OIDC auth.
    sample = {
        "id": "evt_alias_guard_01",
        "type": "checkout.session.expired",
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

    # Unknown checkout session expires cleanly with 200 ignored (never 500).
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
    assert res_unknown.json()["status"] == "ignored"


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

    # Verify Factur-X 380 Invoice row is 100% immutable after refund reconciliation.
    invoice_after_refund = Invoice.objects.get(id=invoice_before.id)
    assert invoice_after_refund.state == "paid"
    assert invoice_after_refund.number == original_number
    assert invoice_after_refund.issued_at == original_issued_at
    assert invoice_after_refund.paid_at == paid_at_snapshot
    assert invoice_after_refund.total_excl_vat_minor == invoice_before.total_excl_vat_minor
    assert invoice_after_refund.vat_amount_minor == invoice_before.vat_amount_minor
    assert invoice_after_refund.total_incl_vat_minor == total_minor
    assert invoice_after_refund.amount_paid_minor == total_minor

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
