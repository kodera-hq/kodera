"""createSupportTicket's service: docs/specs/SUPPORT_TICKETS.md.

The caller is authorised in a read-only snapshot of its own, then again inside the replay store's
transaction, where the ticket is written under a lock of its organisation's tickets with the two limits
counted. The tenant context and the address support replies to are Core's, never the request's.
Nothing here mails: the operator's run does (apps/support/ticket_mail.py).
"""

import json
import math
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db import connection, transaction
from django.utils import timezone

from apps.audit.services import record_authz_denied, record_support_ticket_opened
from apps.identity.selectors import current_identity, current_staff_identity
from apps.orgs.actor_selectors import (
    TenantCaller,
    TenantCallerNotFoundError,
    TenantCallerUnknownError,
    read_tenant_caller,
)
from apps.tenancy.selectors import newest_tenant_not_deleted, tenant_of
from services.identity.access_tokens import VerifiedAccessToken

from .models import BODY_LENGTH, CATEGORIES, LOCALES, SEVERITIES, SUBJECT_LENGTH, SupportTicket

SCOPE = "support_ticket:create"
NEW_TICKET = "urn:kodera:support_ticket:new"
TENANT_ROLES = frozenset({"org_owner", "org_admin", "org_billing", "org_member"})
# The longest body a valid request has: 20,000 characters, each at most a six-byte JSON escape,
# plus the other members. A larger one is refused before it is parsed.
MAX_REQUEST_BYTES = 128 * 1024
# The longest `contact_email` accepted: a mail parameter's bound (apps/outbox/mail/catalogue.py
# MAX_PARAM_LENGTH), so every ticket the API accepts can be mailed. Pinned by
# tests/test_support_ticket_request.py.
MAX_CONTACT_EMAIL = 200
WINDOW = timedelta(hours=1)
PER_IDENTITY = 5
PER_ORGANISATION = 20
# A request names these and nothing else (SupportTicketCreateRequest, additionalProperties false).
MEMBERS = frozenset(
    {
        "subject",
        "body",
        "category",
        "severity",
        "organisation_id",
        "tenant_id",
        "contact_email",
        "locale",
    }
)
REQUIRED = ("subject", "body", "category")
# The outbox sender's own conservative address (apps/outbox/sender.py RECIPIENT, which the API
# image does not carry): letters, digits and `_ % + -` atoms before the `@`, host labels after it.
ADDRESS = re.compile(
    r"[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+"
)
# The only control characters a ticket's message keeps.
BODY_CONTROLS = frozenset("\n\t")


class TicketCallerUnknownError(Exception):
    """Core holds no enabled identity for the token: the identity-unknown answer."""


class TicketForbiddenError(Exception):
    """A refusal recorded as `authz.denied`: no current membership, or another organisation."""

    def __init__(
        self, *, identity_id: UUID | None, organisation_id: UUID | None, target_urn: str
    ) -> None:
        super().__init__("support ticket refused")
        self.identity_id, self.organisation_id, self.target_urn = (
            identity_id,
            organisation_id,
            target_urn,
        )


class TicketInputError(Exception):
    """The request is malformed: each error a JSON pointer and a code."""

    def __init__(self, errors: list[tuple[str, str]] | None = None) -> None:
        super().__init__("malformed support ticket")
        self.errors = errors or []


class TicketRateLimitedError(Exception):
    def __init__(self, retry_after_s: int) -> None:
        super().__init__("rate limited")
        self.retry_after_s = retry_after_s


class SupportUnavailableError(Exception):
    """No support mailbox is configured: nothing is stored."""


@dataclass(frozen=True, slots=True)
class Caller:
    identity_id: UUID
    organisation_id: UUID
    email: str | None


@dataclass(frozen=True, slots=True)
class TicketRequest:
    subject: str
    body: str
    category: str
    severity: str
    locale: str
    organisation_id: UUID | None
    tenant_id: UUID | None
    contact_email: str | None


# ------------------------------------------------------------------------------ settings ----


def support_mailbox() -> str | None:
    """KODERA_SUPPORT_MAILBOX when it is one address, else None (the route answers `503`)."""
    value = getattr(settings, "KODERA_SUPPORT_MAILBOX", None)
    if not isinstance(value, str) or not is_address(value):
        return None
    return value


def is_address(value: str) -> bool:
    return (
        len(value) <= 254 and len(value.partition("@")[0]) <= 64 and bool(ADDRESS.fullmatch(value))
    )


# ----------------------------------------------------------------------------- authority ----


def _caller(verified: VerifiedAccessToken) -> tuple[TenantCaller, str | None]:
    """The caller's current membership in its own organisation, in the caller's transaction."""
    resolved = current_identity(issuer=verified.issuer, subject=verified.subject)
    if resolved is None:
        raise TicketCallerUnknownError()
    person, identity = resolved
    if identity.organisation_id is None:
        raise TicketCallerUnknownError()
    try:
        caller = read_tenant_caller(verified=verified, organisation_id=identity.organisation_id)
    except TenantCallerUnknownError:
        raise TicketCallerUnknownError() from None
    except TenantCallerNotFoundError:
        raise TicketForbiddenError(
            identity_id=identity.id,
            organisation_id=identity.organisation_id,
            target_urn=NEW_TICKET,
        ) from None
    if caller.role not in TENANT_ROLES:
        raise TicketForbiddenError(
            identity_id=caller.identity_id,
            organisation_id=caller.organisation_id,
            target_urn=NEW_TICKET,
        )
    return caller, person.email


def authorise(*, verified: VerifiedAccessToken) -> Caller:
    """The caller, read in a read-only snapshot of its own before anything is parsed or written:
    any current member of its own organisation, active or suspended."""
    if connection.in_atomic_block or not connection.get_autocommit():
        raise RuntimeError("authorisation requires its own transaction")
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        caller, email = _caller(verified)
    return Caller(caller.identity_id, caller.organisation_id, email)


def record_tenant_denial(*, refused: TicketForbiddenError, request_id: str) -> None:
    with transaction.atomic():
        record_authz_denied(
            actor_type="tenant",
            actor_id=refused.identity_id,
            organisation_id=refused.organisation_id,
            target_urn=refused.target_urn,
            request_id=request_id,
            required_scope=SCOPE,
            reason="role_missing",
        )


def record_staff_denial(*, verified: VerifiedAccessToken, request_id: str) -> None:
    """Staff are refused until the staff lane of the customer operations exists."""
    with transaction.atomic():
        staff = current_staff_identity(issuer=verified.issuer, subject=verified.subject)
        record_authz_denied(
            actor_type="staff",
            actor_id=None if staff is None else staff.id,
            organisation_id=None,
            target_urn=NEW_TICKET,
            request_id=request_id,
            required_scope=SCOPE,
            reason="role_missing",
        )


# ------------------------------------------------------------------------------- request ----


# What a message may not hold besides its line feeds and tabs: the other C0 and C1 controls, a lone
# surrogate (which no mail can encode), and the line and paragraph separators, which break a line
# without being one. Format characters (an emoji's joiner, a soft hyphen, a right-to-left mark) are
# text. The catalogue's `text` check is the same rule (tests/test_support_ticket_request.py).
REFUSED_IN_MESSAGE = frozenset({"Cc", "Cs", "Zl", "Zp"})


def _one_line(value: str) -> bool:
    """A subject: the rule of a mail's single value (no character of category C), and no line or
    paragraph separator."""
    return not any(
        unicodedata.category(character).startswith("C")
        or unicodedata.category(character) in {"Zl", "Zp"}
        for character in value
    )


def _message(value: str) -> str | None:
    """The message with CRLF and CR made LF, or None when another control character is in it."""
    text = value.replace("\r\n", "\n").replace("\r", "\n")
    if any(
        character not in BODY_CONTROLS and unicodedata.category(character) in REFUSED_IN_MESSAGE
        for character in text
    ):
        return None
    return text


def _uuid(value: object) -> UUID | None:
    if not isinstance(value, str):
        raise ValueError
    parsed = UUID(value)
    if str(parsed) != value.lower():
        raise ValueError
    return parsed


def _pointer(name: str) -> str:
    """The JSON Pointer (RFC 6901) to a top-level member: `~` and `/` escaped."""
    return "/" + name.replace("~", "~0").replace("/", "~1")


def parse_request(raw: bytes, content_type: str) -> TicketRequest:
    """A SupportTicketCreateRequest, or `400` naming each malformed member."""
    if content_type != "application/json" or len(raw) > MAX_REQUEST_BYTES:
        raise TicketInputError()
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError, RecursionError):
        # RecursionError: a body nested deeper than the parser goes, which fits in the size cap.
        raise TicketInputError() from None
    if not isinstance(body, dict):
        raise TicketInputError()
    errors: list[tuple[str, str]] = [
        (_pointer(name), "unexpected") for name in sorted(set(body) - MEMBERS)
    ]
    errors += [("/" + name, "required") for name in REQUIRED if name not in body]

    subject = body.get("subject")
    if "subject" in body and not (
        isinstance(subject, str)
        and SUBJECT_LENGTH[0] <= len(subject) <= SUBJECT_LENGTH[1]
        and _one_line(subject)
    ):
        errors.append(("/subject", "invalid"))
    raw_message = body.get("body")
    message = _message(raw_message) if isinstance(raw_message, str) else None
    if "body" in body and not (
        message is not None and BODY_LENGTH[0] <= len(message) <= BODY_LENGTH[1]
    ):
        errors.append(("/body", "invalid"))
    if "category" in body and body["category"] not in CATEGORIES:
        errors.append(("/category", "invalid"))
    severity = body.get("severity", "question")
    if severity not in SEVERITIES:
        errors.append(("/severity", "invalid"))
    locale = body.get("locale", "fr")
    if locale not in LOCALES:
        errors.append(("/locale", "invalid"))
    identifiers: dict[str, UUID | None] = {}
    for name in ("organisation_id", "tenant_id"):
        value = body.get(name)
        try:
            identifiers[name] = None if value is None else _uuid(value)
        except ValueError:
            errors.append(("/" + name, "invalid"))
    contact = body.get("contact_email")
    if contact is not None and not (
        isinstance(contact, str) and len(contact) <= MAX_CONTACT_EMAIL and is_address(contact)
    ):
        errors.append(("/contact_email", "invalid"))
    if errors:
        raise TicketInputError(errors)
    assert isinstance(subject, str) and message is not None  # noqa: S101 - checked above
    return TicketRequest(
        subject=subject,
        body=message,
        category=str(body["category"]),
        severity=str(severity),
        locale=str(locale),
        organisation_id=identifiers.get("organisation_id"),
        tenant_id=identifiers.get("tenant_id"),
        contact_email=contact,
    )


def check_organisation(caller: Caller, request: TicketRequest) -> None:
    """A ticket is never filed under an organisation the caller does not belong to."""
    if request.organisation_id is not None and request.organisation_id != caller.organisation_id:
        raise TicketForbiddenError(
            identity_id=caller.identity_id,
            organisation_id=caller.organisation_id,
            target_urn=f"urn:kodera:organisation:{request.organisation_id}",
        )


# ----------------------------------------------------------------------------------- open ----


def _retry_after(created: list[datetime], limit: int, now: datetime) -> int | None:
    """Seconds until fewer than `limit` of `created` (oldest first) are within the hour, or None
    when fewer already are."""
    if len(created) < limit:
        return None
    leaves = created[len(created) - limit] + WINDOW
    return max(1, math.ceil((leaves - now).total_seconds()))


def _recent(rows: Any, since: datetime) -> list[datetime]:
    return list(
        rows.filter(created_at__gt=since)
        .order_by("created_at")
        .values_list("created_at", flat=True)
    )


def _tenant(organisation_id: UUID, tenant_id: UUID | None) -> Any:
    """The tenancy app's tenant row the ticket is about, or None (SUPPORT_TICKETS.md §3)."""
    if tenant_id is None:
        return newest_tenant_not_deleted(organisation_id)
    named = tenant_of(organisation_id=organisation_id, tenant_id=tenant_id)
    if named is None or named.status == "deleted":
        raise TicketInputError([("/tenant_id", "unknown")])
    return named


def open_ticket(
    *, verified: VerifiedAccessToken, request: TicketRequest, request_id: str
) -> SupportTicket:
    """The ticket, in the replay store's transaction. The caller is read again here, so a member
    removed since the snapshot opens nothing."""
    if not connection.in_atomic_block:
        raise RuntimeError("a ticket is opened in the replay store's transaction")
    caller, email = _caller(verified)
    check_organisation(Caller(caller.identity_id, caller.organisation_id, email), request)
    # Every ticket of the organisation is counted under this lock, the identity's included. It is
    # a transaction lock of its own rather than the organisation's row lock, so creating a ticket
    # neither waits on nor holds back an update of the organisation.
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended('support_tickets:' || %s::text, 0))",
            [str(caller.organisation_id)],
        )
    now = timezone.now()
    since = now - WINDOW
    waits = [
        _retry_after(
            _recent(SupportTicket.objects.filter(created_by_id=caller.identity_id), since),
            PER_IDENTITY,
            now,
        ),
        _retry_after(
            _recent(SupportTicket.objects.filter(organisation_id=caller.organisation_id), since),
            PER_ORGANISATION,
            now,
        ),
    ]
    if any(wait is not None for wait in waits):
        raise TicketRateLimitedError(max(wait for wait in waits if wait is not None))
    tenant = _tenant(caller.organisation_id, request.tenant_id)
    ticket = SupportTicket.objects.create(
        organisation_id=caller.organisation_id,
        created_by_id=caller.identity_id,
        tenant=tenant,
        subject=request.subject,
        body=request.body,
        category=request.category,
        severity=request.severity,
        locale=request.locale,
        reply_to_email=email if email is not None and is_address(email) else None,
        contact_email=request.contact_email,
        tenant_slug=None if tenant is None else tenant.slug,
        tenant_status=None if tenant is None else tenant.status,
        pack_code=None if tenant is None else tenant.pack_code,
        capacity_tier_code=None if tenant is None else tenant.capacity_tier_code,
    )
    record_support_ticket_opened(
        organisation_id=caller.organisation_id,
        ticket_id=ticket.id,
        actor_id=caller.identity_id,
        request_id=request_id,
        category=ticket.category,
        severity=ticket.severity,
    )
    return ticket


def _stamp(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def representation(ticket: SupportTicket) -> dict[str, Any]:
    """The contract's SupportTicket: no `sla` until a target per tier exists, no helpdesk
    reference, and the tenant context Core copied when the ticket was opened."""
    created = _stamp(ticket.created_at)
    return {
        "id": str(ticket.id),
        "organisation_id": str(ticket.organisation_id),
        "tenant_id": None if ticket.tenant_id is None else str(ticket.tenant_id),
        "subject": ticket.subject,
        "category": ticket.category,
        "severity": ticket.severity,
        "state": ticket.state,
        "tenant_context": {
            "tenant_slug": ticket.tenant_slug,
            "tenant_status": ticket.tenant_status,
            "pack_code": ticket.pack_code,
            "capacity_tier_code": ticket.capacity_tier_code,
            "agent_stale": None,
            "open_incident_component_keys": [],
            "last_job_id": None,
        },
        "message_count": 1,
        "last_message_at": created,
        "created_by": str(ticket.created_by_id),
        "external_ref": None,
        "created_at": created,
        "updated_at": _stamp(ticket.updated_at),
    }
