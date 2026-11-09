"""The support ticket mail: docs/specs/SUPPORT_TICKETS.md §6.

The API process holds no outbox seal key, so it only stores the ticket with `mail_enqueued_at`
null. This run, in the operator profile, hands one `support_ticket` message per such ticket to the
outbox in a transaction of its own, to the support mailbox, with the requester's address as its
Reply-To, and marks the ticket; `run_deliveries` sends it.

Core keeps the customer's text only as long as its mail needs it. Each run first settles the
tickets whose message's delivery ended: delivered, the ticket's subject, body and addresses are
erased, and so are the message's copies of them; failed or expired, the ticket is owed again once,
while MIN_WINDOW of its RETENTION is left, and erased otherwise. No message expires past its ticket's
RETENTION. It then erases every ticket older than
RETENTION, delivered or not. Both run whatever the mail settings, so the bound holds even where the
mail is refused.

Nothing is enqueued where it could not be sent: without the mailbox, the seal key or a transport
the run refuses to enqueue. A remote transport holds unapproved copy (OUTBOX_MAIL_SENDER.md §4), so
whenever the template is a draft the run enqueues nothing and reports every ticket as held: they stay
owed until RETENTION. It reports counts, never an address or a text.
"""

import logging
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from uuid import UUID

from django.conf import settings
from django.db import connection, transaction
from django.utils import timezone

from apps.orgs.actor_selectors import organisation_name_and_slug
from apps.outbox.mail.catalogue import MAX_PARAM_LENGTH
from apps.outbox.selectors import ended_messages
from apps.outbox.sender import (
    MessageRefusedError,
    SenderUnavailableError,
    check_recipient,
    enqueue_message,
    held_templates,
    redact_ended_params,
)

from .models import SupportTicket

LOG = logging.getLogger(__name__)
TEMPLATE = "support_ticket"
# The outbox keeps a message at most seven days.
LIFETIME = timedelta(days=6)
# How long Core keeps a ticket's text at most, delivered or not: two outbox windows and a margin, so
# that the first message and one retry after a failed delivery both end inside it. A ticket no mail
# delivered in two weeks is better reopened than kept (SUPPORT_TICKETS.md §6).
RETENTION = timedelta(days=14)
# The least time a message is given: a ticket with less of its RETENTION left is not mailed again.
MIN_WINDOW = timedelta(hours=1)
NONE = "—"
# The message parameters that carry the customer's text or an address, erased once it ended.
CONTENT_PARAMS = ("customer_subject", "customer_body", "requester_email", "contact_email")
ERASED = {"subject": "", "body": "", "reply_to_email": None, "contact_email": None}


class SupportMailUnavailableError(Exception):
    """This deployment cannot mail a ticket: nothing is enqueued."""


@dataclass
class SupportMailReport:
    enqueued: list[UUID] = field(default_factory=list)
    skipped: list[UUID] = field(default_factory=list)
    held_for_approval: int = 0
    delivered: int = 0
    retried: int = 0
    erased_undelivered: int = 0


def support_mailbox() -> str:
    value = getattr(settings, "KODERA_SUPPORT_MAILBOX", None)
    if not isinstance(value, str) or not check_recipient(value):
        raise SupportMailUnavailableError("KODERA_SUPPORT_MAILBOX is not one mail address")
    return value


def _left(created_at: datetime) -> timedelta:
    """How much of a ticket's RETENTION is left, on the clock its `created_at` was written by."""
    return created_at + RETENTION - timezone.now()


def _expiry(created_at: datetime, now: datetime) -> datetime | None:
    """When a ticket's message expires, on the database clock `now` the outbox checks it against:
    LIFETIME from now, but never past the ticket's RETENTION, so no copy of its text outlives it.
    None when less than MIN_WINDOW of it is left."""
    left = _left(created_at)
    return now + min(LIFETIME, left) if left >= MIN_WINDOW else None


def _now() -> datetime:
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        now: datetime = cursor.fetchone()[0]
    return now


OWED = {"mail_enqueued_at__isnull": True, "mail_refused_at__isnull": True}
HELD = {"content_erased_at__isnull": True}


def _owed(limit: int) -> list[UUID]:
    return list(
        SupportTicket.objects.filter(**OWED, **HELD)
        .order_by("created_at", "id")
        .values_list("id", flat=True)[:limit]
    )


def settle_support_ticket_mails(report: SupportMailReport, *, limit: int = 50) -> None:
    """Each ticket whose message will never be built again (its delivery ended, or it expired), in
    its own transaction: the message's copies of the text are redacted; delivered, the ticket's
    text is erased; otherwise the ticket is owed again, once, while MIN_WINDOW of its RETENTION
    is left, and its text is erased if not."""
    pending: dict[UUID, UUID] = {
        delivery_id: ticket_id
        for delivery_id, ticket_id in SupportTicket.objects.filter(
            mail_delivery_id__isnull=False
        ).values_list("mail_delivery_id", "id")
        if delivery_id is not None
    }
    ended = ended_messages(list(pending))
    for delivery_id in sorted(ended, key=lambda delivery: str(pending[delivery]))[:limit]:
        ticket_id = pending[delivery_id]
        with transaction.atomic():
            ticket = (
                SupportTicket.objects.select_for_update(skip_locked=True)
                .filter(id=ticket_id, mail_delivery_id=delivery_id)
                .first()
            )
            if ticket is None:
                continue
            now = _now()
            redact_ended_params(delivery_id, CONTENT_PARAMS)
            fields: dict[str, object] = {"mail_delivery_id": None, "updated_at": now}
            held = ticket.content_erased_at is None
            if ended[delivery_id]:
                fields |= {"mail_delivered_at": now}
                report.delivered += 1
            elif held and ticket.mail_retried_at is None and _left(ticket.created_at) >= MIN_WINDOW:
                fields |= {"mail_enqueued_at": None, "mail_retried_at": now}
                report.retried += 1
            elif held:
                report.erased_undelivered += 1
                LOG.error("support ticket %s erased: its mail was not delivered", ticket.id)
            if held and "mail_enqueued_at" not in fields:
                fields |= ERASED | {"content_erased_at": now}
            SupportTicket.objects.filter(id=ticket.id).update(**fields)


def erase_expired_ticket_content(report: SupportMailReport) -> None:
    """Erase the text of every ticket older than RETENTION. A message still in the outbox keeps its
    own copy until its delivery ends, when the next run's settling redacts it."""
    now = _now()
    cutoff = timezone.now() - RETENTION
    erased = SupportTicket.objects.filter(**HELD, created_at__lte=cutoff).update(
        **ERASED, content_erased_at=now, updated_at=now
    )
    if erased:
        report.erased_undelivered += erased
        LOG.error(
            "support tickets erased before their mail was delivered: %d older than %d days",
            erased,
            RETENTION.days,
        )


def run_support_ticket_mails(*, limit: int = 50) -> SupportMailReport:
    """One pass: settle, erase what is past RETENTION, then enqueue what is owed. The first two
    need no mail setting; the last refuses without them (SupportMailUnavailableError)."""
    if connection.in_atomic_block:
        raise RuntimeError("the support ticket mail run uses transactions of its own")
    report = SupportMailReport()
    settle_support_ticket_mails(report, limit=limit)
    erase_expired_ticket_content(report)
    return enqueue_support_ticket_mails(limit=limit, report=report)


def _clean(value: str) -> str:
    """A value Core holds with every character a mail parameter refuses (a control, format or
    private-use character: Unicode category C) and the line and paragraph separators made a space.
    Intake refuses only NUL in a name, so a pasted zero-width space or tab must not make every ticket
    of that organisation unmailable."""
    return " ".join(
        "".join(
            " " if unicodedata.category(c).startswith("C") or c in "\u2028\u2029" else c
            for c in value
        ).split()
    )


def _value(value: str | None) -> str:
    """A single value within a mail parameter's bound: cleaned, and a long one is cut, never
    refused."""
    value = _clean(value or "")
    if value == "":
        return NONE
    if len(value) > MAX_PARAM_LENGTH:
        return value[: MAX_PARAM_LENGTH - 1] + "…"
    return value


def _address(value: str | None) -> str:
    """An address shown whole or not at all: one longer than a mail parameter's bound is shown as
    missing. The requester's still reaches the support team as the message's Reply-To."""
    if value is None or value == "" or len(value) > MAX_PARAM_LENGTH:
        return NONE
    return value


def params(ticket: SupportTicket, organisation: tuple[str, str] | None) -> dict[str, object]:
    # The codes as Core stores them (SUPPORT_TICKETS.md §2): the mail goes to the support team, and
    # product copy lives in the catalogue only.
    name, slug = (None, None) if organisation is None else organisation
    return {
        "ticket_ref": str(ticket.id),
        "organisation_name": _value(name),
        "organisation_slug": _value(slug),
        "tenant_slug": _value(ticket.tenant_slug),
        "tenant_status": _value(ticket.tenant_status),
        "pack_code": _value(ticket.pack_code),
        "category": ticket.category,
        "severity": ticket.severity,
        "requester_email": _address(ticket.reply_to_email),
        "contact_email": _address(ticket.contact_email),
        "customer_locale": ticket.locale,
        "customer_subject": ticket.subject,
        "customer_body": ticket.body,
    }


def enqueue_support_ticket_mails(
    *, limit: int = 50, report: SupportMailReport | None = None
) -> SupportMailReport:
    """One `support_ticket` message for each ticket not yet mailed, each in its own transaction."""
    if connection.in_atomic_block:
        raise RuntimeError("the support ticket mail run uses transactions of its own")
    mailbox = support_mailbox()
    if getattr(settings, "KODERA_OUTBOX_SEAL_KEY", None) is None:
        raise SupportMailUnavailableError("no seal key is configured: KODERA_OUTBOX_SEAL_KEY")
    transport = getattr(settings, "KODERA_MAIL_TRANSPORT", None)
    if transport is None:
        raise SupportMailUnavailableError("no mail transport: a ticket's mail would never leave")
    report = SupportMailReport() if report is None else report
    if TEMPLATE in held_templates(transport):
        # Every owed ticket, not one batch: the count is what an alert reads. A ticket held here
        # was answered 201 and reaches nobody until the copy is approved (SUPPORT_TICKETS.md §6).
        report.held_for_approval = SupportTicket.objects.filter(**OWED, **HELD).count()
        if report.held_for_approval:
            LOG.warning(
                "support ticket mails held for approval: %d tickets reach nobody until the "
                "support_ticket copy is approved",
                report.held_for_approval,
            )
        return report
    for ticket_id in _owed(limit):
        try:
            with transaction.atomic():
                ticket = (
                    SupportTicket.objects.select_for_update(skip_locked=True)
                    .filter(id=ticket_id, **OWED, **HELD)
                    .first()
                )
                if ticket is None:
                    continue
                now = _now()
                expires_at = _expiry(ticket.created_at, now)
                if expires_at is None:
                    # Too little of its RETENTION is left for a message: the expiry erases it.
                    continue
                organisation = organisation_name_and_slug(organisation_id=ticket.organisation_id)
                delivery_id = enqueue_message(
                    organisation_id=ticket.organisation_id,
                    template_id=TEMPLATE,
                    locale=ticket.locale,
                    recipient=mailbox,
                    params=params(ticket, organisation),
                    expires_at=expires_at,
                    reply_to=ticket.reply_to_email,
                )
                SupportTicket.objects.filter(id=ticket.id).update(
                    mail_enqueued_at=now, mail_delivery_id=delivery_id, updated_at=now
                )
            report.enqueued.append(ticket_id)
        except SenderUnavailableError:
            raise
        except MessageRefusedError as refused:
            # Its transaction rolled back. The ticket is marked so that no later run retries it and
            # it holds back no newer ticket; it is reported once. The log names the class only.
            LOG.error("support ticket %s mail refused: %s", ticket_id, type(refused).__name__)
            now = _now()
            SupportTicket.objects.filter(id=ticket_id, **OWED).update(
                mail_refused_at=now, updated_at=now
            )
            report.skipped.append(ticket_id)
    return report
