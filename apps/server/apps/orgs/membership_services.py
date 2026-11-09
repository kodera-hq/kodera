"""Current authority and materialized directory facts share one read-only snapshot."""

from dataclasses import dataclass

from django.db import connection, transaction

from apps.identity.selectors import PersonSnapshot, current_identity, person_contacts
from services.identity.access_tokens import VerifiedAccessToken

from .membership_pagination import (
    cursor_key,
    decode_cursor,
    encode_cursor,
    parse_query,
    parse_target,
)
from .membership_selectors import (
    DIRECTORY_ROLES,
    DirectoryMembership,
    directory_memberships,
    directory_role,
)
from .selectors import has_current_read_grant


class UnknownDirectoryCustomerError(Exception):
    """No currently eligible persisted identity and person."""


class DirectoryForbiddenError(Exception):
    """No current grant or directory role."""


class DirectoryNotFoundError(Exception):
    """Target is outside the verified customer's issuer-bound organisation."""


@dataclass(frozen=True, slots=True, repr=False)
class DirectoryRow:
    membership: DirectoryMembership
    person: PersonSnapshot


@dataclass(frozen=True, slots=True, repr=False)
class DirectoryPage:
    rows: tuple[DirectoryRow, ...]
    next_cursor: str | None
    has_more: bool


def read_directory(
    *, verified: VerifiedAccessToken, target: str, raw_query: str, signing_input: object
) -> DirectoryPage:
    subject = verified.subject
    if not 1 <= len(subject) <= 255 or not subject.isascii() or "\x00" in subject:
        raise UnknownDirectoryCustomerError()
    if connection.in_atomic_block:
        raise RuntimeError("directory read requires its own transaction")
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        resolved = current_identity(issuer=verified.issuer, subject=subject)
        if resolved is None:
            raise UnknownDirectoryCustomerError()
        person, identity = resolved
        target_id = parse_target(target)
        if target_id != identity.organisation_id:
            raise DirectoryNotFoundError()
        if not has_current_read_grant(
            user_id=person.id,
            organisation_id=identity.organisation_id,
            issuer=identity.issuer,
            realm=identity.realm,
        ):
            raise DirectoryForbiddenError()
        role = directory_role(user_id=person.id, organisation_id=identity.organisation_id)
        if role not in DIRECTORY_ROLES:
            raise DirectoryForbiddenError()
        parameters = parse_query(raw_query)
        key = cursor_key(signing_input)
        continuation = decode_cursor(
            key=key,
            person_id=person.id,
            organisation_id=identity.organisation_id,
            query=parameters,
        )
        memberships, ceiling = directory_memberships(
            organisation_id=identity.organisation_id,
            query=parameters,
            continuation=continuation,
        )
        has_more = len(memberships) > parameters.limit
        visible = memberships[: parameters.limit]
        contacts = {
            contact.id: contact
            for contact in person_contacts(user_ids=tuple(item.user_id for item in visible))
        }
        rows = tuple(DirectoryRow(item, contacts[item.user_id]) for item in visible)
        next_cursor = None
        if has_more:
            if ceiling is None:
                raise RuntimeError("nonterminal directory page has no ceiling")
            next_cursor = encode_cursor(
                key=key,
                person_id=person.id,
                organisation_id=identity.organisation_id,
                query=parameters,
                after=visible[-1].id,
                ceiling=ceiling,
            )
        return DirectoryPage(rows, next_cursor, has_more)
