"""Bounded list queries and signed keyset cursors: docs/api/CONVENTIONS.md §12.

A cursor is opaque to the client: the operation, the scope it was issued in (the organisation,
empty for the public catalogue), the filters and the last row's sort key, signed with a key derived
from `SECRET_KEY` for this purpose only. A cursor replayed against another operation, scope or set
of filters, or altered in any byte, is refused, as is any parameter the operation does not declare.
"""

import base64
import binascii
import hashlib
import hmac
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass

from django.conf import settings
from django.core.exceptions import TooManyFieldsSent
from django.http import QueryDict

DEFAULT_LIMIT = 50
MAX_LIMIT = 200
MAX_CURSOR = 512
LIMIT = re.compile(r"[1-9][0-9]{0,2}\Z")
FILTER_VALUE = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
DOMAIN = b"billing-list-cursor-v1"


class InvalidListQueryError(Exception):
    """A parameter, value or cursor the operation does not accept: `400 malformed-request`."""


@dataclass(frozen=True, slots=True)
class ListQuery:
    limit: int
    filters: Mapping[str, str]
    after: tuple[str, ...] | None


def _key() -> bytes:
    secret: str = settings.SECRET_KEY
    return hmac.new(secret.encode(), DOMAIN, hashlib.sha256).digest()


def _sign(payload: bytes) -> str:
    return hmac.new(_key(), payload, hashlib.sha256).hexdigest()


def encode_cursor(
    *, operation: str, scope: str, filters: Mapping[str, str], after: tuple[str, ...]
) -> str:
    payload = json.dumps(
        [operation, scope, sorted(filters.items()), list(after)], separators=(",", ":")
    ).encode()
    token = base64.urlsafe_b64encode(payload).rstrip(b"=").decode() + "." + _sign(payload)
    if len(token) > MAX_CURSOR:
        raise RuntimeError("a cursor outgrew the contract's bound")
    return token


def _decode_cursor(
    token: str, *, operation: str, scope: str, filters: Mapping[str, str]
) -> tuple[str, ...]:
    encoded, _, signature = token.partition(".")
    try:
        payload = base64.b64decode(
            encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True
        )
    except (binascii.Error, ValueError):
        raise InvalidListQueryError() from None
    if not hmac.compare_digest(signature, _sign(payload)):
        raise InvalidListQueryError()
    issued_operation, issued_scope, issued_filters, after = json.loads(payload)
    if (issued_operation, issued_scope, issued_filters) != (
        operation,
        scope,
        [list(item) for item in sorted(filters.items())],
    ):
        raise InvalidListQueryError()
    return tuple(after)


def parse_query(
    raw_query: str,
    *,
    operation: str,
    scope: str,
    filters: Mapping[str, frozenset[str] | None],
) -> ListQuery:
    """`limit`, `cursor` and the operation's filters; a filter's allowed values, None for any
    short identifier-like value."""
    if len(raw_query) > 2048:
        raise InvalidListQueryError()
    try:
        query = QueryDict(raw_query)
    except TooManyFieldsSent:
        raise InvalidListQueryError() from None
    allowed = {"limit", "cursor", *filters}
    if any(
        key not in allowed or len(values) != 1 or not values[0] for key, values in query.lists()
    ):
        raise InvalidListQueryError()
    limit = query.get("limit", str(DEFAULT_LIMIT))
    if not LIMIT.match(limit) or int(limit) > MAX_LIMIT:
        raise InvalidListQueryError()
    chosen: dict[str, str] = {}
    for name, values in filters.items():
        value = query.get(name)
        if value is None:
            continue
        if not FILTER_VALUE.match(value) or (values is not None and value not in values):
            raise InvalidListQueryError()
        chosen[name] = value
    cursor = query.get("cursor")
    after = None
    if cursor is not None:
        if len(cursor) > MAX_CURSOR or not cursor.isascii():
            raise InvalidListQueryError()
        try:
            after = _decode_cursor(cursor, operation=operation, scope=scope, filters=chosen)
        except (ValueError, TypeError):
            raise InvalidListQueryError() from None
    return ListQuery(limit=int(limit), filters=chosen, after=after)
