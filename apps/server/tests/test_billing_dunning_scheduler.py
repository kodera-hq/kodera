"""Real ledger collection replay, authority, legal clocks and immutable evidence."""

from datetime import timedelta
from unittest.mock import patch
from uuid import uuid4

import pytest
from django.db import IntegrityError, transaction
from django.utils import timezone
from test_billing_orders import offer, place, world
from test_complimentary_order import staff

from apps.billing.dunning import DunningRefusedError
from apps.billing.dunning_scheduler import confirm_action, record_dispute, schedule_subscription
from apps.billing.models import DunningAction, DunningCase, DunningDispute, Invoice, Subscription
from apps.identity.command_principal import staff_principal_for_command
from apps.identity.models import StaffRole
from apps.support.models import SupportTicket

pytestmark = pytest.mark.django_db(transaction=True)


def debt():
    now = timezone.now()
    from apps.billing import services

    allocate = services._allocate

    def frozen(series):
        number, _ = allocate(series)
        return number, now - timedelta(days=140)

    with (
        patch("django.utils.timezone.now", return_value=now - timedelta(days=140)),
        patch("apps.billing.services._allocate", side_effect=frozen),
    ):
        w = world()
        placed = place(w, offer())
    Subscription.objects.filter(id=placed.subscription.id).update(state="active")
    principal = staff_principal_for_command(staff("dunning-" + uuid4().hex).id)
    return w, placed, principal, now


def confirm(principal, action, at, **kwargs):
    with patch("django.utils.timezone.now", return_value=max(at, kwargs.get("receipt_at") or at)):
        return confirm_action(
            principal=principal,
            action_id=action.id,
            delivered_at=at,
            evidence_ref="urn:kodera:evidence:" + str(uuid4()),
            **kwargs,
        )


def prepare(subscription, at):
    with patch("django.utils.timezone.now", return_value=at):
        return schedule_subscription(subscription.id)


def test_scheduler_replay_and_immutable_confirmed_evidence():
    _, placed, principal, now = debt()
    first = prepare(placed.subscription, now - timedelta(days=40))
    assert first.id == prepare(placed.subscription, now - timedelta(days=40)).id
    assert DunningAction.objects.count() == 1
    assert Invoice.objects.get(id=placed.invoice.id).state == "overdue"
    assert Subscription.objects.get(id=placed.subscription.id).state == "past_due"
    confirmed = confirm(principal, first, now - timedelta(days=39))
    assert confirmed.state == "confirmed"
    with pytest.raises(IntegrityError, match="immutable"), transaction.atomic():
        DunningAction.objects.filter(id=first.id).update(
            evidence_ref="urn:kodera:evidence:" + str(uuid4())
        )
    with pytest.raises(IntegrityError, match="retained"), transaction.atomic():
        confirmed.delete()


def test_confirmation_rechecks_revoked_staff():
    _, placed, principal, now = debt()
    action = prepare(placed.subscription, now - timedelta(days=1))
    StaffRole.objects.filter(identity_id=principal.identity_id).update(revoked_at=timezone.now())
    with pytest.raises(DunningRefusedError, match="staff_operator"):
        confirm(principal, action, now)
    assert DunningAction.objects.get(id=action.id).state == "prepared"


def test_legal_ladder_waits_for_deliveries_receipt_and_real_transition_job():
    _, placed, principal, now = debt()
    first = prepare(placed.subscription, now - timedelta(days=70))
    confirm(principal, first, now - timedelta(days=69))
    assert prepare(placed.subscription, now - timedelta(days=60)) is None
    second = prepare(placed.subscription, now - timedelta(days=54))
    confirm(principal, second, now - timedelta(days=53))
    assert prepare(placed.subscription, now - timedelta(days=45)) is None
    formal = prepare(placed.subscription, now - timedelta(days=38))
    with pytest.raises(DunningRefusedError, match="receipt_required"):
        confirm(principal, formal, now - timedelta(days=37))
    confirm(principal, formal, now - timedelta(days=37), receipt_at=now - timedelta(days=36))
    notice = prepare(placed.subscription, now - timedelta(days=29))
    confirm(principal, notice, now - timedelta(days=28))
    suspension = prepare(placed.subscription, now - timedelta(days=20))
    assert suspension.step == "suspended"
    with pytest.raises(DunningRefusedError, match="transition_job_evidence"):
        confirm(principal, suspension, now - timedelta(days=19))
    assert Subscription.objects.get(id=placed.subscription.id).state == "past_due"


def test_dispute_is_ticket_scoped_amount_bounded_and_idempotent():
    w, placed, principal, now = debt()
    ticket = SupportTicket.objects.create(
        organisation=w.organisation,
        created_by=w.owner,
        subject="Invoice dispute",
        body="Synthetic billing dispute evidence",
        category="billing",
        severity="question",
        locale="en",
    )
    hold = now + timedelta(days=10)
    row = record_dispute(
        principal=principal,
        invoice_id=placed.invoice.id,
        ticket_id=ticket.id,
        amount_minor=placed.invoice.total_incl_vat_minor,
        hold_until=hold,
    )
    assert (
        record_dispute(
            principal=principal,
            invoice_id=placed.invoice.id,
            ticket_id=ticket.id,
            amount_minor=row.amount_minor,
            hold_until=hold,
        ).id
        == row.id
    )
    assert schedule_subscription(placed.subscription.id) is None
    assert not DunningAction.objects.exists()
    with pytest.raises(IntegrityError, match="immutable"), transaction.atomic():
        DunningDispute.objects.filter(id=row.id).update(amount_minor=1)
    other = world()
    other_ticket = SupportTicket.objects.create(
        organisation=other.organisation,
        created_by=other.owner,
        subject="Other dispute",
        body="Synthetic billing dispute evidence",
        category="billing",
        severity="question",
        locale="en",
    )
    with pytest.raises(DunningRefusedError, match="ticket_required"):
        record_dispute(
            principal=principal,
            invoice_id=placed.invoice.id,
            ticket_id=other_ticket.id,
            amount_minor=1,
            hold_until=hold,
        )


def test_day_zero_overdue_does_not_claim_notice_delivery():
    _, placed, _, _ = debt()
    assert prepare(placed.subscription, placed.invoice.due_at + timedelta(hours=1)) is None
    assert Invoice.objects.get(id=placed.invoice.id).state == "overdue"
    assert DunningCase.objects.get(subscription=placed.subscription).state == "past_due"
    assert not DunningAction.objects.exists()


def test_payment_after_prepare_cancels_proposal_and_starts_new_episode():
    _, placed, principal, now = debt()
    action = prepare(placed.subscription, now - timedelta(days=1))
    episode = action.episode
    Invoice.objects.filter(id=placed.invoice.id).update(
        state="paid", amount_paid_minor=placed.invoice.total_incl_vat_minor, paid_at=now
    )
    assert schedule_subscription(placed.subscription.id) is None
    action.refresh_from_db()
    assert action.state == "cancelled"
    assert DunningCase.objects.get(subscription=placed.subscription).episode != episode
    assert Subscription.objects.get(id=placed.subscription.id).state == "active"
    with pytest.raises(DunningRefusedError, match="stale_or_held"):
        confirm(principal, action, now)


def test_current_processing_payment_holds_prepared_confirmation():
    from apps.billing.models import Payment

    _, placed, principal, now = debt()
    action = prepare(placed.subscription, now - timedelta(days=1))
    Payment.objects.create(
        organisation_id=placed.invoice.organisation_id,
        invoice=placed.invoice,
        provider="synthetic",
        provider_ref="processing",
        state="processing",
        amount_minor=placed.invoice.total_incl_vat_minor,
        currency="EUR",
        last_event_at=now - timedelta(hours=1),
    )
    with pytest.raises(DunningRefusedError, match="stale_or_held"):
        confirm(principal, action, now)
    assert DunningAction.objects.get(id=action.id).state == "prepared"


def test_confirmation_exact_replay_is_idempotent():
    _, placed, principal, now = debt()
    action = prepare(placed.subscription, now - timedelta(days=1))
    done = confirm(principal, action, now - timedelta(hours=1))
    replay = confirm_action(
        principal=principal,
        action_id=action.id,
        delivered_at=done.delivered_at,
        evidence_ref=done.evidence_ref,
    )
    assert replay.id == done.id
    with pytest.raises(DunningRefusedError, match="confirmation_reuse"):
        confirm(principal, done, now)


def test_full_dispute_or_future_invoice_clears_case_when_no_undisputed_debt_is_overdue():
    w, placed, principal, now = debt()
    first = prepare(placed.subscription, now - timedelta(days=20))
    confirm(principal, first, now - timedelta(days=19))
    second = prepare(placed.subscription, now - timedelta(days=4))
    episode = second.episode
    ticket = SupportTicket.objects.create(
        organisation=w.organisation,
        created_by=w.owner,
        subject="Disputed balance",
        body="Full dispute covering overdue invoice",
        category="billing",
        severity="question",
        locale="en",
    )
    record_dispute(
        principal=principal,
        invoice_id=placed.invoice.id,
        ticket_id=ticket.id,
        amount_minor=placed.invoice.total_incl_vat_minor,
        hold_until=now + timedelta(days=10),
    )
    assert schedule_subscription(placed.subscription.id) is None
    second.refresh_from_db()
    assert second.state == "cancelled"
    case = DunningCase.objects.get(subscription=placed.subscription)
    assert case.state == "current"
    assert case.episode != episode
    assert Subscription.objects.get(id=placed.subscription.id).state == "active"
