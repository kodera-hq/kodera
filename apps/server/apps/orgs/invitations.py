"""Invitations: inviteToOrganisation, listInvitations, resendInvitation, revokeInvitation,
previewInvitation and acceptInvitation (docs/specs/INVITATIONS.md).

The API process writes the invitation, its realm account delivery and the request for a mail; it
sends nothing. The operator profile hands the mail to the outbox (`invitation_mail.py`) and the
realm worker makes sure the invitee has an account in the organisation's realm with its required
actions (`apps/outbox/realm_accounts.py`). Accepting needs a token of that realm whose subject is
the account the worker recorded for the invitation, and creates the person, their identity and
their membership in one transaction. Previewing makes the same checks from the same code and
writes nothing.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import struct
from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import RFC_4122, UUID

from django.conf import settings
from django.db import connection, transaction

from apps.audit.services import (
    record_authz_denied,
    record_invitation_event,
    record_membership_created,
)
from apps.identity.invited import (
    KnownSubject,
    create_invited_identity,
    identity_person,
    known_subject,
    person_display_name,
)
from apps.identity.selectors import current_staff_identity, is_storable_subject
from apps.outbox.realm_enqueue import (
    ACCESS_ON,
    account_realm_user_ids,
    enqueue_realm_access,
    enqueue_realm_account,
)
from core.sealing import seal
from services.identity.access_tokens import VerifiedAccessToken

from . import member_set_hooks
from .actor_selectors import (
    TenantCaller,
    TenantCallerNotFoundError,
    TenantCallerUnknownError,
    read_tenant_caller,
)
from .models import INVITATION_LIFETIME, Invitation, Membership, Organisation

READ_SCOPE = "invitation:read"
CREATE_SCOPE = "invitation:create"
ACT_SCOPE = "invitation:act"
DELETE_SCOPE = "invitation:delete"
ADMINISTERING_ROLES = frozenset({"org_owner", "org_admin"})
# An admin may invite an admin or a member, an owner also a billing contact (ADR-0010).
GRANTABLE = {
    "org_owner": frozenset({"org_admin", "org_billing", "org_member"}),
    "org_admin": frozenset({"org_admin", "org_member"}),
}
MAX_BATCH = 500
LIST_DEFAULT = 50
LIST_MAX = 200
# A resend within this window answers `429` (the contract's rate limit per invitation).
RESEND_INTERVAL = timedelta(seconds=60)
MEMBER_JOINED = "member_joined"
TOKEN_PREFIX = "inv1_"  # noqa: S105 - the token grammar's prefix, not a secret
SEAL_CONTEXT = b"invitation-token-v1\x00"
CURSOR_DOMAIN = b"invitation-list-cursor-v1\x00"
_SECRET = re.compile(r"[A-Za-z0-9_-]{43}\Z", re.ASCII)
# The outbox sender's conservative address (apps/outbox/sender.py RECIPIENT, which the API image
# does not carry): an invitation is never written for an address the mail could not be sent to.
_ADDRESS = re.compile(
    r"[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    r"(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\Z",
    re.ASCII,
)
_STATES = ("pending", "accepted", "revoked", "expired")
_CURSOR = struct.Struct("!16s16sB16s")


class InvitationCallerUnknownError(Exception):
    """A verified customer token whose subject Core does not know: `403 identity-unknown`."""


class InvitationNotFoundError(Exception):
    """Not the caller's organisation or invitation, or a token that does not resolve: `404`."""


class InvitationForbiddenError(Exception):
    """A role that may not do this, or an organisation that is not active: `403`, audited."""

    def __init__(self, caller: TenantCaller, scope: str, target_urn: str) -> None:
        super().__init__("forbidden")
        self.caller, self.scope, self.target_urn = caller, scope, target_urn


class InvitationInputError(Exception):
    """A body or query outside the contract: `400 malformed-request`."""


class InvitationStateError(Exception):
    """The invitation or the organisation does not allow this: `409 conflict`."""


class InvitationGoneError(Exception):
    """An expired or revoked invitation, presented for acceptance or a resend: `410`, typed
    `invitation-expired` or `invitation-revoked`."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _gone(invitation: Invitation, now: datetime) -> InvitationGoneError | None:
    """Why the invitation can no longer be used, or None while it is pending and unexpired."""
    if invitation.state == "revoked":
        return InvitationGoneError("revoked")
    if invitation.state == "expired" or (
        invitation.state == "pending" and invitation.expires_at <= now
    ):
        return InvitationGoneError("expired")
    return None


class InvitationRateLimitedError(Exception):
    """A resend sooner than `RESEND_INTERVAL` after the last send: `429`."""

    def __init__(self, retry_after_s: int) -> None:
        super().__init__("rate limited")
        self.retry_after_s = retry_after_s


class InvitationUnavailableError(RuntimeError):
    """This deployment cannot seal a token (no contact seal key): `500`, nothing written."""


@dataclass(frozen=True, slots=True)
class Row:
    email: str
    role: str
    display_name: str | None


@dataclass(frozen=True, slots=True)
class Batch:
    rows: tuple[Row | str, ...]  # a str is an address refused as `invalid_email`
    send_email: bool
    locale: str | None


@dataclass(frozen=True, slots=True)
class Accept:
    token: str
    display_name: str | None
    has_display_name: bool


@dataclass(frozen=True, slots=True)
class InvitationPreview:
    """The invitation card: display names, the role and the expiry; no identifier, no address."""

    organisation_name: str
    inviter_display_name: str | None
    role: str
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class InvitationView:
    id: UUID
    organisation_id: UUID
    email: str
    role: str
    state: str
    realm: str
    invited_by: UUID
    expires_at: datetime
    accepted_at: datetime | None
    membership_id: UUID | None
    sent_count: int
    last_sent_at: datetime | None
    created_at: datetime


@dataclass(frozen=True, slots=True)
class Outcome:
    email: str
    outcome: str
    invitation: InvitationView | None
    detail: str | None


@dataclass(frozen=True, slots=True)
class BatchResult:
    outcomes: tuple[Outcome, ...]


@dataclass(frozen=True, slots=True)
class Page:
    data: tuple[InvitationView, ...]
    next_cursor: str | None


@dataclass(frozen=True, slots=True)
class AcceptedMembership:
    id: UUID
    organisation_id: UUID
    user_id: UUID
    identity_id: UUID
    email: str
    display_name: str | None
    role: str
    state: str
    created_at: datetime
    updated_at: datetime


# --------------------------------------------------------------------------- tokens ----


def format_token(invitation_id: UUID, secret: str) -> str:
    return f"{TOKEN_PREFIX}{invitation_id}_{secret}"


def parse_token(token: str) -> tuple[UUID, str] | None:
    """The invitation id and secret of a well-formed token, or None."""
    if not isinstance(token, str) or len(token) != 85 or not token.startswith(TOKEN_PREFIX):
        return None
    if token[41] != "_" or not _SECRET.fullmatch(token[42:]):
        return None
    try:
        invitation_id = UUID(token[5:41])
    except ValueError:
        return None
    if (
        str(invitation_id) != token[5:41]
        or invitation_id.version != 7
        or invitation_id.variant != RFC_4122
    ):
        return None
    return invitation_id, token[42:]


def digest(secret: str) -> bytes:
    return hashlib.sha256(secret.encode("ascii")).digest()


def seal_context(invitation_id: UUID) -> bytes:
    return SEAL_CONTEXT + invitation_id.bytes


# ---------------------------------------------------------------------------- input ----


def _object(raw: bytes) -> dict[str, object]:
    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise InvitationInputError() from None
    if not isinstance(body, dict):
        raise InvitationInputError()
    return body


def _display_name(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 200 or "\x00" in value:
        raise InvitationInputError()
    return value.strip() or None


def parse_batch(raw: bytes) -> Batch:
    body = _object(raw)
    if set(body) - {"invitations", "send_email", "locale"} or "invitations" not in body:
        raise InvitationInputError()
    items = body["invitations"]
    send_email = body.get("send_email", True)
    locale = body.get("locale")
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_BATCH:
        raise InvitationInputError()
    if not isinstance(send_email, bool) or locale not in {None, "fr", "en"}:
        raise InvitationInputError()
    rows: list[Row | str] = []
    for item in items:
        if not isinstance(item, dict) or set(item) - {"email", "role", "display_name"}:
            raise InvitationInputError()
        email, role = item.get("email"), item.get("role")
        if not isinstance(email, str) or len(email) > 320:
            raise InvitationInputError()
        if role not in {"org_admin", "org_billing", "org_member"}:
            raise InvitationInputError()
        name = _display_name(item.get("display_name"))
        address = email.strip().lower()
        if len(address) > 254 or not _ADDRESS.fullmatch(address):
            rows.append(email)
        else:
            rows.append(Row(address, str(role), name))
    return Batch(tuple(rows), send_email, None if locale is None else str(locale))


def parse_accept(raw: bytes) -> Accept:
    body = _object(raw)
    if set(body) - {"token", "display_name"} or not isinstance(body.get("token"), str):
        raise InvitationInputError()
    token = str(body["token"])
    if not 32 <= len(token) <= 256:
        raise InvitationInputError()
    return Accept(token, _display_name(body.get("display_name")), "display_name" in body)


def parse_preview(raw: bytes) -> str:
    """The token of a previewInvitation body, bounded as acceptance bounds it."""
    body = _object(raw)
    if set(body) != {"token"} or not isinstance(body["token"], str):
        raise InvitationInputError()
    token = str(body["token"])
    if not 32 <= len(token) <= 256:
        raise InvitationInputError()
    return token


# ----------------------------------------------------------------------- authority ----


def _now() -> datetime:
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        now: datetime = cursor.fetchone()[0]
    return now


def authorise(*, verified: VerifiedAccessToken, organisation_id: UUID, scope: str) -> TenantCaller:
    """The caller's current membership, read in a snapshot of its own before any write; an owner
    or an admin of an active organisation, or a refusal."""
    if connection.in_atomic_block or not connection.get_autocommit():
        raise RuntimeError("authorisation requires its own transaction")
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        try:
            caller = read_tenant_caller(verified=verified, organisation_id=organisation_id)
        except TenantCallerUnknownError:
            raise InvitationCallerUnknownError() from None
        except TenantCallerNotFoundError:
            raise InvitationNotFoundError() from None
    if caller.role not in ADMINISTERING_ROLES or (
        scope != READ_SCOPE and caller.organisation_state != "active"
    ):
        raise InvitationForbiddenError(
            caller, scope, f"urn:kodera:organisation:{caller.organisation_id}"
        )
    return caller


def invitation_organisation(*, invitation_id: UUID) -> UUID:
    """The organisation of an invitation, to authorise the caller against; `404` when absent."""
    organisation_id: UUID | None = (
        Invitation.objects.filter(id=invitation_id)
        .values_list("organisation_id", flat=True)
        .first()
    )
    if organisation_id is None:
        raise InvitationNotFoundError()
    return organisation_id


def record_tenant_denial(*, refused: InvitationForbiddenError, request_id: str) -> None:
    with transaction.atomic():
        record_authz_denied(
            actor_type="tenant",
            actor_id=refused.caller.identity_id,
            organisation_id=refused.caller.organisation_id,
            target_urn=refused.target_urn,
            request_id=request_id,
            required_scope=refused.scope,
            reason="role_missing",
        )


def record_staff_denial(
    *, verified: VerifiedAccessToken, organisation_id: UUID | None, scope: str, request_id: str
) -> None:
    """Staff hold no invitation write, and their reads are declared but not served yet."""
    with transaction.atomic():
        staff = current_staff_identity(issuer=verified.issuer, subject=verified.subject)
        record_authz_denied(
            actor_type="staff",
            actor_id=None if staff is None else staff.id,
            organisation_id=organisation_id,
            target_urn="urn:kodera:organisation:"
            + ("unknown" if organisation_id is None else str(organisation_id)),
            request_id=request_id,
            required_scope=scope,
            reason="role_missing",
        )


# --------------------------------------------------------------------------- reads ----


def _view(invitation: Invitation, realm: str, now: datetime) -> InvitationView:
    state = invitation.state
    if state == "pending" and invitation.expires_at <= now:
        state = "expired"
    return InvitationView(
        invitation.id,
        invitation.organisation_id,
        invitation.email,
        invitation.role,
        state,
        realm,
        invitation.invited_by_user_id,
        invitation.expires_at,
        invitation.accepted_at,
        invitation.membership_id,
        invitation.sent_count,
        invitation.last_sent_at,
        invitation.created_at,
    )


def _realm(organisation_id: UUID) -> str:
    realm: str = Organisation.objects.values_list("realm", flat=True).get(id=organisation_id)
    return realm


def _cursor_key() -> bytes:
    key = getattr(settings, "KODERA_MEMBERSHIP_CURSOR_KEY", None)
    if not isinstance(key, str) or len(key) < 32:
        raise RuntimeError("no cursor key is configured: KODERA_MEMBERSHIP_CURSOR_KEY")
    return key.encode("utf-8")


def _sign(fields: bytes) -> bytes:
    return hmac.new(_cursor_key(), CURSOR_DOMAIN + fields, hashlib.sha256).digest()[:16]


def _encode_cursor(caller: TenantCaller, state: str | None, after: UUID) -> str:
    fields = _CURSOR.pack(
        caller.organisation_id.bytes,
        caller.identity_id.bytes,
        0 if state is None else _STATES.index(state) + 1,
        after.bytes,
    )
    return base64.urlsafe_b64encode(fields + _sign(fields)).decode("ascii").rstrip("=")


def _decode_cursor(value: str, caller: TenantCaller, state: str | None) -> UUID:
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError):
        raise InvitationInputError() from None
    if len(raw) != _CURSOR.size + 16:
        raise InvitationInputError()
    fields, tag = raw[: _CURSOR.size], raw[_CURSOR.size :]
    if not hmac.compare_digest(tag, _sign(fields)):
        raise InvitationInputError()
    organisation, identity, state_index, after = _CURSOR.unpack(fields)
    if (
        organisation != caller.organisation_id.bytes
        or identity != caller.identity_id.bytes
        or state_index != (0 if state is None else _STATES.index(state) + 1)
    ):
        raise InvitationInputError()
    return UUID(bytes=after)


def parse_query(query: dict[str, list[str]]) -> tuple[int, str | None, str | None]:
    if set(query) - {"limit", "cursor", "state"} or any(len(v) != 1 for v in query.values()):
        raise InvitationInputError()
    limit = LIST_DEFAULT
    if "limit" in query:
        raw = query["limit"][0]
        if not re.fullmatch(r"[0-9]{1,3}", raw) or not 1 <= int(raw) <= LIST_MAX:
            raise InvitationInputError()
        limit = int(raw)
    state = query.get("state", [None])[0]
    if state is not None and state not in _STATES:
        raise InvitationInputError()
    cursor = query.get("cursor", [None])[0]
    if cursor is not None and not re.fullmatch(r"[A-Za-z0-9_-]{1,512}", cursor):
        raise InvitationInputError()
    return limit, state, cursor


def list_invitations(
    *, caller: TenantCaller, limit: int, state: str | None, cursor: str | None
) -> Page:
    """Newest first, keyset on the UUIDv7 id. `expired` is a pending invitation past its time."""
    after = None if cursor is None else _decode_cursor(cursor, caller, state)
    with transaction.atomic():
        now = _now()
        rows = Invitation.objects.filter(organisation_id=caller.organisation_id)
        if state == "pending":
            rows = rows.filter(state="pending", expires_at__gt=now)
        elif state == "expired":
            rows = rows.filter(state__in=["pending", "expired"], expires_at__lte=now)
        elif state is not None:
            rows = rows.filter(state=state)
        if after is not None:
            rows = rows.filter(id__lt=after)
        found = list(rows.order_by("-id")[: limit + 1])
        realm = _realm(caller.organisation_id)
    page = tuple(_view(row, realm, now) for row in found[:limit])
    more = len(found) > limit
    return Page(page, _encode_cursor(caller, state, page[-1].id) if more else None)


# ---------------------------------------------------------------------------- writes ----


def _lock_invitations(organisation_id: UUID) -> None:
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL lock_timeout = '2s'")
        cursor.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended('invitations:' || %s::text, 0))",
            [organisation_id],
        )


def _expire_due(organisation_id: UUID, now: datetime, request_id: str | None) -> None:
    for invitation_id in Invitation.objects.filter(
        organisation_id=organisation_id, state="pending", expires_at__lte=now
    ).values_list("id", flat=True):
        Invitation.objects.filter(id=invitation_id, state="pending").update(
            state="expired", updated_at=now
        )
        record_invitation_event(
            action="invitation.expired",
            organisation_id=organisation_id,
            invitation_id=invitation_id,
            actor_id=None,
            request_id=request_id,
        )


def _member_addresses(organisation_id: UUID) -> dict[str, str]:
    """The lower-cased addresses of the organisation's people, current or removed, with their
    membership state."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT lower(u.email), lower(i.email), m.state FROM orgs_membership m "
            "JOIN identity_user u ON u.id = m.user_id "
            "LEFT JOIN identity_identity i ON i.user_id = m.user_id AND i.organisation_id = "
            "m.organisation_id AND i.deleted_at IS NULL "
            "WHERE m.organisation_id = %s AND m.deleted_at IS NULL "
            "AND m.state IN ('invited', 'active', 'suspended', 'removed')",
            [organisation_id],
        )
        found: dict[str, str] = {}
        for person, identity, state in cursor.fetchall():
            for address in (person, identity):
                # A current membership wins over a removed one holding the same address.
                if address and found.get(address) in (None, "removed"):
                    found[address] = state
    return found


def _seal_key() -> bytes:
    key = getattr(settings, "KODERA_CONTACT_SEAL_KEY", None)
    if not isinstance(key, bytes):
        raise InvitationUnavailableError("no contact seal key: KODERA_CONTACT_SEAL_KEY")
    return key


def _check_role_grantable(caller: TenantCaller, role: str, scope: str) -> None:
    """An invitation to a role the caller may not grant is not theirs to resend or revoke."""
    if role not in GRANTABLE[caller.role]:
        raise InvitationForbiddenError(
            caller, scope, f"urn:kodera:organisation:{caller.organisation_id}"
        )


def check_grantable(*, caller: TenantCaller, batch: Batch) -> None:
    """A role the caller may not grant refuses the whole call before anything is written."""
    if any(isinstance(row, Row) and row.role not in GRANTABLE[caller.role] for row in batch.rows):
        raise InvitationForbiddenError(
            caller, CREATE_SCOPE, f"urn:kodera:organisation:{caller.organisation_id}"
        )


def invite(*, caller: TenantCaller, batch: Batch, request_id: str) -> BatchResult:
    """The batch, in the replay store's transaction. Every row has an outcome."""
    if not connection.in_atomic_block:
        raise RuntimeError("the invitation batch runs in the replay store's transaction")
    check_grantable(caller=caller, batch=batch)
    key = _seal_key()
    _lock_invitations(caller.organisation_id)
    now = _now()
    _expire_due(caller.organisation_id, now, request_id)
    members = _member_addresses(caller.organisation_id)
    pending = set(
        Invitation.objects.filter(
            organisation_id=caller.organisation_id, state="pending"
        ).values_list("email", flat=True)
    )
    realm = _realm(caller.organisation_id)
    inviter = identity_person(identity_id=caller.identity_id)
    locale = batch.locale or "fr"
    outcomes = []
    for row in batch.rows:
        if isinstance(row, str):
            outcomes.append(Outcome(row, "invalid_email", None, None))
        elif members.get(row.email) == "removed":
            # Their realm account stays disabled, and an invitation never turns one on
            # (docs/specs/INVITATIONS.md §3): no invitation, no mail, no realm delivery.
            outcomes.append(Outcome(row.email, "failed", None, "Removed from this organisation."))
        elif row.email in members:
            outcomes.append(
                Outcome(row.email, "already_member", None, "Already in this organisation.")
            )
        elif row.email in pending:
            outcomes.append(Outcome(row.email, "already_invited", None, None))
        else:
            pending.add(row.email)
            secret = secrets.token_urlsafe(32)
            invitation = Invitation(
                organisation_id=caller.organisation_id,
                email=row.email,
                display_name=row.display_name,
                role=row.role,
                locale=locale,
                token_digest=digest(secret),
                invited_by_user_id=inviter,
                invited_by_identity_id=caller.identity_id,
                issued_at=now,
                expires_at=now + INVITATION_LIFETIME,
                sent_count=1 if batch.send_email else 0,
                last_sent_at=now if batch.send_email else None,
            )
            invitation.token_sealed = seal(key, seal_context(invitation.id), secret.encode())
            invitation.save(force_insert=True)
            enqueue_realm_account(
                organisation_id=caller.organisation_id, invitation_id=invitation.id
            )
            record_invitation_event(
                action="invitation.sent",
                organisation_id=caller.organisation_id,
                invitation_id=invitation.id,
                actor_id=caller.identity_id,
                request_id=request_id,
                metadata={"role": row.role, "send_email": batch.send_email},
            )
            outcomes.append(Outcome(row.email, "created", _view(invitation, realm, now), None))
    return BatchResult(tuple(outcomes))


def _held(invitation_id: UUID, organisation_id: UUID) -> Invitation:
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL lock_timeout = '2s'")
    invitation = (
        Invitation.objects.select_for_update()
        .filter(id=invitation_id, organisation_id=organisation_id)
        .first()
    )
    if invitation is None:
        raise InvitationNotFoundError()
    return invitation


def resend(*, caller: TenantCaller, invitation_id: UUID, request_id: str) -> InvitationView:
    """Same invitation, same token: one more mail requested, and the realm's own required-actions
    mail again for an account not set up yet. In the replay store's transaction."""
    if not connection.in_atomic_block:
        raise RuntimeError("a resend runs in the replay store's transaction")
    invitation = _held(invitation_id, caller.organisation_id)
    _check_role_grantable(caller, invitation.role, ACT_SCOPE)
    now = _now()
    if (gone := _gone(invitation, now)) is not None:
        raise gone
    if invitation.state != "pending":
        raise InvitationStateError()
    if invitation.last_sent_at is not None and now < invitation.last_sent_at + RESEND_INTERVAL:
        wait = invitation.last_sent_at + RESEND_INTERVAL - now
        raise InvitationRateLimitedError(max(1, int(wait.total_seconds()) + 1))
    invitation.sent_count += 1
    invitation.last_sent_at = now
    Invitation.objects.filter(id=invitation.id).update(
        sent_count=invitation.sent_count, last_sent_at=now, updated_at=now
    )
    enqueue_realm_account(organisation_id=caller.organisation_id, invitation_id=invitation.id)
    record_invitation_event(
        action="invitation.resent",
        organisation_id=caller.organisation_id,
        invitation_id=invitation.id,
        actor_id=caller.identity_id,
        request_id=request_id,
        metadata={"sent_count": invitation.sent_count},
    )
    return _view(invitation, _realm(caller.organisation_id), now)


def revoke(*, caller: TenantCaller, invitation_id: UUID, request_id: str) -> None:
    """A pending invitation becomes a tombstone; revoking one already revoked is answered again.
    An accepted or expired one is a conflict."""
    with transaction.atomic():
        invitation = _held(invitation_id, caller.organisation_id)
        _check_role_grantable(caller, invitation.role, DELETE_SCOPE)
        if invitation.state == "revoked":
            return
        now = _now()
        if invitation.state != "pending" or invitation.expires_at <= now:
            raise InvitationStateError()
        Invitation.objects.filter(id=invitation.id, state="pending").update(
            state="revoked", revoked_at=now, updated_at=now
        )
        record_invitation_event(
            action="invitation.revoked",
            organisation_id=caller.organisation_id,
            invitation_id=invitation.id,
            actor_id=caller.identity_id,
            request_id=request_id,
        )


# ---------------------------------------------------------------------------- accept ----


def _accepted(membership: Membership, person: KnownSubject) -> AcceptedMembership:
    return AcceptedMembership(
        membership.id,
        membership.organisation_id,
        person.user_id,
        person.identity_id,
        person.email,
        person.display_name,
        membership.role,
        membership.state,
        membership.created_at,
        membership.updated_at,
    )


@dataclass(frozen=True, slots=True)
class _Redeemable:
    invitation: Invitation
    organisation: Organisation
    known: KnownSubject | None
    now: datetime


def _redeemable(*, verified: VerifiedAccessToken, lane: str, token: str, lock: bool) -> _Redeemable:
    """Steps 1 to 6 of INVITATIONS.md §3, in that order, for acceptance (`lock`: the invitation is
    held `FOR UPDATE`) and for its preview (read in the caller's snapshot, nothing held)."""
    parsed = parse_token(token)
    if lane != "customer" or parsed is None or not is_storable_subject(verified.subject):
        raise InvitationNotFoundError()
    invitation_id, secret = parsed
    organisation_id = invitation_organisation(invitation_id=invitation_id)
    if lock:
        invitation = _held(invitation_id, organisation_id)
    else:
        found = Invitation.objects.filter(id=invitation_id, organisation_id=organisation_id).first()
        if found is None:
            raise InvitationNotFoundError()
        invitation = found
    organisation = Organisation.objects.filter(id=organisation_id, deleted_at__isnull=True).first()
    if (
        organisation is None
        or organisation.issuer != verified.issuer
        or not hmac.compare_digest(bytes(invitation.token_digest), digest(secret))
    ):
        raise InvitationNotFoundError()
    known = known_subject(issuer=verified.issuer, subject=verified.subject)
    if (
        known is not None
        and Membership.objects.filter(
            user_id=known.user_id,
            organisation_id=organisation_id,
            state__in=["active", "suspended"],
            deleted_at__isnull=True,
        ).exists()
    ):
        # A second click on the same link, or a member holding someone else's link.
        raise InvitationStateError()
    now = _now()
    if (gone := _gone(invitation, now)) is not None:
        raise gone
    if invitation.state != "pending":
        raise InvitationNotFoundError()
    # The account the realm worker found or created for this address is the only one that may
    # accept; and the realm must have verified the address the invitation was sent to.
    if (
        verified.subject not in account_realm_user_ids(invitation_id=invitation.id)
        or not verified.email_verified
    ):
        raise InvitationNotFoundError()
    if organisation.state != "active":
        raise InvitationStateError()
    return _Redeemable(invitation, organisation, known, now)


def accept(*, verified: VerifiedAccessToken, lane: str, request: Accept, request_id: str):
    """acceptInvitation, in the replay store's transaction: the caller's realm token and the
    invitation's token together create the person, their identity and their membership."""
    if not connection.in_atomic_block:
        raise RuntimeError("an acceptance runs in the replay store's transaction")
    held = _redeemable(verified=verified, lane=lane, token=request.token, lock=True)
    invitation, organisation, known, now = held.invitation, held.organisation, held.known, held.now
    organisation_id = organisation.id
    name = request.display_name if request.has_display_name else invitation.display_name
    if known is None:
        person = create_invited_identity(
            organisation_id=organisation_id,
            issuer=organisation.issuer,
            realm=organisation.realm,
            subject=verified.subject,
            contact=invitation.email,
            display_name=name,
        )
    elif known.usable:
        # A person Core already holds: their identity stays. An `invited` row is taken over
        # rather than a second one written; a removed one is refused below.
        person = known
    else:
        raise InvitationNotFoundError()
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL lock_timeout = '2s'")
    revived = (
        Membership.objects.filter(
            user_id=person.user_id, organisation_id=organisation_id, deleted_at__isnull=True
        )
        .select_for_update()
        .first()
    )
    if revived is not None and revived.state == "removed":
        # A removed person is refused at invitation time (§3 batch rules) and their realm account
        # stays disabled: a removed row is never revived through an invitation.
        raise InvitationStateError()
    if revived is None:
        membership = Membership.objects.create(
            user_id=person.user_id,
            organisation_id=organisation_id,
            role=invitation.role,
            state="active",
            accepted_at=now,
        )
    else:
        Membership.objects.filter(id=revived.id).update(
            role=invitation.role, state="active", accepted_at=now, updated_at=now
        )
        membership = Membership.objects.get(id=revived.id)
        enqueue_realm_access(
            organisation_id=organisation_id,
            membership_id=membership.id,
            user_id=person.user_id,
            operation=ACCESS_ON,
        )
    Invitation.objects.filter(id=invitation.id, state="pending").update(
        state="accepted", accepted_at=now, membership_id=membership.id, updated_at=now
    )
    record_invitation_event(
        action="invitation.accepted",
        organisation_id=organisation_id,
        invitation_id=invitation.id,
        actor_id=person.identity_id,
        request_id=request_id,
    )
    record_membership_created(
        organisation_id=organisation_id,
        membership_id=membership.id,
        actor_id=person.identity_id,
        request_id=request_id,
    )
    # The engines learn of the newcomer now rather than at the next change (ADR-0016).
    member_set_hooks.member_set_changed(organisation_id=organisation_id, reason=MEMBER_JOINED)
    return _accepted(membership, person)


def preview(*, verified: VerifiedAccessToken, lane: str, token: str) -> InvitationPreview:
    """previewInvitation: what acceptance would answer, read in one read-only snapshot. The card
    on success; otherwise the refusal acceptance would give, raised before it would write."""
    if connection.in_atomic_block or not connection.get_autocommit():
        raise RuntimeError("a preview requires its own transaction")
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        found = _redeemable(verified=verified, lane=lane, token=token, lock=False)
        invitation, organisation, known = found.invitation, found.organisation, found.known
        # Acceptance's two refusals after step 6: a person Core holds who is no longer usable,
        # and a removed membership, which an invitation never revives.
        if known is not None and not known.usable:
            raise InvitationNotFoundError()
        if (
            known is not None
            and Membership.objects.filter(
                user_id=known.user_id,
                organisation_id=organisation.id,
                state="removed",
                deleted_at__isnull=True,
            ).exists()
        ):
            raise InvitationStateError()
        return InvitationPreview(
            organisation_name=organisation.name,
            inviter_display_name=person_display_name(user_id=invitation.invited_by_user_id),
            role=invitation.role,
            expires_at=invitation.expires_at,
        )
