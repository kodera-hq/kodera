"""Dunning refusal vectors preserve notice order, legal gaps and supervised transitions."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest

from apps.billing.dunning import Debt, DeliveredStep, DunningRefusedError, propose, require_release
from apps.billing.integrity import IntegrityRefusedError
from apps.billing.reconciliation import _observations

NOW = datetime(2026, 11, 13, 12, tzinfo=UTC)
SUB = UUID(int=1)
INVOICE = UUID(int=2)


def plan(*, debts=None, delivered=()):
    if debts is None:
        debts = (Debt(INVOICE, NOW - timedelta(days=100), 1200),)
    return propose(subscription_id=SUB, debts=debts, delivered=delivered, now=NOW)


def test_old_debt_starts_with_first_reminder_and_has_stable_idempotency_key():
    first = plan()
    assert first.step == "reminder_1"
    assert first == plan()
    assert not first.requires_staff_operator


def test_delayed_notice_never_skips_its_minimum_delivery_gap():
    assert plan(delivered=(DeliveredStep("reminder_1", NOW),)) is None
    second = plan(delivered=(DeliveredStep("reminder_1", NOW - timedelta(days=14)),))
    assert second.step == "reminder_2"


def test_processing_payment_holds_ladder_without_clearing_it():
    assert (
        plan(
            debts=(
                Debt(
                    INVOICE,
                    NOW - timedelta(days=100),
                    1200,
                    processing_since=NOW - timedelta(days=2),
                ),
            ),
            delivered=(DeliveredStep("reminder_1", NOW - timedelta(days=30)),),
        )
        is None
    )


def test_only_disputed_amount_is_held_and_partial_dispute_still_owes_the_rest():
    held = Debt(INVOICE, NOW - timedelta(days=100), 1200, 1200, NOW + timedelta(days=10))
    assert plan(debts=(held,)) is None
    partial = Debt(INVOICE, held.due_at, 1200, 1000, held.dispute_hold_until)
    assert plan(debts=(partial,)).step == "reminder_1"


def test_suspension_requires_seven_days_notice_then_current_staff_confirmation():
    trail = tuple(
        DeliveredStep(step, NOW - timedelta(days=40 - i * 10))
        for i, step in enumerate(("reminder_1", "reminder_2", "formal_notice", "suspension_notice"))
    )
    proposal = plan(delivered=trail)
    assert proposal.step == "suspended"
    with pytest.raises(DunningRefusedError, match="dunning_staff_operator_confirmation_required"):
        require_release(proposal, staff_operator=False)
    require_release(proposal, staff_operator=True)
    short = (*trail[:-1], DeliveredStep("suspension_notice", NOW - timedelta(days=6)))
    assert plan(delivered=short) is None


def test_termination_waits_for_actual_formal_notice_receipt_plus_thirty_days():
    trail = tuple(
        DeliveredStep(step, NOW - timedelta(days=60 - i * 10))
        for i, step in enumerate(
            ("reminder_1", "reminder_2", "formal_notice", "suspension_notice", "suspended")
        )
    )
    assert plan(delivered=trail) is None


def test_missing_notice_mutation_is_named_and_refused():
    with pytest.raises(DunningRefusedError, match="dunning_notice_trail_out_of_order"):
        plan(delivered=(DeliveredStep("suspension_notice", NOW - timedelta(days=10)),))


@pytest.mark.parametrize(
    "mutation",
    [
        {},
        {"schema_version": 2, "invoices": [], "payments": []},
        {
            "schema_version": 1,
            "invoices": [
                {"core_invoice_id": str(INVOICE), "amount_minor": True, "currency": "EUR"}
            ],
            "payments": [],
        },
        {
            "schema_version": 1,
            "invoices": [],
            "payments": [{"provider": "fixture", "provider_ref": "one"}] * 2,
        },
    ],
)
def test_reconciliation_observation_mutations_refuse(mutation):
    with pytest.raises(IntegrityRefusedError, match="reconciliation_observations"):
        _observations(mutation)
