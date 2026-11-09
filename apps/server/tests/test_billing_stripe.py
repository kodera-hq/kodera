"""The Stripe adapter against stubbed Stripe responses: no network, no account, no real key.

What Core sends to Stripe (the Checkout Session for a Core invoice, card and SEPA Direct Debit),
how it reads Stripe's answers and failures, how it verifies a webhook delivery (signature, replay
window), and what each Stripe event becomes once it reaches the reconciliation already proven with
the fake adapter. The keys are synthetic strings shaped so no secret scanner mistakes them for keys.
"""

import hashlib
import hmac
import itertools
import json
import time
import urllib.parse
from datetime import timedelta

import pytest
from django.utils import timezone
from test_billing_orders import offer, place, world

import apps.billing.payments as payments_package
from apps.billing import configuration
from apps.billing.models import Invoice, Payment, PaymentLink
from apps.billing.payments import port, services as payments
from apps.billing.payments.port import ProviderRefusedError, ReturnUrlRequiredError
from apps.billing.payments.stripe import (
    API_VERSION,
    MAX_SESSION,
    StripeProvider,
)

SECRET = "rk_test_" + "SyntheticNotAKey0"
WEBHOOK = "whsec_" + "synthetic-not-a-secret"
_ids = itertools.count()


class StubStripe:
    """Records each request; answers from a queue of (status, body) or a session by default."""

    def __init__(self):
        self.requests = []
        self.answers = []

    def __call__(self, method, url, headers, body):
        self.requests.append((method, url, dict(headers), urllib.parse.parse_qs(body.decode())))
        if self.answers:
            status, answer = self.answers.pop(0)
            return status, json.dumps(answer).encode()
        if url.endswith("/expire"):
            return 200, json.dumps({"id": url.split("/")[-2], "status": "expired"}).encode()
        expires = int(self.requests[-1][3]["expires_at"][0])
        number = next(_ids)
        return 200, json.dumps(
            {
                "id": f"cs_stub_{number}",
                "url": f"https://checkout.stripe.invalid/c/{number}",
                "expires_at": expires,
            }
        ).encode()


@pytest.fixture
def stripe(settings, monkeypatch):
    """Stripe configured with synthetic keys, its HTTP answered by a stub."""
    stub = StubStripe()
    provider = StripeProvider(secret_key=SECRET, webhook_secret=WEBHOOK, transport=stub)
    settings.KODERA_PAYMENT_PROVIDER = "stripe"
    settings.KODERA_STRIPE_SECRET_KEY = SECRET
    settings.KODERA_STRIPE_WEBHOOK_SECRET = WEBHOOK
    monkeypatch.setattr(payments_package, "_stripe", lambda secret_key, webhook_secret: provider)
    return provider, stub


def signed(payload, *, secret=WEBHOOK, at=None):
    body = json.dumps(payload).encode()
    timestamp = str(int(at if at is not None else time.time()))
    signature = hmac.new(
        secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256
    ).hexdigest()
    return body, {"Stripe-Signature": f"t={timestamp},v1={signature}"}


def event(kind, data, *, created=None, event_id=None, api_version=API_VERSION):
    return {
        "id": event_id or f"evt_stub_{next(_ids)}",
        "api_version": api_version,
        "type": kind,
        "created": int(created if created is not None else time.time()),
        "data": {"object": data},
    }


def session_event(
    kind, link, *, paid=True, intent="pi_stub_1", amount=538_560, customer=None, **extra
):
    data = {
        "id": link.provider_ref,
        "payment_intent": intent,
        "payment_status": "paid" if paid else "unpaid",
        "amount_total": amount,
        "currency": "eur",
        "customer": customer,
    }
    return event(kind, data, **extra)


def deliver(payload, **kwargs):
    body, headers = signed(payload, **kwargs)
    return payments.receive_event(provider_name="stripe", body=body, headers=headers)


def linked(stripe):
    w = world()
    placed = place(w, offer())
    link = payments.create_payment_link(
        invoice_id=placed.invoice.id,
        organisation_id=w.organisation.id,
        return_url="https://app.localhost/invoices",
    ).link
    return w, placed, link


def states(placed):
    invoice = Invoice.objects.get(id=placed.invoice.id)
    return invoice.state, invoice.amount_paid_minor


pytestmark = pytest.mark.django_db(transaction=True)


# --- what Core sends -----------------------------------------------------------------------------


def test_a_link_is_a_checkout_session_for_the_invoice_card_and_sepa(stripe):
    provider, stub = stripe
    _, placed, link = linked(stripe)
    method, url, headers, form = stub.requests[0]
    assert (method, url) == ("POST", "https://api.stripe.com/v1/checkout/sessions")
    assert headers["Authorization"] == f"Bearer {SECRET}" and headers["Stripe-Version"]
    assert headers["Idempotency-Key"].startswith("core-")
    assert form["mode"] == ["payment"]
    assert (form["payment_method_types[0]"], form["payment_method_types[1]"]) == (
        ["card"],
        ["sepa_debit"],
    )
    assert form["line_items[0][price_data][unit_amount]"] == ["538560"]
    assert form["line_items[0][price_data][currency]"] == ["eur"]
    assert form["metadata[core_invoice_id]"] == [str(placed.invoice.id)]
    assert form["payment_intent_data[metadata][core_invoice_id]"] == [str(placed.invoice.id)]
    assert form["customer_creation"] == ["always"]
    assert "tax" not in " ".join(form), "Stripe Tax is not used: Core computes the VAT"
    assert link.provider == "stripe" and link.provider_ref.startswith("cs_stub_")
    assert link.url.startswith("https://checkout.stripe.invalid/")
    # Stripe keeps a session open for a day at most: the link says so.
    assert link.expires_at <= timezone.now() + MAX_SESSION + timedelta(seconds=5)


@pytest.mark.parametrize(
    ("status", "error"),
    [
        (500, port.ProviderUnavailableError),
        (429, port.ProviderUnavailableError),
        (400, ProviderRefusedError),
    ],
)
def test_a_stripe_failure_writes_no_link(stripe, status, error):
    provider, stub = stripe
    w = world()
    placed = place(w, offer())
    stub.answers.append(
        (status, {"error": {"type": "invalid_request_error", "code": "x", "message": "echo"}})
    )
    with pytest.raises(error) as raised:
        payments.create_payment_link(
            invoice_id=placed.invoice.id,
            organisation_id=w.organisation.id,
            return_url="https://app.localhost/i",
        )
    assert "echo" not in str(raised.value)
    assert not PaymentLink.objects.exists()


def test_a_session_needs_its_return_url(stripe):
    w = world()
    placed = place(w, offer())
    with pytest.raises(ReturnUrlRequiredError):
        payments.create_payment_link(
            invoice_id=placed.invoice.id, organisation_id=w.organisation.id
        )


@pytest.mark.parametrize(
    "return_url",
    [
        "https://elsewhere.example/i",
        "http://app.localhost.example/i",
        "https://user@app.localhost/i",
        "javascript:alert(1)",
    ],
)
def test_the_payer_returns_only_to_the_console(stripe, return_url):
    provider, stub = stripe
    w = world()
    placed = place(w, offer())
    with pytest.raises(payments.ReturnUrlRefusedError):
        payments.create_payment_link(
            invoice_id=placed.invoice.id, organisation_id=w.organisation.id, return_url=return_url
        )
    assert stub.requests == [] and not PaymentLink.objects.exists()


def test_a_withdrawn_link_expires_its_session_and_only_a_closed_one_is_left(stripe):
    provider, stub = stripe
    provider.cancel_link("cs_stub_x")
    assert stub.requests[-1][1].endswith("/checkout/sessions/cs_stub_x/expire")
    stub.answers.append(
        (400, {"error": {"type": "invalid_request_error", "code": "checkout_session_not_open"}})
    )
    provider.cancel_link("cs_stub_y")
    # A key Stripe refuses is a configuration error, not a closed session: it is raised.
    stub.answers.append(
        (401, {"error": {"type": "invalid_request_error", "code": "api_key_expired"}})
    )
    with pytest.raises(ProviderRefusedError):
        provider.cancel_link("cs_stub_z")


# --- what Core accepts ---------------------------------------------------------------------------


def test_a_delivery_is_verified_and_refused_outside_its_window(stripe):
    provider, _ = stripe
    payload = event(
        "checkout.session.completed",
        {
            "id": "cs",
            "payment_intent": "pi",
            "payment_status": "paid",
            "amount_total": 1,
            "currency": "eur",
        },
    )
    body, headers = signed(payload)
    assert provider.parse_event(body=body, headers=headers).kind == "payment.succeeded"
    for bad in (
        signed(payload, secret="whsec_" + "another-endpoint"),
        (body + b" ", headers),
        signed(payload, at=time.time() - 301),
        signed(payload, at=time.time() + 301),
        (body, {"Stripe-Signature": "v1=abc"}),
        (body, {}),
    ):
        with pytest.raises(port.EventRejectedError):
            provider.parse_event(body=bad[0], headers=bad[1])
    # A rolled endpoint secret signs twice; either signature verifies.
    timestamp = str(int(time.time()))
    good = hmac.new(WEBHOOK.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
    assert provider.parse_event(
        body=body, headers={"Stripe-Signature": f"t={timestamp},v1={'0' * 64},v1={good}"}
    )


@pytest.mark.parametrize(
    ("kind", "data", "expected"),
    [
        ("checkout.session.completed", {"payment_status": "paid"}, "payment.succeeded"),
        ("checkout.session.completed", {"payment_status": "unpaid"}, "payment.processing"),
        (
            "checkout.session.async_payment_succeeded",
            {"payment_status": "paid"},
            "payment.succeeded",
        ),
        ("checkout.session.async_payment_failed", {"payment_status": "unpaid"}, "payment.failed"),
        ("customer.created", {}, None),
    ],
)
def test_each_stripe_event_becomes_one_port_event_or_none(stripe, kind, data, expected):
    provider, _ = stripe
    body, headers = signed(
        event(
            kind, {"id": "cs", "payment_intent": "pi", "amount_total": 1, "currency": "eur", **data}
        )
    )
    translated = provider.parse_event(body=body, headers=headers)
    assert (translated.kind if translated else None) == expected
    if translated:
        assert (translated.link_ref, translated.payment_ref, translated.currency) == (
            "cs",
            "pi",
            "EUR",
        )


# --- reconciliation through Stripe's events ------------------------------------------------------


def test_an_older_event_does_not_name_the_customer(stripe):
    _, _, link = linked(stripe)
    now = time.time()
    newer = session_event(
        "checkout.session.completed", link, paid=False, customer="cus_stub_new", created=now
    )
    assert deliver(newer) == "applied"
    older = session_event(
        "checkout.session.completed", link, paid=False, customer="cus_stub_old", created=now - 60
    )
    assert deliver(older) == "stale"
    assert Payment.objects.get(provider="stripe").provider_customer_ref == "cus_stub_new"


def test_a_card_payment_pays_the_invoice(stripe):
    _, placed, link = linked(stripe)
    assert deliver(session_event("checkout.session.completed", link)) == "applied"
    assert states(placed) == ("paid", 538_560)
    assert Payment.objects.get(provider="stripe").provider_ref == "pi_stub_1"


def test_a_sepa_debit_is_processing_until_it_settles_and_a_failed_one_does_not_pay(stripe):
    w, placed, link = linked(stripe)
    submitted = session_event("checkout.session.completed", link, paid=False, customer="cus_stub_1")
    assert deliver(submitted) == "applied"
    payment = Payment.objects.get(provider="stripe")
    assert (payment.state, payment.provider_customer_ref) == ("processing", "cus_stub_1")
    assert states(placed) == ("issued", 0)
    assert PaymentLink.objects.get(id=link.id).state == "used"
    # No second link while the debit is in flight: the invoice cannot be paid twice meanwhile.
    with pytest.raises(payments.PaymentInFlightError):
        payments.create_payment_link(
            invoice_id=placed.invoice.id,
            organisation_id=w.organisation.id,
            return_url="https://app.localhost/i",
        )
    assert deliver(session_event("checkout.session.async_payment_succeeded", link)) == "applied"
    assert states(placed) == ("paid", 538_560)
    _, other, other_link = linked(stripe)
    deliver(session_event("checkout.session.completed", other_link, paid=False, intent="pi_stub_2"))
    assert (
        deliver(
            session_event("checkout.session.async_payment_failed", other_link, intent="pi_stub_2")
        )
        == "applied"
    )
    assert states(other) == ("issued", 0)


def test_a_dispute_won_is_for_a_person(stripe):
    _, placed, link = linked(stripe)
    now = time.time()
    deliver(session_event("checkout.session.completed", link, created=now))
    dispute = {"payment_intent": "pi_stub_1", "amount": 538_560, "currency": "eur"}
    assert deliver(event("charge.dispute.created", dispute, created=now + 1)) == "applied"
    assert deliver(event("charge.dispute.funds_reinstated", dispute, created=now + 2)) == "mismatch"
    assert states(placed) == ("issued", 0)


def test_an_event_of_another_api_version_is_refused(stripe):
    provider, _ = stripe
    body, headers = signed(
        event("checkout.session.completed", {"id": "cs"}, api_version="2099-01-01")
    )
    with pytest.raises(port.EventRejectedError, match="API version"):
        provider.parse_event(body=body, headers=headers)


def test_a_redelivered_event_is_a_duplicate(stripe):
    _, placed, link = linked(stripe)
    payload = session_event("checkout.session.completed", link)
    assert deliver(payload) == "applied"
    assert deliver(payload) == "duplicate"
    assert states(placed) == ("paid", 538_560)


def test_a_refund_delivered_before_its_success_waits_and_then_takes_the_money_back(stripe):
    _, placed, link = linked(stripe)
    now = time.time()
    refund = event(
        "charge.refunded",
        {
            "payment_intent": "pi_stub_1",
            "amount": 538_560,
            "amount_refunded": 538_560,
            "refunded": True,
            "currency": "eur",
        },
        created=now + 2,
    )
    # Stripe's charge events name no session: the refund waits for the payment it reverses.
    assert deliver(refund) == "deferred"
    assert deliver(session_event("checkout.session.completed", link, created=now + 1)) == "applied"
    assert states(placed) == ("issued", 0)
    assert Payment.objects.get(provider_ref="pi_stub_1").state == "reversed"


def test_a_partial_refund_is_a_mismatch_and_a_dispute_takes_the_money_back(stripe):
    _, placed, link = linked(stripe)
    now = time.time()
    deliver(session_event("checkout.session.completed", link, created=now))
    partial = event(
        "charge.refunded",
        {
            "payment_intent": "pi_stub_1",
            "amount": 538_560,
            "amount_refunded": 1_000,
            "refunded": False,
            "currency": "eur",
        },
        created=now + 1,
    )
    assert deliver(partial) == "mismatch"
    assert states(placed) == ("paid", 538_560)
    dispute = event(
        "charge.dispute.created",
        {"payment_intent": "pi_stub_1", "amount": 538_560, "currency": "eur"},
        created=now + 2,
    )
    assert deliver(dispute) == "applied"
    assert states(placed) == ("issued", 0)


def test_events_from_the_fake_are_refused_while_stripe_is_configured(stripe):
    with pytest.raises(port.ProviderUnavailableError):
        payments.receive_event(provider_name="fake", body=b"{}", headers={})


# --- configuration -------------------------------------------------------------------------------


def test_stripe_is_selected_by_both_keys_or_neither():
    assert configuration.stripe_from_environment({}) == (None, None, None)
    assert configuration.stripe_from_environment(
        {"KODERA_STRIPE_SECRET_KEY": SECRET, "KODERA_STRIPE_WEBHOOK_SECRET": WEBHOOK}
    ) == ("stripe", SECRET, WEBHOOK)
    with pytest.raises(ValueError, match="both or not at all"):
        configuration.stripe_from_environment({"KODERA_STRIPE_SECRET_KEY": SECRET})
    with pytest.raises(ValueError, match="malformed"):
        configuration.stripe_from_environment(
            {
                "KODERA_STRIPE_SECRET_KEY": "pk_" + "public",
                "KODERA_STRIPE_WEBHOOK_SECRET": WEBHOOK,
            }
        )


def test_the_adapter_refuses_keys_of_the_wrong_kind():
    with pytest.raises(ValueError):
        StripeProvider(secret_key="pk_" + "public", webhook_secret=WEBHOOK)
    with pytest.raises(ValueError):
        StripeProvider(secret_key="sk_" + "unrestricted", webhook_secret=WEBHOOK)
    with pytest.raises(ValueError):
        StripeProvider(secret_key=SECRET, webhook_secret="not-a-secret")


def test_no_stripe_key_selects_no_provider_in_the_image_profiles(settings):
    from config.settings import customer_http

    assert customer_http.KODERA_PAYMENT_PROVIDER is None
    assert customer_http.KODERA_STRIPE_SECRET_KEY is None


def test_a_refund_delivered_while_the_debit_is_processing_waits_for_its_settlement(stripe):
    _, placed, link = linked(stripe)
    now = time.time()
    deliver(session_event("checkout.session.completed", link, paid=False, created=now))
    refund = {
        "payment_intent": "pi_stub_1",
        "amount": 538_560,
        "amount_refunded": 538_560,
        "currency": "eur",
    }
    assert deliver(event("charge.refunded", refund, created=now + 2)) == "deferred"
    assert (
        deliver(session_event("checkout.session.async_payment_succeeded", link, created=now + 1))
        == "applied"
    )
    assert states(placed) == ("issued", 0)
    assert Payment.objects.get(provider_ref="pi_stub_1").state == "reversed"


def test_a_debit_submitted_while_the_link_was_being_created_withdraws_the_new_link(
    stripe, monkeypatch
):
    provider, _ = stripe
    w, placed, link = linked(stripe)
    PaymentLink.objects.filter(id=link.id).update(state="expired")
    real = provider.create_link

    def submitted_meanwhile(request):
        issued = real(request)
        deliver(session_event("checkout.session.completed", link, paid=False))
        return issued

    monkeypatch.setattr(provider, "create_link", submitted_meanwhile)
    # Under the lock the debit is seen for what it is: a payment settling, as the check before
    # the provider call names it, not an invoice that cannot be paid.
    with pytest.raises(payments.PaymentInFlightError):
        payments.create_payment_link(
            invoice_id=placed.invoice.id,
            organisation_id=w.organisation.id,
            return_url="https://app.localhost/i",
        )
    assert not PaymentLink.objects.filter(invoice_id=placed.invoice.id, state="active").exists()


def test_a_debit_older_than_its_settlement_window_no_longer_holds_the_invoice(stripe):
    w, placed, link = linked(stripe)
    deliver(session_event("checkout.session.completed", link, paid=False))
    Payment.objects.filter(provider="stripe").update(
        last_event_at=timezone.now() - timedelta(days=21)
    )
    fresh = payments.create_payment_link(
        invoice_id=placed.invoice.id,
        organisation_id=w.organisation.id,
        return_url="https://app.localhost/i",
    )
    assert fresh.created is True


def test_the_replay_window_is_three_hundred_seconds_exactly(stripe):
    provider, _ = stripe
    payload = event("customer.created", {})
    now = float(int(time.time()))
    provider._clock = lambda: now
    body, headers = signed(payload, at=now - 300)
    assert provider.parse_event(body=body, headers=headers) is None
    body, headers = signed(payload, at=now - 301)
    with pytest.raises(port.EventRejectedError):
        provider.parse_event(body=body, headers=headers)


def test_a_signature_that_is_not_hex_is_refused_not_a_crash(stripe):
    provider, _ = stripe
    body, _ = signed(event("customer.created", {}))
    with pytest.raises(port.EventRejectedError):
        provider.parse_event(body=body, headers={"Stripe-Signature": f"t={int(time.time())},v1=é"})


def test_the_signature_header_is_found_whatever_its_case(stripe):
    provider, _ = stripe
    body, headers = signed(event("customer.created", {}))
    assert (
        provider.parse_event(body=body, headers={"stripe-signature": headers["Stripe-Signature"]})
        is None
    )


def test_an_inquiry_withdraws_nothing(stripe):
    _, placed, link = linked(stripe)
    now = time.time()
    deliver(session_event("checkout.session.completed", link, created=now))
    inquiry = {
        "payment_intent": "pi_stub_1",
        "amount": 538_560,
        "currency": "eur",
        "status": "warning_needs_response",
    }
    assert deliver(event("charge.dispute.created", inquiry, created=now + 1)) == "ignored"
    assert states(placed) == ("paid", 538_560)


@pytest.mark.parametrize(
    ("kind", "data"),
    [
        (
            "checkout.session.completed",
            {"id": "cs", "payment_status": "paid", "amount_total": 1, "currency": "eur"},
        ),
        (
            "charge.refunded",
            {"payment_intent": None, "amount": 1, "amount_refunded": 1, "currency": "eur"},
        ),
    ],
)
def test_money_events_without_their_payment_intent_are_refused(stripe, kind, data):
    provider, _ = stripe
    body, headers = signed(event(kind, data))
    with pytest.raises(port.EventRejectedError):
        provider.parse_event(body=body, headers=headers)


def test_a_failed_sepa_debit_spends_its_link_so_the_next_press_opens_a_fresh_one(stripe):
    w, placed, link = linked(stripe)
    now = time.time()
    deliver(session_event("checkout.session.completed", link, paid=False, created=now))
    deliver(session_event("checkout.session.async_payment_failed", link, created=now + 1))
    fresh = payments.create_payment_link(
        invoice_id=placed.invoice.id,
        organisation_id=w.organisation.id,
        return_url="https://app.localhost/i",
    )
    assert fresh.created is True and fresh.link.id != link.id
