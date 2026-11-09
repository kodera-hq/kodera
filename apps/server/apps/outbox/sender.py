"""The mail sender of `message` outbox deliveries: docs/specs/OUTBOX_MAIL_SENDER.md.

`enqueue_message` runs inside the caller's transaction and writes a pending delivery with its
message. `run_deliveries` runs in transactions of its own: it sweeps, then claims one delivery,
opening and committing its attempt before anything is sent, sends it over SMTP outside any
transaction, and records the outcome. A closed attempt is never sent again; an unknown outcome is
held for an operator, never retried.

Logs and audit rows carry identifiers, codes and reasons only (§5.2): never the recipient, the
subject, the body, the link or its secret.
"""

from __future__ import annotations

import json
import logging
import re
import secrets
import time
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import format_datetime
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db import connection, transaction

from apps.audit.services import record_delivery_event
from core.db.ids import new_uuid7

from .mail import catalogue, links, seal, transport as smtp
from .mail.catalogue import TemplateError
from .mail.transport import MailTransport, SendResult

logger = logging.getLogger("apps.outbox.sender")

# Retry class A of docs/domain/JOB_CATALOGUE.md: five attempts, exponential from 30 s, cap 10 min,
# full jitter. Only `temporary` attempts count: a transport failure (outage, TLS, authentication)
# says nothing about the message and spends none of its budget (§7.3).
MAX_DEFERRALS = 5
BACKOFF_BASE_S = 30.0
BACKOFF_CAP_S = 600.0
# An open attempt older than this is abandoned to an operator (§7.1).
STALE_AFTER = timedelta(minutes=15)
# A transport failure ends the run: the next delivery would meet the same transport (§7.3).
STOP_ON_TRANSPORT_FAILURE = True
# A run given a time budget claims nothing new once it is spent (OPERATOR_SCHEDULE.md §1).
STOP_ON_BUDGET = True
COUNT_TRANSPORT_FAILURES = False
# The longest a message may wait to be sent; a claim link lives 72 hours (§3).
MAX_LIFETIME = timedelta(days=7)
DEFAULT_LIMIT = 50
REPLY_TO_HEADER = "Reply-To"
# A message that fails to render or build is failed `unrenderable`, never left to roll its claim
# back and come first again at every run (§7.2).
UNBUILDABLE: tuple[type[Exception], ...] = (Exception,)

SECRET = re.compile(r"[A-Za-z0-9_-]{16,512}")
# A conservative address: dot-separated atoms of letters, digits and `_ % + -` before the `@`, no
# quoting, comments or other atext; a host name of letter-digit-hyphen labels after it.
RECIPIENT = re.compile(
    r"[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+"
)


class MessageRefusedError(ValueError):
    """enqueue_message refused its input; nothing was written."""


class SenderUnavailableError(RuntimeError):
    """The sender cannot run here: no seal key, or a transaction it must not join."""


# ------------------------------------------------------------------------------ enqueue ----


def require_caller_transaction() -> None:
    if not connection.in_atomic_block:
        raise SenderUnavailableError(
            "enqueue_message runs inside the transaction of the change it belongs to"
        )


def require_own_transaction() -> None:
    if connection.in_atomic_block:
        raise SenderUnavailableError("run_deliveries runs in transactions of its own")


def seal_key() -> bytes | None:
    key: bytes | None = getattr(settings, "KODERA_OUTBOX_SEAL_KEY", None)
    return key


def _plain(value: str) -> bool:
    return not any(unicodedata.category(character).startswith("C") for character in value)


def check_recipient(recipient: str) -> bool:
    local_part = recipient.partition("@")[0]
    return (
        len(recipient) <= 254
        and len(local_part) <= 64
        and RECIPIENT.fullmatch(recipient) is not None
    )


def check_reply_to(reply_to: str) -> bool:
    """A message's own Reply-To: one conservative address, so no header can be folded into it."""
    return check_recipient(reply_to)


def link_origin_allowed(origin: str | None) -> bool:
    """Whether `origin` is one of KODERA_MAIL_LINK_ORIGINS, the console's origins."""
    allowed: frozenset[str] = getattr(settings, "KODERA_MAIL_LINK_ORIGINS", frozenset())
    return origin is not None and origin in allowed


def check_link(link: str) -> bool:
    """An absolute https URL, or http on a local host, with no user, password or fragment, on an
    allowed origin."""
    if not 0 < len(link) <= 2048 or not _plain(link) or " " in link or "#" in link:
        return False
    return links.origin_of(link) is not None and link_origin_allowed(links.origin_of(link))


def link_refusal(
    template: catalogue.MessageTemplate, link: str | None, link_secret: str | None
) -> str | None:
    """Why a template without a link refuses the link or secret it was given, if it does."""
    if not template.link and (link is not None or link_secret is not None):
        return f"{template.template_id} carries no link"
    return None


def _database_now() -> datetime:
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        now: datetime = cursor.fetchone()[0]
    return now


def enqueue_message(
    *,
    organisation_id: UUID,
    template_id: str,
    locale: str,
    recipient: str,
    params: dict[str, object],
    expires_at: datetime,
    link: str | None = None,
    link_secret: str | None = None,
    reply_to: str | None = None,
) -> UUID:
    """A pending `message` delivery and its sealed message, in the caller's transaction (§3).

    A template that carries a link takes it and its secret; one without a link takes neither. A
    message may name its own Reply-To, sealed with its recipient (§5.1); otherwise the transport's
    applies."""
    require_caller_transaction()
    key = seal_key()
    if key is None:
        raise SenderUnavailableError("no seal key is configured: KODERA_OUTBOX_SEAL_KEY")
    try:
        template = catalogue.get(template_id)
        if locale not in template.copies:
            raise MessageRefusedError(f"{template_id} has no {locale} copy")
        catalogue.check_params(template, params)
    except TemplateError as error:
        raise MessageRefusedError(str(error)) from None
    if not check_recipient(recipient):
        raise MessageRefusedError("the recipient is not one mail address")
    if reply_to is not None and not check_reply_to(reply_to):
        raise MessageRefusedError("the Reply-To is not one mail address")
    refusal = link_refusal(template, link, link_secret)
    if refusal is not None:
        raise MessageRefusedError(refusal)
    if template.link and (link is None or not check_link(link)):
        raise MessageRefusedError(
            "the link is not an https URL without a fragment on an allowed origin"
        )
    if template.link and (link_secret is None or SECRET.fullmatch(link_secret) is None):
        raise MessageRefusedError("the link secret is not 16 to 512 URL-safe characters")
    now = _database_now()
    if expires_at.tzinfo is None or expires_at <= now:
        raise MessageRefusedError("the message expires before it could be sent")
    if expires_at > now + MAX_LIFETIME:
        raise MessageRefusedError("the message would wait longer than seven days")

    delivery_id = new_uuid7()
    sealed = seal.seal(key, delivery_id, recipient, link_secret or "", reply_to=reply_to)
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO outbox_outboxdelivery (id, organisation_id, category, changes_realm, "
            "status, created_at, updated_at) VALUES (%s, %s, 'message', false, 'pending', "
            "clock_timestamp(), clock_timestamp())",
            [delivery_id, organisation_id],
        )
        cursor.execute(
            "INSERT INTO outbox_message (delivery_id, template_id, locale, params, link, sealed, "
            "expires_at) VALUES (%s, %s, %s, %s::jsonb, %s, %s, %s)",
            [delivery_id, template_id, locale, json.dumps(params), link, sealed, expires_at],
        )
    logger.info("message enqueued: delivery %s template %s", delivery_id, template_id)
    return delivery_id


# ---------------------------------------------------------------------------------- run ----


@dataclass
class RunReport:
    sent: int = 0
    deferred: int = 0
    failed: int = 0
    reconciliation: int = 0
    held_for_approval: int = 0
    late: int = 0
    stopped_on_transport_failure: bool = False
    stopped_on_budget: bool = False

    def line(self) -> str:
        return (
            f"sent={self.sent} deferred={self.deferred} failed={self.failed} "
            f"reconciliation={self.reconciliation} held_for_approval={self.held_for_approval}"
            + (" stopped=transport_failure" if self.stopped_on_transport_failure else "")
            + (" stopped=budget" if self.stopped_on_budget else "")
        )


@dataclass(frozen=True)
class Claimed:
    delivery_id: UUID
    organisation_id: UUID
    attempt_id: UUID
    seq: int
    template_id: str
    message_id: str
    recipient: str = field(repr=False)
    message: bytes = field(repr=False)


def jitter(upper: float) -> float:
    """Full jitter: a uniformly random delay between 0 and `upper` seconds."""
    return secrets.SystemRandom().uniform(0.0, upper)


def backoff_s(deferral: int) -> float:
    """The delay after the `deferral`-th temporary attempt of a delivery."""
    return jitter(min(BACKOFF_CAP_S, BACKOFF_BASE_S * 2 ** (deferral - 1)))


def held_templates(transport: MailTransport) -> frozenset[str]:
    """Templates a run does not claim: unapproved copy never leaves on a remote transport (§4)."""
    return frozenset() if transport.local else catalogue.unapproved()


def build_message(
    transport: MailTransport,
    *,
    recipient: str,
    rendered: catalogue.Rendered,
    locale: str,
    message_id: str,
    reply_to: str | None = None,
) -> bytes:
    """One plain-text part. Its Reply-To is the message's own when it names one (checked again
    here, since a sealed value is only as good as what was sealed), else the transport's."""
    if reply_to is not None and not check_reply_to(reply_to):
        raise MessageRefusedError("the Reply-To is not one mail address")
    message = EmailMessage(policy=SMTP)
    message["From"] = transport.sender
    message["To"] = recipient
    message[REPLY_TO_HEADER] = transport.reply_to if reply_to is None else reply_to
    message["Subject"] = rendered.subject
    message["Date"] = format_datetime(datetime.now(UTC))
    message["Message-ID"] = message_id
    message["Auto-Submitted"] = "auto-generated"
    # set_content replaces every Content-* header, so Content-Language follows it.
    message.set_content(rendered.body, charset="utf-8", cte="quoted-printable")
    message["Content-Language"] = locale
    return message.as_bytes()


def _execute(statement: str, parameters: list[Any] | None = None) -> int:
    with connection.cursor() as cursor:
        cursor.execute(statement, parameters)
        count: int = cursor.rowcount
    return count


def _rows(statement: str, parameters: list[Any] | None = None) -> list[tuple[Any, ...]]:
    with connection.cursor() as cursor:
        cursor.execute(statement, parameters)
        rows: list[tuple[Any, ...]] = cursor.fetchall()
    return rows


def erase_sealed(delivery_id: UUID) -> None:
    """Erase the sealed recipient and secret of a delivery that ended (§5.1)."""
    _execute("UPDATE outbox_message SET sealed = NULL WHERE delivery_id = %s", [delivery_id])


_REDACT_ENDED = """
UPDATE outbox_message m SET params = COALESCE(
    (SELECT jsonb_object_agg(e.key, CASE WHEN e.key = ANY(%s) THEN to_jsonb(%s::text) ELSE e.value END)
     FROM jsonb_each(m.params) AS e),
    '{}'::jsonb)
FROM outbox_outboxdelivery d
WHERE m.delivery_id = d.id AND d.id = %s
  AND (d.status IN ('succeeded', 'failed') OR m.expires_at <= clock_timestamp())
"""
REDACTED = "—"


def redact_ended_params(delivery_id: UUID, names: tuple[str, ...]) -> bool:
    """Replace the named parameters of a message whose delivery ended, `succeeded` or `failed`, or
    whose `expires_at` passed, with a dash: a caller that holds customer text erases its last copy
    here (SUPPORT_TICKETS.md §6). It is the condition the sweep erases `sealed` on (§7.1): an expired
    message is never built again, even one awaiting reconciliation, since its seal is gone. A message
    still to be sent is left whole. True when the message was redacted."""
    if not names:
        raise ValueError("name the parameters to redact")
    return _execute(_REDACT_ENDED, [list(names), REDACTED, delivery_id]) == 1


def _metadata(
    *, seq: int | None, template_id: str, smtp_code: int | None, reason: str | None
) -> dict[str, object]:
    return {"attempt": seq, "template_id": template_id, "smtp_code": smtp_code, "reason": reason}


def _end(
    delivery_id: UUID,
    organisation_id: UUID,
    *,
    status: str,
    action: str,
    metadata: dict[str, object],
) -> None:
    """Move a delivery to a terminal status, erase its sealed values, and audit it."""
    _execute(
        "UPDATE outbox_outboxdelivery SET status = %s, finished_at = clock_timestamp(), "
        "updated_at = clock_timestamp() WHERE id = %s",
        [status, delivery_id],
    )
    erase_sealed(delivery_id)
    record_delivery_event(
        action=action, delivery_id=delivery_id, organisation_id=organisation_id, metadata=metadata
    )


# -------------------------------------------------------------------------------- sweep ----

_ABANDONED = """
SELECT d.id, d.organisation_id, a.id, a.seq, m.template_id
FROM outbox_outboxdelivery d
JOIN outbox_deliveryattempt a ON a.delivery_id = d.id AND a.outcome IS NULL
JOIN outbox_message m ON m.delivery_id = d.id
WHERE d.status = 'in_flight' AND d.category = 'message'
  AND a.started_at < clock_timestamp() - %s * interval '1 second'
ORDER BY d.id
FOR NO KEY UPDATE OF d SKIP LOCKED
"""

_EXPIRED = """
SELECT d.id, d.organisation_id, m.template_id
FROM outbox_outboxdelivery d JOIN outbox_message m ON m.delivery_id = d.id
WHERE d.status = 'pending' AND d.category = 'message'
  AND (m.expires_at <= clock_timestamp() OR m.sealed IS NULL)
ORDER BY d.id
FOR NO KEY UPDATE OF d SKIP LOCKED
"""

_ERASE_ENDED = """
UPDATE outbox_message m SET sealed = NULL
FROM outbox_outboxdelivery d
WHERE m.delivery_id = d.id AND m.sealed IS NOT NULL
  AND (d.status IN ('succeeded', 'failed') OR m.expires_at <= clock_timestamp())
"""


def abandon_stale_attempts(report: RunReport) -> None:
    for delivery_id, organisation_id, attempt_id, seq, template_id in _rows(
        _ABANDONED, [STALE_AFTER.total_seconds()]
    ):
        _execute(
            "UPDATE outbox_deliveryattempt SET outcome = 'abandoned', "
            "finished_at = clock_timestamp() WHERE id = %s AND outcome IS NULL",
            [attempt_id],
        )
        _execute(
            "UPDATE outbox_outboxdelivery SET status = 'needs_reconciliation', "
            "updated_at = clock_timestamp() WHERE id = %s",
            [delivery_id],
        )
        record_delivery_event(
            action="outbox_delivery.reconciliation_required",
            delivery_id=delivery_id,
            organisation_id=organisation_id,
            metadata=_metadata(
                seq=seq, template_id=template_id, smtp_code=None, reason="attempt_abandoned"
            ),
        )
        report.reconciliation += 1
        logger.warning(
            "delivery %s attempt %s abandoned: held for reconciliation", delivery_id, seq
        )


def fail_expired(report: RunReport) -> None:
    for delivery_id, organisation_id, template_id in _rows(_EXPIRED):
        _end(
            delivery_id,
            organisation_id,
            status="failed",
            action="outbox_delivery.failed",
            metadata=_metadata(seq=None, template_id=template_id, smtp_code=None, reason="expired"),
        )
        report.failed += 1
        logger.info("delivery %s failed: expired", delivery_id)


def sweep(report: RunReport) -> None:
    """Abandoned attempts, expired messages, then erasure (§7.1), in one transaction."""
    with transaction.atomic():
        abandon_stale_attempts(report)
        fail_expired(report)
        _execute(_ERASE_ENDED)


# -------------------------------------------------------------------------------- claim ----

CLAIM_UNEXPIRED = "AND m.expires_at > clock_timestamp()"

_CLAIM = """
SELECT d.id, d.organisation_id, m.template_id, m.locale, m.params, m.link, m.sealed
FROM outbox_outboxdelivery d JOIN outbox_message m ON m.delivery_id = d.id
WHERE d.status = 'pending' AND d.category = 'message' AND NOT d.changes_realm
  AND m.sealed IS NOT NULL AND m.not_before <= clock_timestamp()
  {unexpired}
  AND NOT (m.template_id = ANY(%s)) AND NOT (d.id = ANY(%s))
ORDER BY m.not_before, d.id
LIMIT 1
FOR NO KEY UPDATE OF d SKIP LOCKED
"""


# A confirmation forms the contract when it is sent (CGV 5.3): one whose order was cancelled before
# it left is withdrawn, never sent. The order's row is locked by its key and its state read after:
# a filter on the state would be applied to the snapshot and skip a row a cancellation still holds,
# so a cancellation still open is waited for, then seen. One that commits after the claim finds the
# confirmation on its way: the cancelled order is then a formed contract's termination
# (apps/billing/confirmations.py). Never SKIP LOCKED here: a held row would read as not cancelled.
_WITHDRAWN = {
    "order_confirmation": (
        "SELECT state FROM billing_order WHERE confirmation_delivery_id = %s FOR SHARE"
    ),
}


def withdrawn(template_id: str, delivery_id: UUID) -> bool:
    statement = _WITHDRAWN.get(template_id)
    if statement is None:
        return False
    rows = _rows(statement, [delivery_id])
    return bool(rows) and rows[0][0] == "cancelled"


def already_attempted(attempted: frozenset[UUID]) -> list[UUID]:
    """The deliveries this run attempted, which it does not claim again (§7)."""
    return sorted(attempted)


def claim_next(
    transport: MailTransport,
    key: bytes,
    report: RunReport,
    attempted: frozenset[UUID] = frozenset(),
) -> Claimed | None:
    """The next due delivery, its attempt opened and committed, or None when nothing is due.

    A sealed value that does not open raises SealError and changes nothing. A template that no
    longer renders fails its delivery, and the claim moves on to the next one. A delivery in
    `attempted` is skipped: a run attempts each delivery at most once, whatever its backoff."""
    held = sorted(held_templates(transport))
    while True:
        with transaction.atomic():
            rows = _rows(
                _CLAIM.format(unexpired=CLAIM_UNEXPIRED), [held, already_attempted(attempted)]
            )
            if not rows:
                return None
            delivery_id, organisation_id, template_id, locale, params, link, sealed = rows[0]
            if withdrawn(template_id, delivery_id):
                _end(
                    delivery_id,
                    organisation_id,
                    status="failed",
                    action="outbox_delivery.failed",
                    metadata=_metadata(
                        seq=None, template_id=template_id, smtp_code=None, reason="withdrawn"
                    ),
                )
                report.failed += 1
                logger.info("delivery %s withdrawn: its order was cancelled", delivery_id)
                continue
            opened = seal.unseal(key, delivery_id, bytes(sealed))
            values = params if isinstance(params, dict) else json.loads(params)
            attempt_id = new_uuid7()
            message_id = f"<{attempt_id}@{transport.sender_domain}>"
            try:
                rendered = catalogue.render(
                    template_id,
                    locale,
                    values,
                    link=None if link is None else f"{link}#{opened.secret}",
                )
                message = build_message(
                    transport,
                    recipient=opened.recipient,
                    rendered=rendered,
                    locale=locale,
                    message_id=message_id,
                    reply_to=opened.reply_to,
                )
            except UNBUILDABLE as error:
                _end(
                    delivery_id,
                    organisation_id,
                    status="failed",
                    action="outbox_delivery.failed",
                    metadata=_metadata(
                        seq=None, template_id=template_id, smtp_code=None, reason="unrenderable"
                    ),
                )
                report.failed += 1
                logger.error(
                    "delivery %s failed: template %s does not build (%s)",
                    delivery_id,
                    template_id,
                    type(error).__name__,
                )
                continue
            (last_seq,) = _rows(
                "SELECT coalesce(max(seq), 0) FROM outbox_deliveryattempt WHERE delivery_id = %s",
                [delivery_id],
            )[0]
            seq = int(last_seq) + 1
            _execute(
                "INSERT INTO outbox_deliveryattempt (id, delivery_id, seq, message_id) "
                "VALUES (%s, %s, %s, %s)",
                [attempt_id, delivery_id, seq, message_id],
            )
            _execute(
                "UPDATE outbox_outboxdelivery SET status = 'in_flight', "
                "started_at = clock_timestamp(), operation_ref = %s, "
                "updated_at = clock_timestamp() WHERE id = %s",
                [message_id, delivery_id],
            )
        logger.info("delivery %s attempt %s claimed: template %s", delivery_id, seq, template_id)
        return Claimed(
            delivery_id=delivery_id,
            organisation_id=organisation_id,
            attempt_id=attempt_id,
            seq=seq,
            template_id=template_id,
            message_id=message_id,
            recipient=opened.recipient,
            message=message,
        )


# ------------------------------------------------------------------------------- record ----


def attempt_is_open(claimed: Claimed) -> bool:
    """Whether the claimed attempt can still be closed: the delivery is still in flight and the
    attempt still open, its row locked. False once the sweep abandoned it (§7.3): a late outcome
    is logged and dropped, and the delivery stays with its operator."""
    return bool(
        _rows(
            "SELECT 1 FROM outbox_outboxdelivery d JOIN outbox_deliveryattempt a "
            "ON a.delivery_id = d.id WHERE d.id = %s AND d.status = 'in_flight' "
            "AND a.id = %s AND a.outcome IS NULL FOR NO KEY UPDATE OF d",
            [claimed.delivery_id, claimed.attempt_id],
        )
    )


def record_outcome(claimed: Claimed, result: SendResult, report: RunReport) -> None:
    """Close the attempt with its outcome and move the delivery, in one transaction (§7.3)."""
    with transaction.atomic():
        if not attempt_is_open(claimed):
            report.late += 1
            logger.warning(
                "delivery %s attempt %s outcome %s arrived after the attempt was abandoned",
                claimed.delivery_id,
                claimed.seq,
                result.outcome,
            )
            return
        transport_only = result.transport_failure and not COUNT_TRANSPORT_FAILURES
        _execute(
            "UPDATE outbox_deliveryattempt SET outcome = %s, finished_at = clock_timestamp(), "
            "smtp_code = %s, provider_message_id = %s WHERE id = %s",
            [
                "transport" if transport_only else result.outcome,
                result.smtp_code,
                result.provider_message_id,
                claimed.attempt_id,
            ],
        )
        metadata = _metadata(
            seq=claimed.seq,
            template_id=claimed.template_id,
            smtp_code=result.smtp_code,
            reason=None,
        )
        if transport_only:
            # The transport failed before MAIL: nothing about the message is known, so the
            # delivery waits for the next run, with no backoff and nothing spent (§7.3).
            _execute(
                "UPDATE outbox_outboxdelivery SET status = 'pending', "
                "updated_at = clock_timestamp() WHERE id = %s",
                [claimed.delivery_id],
            )
            record_delivery_event(
                action="outbox_delivery.deferred",
                delivery_id=claimed.delivery_id,
                organisation_id=claimed.organisation_id,
                metadata={**metadata, "reason": "transport"},
            )
            report.deferred += 1
        elif result.outcome == "accepted":
            _end(
                claimed.delivery_id,
                claimed.organisation_id,
                status="succeeded",
                action="outbox_delivery.sent",
                metadata={
                    **metadata,
                    "message_id": claimed.message_id,
                    "provider_message_id": result.provider_message_id,
                },
            )
            report.sent += 1
        elif result.outcome == "permanent":
            _end(
                claimed.delivery_id,
                claimed.organisation_id,
                status="failed",
                action="outbox_delivery.failed",
                metadata={**metadata, "reason": "rejected"},
            )
            report.failed += 1
        elif result.outcome == "ambiguous":
            _execute(
                "UPDATE outbox_outboxdelivery SET status = 'needs_reconciliation', "
                "updated_at = clock_timestamp() WHERE id = %s",
                [claimed.delivery_id],
            )
            record_delivery_event(
                action="outbox_delivery.reconciliation_required",
                delivery_id=claimed.delivery_id,
                organisation_id=claimed.organisation_id,
                metadata={**metadata, "reason": "outcome_unknown"},
            )
            report.reconciliation += 1
        else:
            _defer(claimed, result, metadata, report)
    logger.info(
        "delivery %s attempt %s outcome %s smtp_code %s error %s",
        claimed.delivery_id,
        claimed.seq,
        result.outcome,
        result.smtp_code,
        result.error_class,
    )


def _defer(
    claimed: Claimed, result: SendResult, metadata: dict[str, object], report: RunReport
) -> None:
    ((deferrals,),) = _rows(
        "SELECT count(*) FROM outbox_deliveryattempt WHERE delivery_id = %s "
        "AND outcome = 'temporary'",
        [claimed.delivery_id],
    )
    if deferrals >= MAX_DEFERRALS:
        _end(
            claimed.delivery_id,
            claimed.organisation_id,
            status="failed",
            action="outbox_delivery.failed",
            metadata={**metadata, "reason": "attempts_exhausted"},
        )
        report.failed += 1
        return
    _execute(
        "UPDATE outbox_message SET not_before = clock_timestamp() + %s * interval '1 second' "
        "WHERE delivery_id = %s",
        [backoff_s(int(deferrals)), claimed.delivery_id],
    )
    _execute(
        "UPDATE outbox_outboxdelivery SET status = 'pending', updated_at = clock_timestamp() "
        "WHERE id = %s",
        [claimed.delivery_id],
    )
    record_delivery_event(
        action="outbox_delivery.deferred",
        delivery_id=claimed.delivery_id,
        organisation_id=claimed.organisation_id,
        metadata={**metadata, "reason": "transport" if result.transport_failure else "temporary"},
    )
    report.deferred += 1


def _held_count(transport: MailTransport) -> int:
    held = sorted(held_templates(transport))
    if not held:
        return 0
    ((count,),) = _rows(
        "SELECT count(*) FROM outbox_outboxdelivery d JOIN outbox_message m "
        "ON m.delivery_id = d.id WHERE d.status = 'pending' AND d.category = 'message' "
        "AND m.template_id = ANY(%s)",
        [held],
    )
    return int(count)


def run_deliveries(
    transport: MailTransport,
    *,
    limit: int = DEFAULT_LIMIT,
    key: bytes | None = None,
    budget_s: float | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> RunReport:
    """Sweep, then claim, send and record due `message` deliveries, one at a time (§7). With
    `budget_s`, nothing new is claimed once that many seconds have passed; a send in progress
    still ends within its own timeout."""
    require_own_transaction()
    key = key if key is not None else seal_key()
    if key is None:
        raise SenderUnavailableError("no seal key is configured: KODERA_OUTBOX_SEAL_KEY")
    report = RunReport()
    sweep(report)
    attempted: set[UUID] = set()
    started = clock()
    while len(attempted) < limit:
        if budget_s is not None and STOP_ON_BUDGET and clock() - started >= budget_s:
            report.stopped_on_budget = True
            break
        claimed = claim_next(transport, key, report, frozenset(attempted))
        if claimed is None:
            break
        attempted.add(claimed.delivery_id)
        try:
            result = smtp.send(transport, recipient=claimed.recipient, message=claimed.message)
        except Exception as error:  # noqa: BLE001 - send never raises; if it does, the outcome is unknown
            result = SendResult(
                outcome="ambiguous", smtp_code=None, error_class=type(error).__name__
            )
        record_outcome(claimed, result, report)
        if result.transport_failure and STOP_ON_TRANSPORT_FAILURE:
            report.stopped_on_transport_failure = True
            break
    report.held_for_approval = _held_count(transport)
    return report
