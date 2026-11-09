"""One order in flight per organisation, and the cancellation of an order not yet paid.

docs/domain/BILLING_MODEL.md §4.1, against real PostgreSQL: the owner cancels an order `placed` or
`awaiting_payment` (`cancelOrder`), and the `system` one whose invoice is unpaid past its due date
(`cancel_unpaid_orders`), only while its invoice is a draft: an issued invoice is never voided, and
waits for credit notes (`invoice-issued`). A cancelled order's pending subscription, draft invoice
and `ordered` tenant go with it.
"""

import threading
from datetime import timedelta
from uuid import uuid4

import pytest
import time_machine
from django.core.management import CommandError, call_command
from django.db import connection, transaction
from django.utils import timezone
from test_billing_orders import KEY, member, offer, place, world
from test_billing_payments import fake as fake

from apps.billing import services
from apps.billing.callers import BillingForbiddenError, BillingNotFoundError
from apps.billing.models import (
    CreditNote,
    Invoice,
    InvoiceLine,
    Order,
    Payment,
    PaymentLink,
    Subscription,
)
from apps.billing.payments import services as payments
from apps.billing.services import Accepted, Agreements
from apps.billing.states import TransitionRefusedError
from apps.tenancy.models import Tenant

pytestmark = pytest.mark.django_db(transaction=True)


def _rows(placed):
    invoice = Invoice.objects.filter(id=placed.invoice.id).first()
    return (
        Order.objects.get(id=placed.order.id).state,
        Subscription.objects.get(id=placed.subscription.id).state,
        None if invoice is None else invoice.state,
        Tenant.objects.get(id=placed.order.tenant_id).status,
    )


def _audit(organisation_id):
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT action, actor_type, metadata->>'reason' FROM audit_auditevent"
            " WHERE organisation_id = %s AND action IN"
            " ('subscription.cancelled', 'invoice.voided', 'credit_note.issued', 'tenant.deleted')"
            " ORDER BY occurred_at, id",
            [organisation_id],
        )
        return cursor.fetchall()


@pytest.fixture
def drafted(monkeypatch):
    """Place an order whose invoice stays a draft: the one an order can be cancelled with."""

    def place_draft(w, price=None, **changes):
        with monkeypatch.context() as patched:
            patched.setattr(services, "issue_invoice", lambda invoice, **kwargs: None)
            return place(w, price or offer(), **changes)

    return place_draft


def _cancel(w, placed, token=None):
    return services.cancel_order(
        verified=token or w.token, order_id=placed.order.id, request_id="request-0002"
    )


# --- one order in flight ------------------------------------------------------------------------


@pytest.mark.parametrize("held_by", ["placed", "awaiting_payment"])
def test_an_order_in_flight_refuses_the_next(held_by):
    w = world()
    price = offer()
    first = place(w, price)
    Order.objects.filter(id=first.order.id).update(state=held_by)
    with pytest.raises(services.OrderInProgressError):
        place(w, price, key=KEY + "b")
    assert Order.objects.filter(organisation_id=w.organisation.id).count() == 1


@pytest.mark.parametrize("settled", ["paid", "provisioning", "fulfilled", "cancelled"])
def test_a_settled_order_lets_the_organisation_order_its_next_tenant(settled):
    w = world()
    first = place(w, offer())
    Order.objects.filter(id=first.order.id).update(state=settled)
    # Another pack for a second tenant of the same organisation (MODEL.md: one or more tenants).
    second = place(w, offer(), key=KEY + "b")
    assert second.order.id != first.order.id and second.replayed is False
    assert Tenant.objects.filter(organisation_id=w.organisation.id).count() == 2


def test_the_order_in_flight_is_answered_before_anything_the_request_names():
    """ "Whatever its key, its DPA or its slug": a second order naming a CGV version not in force
    is refused for the order in flight, not for its CGV."""
    w = world()
    price = offer()
    place(w, price)
    stale = Agreements(
        dpa_id=uuid4(), documents=(Accepted(code="cgv", version="9.9", locale="fr"),)
    )
    with pytest.raises(services.OrderInProgressError):
        place(w, price, key=KEY + "b", agreements=stale)


# --- an issued invoice is credited, never voided -------------------------------------------------


def _credit_notes(invoice_id):
    return list(CreditNote.objects.filter(invoice_id=invoice_id))


@pytest.mark.parametrize("invoice_state", ["issued", "overdue"])
@pytest.mark.parametrize("state", ["placed", "awaiting_payment"])
def test_the_owner_cancels_an_order_and_a_credit_note_credits_its_invoice(
    state, invoice_state, fake
):
    w = world()
    placed = place(w, offer())
    link = payments.create_payment_link(
        invoice_id=placed.invoice.id, organisation_id=w.organisation.id
    ).link
    Order.objects.filter(id=placed.order.id).update(state=state)
    Invoice.objects.filter(id=placed.invoice.id).update(state=invoice_state)
    _cancel(w, placed)
    assert _rows(placed) == ("cancelled", "cancelled", "credited", "deleted")
    (note,) = _credit_notes(placed.invoice.id)
    invoice = Invoice.objects.get(id=placed.invoice.id)
    assert note.number.startswith("AV-TST-") and note.reason == "customer_cancellation"
    assert (note.total_incl_vat_minor, note.currency) == (invoice.total_incl_vat_minor, "EUR")
    # The link is cancelled, and withdrawn at the provider once the cancellation committed; the
    # operator command asks again, for a cancellation made where no provider is configured.
    assert PaymentLink.objects.get(id=link.id).state == "cancelled"
    assert fake.cancelled == [link.provider_ref]
    assert payments.withdraw_cancelled_links() == 1
    assert _audit(w.organisation.id) == [
        ("subscription.cancelled", "tenant", "customer"),
        ("credit_note.issued", "system", "customer_cancellation"),
        ("tenant.deleted", "system", "customer"),
    ]
    # A second cancellation answers the order as it is and writes nothing.
    assert _cancel(w, placed).state == "cancelled" and len(_credit_notes(placed.invoice.id)) == 1


def test_a_cancellation_that_rolls_back_withdraws_no_link(fake):
    """The provider is asked only once the cancellation has committed."""
    w = world()
    placed = place(w, offer())
    payments.create_payment_link(invoice_id=placed.invoice.id, organisation_id=w.organisation.id)

    class AbortError(Exception):
        pass

    with pytest.raises(AbortError):
        with transaction.atomic():
            _cancel(w, placed)
            raise AbortError()
    assert fake.cancelled == [] and _rows(placed)[0] == "awaiting_payment"


def test_a_payment_received_or_settling_holds_the_order(fake):
    w = world()
    placed = place(w, offer())
    # A partial transfer: only a partial credit with a refund would correct it.
    Invoice.objects.filter(id=placed.invoice.id).update(amount_paid_minor=100)
    with pytest.raises(services.OrderInvoiceIssuedError):
        _cancel(w, placed)
    Invoice.objects.filter(id=placed.invoice.id).update(amount_paid_minor=0)
    Payment.objects.create(
        organisation_id=w.organisation.id,
        invoice_id=placed.invoice.id,
        provider="fake",
        provider_ref="pay_settling",
        state="processing",
        amount_minor=placed.invoice.total_incl_vat_minor,
        currency="EUR",
        last_event_at=timezone.now(),
    )
    with pytest.raises(services.OrderInvoiceIssuedError):
        _cancel(w, placed)
    assert _rows(placed) == ("placed", "pending", "issued", "ordered")
    assert _credit_notes(placed.invoice.id) == [] and _audit(w.organisation.id) == []
    # Past the settlement window the debit no longer holds it.
    with time_machine.travel(timezone.now() + services.SETTLEMENT_WINDOW + timedelta(hours=1)):
        _cancel(w, placed)
    assert _rows(placed)[0] == "cancelled"


# --- the owner cancels while the invoice is a draft --------------------------------------------


def test_the_owner_cancels_an_order_with_a_draft_invoice_and_orders_again(drafted):
    w = world()
    placed = drafted(w)
    assert Invoice.objects.get(id=placed.invoice.id).state == "draft"
    cancelled = _cancel(w, placed)
    assert cancelled.state == "cancelled"
    # The draft and its lines are discarded: it had no number and was never sent.
    assert _rows(placed) == ("cancelled", "cancelled", None, "deleted")
    assert not InvoiceLine.objects.filter(invoice_id=placed.invoice.id).exists()
    assert Subscription.objects.get(id=placed.subscription.id).cancelled_at is not None
    # The tenant row is kept, and its slug with it.
    assert Tenant.objects.filter(id=placed.order.tenant_id).exists()
    assert _audit(w.organisation.id) == [
        ("subscription.cancelled", "tenant", "customer"),
        ("tenant.deleted", "system", "customer"),
    ]
    # A second cancellation answers the order as it is and writes nothing.
    again = _cancel(w, placed)
    assert again.state == "cancelled" and len(_audit(w.organisation.id)) == 2
    # A new key, a new DPA and a new slug: the organisation orders again.
    assert place(w, offer(), key=KEY + "b").order.state == "placed"


@pytest.mark.parametrize("state", ["paid", "provisioning", "fulfilled"])
def test_a_paid_order_is_not_cancelled(state, drafted):
    w = world()
    placed = drafted(w)
    Order.objects.filter(id=placed.order.id).update(state=state)
    with pytest.raises(TransitionRefusedError) as refused:
        _cancel(w, placed)
    assert (refused.value.current, refused.value.requested) == (state, "cancelled")
    assert _rows(placed)[1:] == ("pending", "draft", "ordered")


def test_two_cancellations_at_once_write_once(monkeypatch, drafted):
    """Each cancellation locks its rows before it reads them: the second waits for the first and
    finds the order cancelled. Unlocked, both would read it in flight and both write."""
    w = world()
    placed = drafted(w)
    real = services.require_transition
    arrived = threading.Semaphore(0)

    def meet(*args, **kwargs):
        # Give the other cancellation two seconds to reach this point too.
        arrived.release()
        arrived.acquire(timeout=2)
        return real(*args, **kwargs)

    monkeypatch.setattr(services, "require_transition", meet)
    failures = []

    def cancel():
        try:
            _cancel(w, placed)
        except BaseException as failure:  # re-raised below, on the test's own thread
            failures.append(failure)
        finally:
            connection.close()

    threads = [threading.Thread(target=cancel) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    if failures:
        raise failures[0]
    assert _rows(placed) == ("cancelled", "cancelled", None, "deleted")
    assert len(_audit(w.organisation.id)) == 2


def test_a_suspended_organisation_may_cancel_an_order_not_yet_paid(drafted):
    w = world()
    placed = drafted(w)
    type(w.organisation).objects.filter(id=w.organisation.id).update(state="suspended")
    _cancel(w, placed)
    assert _rows(placed)[0] == "cancelled"


def test_only_the_owner_of_the_organisation_cancels(drafted):
    w = world()
    placed = drafted(w)
    for role in ("org_admin", "org_billing"):
        with pytest.raises(BillingForbiddenError):
            _cancel(w, placed, token=member(w, role))
    stranger = world()
    with pytest.raises(BillingNotFoundError):
        _cancel(w, placed, token=stranger.token)
    with pytest.raises(BillingNotFoundError):
        services.cancel_order(verified=w.token, order_id=stranger.organisation.id)
    assert _rows(placed) == ("placed", "pending", "draft", "ordered")


# --- the system's sweep -----------------------------------------------------------------------


def test_the_lapse_refuses_to_run_until_it_is_enabled():
    with pytest.raises(CommandError, match="not enabled"):
        call_command("cancel_unpaid_orders")


def test_an_order_past_its_due_date_is_cancelled_with_a_credit_note(capsys, settings):
    settings.KODERA_UNPAID_LAPSE_ENABLED = True
    w, held = world(), world()
    placed, other = place(w, offer()), place(held, offer())
    Invoice.objects.filter(id=other.invoice.id).update(amount_paid_minor=100)
    due = Invoice.objects.get(id=placed.invoice.id).due_at
    # Within the payment term (CGV 8.3) the sweep does not even look at it.
    with time_machine.travel(due - timedelta(minutes=1)):
        assert services.cancel_unpaid_orders() == (0, 0)
    with time_machine.travel(due + services.UNPAID_ORDER_GRACE + timedelta(hours=1)):
        call_command("cancel_unpaid_orders")
    assert capsys.readouterr().out == "cancel_unpaid_orders cancelled=1 held=1\n"
    assert _rows(placed) == ("cancelled", "cancelled", "credited", "deleted")
    assert _rows(other)[0] == "placed"
    assert _audit(w.organisation.id) == [
        ("subscription.cancelled", "system", "unpaid"),
        ("credit_note.issued", "system", "unpaid_lapse"),
        ("tenant.deleted", "system", "unpaid"),
    ]


def test_an_order_paid_while_the_sweep_runs_is_held_not_fatal(monkeypatch):
    w = world()
    placed = place(w, offer())
    due = Invoice.objects.get(id=placed.invoice.id).due_at
    real = services._cancel

    def paid_meanwhile(order_id, **kwargs):
        # Paid between the listing and the lock: the transition is refused, the sweep goes on.
        Order.objects.filter(id=order_id).update(state="paid")
        return real(order_id, **kwargs)

    monkeypatch.setattr(services, "_cancel", paid_meanwhile)
    with time_machine.travel(due + services.UNPAID_ORDER_GRACE + timedelta(hours=1)):
        assert services.cancel_unpaid_orders() == (0, 1)
    # The simulated payment was written in the refused order's own transaction, rolled back with it.
    assert _rows(placed) == ("placed", "pending", "issued", "ordered")
