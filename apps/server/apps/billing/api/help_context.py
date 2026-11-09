"""getHelpContext (contracts/core-api.openapi.yaml, tag Support): what the help entry offers on one
console screen, read by the shell's help entry and the home screen's support card.

Served as the billing reads are (apps/billing/api/views.py): the bearer token is verified, a staff
token is refused with `403` until the staff lane of these reads is built, and the caller's stored
role is checked in a read-only snapshot by apps/billing/access.py. The path names no organisation:
it is the caller's own. Every tenant role reads it. The contract declares no `404`, so a known
caller with no current membership is refused with `403`. Every `403` is recorded as
`authz.denied`.

The query is read once the caller is authorised, so an unauthenticated caller gets `401` whatever
it asked; then `area` is required and of the closed ConsoleArea enum, `screen` and `locale` are
optional, each at most once, and anything else is `400`.

Core holds no article catalogue, no incident feed and no service level per support tier yet, so
the answer has no articles, no incident and no `sla`, as the contract's description says. `sla` is
optional in the contract; without it the console states no promise rather than an invented one.
"""

import re
from typing import Any
from urllib.parse import parse_qsl

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from apps.billing.access import (
    BillingForbiddenError,
    BillingNotFoundError,
    own_organisation,
    read_as_member,
    record_member_denial,
    record_no_membership_denial,
    record_staff_denial,
)
from core.api import lanes
from core.api.scopes import declares
from services.identity.trusted_issuers import verify_configured_token

from ..pagination import InvalidListQueryError
from . import permissions as op
from .views import _answer, _bearer, _RefusedError

SCOPE = "support_ticket:read"
TARGET = "urn:kodera:help-context"
# Bounds parsing only: the longest valid query, every character of a 64-character screen
# percent-encoded, is under 256.
MAX_QUERY = 512
AREAS = frozenset(
    {"shell", "login", "order", "status", "people", "domain", "invoices", "support", "federation"}
)
SCREEN = re.compile(r"[a-z0-9-]{1,64}")
LOCALES = frozenset({"fr", "en"})


def requested_context(query_string: str) -> tuple[str, str | None]:
    """The query's `area` and `screen`, of the contract's shapes, or `400`."""
    if len(query_string) > MAX_QUERY:
        raise InvalidListQueryError()
    try:
        pairs = parse_qsl(query_string, keep_blank_values=True, strict_parsing=bool(query_string))
    except ValueError:
        raise InvalidListQueryError() from None
    found = dict(pairs)
    if (
        len(found) != len(pairs)
        or not set(found) <= {"area", "screen", "locale"}
        or found.get("area") not in AREAS
        or ("screen" in found and not SCREEN.fullmatch(found["screen"]))
        or ("locale" in found and found["locale"] not in LOCALES)
    ):
        raise InvalidListQueryError()
    return found["area"], found.get("screen")


def context(query_string: str) -> dict[str, Any]:
    area, screen = requested_context(query_string)
    return {"area": area, "screen": screen, "articles": [], "incident": None}


@declares(op.GET_HELP_CONTEXT)
def help_context(request: HttpRequest) -> HttpResponse:
    def produce(request_id: str) -> Any:
        verified, lane = verify_configured_token(
            _bearer(request), trusted=settings.KODERA_AUTH_TRUST
        )
        verified, lane = lanes.admit(verified, lane)
        if lane == "staff":
            record_staff_denial(
                verified=verified, target_urn=TARGET, request_id=request_id, scope=SCOPE
            )
            raise _RefusedError()
        try:
            return read_as_member(
                verified=verified,
                organisation=lambda: own_organisation(verified),
                scope=SCOPE,
                read=lambda _: context(request.META.get("QUERY_STRING", "")),
            )
        except BillingForbiddenError as refused:
            record_member_denial(refused=refused, target_urn=TARGET, request_id=request_id)
            raise _RefusedError() from None
        except BillingNotFoundError:
            record_no_membership_denial(
                verified=verified, target_urn=TARGET, request_id=request_id, scope=SCOPE
            )
            raise _RefusedError() from None

    return _answer(request, op.GET_HELP_CONTEXT, produce)
