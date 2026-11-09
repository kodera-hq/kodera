"""The order confirmation: the e-mail that forms the contract (CGV 5.3).

It names each document accepted with the order, with its version and the permanent URL of its
text (`getLegalDocumentText`), and goes to the person who accepted them. The API process holds no
mail seal key and no outbox, so the operator profile enqueues it: `send_order_confirmations` finds
each order with an accepted DPA, not cancelled, whose confirmation was never enqueued or ended
`failed` (expired, rejected, out of attempts), and enqueues one, recording the delivery on the
order and an `order.confirmation_enqueued` audit row. The outbox then sends it (`run_deliveries`).

Nothing is enqueued where it could not be sent: without the legal texts' origin, without a mail
transport, or on a remote transport while the copy is not approved, the run refuses as a whole.

A cancelled order is never confirmed. A confirmation still waiting when its order is cancelled is
withdrawn by the outbox at its claim (apps/outbox/sender.py `withdrawn`), so it never leaves. One
the outbox had already sent formed the contract: the same run records the cancellation as that
contract's termination (`order.terminated`) and enqueues the `order_cancellation` notice, once.
A confirmation whose fate is unknown (`needs_reconciliation`) waits for a person.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from uuid import UUID

from django.conf import settings
from django.db import connection, transaction
from django.db.models import Q

from apps.legal.services import OrderAgreements, order_agreements, text_url
from apps.outbox.selectors import failed_deliveries, succeeded_deliveries
from apps.outbox.sender import (
    MessageRefusedError,
    SenderUnavailableError,
    check_recipient,
    enqueue_message,
    held_templates,
)

from . import events
from .actors import Actor
from .models import CreditNote, Order
from .services import PARIS

LOG = logging.getLogger(__name__)
TEMPLATE = "order_confirmation"
NOTICE = "order_cancellation"
CREDIT_NOTE_NOTICE = "credit_note_issued"
SYSTEM = Actor("system", None)
# The outbox keeps a message at most seven days; one that fails is enqueued again by a later run.
LIFETIME = timedelta(days=6)


class ConfirmationsUnavailableError(Exception):
    """This deployment cannot send a confirmation: nothing is enqueued."""


@dataclass
class ConfirmationReport:
    enqueued: list[UUID] = field(default_factory=list)
    skipped: list[UUID] = field(default_factory=list)
    notified: list[UUID] = field(default_factory=list)
    credit_notes: list[UUID] = field(default_factory=list)


def _database_now() -> datetime:
    # The outbox bounds a message's expiry by the database clock: the same clock sets it.
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        now: datetime = cursor.fetchone()[0]
    return now


def _deliverable() -> None:
    if settings.KODERA_LEGAL_TEXT_ORIGIN is None:
        raise ConfirmationsUnavailableError(
            "no KODERA_LEGAL_TEXT_ORIGIN: a confirmation could not name where a text is read"
        )
    transport = getattr(settings, "KODERA_MAIL_TRANSPORT", None)
    if transport is None:
        raise ConfirmationsUnavailableError("no mail transport: a confirmation would never leave")
    for template in (TEMPLATE, NOTICE, CREDIT_NOTE_NOTICE):
        if template in held_templates(transport):
            raise ConfirmationsUnavailableError(
                f"{template}'s copy is not approved: a remote transport would hold it until it"
                " expires"
            )


def _lines(order_id: UUID) -> tuple[OrderAgreements, list[str]] | None:
    agreements = order_agreements(order_id=order_id)
    if agreements is None:
        return None
    lines = []
    for document in agreements.documents:
        url = text_url(document)
        if url is None:
            # A confirmation that cannot name where a text is read does not form the contract.
            return None
        lines.append(f"{document.title}, version {document.version} — {url}")
    return agreements, lines


def _due(order: Order, failed: set[UUID]) -> bool:
    return order.confirmation_delivery_id is None or order.confirmation_delivery_id in failed


def _locked(order_id: UUID) -> Order | None:
    """The order, locked, unless another transaction holds it or it is cancelled by now: an order
    cancelled between the listing and the lock is never confirmed, so no contract is formed for it."""
    order: Order | None = (
        Order.objects.select_for_update(skip_locked=True, no_key=True, of=("self",))
        .filter(id=order_id)
        .exclude(state="cancelled")
        .first()
    )
    return order


def enqueue_order_confirmations() -> ConfirmationReport:
    """Enqueue the confirmation of each order that has an accepted DPA and none on its way."""
    _deliverable()
    report = ConfirmationReport()
    live = (
        Order.objects.filter(dpa__state="accepted")
        .exclude(state="cancelled")
        .order_by("created_at", "id")
    )
    sent = list(
        live.filter(confirmation_delivery_id__isnull=False).values_list(
            "confirmation_delivery_id", flat=True
        )
    )
    failed = failed_deliveries([delivery for delivery in sent if delivery is not None])
    candidates = list(
        live.filter(
            Q(confirmation_delivery_id__isnull=True) | Q(confirmation_delivery_id__in=failed)
        ).values_list("id", flat=True)
    )
    for order_id in candidates:
        with transaction.atomic():
            order = _locked(order_id)
            if order is None or not _due(order, failed):
                continue
            found = _lines(order.id)
            if found is None:
                LOG.error("order %s: its confirmation cannot name every accepted text", order.id)
                report.skipped.append(order.id)
                continue
            agreements, lines = found
            try:
                delivery_id = enqueue_message(
                    organisation_id=order.organisation_id,
                    template_id=TEMPLATE,
                    locale=agreements.locale,
                    recipient=agreements.recipient,
                    params={
                        "organisation_name": order.organisation.name,
                        "order_reference": str(order.id),
                        "documents": lines,
                    },
                    expires_at=_database_now() + LIFETIME,
                )
            except MessageRefusedError as refused:
                LOG.error("order %s: confirmation refused: %s", order.id, refused)
                report.skipped.append(order.id)
                continue
            previous = order.confirmation_delivery_id
            order.confirmation_delivery_id = delivery_id
            order.save(update_fields=["confirmation_delivery_id", "updated_at"])
            events.record(
                "order.confirmation_enqueued",
                actor=SYSTEM,
                organisation_id=order.organisation_id,
                target=("order", order.id),
                metadata={
                    "delivery_id": str(delivery_id),
                    "replaces_failed_delivery_id": None if previous is None else str(previous),
                    "documents": [
                        [document.code, document.version, document.locale]
                        for document in agreements.documents
                    ],
                },
            )
            report.enqueued.append(order.id)
    _notify_terminations(report)
    _notify_credit_notes(report)
    return report


def _amount(amount_minor: int, currency: str) -> str:
    # French notation, as the copy is read: 5 385,60 EUR.
    units, cents = divmod(amount_minor, 100)
    return f"{units:,}".replace(",", "\u202f") + f",{cents:02d} {currency}"


def credit_note_url(note_id: UUID) -> str:
    """The credit note's permanent URL: `getCreditNote` on Core's public API host, the origin the
    legal texts are read at (`KODERA_LEGAL_TEXT_ORIGIN`)."""
    return f"{settings.KODERA_LEGAL_TEXT_ORIGIN}/api/v1/credit-notes/{note_id}"


def _notify_credit_notes(report: ConfirmationReport) -> None:
    """Deliver each credit note to the customer: a notice naming it, the invoice it cancels and its
    permanent URL, to the order's billing contact, else the signatory, once, and again if it
    failed. A credit note's notice delivery is the one column of it that is ever written again."""
    pending = CreditNote.objects.filter(invoice__order__isnull=False)
    failed = failed_deliveries(
        [d for d in pending.values_list("notice_delivery_id", flat=True) if d is not None]
    )
    due = Q(notice_delivery_id__isnull=True) | Q(notice_delivery_id__in=failed)
    for note_id in list(
        pending.filter(due).order_by("issued_at", "id").values_list("id", flat=True)
    ):
        with transaction.atomic():
            note: CreditNote | None = (
                CreditNote.objects.select_for_update(skip_locked=True, of=("self",))
                .select_related("invoice", "invoice__order", "organisation")
                .filter(due, id=note_id)
                .first()
            )
            if note is None:
                continue
            order = note.invoice.order
            agreements = None if order is None else order_agreements(order_id=order.id)
            if order is None or agreements is None:
                LOG.error("credit note %s: its notice has no recipient", note.id)
                report.skipped.append(note.id)
                continue
            # The billing contact, unless the outbox would refuse its address: then the signatory,
            # rather than no delivery at all.
            contact = order.billing_contact_email
            recipient = contact if contact and check_recipient(contact) else agreements.recipient
            try:
                delivery_id = enqueue_message(
                    organisation_id=note.organisation_id,
                    template_id=CREDIT_NOTE_NOTICE,
                    locale=agreements.locale,
                    recipient=recipient,
                    params={
                        "organisation_name": note.organisation.name,
                        "credit_note_number": note.number,
                        "invoice_number": note.invoice.number or "",
                        "issued_on": f"{note.issued_at.astimezone(PARIS):%Y-%m-%d}",
                        "total_incl_vat": _amount(note.total_incl_vat_minor, note.currency),
                        "credit_note_url": credit_note_url(note.id),
                    },
                    expires_at=_database_now() + LIFETIME,
                )
            except MessageRefusedError as refused:
                LOG.error("credit note %s: notice refused: %s", note.id, refused)
                report.skipped.append(note.id)
                continue
            previous = note.notice_delivery_id
            note.notice_delivery_id = delivery_id
            note.save(update_fields=["notice_delivery_id", "updated_at"])
            events.record(
                "credit_note.notice_enqueued",
                actor=SYSTEM,
                organisation_id=note.organisation_id,
                target=("credit_note", note.id),
                metadata={
                    "delivery_id": str(delivery_id),
                    "number": note.number,
                    "replaces_failed_delivery_id": None if previous is None else str(previous),
                },
            )
            report.credit_notes.append(note.id)


def _notify_terminations(report: ConfirmationReport) -> None:
    """Each cancelled order whose confirmation was sent: its termination, audited, and its notice
    enqueued to the person the confirmation went to, once, or again if that notice failed."""
    confirmed = Order.objects.filter(state="cancelled", confirmation_delivery_id__isnull=False)
    sent = succeeded_deliveries(
        [d for d in confirmed.values_list("confirmation_delivery_id", flat=True) if d is not None]
    )
    failed = failed_deliveries(
        [
            d
            for d in confirmed.values_list("cancellation_notice_delivery_id", flat=True)
            if d is not None
        ]
    )
    # A notice that failed (expired, rejected, out of attempts) goes again, as a confirmation does.
    due = Q(cancellation_notice_delivery_id__isnull=True) | Q(
        cancellation_notice_delivery_id__in=failed
    )
    candidates = list(
        confirmed.filter(due, confirmation_delivery_id__in=sent).values_list("id", flat=True)
    )
    for order_id in candidates:
        with transaction.atomic():
            order: Order | None = (
                Order.objects.select_for_update(skip_locked=True, of=("self",))
                .filter(due, id=order_id, state="cancelled")
                .first()
            )
            if order is None:
                continue
            agreements = order_agreements(order_id=order.id)
            if agreements is None:
                LOG.error("order %s: its cancellation notice has no recipient", order.id)
                report.skipped.append(order.id)
                continue
            try:
                delivery_id = enqueue_message(
                    organisation_id=order.organisation_id,
                    template_id=NOTICE,
                    locale=agreements.locale,
                    recipient=agreements.recipient,
                    params={
                        "organisation_name": order.organisation.name,
                        "order_reference": str(order.id),
                    },
                    expires_at=_database_now() + LIFETIME,
                )
            except MessageRefusedError as refused:
                LOG.error("order %s: cancellation notice refused: %s", order.id, refused)
                report.skipped.append(order.id)
                continue
            previous = order.cancellation_notice_delivery_id
            order.cancellation_notice_delivery_id = delivery_id
            order.save(update_fields=["cancellation_notice_delivery_id", "updated_at"])
            events.record(
                "order.terminated",
                actor=SYSTEM,
                organisation_id=order.organisation_id,
                target=("order", order.id),
                metadata={
                    "confirmation_delivery_id": str(order.confirmation_delivery_id),
                    "notice_delivery_id": str(delivery_id),
                    "replaces_failed_notice_id": None if previous is None else str(previous),
                },
            )
            report.notified.append(order.id)


__all__ = [
    "ConfirmationReport",
    "ConfirmationsUnavailableError",
    "SenderUnavailableError",
    "enqueue_order_confirmations",
]
