"""Payment links and webhook reconciliation through the fake provider, against real PostgreSQL.

apps/billing/payments: a delivery is verified, recorded once and applied in the provider's order.
Duplicates change nothing, an older event than the last applied is stale, a reversal delivered
before its success waits for it, and a payment that fails after it was confirmed takes the money
back. Every scenario drives the fake through signed deliveries, as a provider's webhook would.
"""

import itertools
import json
from datetime import timedelta

import pytest
import time_machine
from django.db import connection, transaction
from django.utils import timezone
from test_billing_orders import offer, place, world

from apps.billing.models import Invoice, Order, Payment, PaymentLink, ProviderEvent, Subscription
from apps.billing.payments import configured_provider, port, services as payments
from apps.billing.services import issue_credit_note

pytestmark = pytest.mark.django_db(transaction=True)
_events = itertools.count()


@pytest.fixture
def fake():
    # The configured fake is one object per process: start every test with empty records.
    provider = configured_provider()
    provider.links.clear()
    provider.cancelled.clear()
    return provider


def _placed():
    w = world()
    return w.organisation, place(w, offer())


def _credit(placed):
    """The invoice credited in full by a credit note: no longer owed, never voided."""
    with transaction.atomic():
        invoice = Invoice.objects.select_for_update().get(id=placed.invoice.id)
        issue_credit_note(invoice, reason="customer_cancellation")


def _linked(fake):
    organisation, placed = _placed()
    result = payments.create_payment_link(
        invoice_id=placed.invoice.id, organisation_id=organisation.id
    )
    return organisation, placed, result.link


def _deliver(
    fake,
    link,
    kind,
    *,
    minutes,
    payment_ref="pay_1",
    amount=538_560,
    event_id=None,
    at=None,
    **extra,
):
    body, headers = fake.deliver(
        event_id=event_id or f"evt_{next(_events)}",
        kind=kind,
        payment_ref=payment_ref,
        link_ref=link.provider_ref if link is not None else None,
        amount_minor=amount,
        occurred_at=(at or timezone.now().replace(microsecond=0)) + timedelta(minutes=minutes),
        **extra,
    )
    return payments.receive_event(provider_name="fake", body=body, headers=headers), body, headers


def _states(placed):
    return (
        Order.objects.get(id=placed.order.id).state,
        Subscription.objects.get(id=placed.subscription.id).state,
        Invoice.objects.get(id=placed.invoice.id).state,
        Invoice.objects.get(id=placed.invoice.id).amount_paid_minor,
    )


def _actions(organisation_id=None):
    with connection.cursor() as cursor:
        if organisation_id is None:
            cursor.execute(
                "SELECT action, metadata->>'reason' FROM audit_auditevent"
                " WHERE organisation_id IS NULL ORDER BY occurred_at, id"
            )
        else:
            cursor.execute(
                "SELECT action, metadata->>'reason' FROM audit_auditevent"
                " WHERE organisation_id = %s AND action LIKE 'payment.%%' OR"
                " organisation_id = %s AND action = 'invoice.paid' ORDER BY occurred_at, id",
                [organisation_id, organisation_id],
            )
        return cursor.fetchall()


# --- links ------------------------------------------------------------------------------------


def test_a_link_is_created_once_and_the_order_awaits_payment(fake):
    organisation, placed = _placed()
    first = payments.create_payment_link(
        invoice_id=placed.invoice.id, organisation_id=organisation.id
    )
    again = payments.create_payment_link(
        invoice_id=placed.invoice.id, organisation_id=organisation.id
    )
    assert first.created is True and again.created is False
    assert again.link.id == first.link.id
    assert first.link.url.startswith("https://pay.fake.invalid/")
    assert (first.link.amount_minor, first.link.state) == (538_560, "active")
    assert len(fake.links) == 1 and fake.links[0].invoice_number == placed.invoice.number
    assert _states(placed)[0] == "awaiting_payment"


def test_an_expired_link_is_replaced(fake):
    organisation, placed, link = _linked(fake)
    with time_machine.travel(timezone.now() + timedelta(days=31)):
        fresh = payments.create_payment_link(
            invoice_id=placed.invoice.id, organisation_id=organisation.id
        )
    assert fresh.created is True and fresh.link.id != link.id
    assert PaymentLink.objects.get(id=link.id).state == "expired"


def test_two_first_presses_keep_one_active_link(fake, monkeypatch):
    organisation, placed = _placed()
    real = fake.create_link
    inner = []
    raced = []

    def racing(request):
        if not raced:
            raced.append(True)
            # A concurrent press completes while this one waits on the provider.
            inner.append(
                payments.create_payment_link(
                    invoice_id=placed.invoice.id, organisation_id=organisation.id
                )
            )
        return real(request)

    monkeypatch.setattr(fake, "create_link", racing)
    outer = payments.create_payment_link(
        invoice_id=placed.invoice.id, organisation_id=organisation.id
    )
    assert outer.created is False and outer.link.id == inner[0].link.id
    states = sorted(
        PaymentLink.objects.filter(invoice_id=placed.invoice.id).values_list("state", flat=True)
    )
    assert states == ["active", "cancelled"]


def test_a_link_is_refused_for_an_invoice_that_is_not_owed_or_not_the_organisations(fake):
    organisation, placed = _placed()
    other = world().organisation
    with pytest.raises(Invoice.DoesNotExist):
        payments.create_payment_link(invoice_id=placed.invoice.id, organisation_id=other.id)
    _credit(placed)
    with pytest.raises(payments.InvoiceNotPayableError):
        payments.create_payment_link(invoice_id=placed.invoice.id, organisation_id=organisation.id)
    assert not PaymentLink.objects.exists() and not fake.links


def test_without_a_provider_no_link_is_faked(fake, settings):
    organisation, placed = _placed()
    settings.KODERA_PAYMENT_PROVIDER = None
    with pytest.raises(port.ProviderUnavailableError):
        payments.create_payment_link(invoice_id=placed.invoice.id, organisation_id=organisation.id)
    assert not PaymentLink.objects.exists()


# --- reconciliation ---------------------------------------------------------------------------


def test_a_success_pays_the_invoice_activates_the_subscription_and_marks_the_order_paid(fake):
    organisation, placed, link = _linked(fake)
    outcome, _, _ = _deliver(fake, link, "payment.succeeded", minutes=1)
    assert outcome == "applied"
    assert _states(placed) == ("paid", "active", "paid", 538_560)
    invoice = Invoice.objects.get(id=placed.invoice.id)
    assert invoice.paid_at is not None
    assert PaymentLink.objects.get(id=link.id).state == "used"
    assert Payment.objects.get(provider_ref="pay_1").state == "succeeded"
    assert _actions(organisation.id) == [("payment.received", None), ("invoice.paid", None)]


def test_a_duplicate_delivery_changes_nothing(fake):
    organisation, placed, link = _linked(fake)
    _, body, headers = _deliver(fake, link, "payment.succeeded", minutes=1, event_id="evt_dup")
    assert payments.receive_event(provider_name="fake", body=body, headers=headers) == "duplicate"
    # The same event id delivered with another body is still the event already recorded.
    outcome, _, _ = _deliver(fake, link, "payment.reversed", minutes=2, event_id="evt_dup")
    assert outcome == "duplicate"
    assert _states(placed) == ("paid", "active", "paid", 538_560)
    assert ProviderEvent.objects.filter(event_id="evt_dup").count() == 1
    assert len(_actions(organisation.id)) == 2


@pytest.mark.parametrize("tamper", ["signature", "body", "malformed"])
def test_an_unverified_or_malformed_delivery_is_refused_and_not_recorded(fake, tamper):
    _, placed, link = _linked(fake)
    body, headers = fake.deliver(
        event_id="evt_forged",
        kind="payment.succeeded",
        payment_ref="pay_1",
        link_ref=link.provider_ref,
        amount_minor=538_560,
        occurred_at=timezone.now(),
    )
    if tamper == "signature":
        headers = {"X-Fake-Signature": "0" * 64}
    elif tamper == "body":
        body = body.replace(b"538560", b"1")
    else:
        body = b'{"id": "evt_forged"}'
        headers = {"X-Fake-Signature": fake._signature(body)}
    with pytest.raises(port.EventRejectedError):
        payments.receive_event(provider_name="fake", body=body, headers=headers)
    assert not ProviderEvent.objects.exists()
    assert _states(placed)[2] == "issued"


def test_events_from_another_provider_than_the_configured_one_are_refused(fake):
    with pytest.raises(port.ProviderUnavailableError):
        payments.receive_event(provider_name="stripe", body=b"{}", headers={})


def test_an_older_failure_delivered_after_the_success_is_stale(fake):
    _, placed, link = _linked(fake)
    assert _deliver(fake, link, "payment.succeeded", minutes=2)[0] == "applied"
    assert _deliver(fake, link, "payment.failed", minutes=1)[0] == "stale"
    assert _states(placed) == ("paid", "active", "paid", 538_560)


def test_a_failed_attempt_then_a_success_pays(fake):
    organisation, placed, link = _linked(fake)
    assert _deliver(fake, link, "payment.failed", minutes=1)[0] == "applied"
    assert _states(placed) == ("awaiting_payment", "pending", "issued", 0)
    assert _deliver(fake, link, "payment.succeeded", minutes=2)[0] == "applied"
    assert _states(placed) == ("paid", "active", "paid", 538_560)
    assert [action for action, _ in _actions(organisation.id)] == [
        "payment.failed",
        "payment.received",
        "invoice.paid",
    ]


def test_a_reversal_delivered_before_its_success_waits_for_it(fake):
    _, placed, link = _linked(fake)
    assert _deliver(fake, link, "payment.reversed", minutes=3, event_id="evt_rev")[0] == "deferred"
    assert _states(placed) == ("awaiting_payment", "pending", "issued", 0)
    assert _deliver(fake, link, "payment.succeeded", minutes=2)[0] == "applied"
    assert ProviderEvent.objects.get(event_id="evt_rev").outcome == "applied"
    assert Payment.objects.get(provider_ref="pay_1").state == "reversed"
    # The order stays the record of what was agreed; the invoice owes again.
    assert _states(placed) == ("paid", "past_due", "issued", 0)
    assert Invoice.objects.get(id=placed.invoice.id).paid_at is None


def test_a_deferred_event_older_than_what_it_waited_for_becomes_stale(fake):
    _, placed, link = _linked(fake)
    assert _deliver(fake, link, "payment.reversed", minutes=1, event_id="evt_old")[0] == "deferred"
    assert _deliver(fake, link, "payment.succeeded", minutes=2)[0] == "applied"
    assert ProviderEvent.objects.get(event_id="evt_old").outcome == "stale"
    assert _states(placed) == ("paid", "active", "paid", 538_560)


def test_a_payment_failing_after_confirmation_takes_the_money_back(fake):
    organisation, placed, link = _linked(fake)
    assert _deliver(fake, link, "payment.succeeded", minutes=1)[0] == "applied"
    with time_machine.travel(timezone.now() + timedelta(days=31)):
        assert _deliver(fake, link, "payment.failed", minutes=2)[0] == "applied"
    assert Payment.objects.get(provider_ref="pay_1").state == "reversed"
    # Past its due date, the invoice that owes again is overdue.
    assert _states(placed) == ("paid", "past_due", "overdue", 0)
    assert [action for action, _ in _actions(organisation.id)] == [
        "payment.received",
        "invoice.paid",
        "payment.refunded",
    ]


def test_an_event_for_no_known_payment_waits_and_is_audited(fake):
    outcome, _, _ = _deliver(fake, None, "payment.reversed", minutes=1, payment_ref="pay_ghost")
    assert outcome == "deferred"
    assert ("payment.reconciliation_mismatch", "unknown_payment") in _actions()
    assert not Payment.objects.exists()


def test_an_event_naming_a_link_core_never_issued_is_unmatched(fake):
    body, headers = fake.deliver(
        event_id="evt_unknown_link",
        kind="payment.succeeded",
        payment_ref="pay_ghost",
        link_ref="fake_link_never_issued",
        amount_minor=1,
        occurred_at=timezone.now(),
    )
    assert payments.receive_event(provider_name="fake", body=body, headers=headers) == "unmatched"


@pytest.mark.parametrize(("amount", "currency"), [(1, "EUR"), (538_560, "USD")])
def test_an_amount_or_currency_that_is_not_the_links_is_a_mismatch(fake, amount, currency):
    organisation, placed, link = _linked(fake)
    outcome, _, _ = _deliver(
        fake, link, "payment.succeeded", minutes=1, amount=amount, currency=currency
    )
    assert outcome == "mismatch"
    assert not Payment.objects.exists()
    assert _states(placed) == ("awaiting_payment", "pending", "issued", 0)
    assert _actions(organisation.id) == [("payment.reconciliation_mismatch", "amount_or_currency")]


def test_money_received_for_a_credited_invoice_is_kept_and_flagged(fake):
    organisation, placed, link = _linked(fake)
    _credit(placed)
    assert _deliver(fake, link, "payment.succeeded", minutes=1)[0] == "applied"
    assert _states(placed) == ("awaiting_payment", "pending", "credited", 0)
    assert Payment.objects.get(provider_ref="pay_1").state == "succeeded"
    assert ("payment.reconciliation_mismatch", "invoice_not_payable") in _actions(organisation.id)


def test_a_second_payment_on_a_paid_invoice_is_flagged_as_an_overpayment(fake):
    organisation, placed, link = _linked(fake)
    assert _deliver(fake, link, "payment.succeeded", minutes=1, payment_ref="pay_a")[0] == "applied"
    assert _deliver(fake, link, "payment.succeeded", minutes=2, payment_ref="pay_b")[0] == "applied"
    assert _states(placed) == ("paid", "active", "paid", 2 * 538_560)
    assert ("payment.reconciliation_mismatch", "overpayment") in _actions(organisation.id)


def test_a_reversal_of_one_of_two_payments_keeps_the_invoice_paid(fake):
    _, placed, link = _linked(fake)
    _deliver(fake, link, "payment.succeeded", minutes=1, payment_ref="pay_a")
    _deliver(fake, link, "payment.succeeded", minutes=2, payment_ref="pay_b")
    assert _deliver(fake, link, "payment.reversed", minutes=3, payment_ref="pay_b")[0] == "applied"
    assert _states(placed) == ("paid", "active", "paid", 538_560)


def test_a_reversal_delivered_while_the_payment_had_failed_waits_for_the_success(fake):
    _, placed, link = _linked(fake)
    assert _deliver(fake, link, "payment.failed", minutes=1)[0] == "applied"
    assert _deliver(fake, link, "payment.reversed", minutes=3, event_id="evt_rev2")[0] == "deferred"
    assert _deliver(fake, link, "payment.succeeded", minutes=2)[0] == "applied"
    assert ProviderEvent.objects.get(event_id="evt_rev2").outcome == "applied"
    assert _states(placed) == ("paid", "past_due", "issued", 0)


def test_a_link_obtained_for_an_invoice_paid_meanwhile_is_withdrawn(fake, monkeypatch):
    organisation, placed = _placed()
    real = fake.create_link

    def paid_meanwhile(request):
        issued = real(request)
        Invoice.objects.filter(id=placed.invoice.id).update(
            amount_paid_minor=placed.invoice.total_incl_vat_minor
        )
        return issued

    monkeypatch.setattr(fake, "create_link", paid_meanwhile)
    with pytest.raises(payments.InvoiceNotPayableError):
        payments.create_payment_link(invoice_id=placed.invoice.id, organisation_id=organisation.id)
    (link,) = PaymentLink.objects.filter(invoice_id=placed.invoice.id)
    assert link.state == "cancelled" and fake.cancelled == [link.provider_ref]
    assert _states(placed)[0] == "placed"


def test_money_paid_through_a_withdrawn_link_is_kept_and_flagged(fake, monkeypatch):
    organisation, placed, link = _linked(fake)
    PaymentLink.objects.filter(id=link.id).update(state="cancelled")
    assert _deliver(fake, link, "payment.succeeded", minutes=1)[0] == "applied"
    assert _states(placed) == ("paid", "active", "paid", 538_560)
    assert ("payment.reconciliation_mismatch", "link_not_active") in _actions(organisation.id)


def test_a_reversal_records_the_invoice_state_it_left(fake):
    organisation, placed, link = _linked(fake)
    _deliver(fake, link, "payment.succeeded", minutes=1)
    _deliver(fake, link, "payment.reversed", minutes=2)
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT metadata FROM audit_auditevent WHERE action = 'payment.refunded'"
            " AND organisation_id = %s",
            [organisation.id],
        )
        (metadata,) = cursor.fetchone()
    metadata = metadata if isinstance(metadata, dict) else json.loads(metadata)
    assert (metadata["invoice_state_before"], metadata["invoice_state_after"]) == ("paid", "issued")
    assert metadata["invoice_paid_at"] is not None


def test_a_reversal_of_money_kept_for_a_credited_invoice_leaves_the_invoice_untouched(fake):
    _, placed, link = _linked(fake)
    _credit(placed)
    _deliver(fake, link, "payment.succeeded", minutes=1)
    assert _deliver(fake, link, "payment.reversed", minutes=2)[0] == "applied"
    assert _states(placed) == ("awaiting_payment", "pending", "credited", 0)
    assert Payment.objects.get(provider_ref="pay_1").state == "reversed"


@pytest.mark.parametrize(
    ("first", "second", "expected"),
    [
        ("payment.succeeded", "payment.reversed", ("paid", "past_due", "issued", 0)),
        ("payment.failed", "payment.succeeded", ("paid", "active", "paid", 538_560)),
        ("payment.reversed", "payment.succeeded", ("paid", "past_due", "issued", 0)),
        ("payment.succeeded", "payment.failed", ("paid", "active", "paid", 538_560)),
    ],
)
def test_events_stamped_at_the_same_instant_apply_by_their_kind(fake, first, second, expected):
    _, placed, link = _linked(fake)
    # One instant for both: read twice, the clock can cross a second between the deliveries.
    at = timezone.now().replace(microsecond=0)
    _deliver(fake, link, first, minutes=1, at=at)
    _deliver(fake, link, second, minutes=1, at=at)
    assert _states(placed) == expected


def test_a_paid_invoice_keeps_no_active_link(fake):
    organisation, placed, old = _linked(fake)
    with time_machine.travel(timezone.now() + timedelta(days=31)):
        fresh = payments.create_payment_link(
            invoice_id=placed.invoice.id, organisation_id=organisation.id
        ).link
    # The payment arrives through the expired link; the fresh one is withdrawn with the payment.
    _deliver(fake, old, "payment.succeeded", minutes=1)
    assert _states(placed)[2] == "paid"
    assert PaymentLink.objects.get(id=fresh.id).state == "cancelled"
    assert fresh.provider_ref in fake.cancelled


def test_a_known_payment_delivered_through_another_invoices_link_moves_no_money(fake):
    organisation, placed, link = _linked(fake)
    other_organisation, other_placed, other_link = _linked(fake)
    _deliver(fake, link, "payment.failed", minutes=1)
    assert _deliver(fake, other_link, "payment.succeeded", minutes=2)[0] == "mismatch"
    assert _states(placed)[2] == "issued" and _states(other_placed)[2] == "issued"
    for org in (organisation, other_organisation):
        assert ("payment.reconciliation_mismatch", "link_mismatch") in _actions(org.id)


def test_an_event_id_reused_for_other_facts_is_flagged(fake):
    _, placed, link = _linked(fake)
    _deliver(fake, link, "payment.succeeded", minutes=1, event_id="evt_same")
    assert (
        _deliver(fake, link, "payment.reversed", minutes=2, event_id="evt_same")[0] == "duplicate"
    )
    assert ("payment.reconciliation_mismatch", "event_id_reused") in _actions()
    assert _states(placed)[2] == "paid"


class _Log:
    def __init__(self):
        self.lines = []

    def warning(self, message, *args):
        self.lines.append(("WARNING", message % args))

    def error(self, message, *args):
        self.lines.append(("ERROR", message % args))


def test_a_withdrawal_with_no_provider_configured_is_a_warning(monkeypatch, settings):
    settings.KODERA_PAYMENT_PROVIDER = None
    log = _Log()
    monkeypatch.setattr(payments, "LOG", log)
    payments._cancel_at_provider("stripe", "cs_1")
    assert log.lines == [("WARNING", "payment link cs_1 not withdrawn: stripe is not configured")]


def test_a_withdrawal_the_provider_did_not_answer_is_an_error(fake, monkeypatch):
    """A configured provider that is down is an outage that leaves a payable link open: logged
    as an error naming the failure, never as a deployment with no provider."""

    def down(provider_ref):
        raise port.ProviderUnavailableError("timed out")

    monkeypatch.setattr(fake, "cancel_link", down)
    log = _Log()
    monkeypatch.setattr(payments, "LOG", log)
    payments._cancel_at_provider(fake.name, "cs_2")
    assert log.lines == [
        ("ERROR", f"payment link cs_2 not withdrawn at {fake.name}: ProviderUnavailableError")
    ]
