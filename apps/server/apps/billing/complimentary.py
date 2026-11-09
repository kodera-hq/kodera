"""An order settled as complimentary by a staff operator.

The organisation's owner places the order as any other, accepting the CGV and the DPA, which no
one may accept on their behalf; Core issues its invoice. A staff operator then settles it with a
mandatory reason: its unpaid invoice is credited in full by a credit note (`complimentary`), its
active payment links are cancelled, the order becomes `paid` and its pending subscription
`active`, audited as `order.complimentary` with the operator as actor. One actor, no second
approval, no charge. An invoice a payment holds is never credited: the order is refused.

Not in the API image: `.dockerignore` admits no line that names it. The command that calls it runs
from the operator image.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import partial
from uuid import UUID

from django.conf import settings
from django.db import transaction

from apps.identity.selectors import current_staff_grant
from apps.identity.staff import StaffPrincipal

from . import events
from .actors import Actor
from .models import CreditNote, Invoice, Order, PaymentLink, Subscription
from .services import CREDITABLE, IN_FLIGHT, _payment_held, _withdraw_at_provider, issue_credit_note
from .states import ORDER_TRANSITIONS, SUBSCRIPTION_TRANSITIONS, require_transition
from .switch import require_billing

OPERATOR = "staff_operator"
REASON_LIMIT = 500


class ComplimentaryRefusedError(Exception):
    """A refusal that wrote nothing; its message names the reason."""


@dataclass(frozen=True, slots=True)
class Settled:
    credit_note: CreditNote
    # The tenant the order created, so the operator can check it against its Fleet record.
    tenant_id: UUID | None
    # `activated`, `missing`, or the state a subscription that was not pending was left in.
    subscription: str


def settle_complimentary(
    *, principal: StaffPrincipal, organisation_id: UUID, order_id: UUID, reason: str
) -> Settled:
    """Settle the organisation's order in flight as complimentary: the credit note it issued and
    the order's tenant."""
    # A deployment that does not bill settles nothing (QUICK_WORKSPACE.md §2.2).
    require_billing()
    reason = reason.strip()
    if not reason:
        raise ComplimentaryRefusedError("a reason is required")
    if len(reason) > REASON_LIMIT:
        raise ComplimentaryRefusedError(f"the reason is longer than {REASON_LIMIT} characters")
    with transaction.atomic():
        # Locked, so a revocation of the grant cannot commit between this read and the change.
        if (
            current_staff_grant(
                identity_id=principal.identity_id, role=OPERATOR, lock_principal=True
            )
            is None
        ):
            raise ComplimentaryRefusedError(
                "the staff identity holds no current staff_operator grant"
            )
        # Reconciliation's lock order: invoice, links, subscription, order.
        invoices = list(
            Invoice.objects.select_for_update()
            .filter(order_id=order_id, organisation_id=organisation_id)
            .order_by("created_at", "id")
        )
        links = list(
            PaymentLink.objects.select_for_update().filter(invoice__in=invoices, state="active")
        )
        subscription = Subscription.objects.select_for_update().filter(order_id=order_id).first()
        order = (
            Order.objects.select_for_update()
            .filter(id=order_id, organisation_id=organisation_id)
            .first()
        )
        if order is None:
            raise ComplimentaryRefusedError("the organisation has no order with that id")
        if order.state not in IN_FLIGHT:
            raise ComplimentaryRefusedError(f"the order is {order.state}, not awaiting payment")
        unpaid = [invoice for invoice in invoices if invoice.state in CREDITABLE]
        if len(unpaid) != 1 or len(invoices) != 1:
            raise ComplimentaryRefusedError("the order has no single unpaid issued invoice")
        (invoice,) = unpaid
        # The credit note is numbered `AV-` and this process's series, so that series must be the
        # one the invoice was numbered in (`<series>-<year>-<NNNNN>`): a different one would open
        # a credit note series of its own, which nothing can renumber.
        series = (invoice.number or "").rsplit("-", 2)[0]
        if series != settings.KODERA_INVOICE_SERIES:
            raise ComplimentaryRefusedError(
                f"the invoice is numbered in series {series}, not {settings.KODERA_INVOICE_SERIES}:"
                " give the API's KODERA_INVOICE_SERIES"
            )
        if _payment_held(invoice):
            raise ComplimentaryRefusedError("a payment holds the order's invoice")
        require_transition(
            ORDER_TRANSITIONS, machine="order", current=order.state, requested="paid"
        )
        actor = Actor("staff", principal.identity_id)
        note = issue_credit_note(invoice, reason="complimentary", order_id=order.id)
        for link in links:
            link.state = "cancelled"
            link.save(update_fields=["state", "updated_at"])
            transaction.on_commit(partial(_withdraw_at_provider, link.provider, link.provider_ref))
        order.state = "paid"
        order.save(update_fields=["state", "updated_at"])
        if subscription is None:
            subscription_outcome = "missing"
        elif "active" in SUBSCRIPTION_TRANSITIONS[subscription.state]:
            subscription.state = "active"
            subscription.save(update_fields=["state", "updated_at"])
            subscription_outcome = "activated"
        else:
            subscription_outcome = subscription.state
        events.record(
            "order.complimentary",
            actor=actor,
            organisation_id=organisation_id,
            target=("order", order.id),
            metadata={
                "reason": reason,
                "invoice_id": str(invoice.id),
                "credit_note_id": str(note.id),
            },
        )
    return Settled(credit_note=note, tenant_id=order.tenant_id, subscription=subscription_outcome)
