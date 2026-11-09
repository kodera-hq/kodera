"""The billing state machines, as the contract names their states.

`OrderState`, `SubscriptionState` and `InvoiceState` of contracts/core-api.openapi.yaml, and the
payment states of the reconciliation (docs/domain/BILLING_MODEL.md §§4–7). A transition not in a
table is refused; the database repeats the invoice table in its guard trigger
(migrations/0002_invoice_guards.py), and a test holds the two equal.
"""

from collections.abc import Mapping

ORDER_STATES = ("placed", "awaiting_payment", "paid", "provisioning", "fulfilled", "cancelled")
SUBSCRIPTION_STATES = ("pending", "active", "past_due", "suspended", "cancelled")
INVOICE_STATES = ("draft", "issued", "paid", "overdue", "void", "credited")
PAYMENT_STATES = ("pending", "processing", "succeeded", "failed", "reversed")

ORDER_TRANSITIONS: Mapping[str, frozenset[str]] = {
    "placed": frozenset({"awaiting_payment", "paid", "cancelled"}),
    "awaiting_payment": frozenset({"paid", "cancelled"}),
    "paid": frozenset({"provisioning"}),
    "provisioning": frozenset({"fulfilled"}),
    "fulfilled": frozenset(),
    "cancelled": frozenset(),
}

SUBSCRIPTION_TRANSITIONS: Mapping[str, frozenset[str]] = {
    "pending": frozenset({"active", "cancelled"}),
    "active": frozenset({"past_due", "cancelled"}),
    "past_due": frozenset({"active", "suspended", "cancelled"}),
    "suspended": frozenset({"active", "cancelled"}),
    "cancelled": frozenset(),
}

# `paid → issued | overdue` is a payment reversed after it was confirmed (a chargeback): the
# invoice owes again. `issued | overdue → credited` is a credit note crediting an unpaid invoice in
# full (services.issue_credit_note). An issued invoice leaves only by payment or credit note: no
# transition reaches `void`, kept in the enum for the records of the contract.
INVOICE_TRANSITIONS: Mapping[str, frozenset[str]] = {
    "draft": frozenset({"issued"}),
    "issued": frozenset({"paid", "overdue", "credited"}),
    "overdue": frozenset({"paid", "credited"}),
    "paid": frozenset({"issued", "overdue"}),
    "void": frozenset(),
    "credited": frozenset(),
}

# A failed attempt may be followed by a success on the same payment; a success may be reversed.
PAYMENT_TRANSITIONS: Mapping[str, frozenset[str]] = {
    "pending": frozenset({"processing", "succeeded", "failed"}),
    # A debit submitted (SEPA) settles or fails days later; no second link while it does.
    "processing": frozenset({"succeeded", "failed"}),
    "failed": frozenset({"succeeded"}),
    "succeeded": frozenset({"reversed"}),
    "reversed": frozenset(),
}


class TransitionRefusedError(Exception):
    """The current state does not allow the requested one: `409 invalid-state-transition`."""

    def __init__(self, machine: str, current: str, requested: str) -> None:
        super().__init__(f"{machine}: {current} → {requested} is not a transition")
        self.machine = machine
        self.current = current
        self.requested = requested


def require_transition(
    table: Mapping[str, frozenset[str]], *, machine: str, current: str, requested: str
) -> None:
    if requested not in table.get(current, frozenset()):
        raise TransitionRefusedError(machine, current, requested)


def predecessors(table: Mapping[str, frozenset[str]], requested: str) -> tuple[str, ...]:
    """The states from which `requested` may be reached: the 409's `allowed_states`."""
    return tuple(state for state, targets in table.items() if requested in targets)
