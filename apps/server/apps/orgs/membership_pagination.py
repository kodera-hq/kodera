"""Bounded query parsing and authenticated principal-bound UUID keyset cursors."""

import base64
import binascii
import hashlib
import hmac
import re
import struct
from dataclasses import dataclass
from uuid import UUID

from django.core.exceptions import TooManyFieldsSent
from django.http import QueryDict

ROLES = (None, "org_owner", "org_admin", "org_billing", "org_member")
STATES = (None, "invited", "active", "suspended", "removed")
FORMAT = struct.Struct("!B16s16sBBH16s16s")
DOMAIN = b"membership-directory-cursor-v1\x00"


class InvalidDirectoryInputError(Exception):
    """Invalid bounded target, query or continuation; no reflected input."""


@dataclass(frozen=True, slots=True)
class DirectoryQuery:
    limit: int
    role: str | None
    state: str | None
    cursor: str | None


def parse_target(value: str) -> UUID:
    try:
        if len(value) != 36:
            raise ValueError()
        result = UUID(value)
        if str(result) != value.lower():
            raise ValueError()
        return result
    except (ValueError, AttributeError):
        raise InvalidDirectoryInputError() from None


def parse_query(raw_query: str) -> DirectoryQuery:
    if len(raw_query) > 2048:
        raise InvalidDirectoryInputError()
    try:
        query = QueryDict(raw_query)
    except TooManyFieldsSent:
        raise InvalidDirectoryInputError() from None
    if any(
        key not in {"limit", "role", "state", "cursor"} or len(values) != 1 or not values[0]
        for key, values in query.lists()
    ):
        raise InvalidDirectoryInputError()
    limit = query.get("limit", "50")
    if re.fullmatch(r"[1-9][0-9]{0,2}", limit) is None or int(limit) > 200:
        raise InvalidDirectoryInputError()
    role, state, cursor = query.get("role"), query.get("state"), query.get("cursor")
    if role not in ROLES or state not in STATES:
        raise InvalidDirectoryInputError()
    if cursor is not None and (len(cursor) > 512 or not cursor.isascii()):
        raise InvalidDirectoryInputError()
    return DirectoryQuery(int(limit), role, state, cursor)


def cursor_key(value: object) -> bytes:
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise RuntimeError("membership cursor signing configuration is unavailable")
    return bytes.fromhex(value)


def encode_cursor(
    *,
    key: bytes,
    person_id: UUID,
    organisation_id: UUID,
    query: DirectoryQuery,
    after: UUID,
    ceiling: UUID,
) -> str:
    payload = FORMAT.pack(
        1,
        person_id.bytes,
        organisation_id.bytes,
        ROLES.index(query.role),
        STATES.index(query.state),
        query.limit,
        after.bytes,
        ceiling.bytes,
    )
    signature = hmac.digest(key, DOMAIN + payload, hashlib.sha256)
    return base64.urlsafe_b64encode(payload + signature).decode("ascii").rstrip("=")


def decode_cursor(
    *, key: bytes, person_id: UUID, organisation_id: UUID, query: DirectoryQuery
) -> tuple[UUID, UUID] | None:
    value = query.cursor
    if value is None:
        return None
    try:
        if not 1 <= len(value) <= 512 or re.fullmatch(r"[A-Za-z0-9_-]+", value) is None:
            raise ValueError()
        raw = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
        if (
            len(raw) != FORMAT.size + 32
            or base64.urlsafe_b64encode(raw).decode().rstrip("=") != value
        ):
            raise ValueError()
        payload, signature = raw[:-32], raw[-32:]
        if not hmac.compare_digest(signature, hmac.digest(key, DOMAIN + payload, hashlib.sha256)):
            raise ValueError()
        version, person, organisation, role, state, limit, after, ceiling = FORMAT.unpack(payload)
        binding = (person, organisation, role, state, limit)
        expected = (
            person_id.bytes,
            organisation_id.bytes,
            ROLES.index(query.role),
            STATES.index(query.state),
            query.limit,
        )
        if version != 1 or binding != expected:
            raise ValueError()
        last, maximum = UUID(bytes=after), UUID(bytes=ceiling)
        if last > maximum:
            raise ValueError()
        return last, maximum
    except (ValueError, binascii.Error, struct.error):
        raise InvalidDirectoryInputError() from None
