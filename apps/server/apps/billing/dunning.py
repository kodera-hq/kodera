"""Conservative dunning proposals; delivery and tenant transitions retain their own authority.

The planner never labels an unsent notice as sent, skips a statutory step, or changes tenant
state. A dispute holds only its amount. Every proposed job carries a stable idempotency key.
"""

import hashlib
from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID


class DunningRefusedError(ValueError):
    """An incomplete trail cannot authorize collection or a destructive tenant transition."""


@dataclass(frozen=True)
class Debt:
    invoice_id: UUID
    due_at: datetime
    owed_minor: int
    disputed_minor: int = 0
    dispute_hold_until: datetime | None = None
    processing_since: datetime | None = None


@dataclass(frozen=True)
class DeliveredStep:
    step: str
    delivered_at: datetime
    receipt_at: datetime | None = None


@dataclass(frozen=True)
class Proposal:
    step: str
    invoice_id: UUID | None
    idempotency_key: str
    requires_staff_operator: bool


# (minimum debt age, minimum gap from the previous actual delivery), never from a proposal.
STEPS = (
    ("reminder_1", 7, 0),
    ("reminder_2", 21, 14),
    ("formal_notice", 35, 14),
    ("suspension_notice", 60, 0),
    ("suspended", 67, 7),
    ("terminated", 90, 0),
)


def propose(
    *,
    subscription_id: UUID,
    debts: tuple[Debt, ...],
    delivered: tuple[DeliveredStep, ...],
    now: datetime,
) -> Proposal | None:
    if now.tzinfo is None:
        raise DunningRefusedError("dunning_clock_requires_offset")
    if any(
        row.delivered_at.tzinfo is None
        or (
            row.receipt_at is not None
            and (
                row.receipt_at.tzinfo is None
                or row.receipt_at < row.delivered_at
                or row.receipt_at > now
            )
        )
        for row in delivered
    ):
        raise DunningRefusedError("dunning_notice_trail_date_invalid")
    names = tuple(step.step for step in delivered)
    if names != tuple(step for step, _, _ in STEPS[: len(delivered)]):
        raise DunningRefusedError("dunning_notice_trail_out_of_order")
    if any(row.delivered_at > now for row in delivered) or any(
        right.delivered_at < left.delivered_at
        for left, right in zip(delivered, delivered[1:], strict=False)
    ):
        raise DunningRefusedError("dunning_notice_trail_date_invalid")
    due = []
    processing_held = False
    if len({row.invoice_id for row in debts}) != len(debts):
        raise DunningRefusedError("dunning_duplicate_debt")
    for debt in debts:
        if (
            any(
                not isinstance(value, int) or isinstance(value, bool)
                for value in (debt.owed_minor, debt.disputed_minor)
            )
            or debt.owed_minor < 0
            or not 0 <= debt.disputed_minor <= debt.owed_minor
        ):
            raise DunningRefusedError("dunning_debt_amount_invalid")
        if (
            debt.due_at.tzinfo is None
            or any(
                moment is not None and moment.tzinfo is None
                for moment in (debt.dispute_hold_until, debt.processing_since)
            )
            or (debt.processing_since is not None and debt.processing_since > now)
        ):
            raise DunningRefusedError("dunning_debt_date_invalid")
        hold = (
            debt.disputed_minor
            if debt.dispute_hold_until is not None and debt.dispute_hold_until > now
            else 0
        )
        if debt.owed_minor <= hold or debt.due_at >= now:
            continue
        if debt.processing_since is not None and debt.processing_since + timedelta(days=20) > now:
            processing_held = True
            continue
        due.append(debt)
    if not due:
        if processing_held:
            return None
        if not delivered or delivered[-1].step == "terminated":
            return None
        step, invoice_id, supervised = "cleared", None, False
    else:
        if len(delivered) >= len(STEPS):
            return None
        oldest = min(due, key=lambda row: (row.due_at, str(row.invoice_id)))
        step, age, gap = STEPS[len(delivered)]
        if now < oldest.due_at + timedelta(days=age):
            return None
        if delivered and now < delivered[-1].delivered_at + timedelta(days=gap):
            return None
        if step == "terminated":
            formal = next(row for row in delivered if row.step == "formal_notice")
            if formal.receipt_at is None or now < formal.receipt_at + timedelta(days=30):
                return None
        invoice_id, supervised = oldest.invoice_id, step in {"suspended", "terminated"}
    key = hashlib.sha256(f"{subscription_id}:{step}:{invoice_id}".encode()).hexdigest()
    return Proposal(step, invoice_id, key, supervised)


def require_release(proposal: Proposal, *, staff_operator: bool) -> None:
    if proposal.requires_staff_operator and not staff_operator:
        raise DunningRefusedError("dunning_staff_operator_confirmation_required")
