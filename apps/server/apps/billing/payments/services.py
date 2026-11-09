"""Payment links and the reconciliation of provider events.

Core is the system of record for what is owed and the provider for what was paid
(docs/domain/BILLING_MODEL.md §5). A delivered event is verified by its adapter, then recorded once
in the event ledger: a second delivery of the same event is a duplicate and changes nothing. Events
of one payment are applied in the order of the provider's clock, not of delivery:

- an event older than the last one applied to its payment is `stale` and changes nothing;
- an event its payment cannot take yet (a reversal before the success it reverses) is `deferred`,
  and applied as soon as the event it follows is;
- an event for no known payment or link is `unmatched`, and one whose amount or currency is not
  the payment's is a `mismatch`; both are audited as `payment.reconciliation_mismatch` and correct
  nothing, because correcting money is a human action (§7).

A success pays the invoice once the payments cover it, activates the subscription and marks the
order paid. A payment reversed after it was confirmed (a refund, a chargeback, or a failure the
provider reports after the success) takes its amount back: the invoice owes again, `overdue` past
its due date, and an active subscription becomes `past_due`. The order stays `paid`: it is the
record of what was agreed, and the dunning ladder acts on the subscription.

The provider is never called inside a transaction that holds a row lock.
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import partial
from uuid import UUID

from django.conf import settings
from django.db import connection, transaction
from django.utils import timezone

from apps.billing.switch import require_billing
from core.db.ids import new_uuid7
from core.links import origin_of

from .. import events
from ..actors import Actor
from ..models import Invoice, Order, Payment, PaymentLink, ProviderEvent, Subscription
from ..services import SETTLEMENT_WINDOW, set_invoice_state
from ..states import (
    ORDER_TRANSITIONS,
    PAYMENT_TRANSITIONS,
    SUBSCRIPTION_TRANSITIONS,
)
from . import configured_provider, provider_named
from .port import LinkRequest, ProviderEvent as Event, ProviderNotConfiguredError

LOG = logging.getLogger(__name__)
SYSTEM = Actor("system", None)
LINK_LIFETIME = timedelta(days=30)
PAYABLE = ("issued", "overdue")


class PaymentInFlightError(Exception):
    """A debit for the invoice is submitted and not yet settled: no second link (`409`)."""


class InvoiceNotPayableError(Exception):
    """The invoice is not owed (a draft, paid, void or credited): `409`."""


class InvoiceNotFoundError(Invoice.DoesNotExist):
    """No such invoice of the organisation: `404`. A `DoesNotExist`, as it always was."""


class ReturnUrlRefusedError(ValueError):
    """The payer's return URL is not on one of the console's origins (`400`, pointer
    `/return_url`)."""


@dataclass(frozen=True, slots=True)
class LinkResult:
    link: PaymentLink
    created: bool


def _active_link(invoice_id: UUID, now: datetime) -> PaymentLink | None:
    link = (
        PaymentLink.objects.select_for_update()
        .filter(invoice_id=invoice_id, state="active")
        .first()
    )
    if link is not None and link.expires_at <= now:
        link.state = "expired"
        link.save(update_fields=["state", "updated_at"])
        return None
    return link


def _in_flight(invoice: Invoice) -> bool:
    """A debit for the invoice submitted within the settlement window and not yet settled."""
    return Payment.objects.filter(
        invoice=invoice,
        state="processing",
        last_event_at__gt=timezone.now() - SETTLEMENT_WINDOW,
    ).exists()


def _owed(invoice: Invoice) -> int:
    return max(invoice.total_incl_vat_minor - invoice.amount_paid_minor, 0)


@dataclass(frozen=True, slots=True)
class IssuedLink:
    """A link a provider created for an owed invoice, not recorded yet (`record_link` does)."""

    provider: str
    provider_ref: str
    url: str
    amount_minor: int
    currency: str
    expires_at: datetime


class LinkNotIssuedError(Exception):
    """The invoice needs a new link, but none usable was issued for it. When one was issued for an
    amount that has since moved, the route answers `409 conflict` and the next press, with its own
    key, issues one for the new amount; when none was issued, it is transient, a `5xx` that no
    replay keeps, and a retry issues one."""


def check_return_url(return_url: str | None) -> None:
    """The provider sends the payer there: only the console's own origins, never a host the caller
    names (`ReturnUrlRefusedError`)."""
    if return_url is None:
        return
    allowed: frozenset[str] = getattr(settings, "KODERA_PAYMENT_RETURN_ORIGINS", frozenset())
    if origin_of(return_url) not in allowed:
        raise ReturnUrlRefusedError()


def issue_link(
    *, invoice_id: UUID, organisation_id: UUID, return_url: str | None = None, locale: str = "fr"
) -> IssuedLink | None:
    """The provider's new link for an owed invoice that has no active one, or None when there is
    nothing to issue (no such invoice, not owed, a debit settling, or an active link): `record_link`
    answers each of those under the invoice's lock.

    It calls the provider, so it runs before any transaction, and holds no lock: two concurrent
    first presses may both issue, and `record_link` keeps the first one recorded.
    """
    # Never a provider call while billing is off (QUICK_WORKSPACE.md §2.2).
    require_billing()
    check_return_url(return_url)
    now = timezone.now()
    invoice = Invoice.objects.filter(id=invoice_id, organisation_id=organisation_id).first()
    if invoice is None or invoice.state not in PAYABLE or _owed(invoice) == 0:
        return None
    if _in_flight(invoice):
        return None
    if PaymentLink.objects.filter(invoice=invoice, state="active", expires_at__gt=now).exists():
        return None
    provider = configured_provider()
    expires_at = now + LINK_LIFETIME
    amount, currency = _owed(invoice), invoice.currency
    issued = provider.create_link(
        LinkRequest(
            invoice_id=invoice_id,
            invoice_number=invoice.number or "",
            amount_minor=amount,
            currency=currency,
            expires_at=expires_at,
            return_url=return_url,
            locale=locale,
        )
    )
    if issued.expires_at is not None:
        expires_at = min(expires_at, issued.expires_at)
    return IssuedLink(
        provider=provider.name,
        provider_ref=issued.provider_ref,
        url=issued.url,
        amount_minor=amount,
        currency=currency,
        expires_at=expires_at,
    )


def record_link(
    *, invoice_id: UUID, organisation_id: UUID, issued: IssuedLink | None
) -> LinkResult:
    """Under the invoice's lock, in the caller's transaction if any: the invoice's active link, or
    `issued` recorded as it. Everything `issue_link` checked is checked again: the invoice may have
    been paid, voided or linked meanwhile.

    An `issued` link that is not the invoice's (another press recorded one first, or the invoice
    stopped being owed) is recorded as cancelled and withdrawn at its provider once the transaction
    commits. A refusal then raises (`DoesNotExist`, `InvoiceNotPayableError`,
    `PaymentInFlightError`, or `LinkNotIssuedError` when a link is needed and none was issued); one
    raised before anything is recorded leaves `issued` to `withdraw_unrecorded`.
    """
    refusal: Exception | None = None
    with transaction.atomic():
        invoice = (
            Invoice.objects.select_for_update()
            .filter(id=invoice_id, organisation_id=organisation_id)
            .first()
        )
        if invoice is None:
            raise InvoiceNotFoundError()
        winner = None
        if invoice.state not in PAYABLE or _owed(invoice) == 0:
            refusal = InvoiceNotPayableError()
        elif _in_flight(invoice):
            refusal = PaymentInFlightError()
        else:
            winner = _active_link(invoice.id, timezone.now())
        usable = (
            refusal is None
            and winner is None
            and issued is not None
            and issued.amount_minor == _owed(invoice)
            and issued.currency == invoice.currency
        )
        if issued is not None and not usable:
            _record_issued(invoice, issued, "cancelled")
            transaction.on_commit(
                partial(_cancel_at_provider, issued.provider, issued.provider_ref)
            )
        if refusal is None and winner is None and not usable:
            refusal = LinkNotIssuedError()
        if refusal is None and winner is None and issued is not None:
            link = _record_issued(invoice, issued, "active")
            order = (
                Order.objects.select_for_update().filter(invoices=invoice, state="placed").first()
            )
            if order is not None:
                order.state = "awaiting_payment"
                order.save(update_fields=["state", "updated_at"])
    if refusal is not None:
        raise refusal
    if winner is not None:
        return LinkResult(link=winner, created=False)
    return LinkResult(link=link, created=True)


def _record_issued(invoice: Invoice, issued: IssuedLink, state: str) -> PaymentLink:
    return PaymentLink.objects.create(
        organisation_id=invoice.organisation_id,
        invoice=invoice,
        provider=issued.provider,
        provider_ref=issued.provider_ref,
        url=issued.url,
        state=state,
        amount_minor=issued.amount_minor,
        currency=issued.currency,
        expires_at=issued.expires_at,
    )


def withdraw_unrecorded(issued: IssuedLink) -> None:
    """Outside any transaction: withdraw `issued` at its provider when no row names it (its
    recording refused or rolled back, or never ran), so no payer can use a link Core does not know."""
    known = PaymentLink.objects.filter(
        provider=issued.provider, provider_ref=issued.provider_ref
    ).exists()
    if not known:
        _cancel_at_provider(issued.provider, issued.provider_ref)


def create_payment_link(
    *, invoice_id: UUID, organisation_id: UUID, return_url: str | None = None, locale: str = "fr"
) -> LinkResult:
    """The active link of an owed invoice, created at the provider when there is none.

    Pressing twice returns the same link. Two concurrent first presses may both ask the provider;
    the second to commit keeps the first's link and records its own as cancelled. The HTTP route
    runs the same two halves around the replay store (`apps/billing/api/views.py`).
    """
    issued = issue_link(
        invoice_id=invoice_id, organisation_id=organisation_id, return_url=return_url, locale=locale
    )
    try:
        return record_link(invoice_id=invoice_id, organisation_id=organisation_id, issued=issued)
    finally:
        if issued is not None:
            withdraw_unrecorded(issued)


def receive_event(*, provider_name: str, body: bytes, headers: dict[str, str]) -> str:
    """A webhook delivery: verified by its adapter (`EventRejectedError` otherwise), reconciled."""
    event = provider_named(provider_name).parse_event(body=body, headers=headers)
    if event is None:
        return "ignored"
    return reconcile(provider_name=provider_name, event=event)


def reconcile(*, provider_name: str, event: Event) -> str:
    """Record `event` once and apply it in provider order. Returns its outcome, or `duplicate`."""
    with transaction.atomic():
        row = _record(provider_name, event)
        if row is None:
            _check_redelivery(provider_name, event)
            return "duplicate"
        outcome = _apply(row)
        if outcome == "applied":
            _drain_deferred(provider_name, row.payment_ref)
        return outcome


def _check_redelivery(provider_name: str, event: Event) -> None:
    """A redelivery changes nothing; one that names other facts under the same id is audited."""
    first = ProviderEvent.objects.get(provider=provider_name, event_id=event.event_id)
    facts = (event.kind, event.payment_ref, event.amount_minor, event.currency)
    if (first.kind, first.payment_ref, first.amount_minor, first.currency) != facts:
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=None,
            target=("payment", f"{provider_name}:{event.payment_ref}"),
            metadata={
                "provider": provider_name,
                "event_id": event.event_id,
                "reason": "event_id_reused",
            },
        )


def _record(provider_name: str, event: Event) -> ProviderEvent | None:
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO billing_providerevent (id, provider, event_id, kind, payment_ref, link_ref,"
            " customer_ref, amount_minor, currency, occurred_at, outcome)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'received')"
            " ON CONFLICT (provider, event_id) DO NOTHING RETURNING id",
            [
                new_uuid7(),
                provider_name,
                event.event_id,
                event.kind,
                event.payment_ref,
                event.link_ref,
                event.customer_ref,
                event.amount_minor,
                event.currency,
                event.occurred_at,
            ],
        )
        inserted = cursor.fetchone()
    return None if inserted is None else ProviderEvent.objects.get(id=inserted[0])


def _finish(row: ProviderEvent, outcome: str) -> str:
    row.outcome = outcome
    row.save(update_fields=["outcome"])
    return outcome


def _mismatch(row: ProviderEvent, outcome: str, organisation_id: UUID | None, reason: str) -> str:
    events.record(
        "payment.reconciliation_mismatch",
        actor=SYSTEM,
        organisation_id=organisation_id,
        target=("payment", f"{row.provider}:{row.payment_ref}"),
        metadata={"provider": row.provider, "event_id": row.event_id, "reason": reason},
    )
    return _finish(row, outcome)


def _locate(row: ProviderEvent) -> tuple[Invoice, Payment | None, PaymentLink | None] | None:
    """The invoice (locked) and the payment the event names, or the link its first event names.

    The invoice is locked before the payment, always, so two events of one invoice queue.
    """
    known = (
        Payment.objects.filter(provider=row.provider, provider_ref=row.payment_ref)
        .values_list("invoice_id", flat=True)
        .first()
    )
    link = None
    if row.link_ref is not None:
        link = PaymentLink.objects.filter(provider=row.provider, provider_ref=row.link_ref).first()
    if known is None:
        if link is None:
            return None
        known = link.invoice_id
    invoice = Invoice.objects.select_for_update().get(id=known)
    payment = (
        Payment.objects.select_for_update()
        .filter(provider=row.provider, provider_ref=row.payment_ref)
        .first()
    )
    if payment is None and link is None:
        return None
    return invoice, payment, link


def _stale(payment: Payment, row: ProviderEvent) -> bool:
    """Older than the last event applied to the payment. At the same instant (a provider that
    stamps whole seconds) the event still applies, by its kind, except a failure against a
    success: a failure after a success is reported later, or as a reversal."""
    if payment.last_event_at is None or row.occurred_at > payment.last_event_at:
        return False
    if row.occurred_at < payment.last_event_at:
        return True
    return row.kind == "payment.failed" and payment.state == "succeeded"


def _target(current: str, kind: str) -> str:
    target = {
        "payment.processing": "processing",
        "payment.succeeded": "succeeded",
        "payment.failed": "failed",
    }.get(kind, "reversed")
    # A failure reported after the success it contradicts takes the money back like a reversal.
    if current == "succeeded" and target == "failed":
        return "reversed"
    return target


def _apply(row: ProviderEvent) -> str:
    located = _locate(row)
    if located is None:
        # An event naming no link, for a payment not yet known (a refund or a dispute delivered
        # before the success it follows), waits for that payment's first event; one naming a link
        # Core never issued is unmatched. Both are audited.
        waits = row.link_ref is None
        return _mismatch(row, "deferred" if waits else "unmatched", None, "unknown_payment")
    invoice, payment, link = located
    source = payment if payment is not None else link
    if source is None:
        return _mismatch(row, "unmatched", None, "unknown_payment")
    if (row.amount_minor, row.currency) != (source.amount_minor, source.currency) or (
        row.currency != invoice.currency
    ):
        return _mismatch(row, "mismatch", invoice.organisation_id, "amount_or_currency")
    if payment is None and link is not None and link.state != "active" and link.state != "used":
        # Money paid through a withdrawn or expired link is still money received: it is kept, and a
        # person looks at why the link was still used.
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=invoice.organisation_id,
            target=("payment", f"{row.provider}:{row.payment_ref}"),
            metadata={"reason": "link_not_active", "link_state": link.state},
        )
    if payment is None:
        payment = Payment.objects.create(
            organisation_id=invoice.organisation_id,
            invoice=invoice,
            payment_link=link,
            provider=row.provider,
            provider_ref=row.payment_ref,
            amount_minor=row.amount_minor,
            currency=row.currency,
        )
    elif link is not None and link.invoice_id != payment.invoice_id:
        # A delivery tying a known payment to another invoice's link moves no money: a person
        # looks at it, from both organisations' records.
        if link.organisation_id != invoice.organisation_id:
            events.record(
                "payment.reconciliation_mismatch",
                actor=SYSTEM,
                organisation_id=link.organisation_id,
                target=("payment", payment.id),
                metadata={"invoice_id": str(link.invoice_id), "reason": "link_mismatch"},
            )
        return _mismatch(row, "mismatch", invoice.organisation_id, "link_mismatch")
    if _stale(payment, row):
        return _finish(row, "stale")
    if row.customer_ref and payment.provider_customer_ref != row.customer_ref:
        # Only an event not older than the last applied names the customer a recurring
        # collection would charge.
        payment.provider_customer_ref = row.customer_ref
        payment.save(update_fields=["provider_customer_ref", "updated_at"])
    if row.kind == "payment.reinstated":
        # A dispute won returns money a reversal took back; a person re-allocates it and lifts
        # what the reversal set in motion, never the reconciliation on its own.
        return _mismatch(row, "mismatch", invoice.organisation_id, "dispute_reinstated")
    target = _target(payment.state, row.kind)
    if target not in PAYMENT_TRANSITIONS[payment.state]:
        # A reversal before its success waits for it; anything else has nothing to act on.
        later = target == "reversed" and "succeeded" in PAYMENT_TRANSITIONS[payment.state]
        return _finish(row, "deferred" if later else "ignored")
    previous = payment.state
    payment.state = target
    payment.last_event_at = row.occurred_at
    payment.save(update_fields=["state", "last_event_at", "updated_at"])
    metadata = {
        "provider": row.provider,
        "event_id": row.event_id,
        "invoice_id": str(invoice.id),
        "amount_minor": row.amount_minor,
    }
    if target == "processing":
        # Submitted, not settled: the link is spent, so the invoice cannot be paid twice meanwhile.
        if payment.payment_link_id is not None:
            PaymentLink.objects.filter(id=payment.payment_link_id, state="active").update(
                state="used", used_at=timezone.now()
            )
    elif target == "succeeded":
        _received(invoice, payment, metadata)
    elif target == "failed":
        # The attempt is over: its link is spent, so the next press opens a fresh one.
        if payment.payment_link_id is not None:
            PaymentLink.objects.filter(id=payment.payment_link_id, state="active").update(
                state="used", used_at=timezone.now()
            )
        events.record(
            "payment.failed",
            actor=SYSTEM,
            organisation_id=invoice.organisation_id,
            target=("payment", payment.id),
            metadata=metadata,
        )
    else:
        _reversed(invoice, payment, {**metadata, "after": previous, "reported_as": row.kind})
    return _finish(row, "applied")


def _received(invoice: Invoice, payment: Payment, metadata: dict[str, object]) -> None:
    events.record(
        "payment.received",
        actor=SYSTEM,
        organisation_id=invoice.organisation_id,
        target=("payment", payment.id),
        metadata=metadata,
    )
    if payment.payment_link_id is not None:
        PaymentLink.objects.filter(id=payment.payment_link_id, state="active").update(
            state="used", used_at=timezone.now()
        )
    if invoice.state not in (*PAYABLE, "paid"):
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=invoice.organisation_id,
            target=("payment", payment.id),
            metadata={
                "invoice_id": str(invoice.id),
                "reason": "invoice_not_payable",
                "state": invoice.state,
            },
        )
        return
    payment.allocated = True
    payment.save(update_fields=["allocated", "updated_at"])
    invoice.amount_paid_minor += payment.amount_minor
    invoice.save(update_fields=["amount_paid_minor", "updated_at"])
    if invoice.amount_paid_minor > invoice.total_incl_vat_minor:
        events.record(
            "payment.reconciliation_mismatch",
            actor=SYSTEM,
            organisation_id=invoice.organisation_id,
            target=("payment", payment.id),
            metadata={
                "invoice_id": str(invoice.id),
                "reason": "overpayment",
                "amount_paid_minor": invoice.amount_paid_minor,
            },
        )
    if invoice.state in PAYABLE and _owed(invoice) == 0:
        set_invoice_state(invoice, "paid", actor=SYSTEM)
        _withdraw_links(invoice)
        _move_subscription(invoice, "active")
        order = Order.objects.select_for_update().filter(invoices=invoice).first()
        if order is not None and "paid" in ORDER_TRANSITIONS[order.state]:
            order.state = "paid"
            order.save(update_fields=["state", "updated_at"])


def _cancel_at_provider(provider_name: str, provider_ref: str) -> None:
    """After commit: a withdrawal the provider refuses is logged for a person, never raised into
    the reconciliation that already committed."""
    try:
        provider_named(provider_name).cancel_link(provider_ref)
    except ProviderNotConfiguredError:
        # No such provider configured here (the API on staging, say): nothing was asked, and
        # withdraw_cancelled_links retries. A provider that did not answer is an error below.
        LOG.warning(
            "payment link %s not withdrawn: %s is not configured", provider_ref, provider_name
        )
    except Exception as failure:
        LOG.error(
            "payment link %s not withdrawn at %s: %s",
            provider_ref,
            provider_name,
            type(failure).__name__,
        )


def _withdraw_links(invoice: Invoice) -> None:
    """A paid invoice keeps no active link: each is cancelled, and withdrawn at the provider once
    the transaction commits, so a second payment cannot be made through it."""
    active = list(PaymentLink.objects.select_for_update().filter(invoice=invoice, state="active"))
    for link in active:
        link.state = "cancelled"
        link.save(update_fields=["state", "updated_at"])
        transaction.on_commit(partial(_cancel_at_provider, link.provider, link.provider_ref))


def withdraw_cancelled_links() -> int:
    """Ask its provider to withdraw every cancelled link that has not expired: a cancelled
    order's, which Core cancels in its own transaction without calling out (`services._cancel`).
    The operator command `withdraw_cancelled_links`. Idempotent, and it records nothing: each run
    asks again for every such link, and a refusal is logged by `_cancel_at_provider`. Returns how
    many were asked."""
    pending = list(
        PaymentLink.objects.filter(state="cancelled", expires_at__gt=timezone.now()).values_list(
            "provider", "provider_ref"
        )
    )
    for provider_name, provider_ref in pending:
        _cancel_at_provider(provider_name, provider_ref)
    return len(pending)


def _reversed(invoice: Invoice, payment: Payment, metadata: dict[str, object]) -> None:
    """The payment's amount leaves the invoice. Leaving `paid` has no audit action of its own: the
    `payment.refunded` row carries the invoice's state before and after, and when it was paid."""
    if payment.allocated:
        payment.allocated = False
        payment.save(update_fields=["allocated", "updated_at"])
        invoice.amount_paid_minor -= payment.amount_minor
    after = invoice.state
    if invoice.state == "paid" and _owed(invoice) > 0:
        overdue = invoice.due_at is not None and invoice.due_at <= timezone.now()
        after = "overdue" if overdue else "issued"
    events.record(
        "payment.refunded",
        actor=SYSTEM,
        organisation_id=invoice.organisation_id,
        target=("payment", payment.id),
        metadata={
            **metadata,
            "invoice_state_before": invoice.state,
            "invoice_state_after": after,
            "invoice_paid_at": None if invoice.paid_at is None else invoice.paid_at.isoformat(),
        },
    )
    invoice.save(update_fields=["amount_paid_minor", "updated_at"])
    if after != invoice.state:
        set_invoice_state(invoice, after, actor=SYSTEM)
        _move_subscription(invoice, "past_due")


def _move_subscription(invoice: Invoice, requested: str) -> None:
    subscription = Subscription.objects.select_for_update().filter(invoices=invoice).first()
    if subscription is None or requested not in SUBSCRIPTION_TRANSITIONS[subscription.state]:
        return
    # Recorded by the payment row that moved it: `subscription.*` rows are staff or tenant acts.
    subscription.state = requested
    subscription.save(update_fields=["state", "updated_at"])


def _drain_deferred(provider_name: str, payment_ref: str) -> None:
    """Apply, in provider order, the deferred events an applied one may have made applicable.

    One pass: each is applied, found stale, or stays deferred for a later event.
    """
    deferred = (
        ProviderEvent.objects.select_for_update()
        .filter(provider=provider_name, payment_ref=payment_ref, outcome="deferred")
        .order_by("occurred_at", "id")
    )
    for row in list(deferred):
        _apply(row)
