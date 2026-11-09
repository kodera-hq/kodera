"""The one answer to a verified customer token whose subject Core does not know: docs/api/AUTHZ.md §2.

A bearer token that passes verification (steps 1 to 5) but whose `(iss, sub)` names no enabled,
undeleted customer `Identity` of an enabled, undeleted person is refused `403 identity-unknown`
(step 6). It is not `401`: the token is valid, and signing in again yields the same token, so a
client told to re-authenticate would loop. The answer carries no `WWW-Authenticate`, and its body
is the four members every problem document has, nothing about the subject.

Every customer view maps its unknown-principal error here, and only here, so that the mapping is
one place. A failure of verification itself stays the view's own `401 unauthenticated`, and so does
a staff token: this answer is for customer identities only (`core.api.lanes` keeps the staff issuer
off the customer lane before any customer resolver runs).

The refusal names no principal, so it writes no `authz.denied` row (AUTHZ.md §9). It logs one
WARNING line, `identity-unknown correlation_id=… operation_id=…`, and nothing else: never the
issuer, the subject, an email, the token or the caller's `X-Request-Id`. The correlation id is a
fresh server-generated UUIDv7, so nothing in the line is a value the caller chose. The `authz_denied_total` counter is owed
(docs/dev/OBSERVABILITY.md).
"""

import json
import logging

from django.http import HttpResponse

from core.db.ids import new_uuid7

IDENTITY_UNKNOWN = "identity-unknown"
IDENTITY_UNKNOWN_STATUS = 403
IDENTITY_UNKNOWN_TITLE = "Identity unknown"
IDENTITY_UNKNOWN_TYPE = "https://kodera.io/problems/" + IDENTITY_UNKNOWN
LOG = logging.getLogger(__name__)


def identity_unknown(request_id: str, operation_id: str) -> HttpResponse:
    """`403 identity-unknown`, logged; the view still sets `Cache-Control` and `X-Request-Id`.

    `request_id` is the one the view answers with, which may be the caller's own `X-Request-Id`, so
    it is never logged: the line carries a fresh server-generated correlation id and
    `operation_id`, a contract constant."""
    LOG.warning("identity-unknown correlation_id=%s operation_id=%s", new_uuid7(), operation_id)
    return answer(request_id)


def answer(request_id: str) -> HttpResponse:
    """The `403 identity-unknown` problem document alone, without the log line."""
    body = {
        "type": IDENTITY_UNKNOWN_TYPE,
        "title": IDENTITY_UNKNOWN_TITLE,
        "status": IDENTITY_UNKNOWN_STATUS,
        "request_id": request_id,
    }
    return HttpResponse(
        json.dumps(body),
        status=IDENTITY_UNKNOWN_STATUS,
        content_type="application/problem+json",
    )
