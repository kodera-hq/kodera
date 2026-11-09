"""The DPA's notice addresses: docs/specs/ORGANISATION_NOTICE_CONTACTS.md.

The read runs in its own repeatable-read snapshot. The write locks the organisation row, checks the
caller under that lock, compares the tag, writes the changed addresses and their one audit row.
`notice_recipients` is what a DPA notice sender asks: the stored address, or the current owners.
"""

import hashlib
import json
import re
from dataclasses import dataclass
from uuid import UUID

from django.db import OperationalError, connection, transaction
from django.utils import timezone

from apps.audit.services import record_authz_denied, record_organisation_updated
from apps.identity.selectors import current_staff_identity, person_contacts
from services.identity.access_tokens import VerifiedAccessToken

from .actor_selectors import (
    TenantCaller,
    TenantCallerNotFoundError,
    TenantCallerUnknownError,
    organisation_slug,
    read_tenant_caller,
)
from .models import Membership, Organisation

FIELDS = ("security_contact_email", "privacy_contact_email", "subprocessor_notice_email")
# DPA 11.6: a breach notification goes to the security contact and the DPO; DPA 8.2: a
# sub-processor change goes to its own recipient (Annex D).
KINDS = {
    "breach": ("security_contact_email", "privacy_contact_email"),
    "subprocessor": ("subprocessor_notice_email",),
}
READING_ROLES = frozenset({"org_owner", "org_admin"})
WRITING_ROLES = frozenset({"org_owner"})
READ_SCOPE = "organisation:read"
UPDATE_SCOPE = "organisation:update"
DENIAL_REASON = "role_missing"
# Under every connection's 2-second statement_timeout (config/environment.py), so a wait for the
# row ends as a lock timeout, which is answered as retryable, rather than as a statement timeout.
LOCK_TIMEOUT = "SET LOCAL lock_timeout = '1s'"
# The outbox sender's conservative address (apps/outbox/sender.py RECIPIENT, check_recipient): a
# notice must be deliverable, so an address the sender would refuse is refused here. Kept equal to
# the sender's by tests/test_organisation_notice_contacts.py.
RECIPIENT = re.compile(
    r"[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+"
)
OWNER_PAGE = 200


class NoticeCallerUnknownError(Exception):
    """No enabled identity for the token: `403 identity-unknown`."""


class NoticeNotFoundError(Exception):
    """Not the caller's organisation, or no current membership in it: `404`."""


class NoticeForbiddenError(Exception):
    """The caller's role, or the organisation's state, refuses: `403`, recorded."""

    def __init__(self, caller: TenantCaller) -> None:
        super().__init__("forbidden")
        self.caller = caller


class NoticePatchInvalidError(Exception):
    """A body outside `NoticeContactsPatchRequest`: `400`."""


class NoticeBusyError(Exception):
    """The organisation row stayed locked past the timeout: `503`, retry the same request."""


class NoticePreconditionRequiredError(Exception):
    """A `PATCH` without `If-Match`: `428`."""


class NoticePreconditionFailedError(Exception):
    """`If-Match` is not the current tag: `412`."""

    def __init__(self, current_etag: str) -> None:
        super().__init__("precondition failed")
        self.current_etag = current_etag


@dataclass(frozen=True, slots=True, repr=False)
class NoticeContacts:
    organisation_id: UUID
    security_contact_email: str | None
    privacy_contact_email: str | None
    subprocessor_notice_email: str | None

    def values(self) -> dict[str, str | None]:
        return {field: getattr(self, field) for field in FIELDS}


def etag(contacts: NoticeContacts) -> str:
    canonical = json.dumps(
        {"organisation_id": str(contacts.organisation_id), **contacts.values()},
        sort_keys=True,
        separators=(",", ":"),
    )
    return '"' + hashlib.sha256(canonical.encode()).hexdigest() + '"'


def parse_patch(body: bytes) -> dict[str, str | None]:
    """A `NoticeContactsPatchRequest`: only the three members, each an address or `null`."""
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise NoticePatchInvalidError() from None
    if not isinstance(value, dict) or not set(value) <= set(FIELDS):
        raise NoticePatchInvalidError()
    for item in value.values():
        if item is not None and not (isinstance(item, str) and deliverable(item)):
            raise NoticePatchInvalidError()
    return dict(value)


def deliverable(address: str) -> bool:
    """Whether the outbox sender would accept `address` as a recipient."""
    return (
        len(address) <= 254
        and len(address.partition("@")[0]) <= 64
        and RECIPIENT.fullmatch(address) is not None
    )


def read_notice_contacts(
    *, verified: VerifiedAccessToken, organisation_id: UUID
) -> tuple[NoticeContacts, str]:
    if connection.in_atomic_block:
        raise RuntimeError("the notice contacts read requires its own transaction")
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        caller = _caller(verified, organisation_id)
        if caller.role not in READING_ROLES:
            raise NoticeForbiddenError(caller)
        contacts = _contacts(caller.organisation_id)
        return contacts, etag(contacts)


def change_notice_contacts(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    patch: dict[str, str | None],
    if_match: str | None,
    request_id: str,
) -> tuple[NoticeContacts, str]:
    if connection.in_atomic_block:
        raise RuntimeError("a notice contacts change runs in its own transaction")
    try:
        return _change(verified, organisation_id, patch, if_match, request_id)
    except OperationalError as error:
        if getattr(error.__cause__, "sqlstate", None) == "55P03":
            raise NoticeBusyError() from error
        raise


def _change(
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    patch: dict[str, str | None],
    if_match: str | None,
    request_id: str,
) -> tuple[NoticeContacts, str]:
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(LOCK_TIMEOUT)
        caller = _caller(verified, organisation_id)
        if caller.role not in WRITING_ROLES:
            raise NoticeForbiddenError(caller)
        Organisation.objects.select_for_update(no_key=True).filter(
            id=caller.organisation_id
        ).values_list("id", flat=True).get()
        # The caller's authority may have changed while this transaction waited for the row.
        caller = _caller(verified, organisation_id)
        if caller.role not in WRITING_ROLES or caller.organisation_state != "active":
            raise NoticeForbiddenError(caller)
        current = _contacts(caller.organisation_id)
        if if_match is None:
            raise NoticePreconditionRequiredError()
        tag = etag(current)
        if if_match != tag:
            raise NoticePreconditionFailedError(tag)
        before = {field: value for field, value in current.values().items() if field in patch}
        changed = {field: value for field, value in patch.items() if before[field] != value}
        if not changed:
            return current, tag
        Organisation.objects.filter(id=caller.organisation_id).update(
            **changed, updated_at=timezone.now()
        )
        # AUDIT_TAXONOMY.md §4: never an email address in the trail, only whether each changed
        # address is set.
        record_organisation_updated(
            organisation_id=caller.organisation_id,
            slug=organisation_slug(organisation_id=caller.organisation_id) or "unknown",
            actor_id=caller.identity_id,
            request_id=request_id,
            before={field: _marker(before[field]) for field in changed},
            after={field: _marker(value) for field, value in changed.items()},
        )
        updated = _contacts(caller.organisation_id)
        return updated, etag(updated)


def notice_recipients(*, organisation_id: UUID, kind: str) -> tuple[str, ...]:
    """Where a DPA notice of `kind` goes: the stored addresses for it, or, when none is set, the
    current owners' addresses (active, accepted owner memberships of enabled people, in membership
    id order). Nothing for an absent or deleted organisation."""
    stored = (
        Organisation.objects.filter(id=organisation_id, deleted_at__isnull=True)
        .values_list(*KINDS[kind])
        .first()
    )
    if stored is None:
        return ()
    addresses = tuple(dict.fromkeys(address for address in stored if address))
    if addresses:
        return addresses
    owners = tuple(
        Membership.objects.filter(
            organisation_id=organisation_id,
            role=Membership.Role.OWNER,
            state=Membership.State.ACTIVE,
            accepted_at__isnull=False,
            deleted_at__isnull=True,
            user__enabled=True,
            user__deleted_at__isnull=True,
        )
        .order_by("id")
        .values_list("user_id", flat=True)
    )
    contacts = {}
    for start in range(0, len(owners), OWNER_PAGE):
        page = owners[start : start + OWNER_PAGE]
        contacts.update({person.id: person.email for person in person_contacts(user_ids=page)})
    return tuple(contacts[user_id] for user_id in owners if user_id in contacts)


def record_tenant_denial(*, refused: NoticeForbiddenError, scope: str, request_id: str) -> None:
    """`authz.denied` for a tenant caller, in a transaction of its own after the refused one."""
    _record_denial(
        actor_type="tenant",
        actor_id=refused.caller.identity_id,
        organisation_id=refused.caller.organisation_id,
        scope=scope,
        request_id=request_id,
    )


def record_staff_denial(
    *, verified: VerifiedAccessToken, organisation_id: UUID, scope: str, request_id: str
) -> None:
    """`authz.denied` for a staff token, which holds no cell of these operations."""
    staff = current_staff_identity(issuer=verified.issuer, subject=verified.subject)
    _record_denial(
        actor_type="staff",
        actor_id=None if staff is None else staff.id,
        organisation_id=organisation_id,
        scope=scope,
        request_id=request_id,
    )


def _record_denial(
    *, actor_type: str, actor_id: UUID | None, organisation_id: UUID, scope: str, request_id: str
) -> None:
    if connection.in_atomic_block:
        raise RuntimeError("a denial is recorded in a transaction of its own")
    with transaction.atomic():
        slug = organisation_slug(organisation_id=organisation_id)
        record_authz_denied(
            actor_type=actor_type,
            actor_id=actor_id,
            organisation_id=None if slug is None else organisation_id,
            target_urn=f"urn:kodera:organisation:{slug or 'unknown'}",
            request_id=request_id,
            required_scope=scope,
            reason=DENIAL_REASON,
        )


def _caller(verified: VerifiedAccessToken, organisation_id: UUID) -> TenantCaller:
    try:
        return read_tenant_caller(verified=verified, organisation_id=organisation_id)
    except TenantCallerUnknownError:
        raise NoticeCallerUnknownError() from None
    except TenantCallerNotFoundError:
        raise NoticeNotFoundError() from None


def _marker(value: str | None) -> str | None:
    return None if value is None else "set"


def _contacts(organisation_id: UUID) -> NoticeContacts:
    row = Organisation.objects.filter(id=organisation_id).values_list(*FIELDS).get()
    return NoticeContacts(organisation_id, *row)
