"""The HTTP side of CONVENTIONS §8 for a POST view: docs/specs/IDEMPOTENCY_REPLAY.md §2.6.

A view authenticates and authorises the caller first, then hands the request, the verified
`(issuer, subject)` and its effect to `respond_once`. The view still sets `X-Request-Id` and
`Cache-Control` on what comes back, as on every other answer. The first answer and every replay are
rendered from one `StoredResponse`, so they differ only by `Idempotency-Replayed`.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from datetime import UTC, datetime

from django.http import HttpRequest, HttpResponse

from core.idempotency import fingerprint, store

# StoredResponse is re-exported: a view builds its step's answer with it, importing only core/api
# (PROJECT_LAYOUT.md §2).
from core.idempotency.store import (
    AuthorityCallback as AuthorityCallback,
    Executed,
    FinalAuthorityCallback as FinalAuthorityCallback,
    InFlight,
    KeyReused,
    Replayed,
    Scope,
    StoredResponse as StoredResponse,
)

KEY_HEADER = "Idempotency-Key"
REPLAYED_HEADER = "Idempotency-Replayed"
OPERATION_REF_HEADER = "X-Operation-Ref"
OPERATION_REF = re.compile(r"[0-9a-f]{64}\Z")
PROBLEM_BASE = "https://kodera.io/problems/"
PROBLEM_TYPE = "application/problem+json"

MISSING = "idempotency-key-missing"
MALFORMED = "malformed-request"
REUSE = "idempotency-key-reuse"
IN_FLIGHT = "idempotency-key-in-flight"
_PROBLEMS = {
    MISSING: (400, "Idempotency-Key header missing"),
    MALFORMED: (400, "Malformed request"),
    REUSE: (409, "Idempotency key reused with a different body"),
    IN_FLIGHT: (409, "Idempotency key in flight"),
}


def is_missing(value: str) -> bool:
    """An absent header, read as empty, and an empty one carry no key."""
    return value == ""


def is_malformed(value: str) -> bool:
    return store.KEY.fullmatch(value) is None


def scope_for(request: HttpRequest, *, issuer: str, subject: str, key: str) -> Scope | None:
    """The request's scope, or None when it is out of the store's bounds: an oversized path or
    issuer, or a subject the store refuses. That is a bad request, never a 500."""
    try:
        return Scope(
            issuer=issuer, subject=subject, method=store.METHOD, path=request.path, key=key
        )
    except ValueError:
        return None


def holds_answer(request: HttpRequest, *, issuer: str, subject: str, key: str) -> bool:
    """Whether the store already holds a live answer under this key, so the request will be
    replayed or refused as a reuse without its handler running: a route that prepares an outside
    effect before the step (createPaymentLink asks the provider) skips it then."""
    if is_missing(key) or is_malformed(key):
        return False
    scope = scope_for(request, issuer=issuer, subject=subject, key=key)
    if scope is None:
        return False
    found = store.lookup(scope)
    return found is not None and not getattr(found, "expired", False)


def problem(kind: str, request_id: str, **extension: object) -> StoredResponse:
    status, title = _PROBLEMS[kind]
    body = {
        "type": PROBLEM_BASE + kind,
        "title": title,
        "status": status,
        "request_id": request_id,
        **extension,
    }
    return StoredResponse(status=status, body=json.dumps(body).encode(), content_type=PROBLEM_TYPE)


def timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def render(response: StoredResponse) -> HttpResponse:
    rendered = HttpResponse(
        response.body, status=response.status, content_type=response.content_type
    )
    for header, value in (
        ("Location", response.location),
        ("ETag", response.etag),
        ("X-Job-Id", response.job_id),
    ):
        if value is not None:
            rendered[header] = value
    return rendered


def mark_replayed(response: HttpResponse) -> None:
    response[REPLAYED_HEADER] = "true"


def mark_operation(response: HttpResponse, operation_ref: str | None) -> HttpResponse:
    """Attach a validated route reference to one of the route's admitted outcomes."""
    if operation_ref is not None:
        response[OPERATION_REF_HEADER] = operation_ref
    return response


def respond_once(
    request: HttpRequest,
    *,
    issuer: str,
    subject: str,
    request_id: str,
    handler: Callable[[], StoredResponse],
    authority: AuthorityCallback | None = None,
    final_authority: FinalAuthorityCallback | None = None,
    operation_ref: str | None = None,
) -> HttpResponse:
    """Answer a POST at most once per key: run, replay, or refuse it as §8 says."""
    if request.method != store.METHOD:
        raise ValueError("respond_once serves POST only")
    if operation_ref is not None and (
        not isinstance(operation_ref, str) or OPERATION_REF.fullmatch(operation_ref) is None
    ):
        raise ValueError("operation reference must be 64 lowercase hexadecimal characters")
    supplied = request.headers.get(KEY_HEADER, "")
    if is_missing(supplied):
        return render(problem(MISSING, request_id))
    if is_malformed(supplied):
        return render(problem(MALFORMED, request_id))
    scope = scope_for(request, issuer=issuer, subject=subject, key=supplied)
    if scope is None:
        return render(problem(MALFORMED, request_id))
    if final_authority is not None:
        outcome = store.run_once(
            scope=scope,
            body_sha256=fingerprint.body_sha256(request.body),
            handler=handler,
            authority=authority,
            final_authority=final_authority,
        )
    elif authority is None:
        outcome = store.run_once(
            scope=scope, body_sha256=fingerprint.body_sha256(request.body), handler=handler
        )
    else:
        outcome = store.run_once(
            scope=scope,
            body_sha256=fingerprint.body_sha256(request.body),
            handler=handler,
            authority=authority,
        )
    if isinstance(outcome, Executed):
        rendered = render(outcome.response)
        return mark_operation(rendered, operation_ref if outcome.response.status == 201 else None)
    if isinstance(outcome, Replayed):
        replayed = render(outcome.response)
        mark_replayed(replayed)
        return mark_operation(replayed, operation_ref if outcome.response.status == 201 else None)
    if isinstance(outcome, KeyReused):
        return render(problem(REUSE, request_id, first_seen_at=timestamp(outcome.first_seen_at)))
    if isinstance(outcome, InFlight):
        return mark_operation(
            render(problem(IN_FLIGHT, request_id, retry_after_s=outcome.retry_after_s)),
            operation_ref,
        )
    raise AssertionError("unreachable: the replay store returned no known outcome")
