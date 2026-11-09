"""What every workspace view shares: the request id, the bearer token and the problem document.

docs/api/CONVENTIONS.md §6 (problems) and §9 (request correlation). A request id the caller
supplies is echoed when it is 8 to 64 of `[A-Za-z0-9_-]`, and replaced by a new UUIDv7 otherwise.
A problem document's body is `type`, `title`, `status` and `request_id`, then its extension
members, serialised as `json.dumps` writes them; a `401` carries `WWW-Authenticate: Bearer` and a
`503` `Retry-After`. Every answer ends `no-store`, with its request id.
"""

import json
import re

from django.http import HttpRequest, HttpResponse

from core.db.ids import new_uuid7
from services.identity.access_tokens import MAX_TOKEN, TokenVerificationError

REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,64}\Z")
PROBLEM_BASE = "https://kodera.io/problems/"
PROBLEM_TYPE = "application/problem+json"
RETRY_AFTER_S = 1
PROBLEMS = {
    "malformed-request": (400, "Malformed request"),
    "unauthenticated": (401, "Authentication required"),
    "forbidden": (403, "Access refused"),
    "not-found": (404, "Not found"),
    "method-not-allowed": (405, "Method not allowed"),
    "conflict": (409, "The structure does not allow this change"),
    "invalid-state-transition": (409, "Invalid state transition"),
    "precondition-failed": (412, "The resource changed since it was read"),
    "validation-error": (422, "The request is not valid"),
    "precondition-required": (428, "If-Match is required"),
    "internal-error": (500, "Internal error"),
    "service-unavailable": (503, "Busy, retry the same request"),
}


def request_id(request: HttpRequest) -> str:
    supplied = request.headers.get("X-Request-Id", "")
    return supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())


def bearer(request: HttpRequest) -> str:
    """The bearer token of `Authorization`, or `TokenVerificationError`."""
    authorization = request.headers.get("Authorization", "")
    if len(authorization) > MAX_TOKEN + 7:
        raise TokenVerificationError()
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise TokenVerificationError()
    return parts[1]


def document(kind: str, request_id: str, extensions: dict[str, object]) -> tuple[int, bytes]:
    """A problem document's status and body, for an answer or for the replay store."""
    status, title = PROBLEMS[kind]
    body = {
        "type": PROBLEM_BASE + kind,
        "title": title,
        "status": status,
        "request_id": request_id,
        **extensions,
    }
    return status, json.dumps(body).encode()


def problem(kind: str, request_id: str, **extensions: object) -> HttpResponse:
    # A 405 also needs its own `Allow` header, which the caller sets, as views._problem does.
    status, body = document(kind, request_id, extensions)
    response = HttpResponse(body, status=status, content_type=PROBLEM_TYPE)
    if status == 401:
        response["WWW-Authenticate"] = "Bearer"
    if status == 503:
        response["Retry-After"] = str(RETRY_AFTER_S)
    return response


def finish(response: HttpResponse, request_id: str) -> HttpResponse:
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response
