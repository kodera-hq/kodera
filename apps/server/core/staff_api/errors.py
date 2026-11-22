"""JSON response and structured error helpers for `/staff/v1/*`."""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from contextlib import contextmanager

from django.db import DatabaseError, transaction
from django.http import HttpRequest, HttpResponse

from core.db.ids import new_uuid7

REQUEST_ID_RE = re.compile(r"[A-Za-z0-9_-]{8,64}\Z")
CONCURRENT_CONTENTION_SQLSTATES = frozenset({"40P01", "40001", "55P03"})
STATEMENT_TIMEOUT_SQLSTATE = "57014"


class StaffApiError(Exception):
    """Structured error mapped to an `application/json` problem response."""

    def __init__(
        self,
        status: int,
        code: str,
        title: str,
        detail: str | None = None,
        *,
        type_slug: str | None = None,
        authenticate_challenge: bool = False,
    ) -> None:
        super().__init__(detail or title)
        self.status = status
        self.code = code
        self.title = title
        self.detail = detail or title
        self.type_slug = type_slug or code.replace("_", "-")
        self.authenticate_challenge = authenticate_challenge


def request_correlation_id(request: HttpRequest) -> str:
    existing = request.META.get("HTTP_X_REQUEST_ID")
    if isinstance(existing, str) and REQUEST_ID_RE.fullmatch(existing) is not None:
        return existing
    generated = str(new_uuid7())
    request.META["HTTP_X_REQUEST_ID"] = generated
    return generated


def staff_problem_response(
    request: HttpRequest,
    *,
    status: int,
    code: str,
    title: str,
    detail: str | None = None,
    type_slug: str | None = None,
    authenticate_challenge: bool = False,
) -> HttpResponse:
    request_id = request_correlation_id(request)
    slug = type_slug or code.replace("_", "-")
    body: dict[str, object] = {
        "type": f"https://kodera.io/problems/{slug}",
        "title": title,
        "detail": detail or title,
        "code": code,
        "status": status,
        "request_id": request_id,
    }
    response = HttpResponse(
        json.dumps(body),
        status=status,
        content_type="application/json",
    )
    response["Cache-Control"] = "no-store"
    response["X-Content-Type-Options"] = "nosniff"
    response["X-Request-Id"] = request_id
    if authenticate_challenge or status == 401:
        response["WWW-Authenticate"] = 'Bearer realm="kodera-staff"'
    return response


def error_to_response(request: HttpRequest, error: StaffApiError) -> HttpResponse:
    return staff_problem_response(
        request,
        status=error.status,
        code=error.code,
        title=error.title,
        detail=error.detail,
        type_slug=error.type_slug,
        authenticate_challenge=error.authenticate_challenge,
    )


def staff_json_response(
    request: HttpRequest, payload: object, *, status: int = 200
) -> HttpResponse:
    request_id = request_correlation_id(request)
    response = HttpResponse(
        json.dumps(payload),
        status=status,
        content_type="application/json",
    )
    response["Cache-Control"] = "no-store"
    response["X-Content-Type-Options"] = "nosniff"
    response["X-Request-Id"] = request_id
    return response


def database_error_sqlstate(error: DatabaseError) -> str:
    cause = error.__cause__
    code = getattr(cause, "sqlstate", None) or getattr(cause, "pgcode", None)
    return str(code) if code is not None else ""


def translate_staff_database_error(error: DatabaseError) -> StaffApiError | None:
    """Translate PostgreSQL lock/deadlock/serialization contention or timeout into typed errors."""
    sqlstate = database_error_sqlstate(error)
    if sqlstate in CONCURRENT_CONTENTION_SQLSTATES:
        return StaffApiError(
            409,
            "staff_authority_contention",
            "Concurrent staff authority or state contention",
            "A concurrent authority or target update conflicted with this staff command; retry the request",
            type_slug="staff-authority-contention",
        )
    if sqlstate == STATEMENT_TIMEOUT_SQLSTATE:
        return StaffApiError(
            503,
            "staff_database_timeout",
            "Staff database statement timed out",
            "Database statement timed out before completion; retry the request",
            type_slug="staff-database-timeout",
        )
    return None


@contextmanager
def staff_command_transaction() -> Iterator[None]:
    """Execute a privileged staff command in `transaction.atomic()`, mapping rolled-back contention."""
    try:
        with transaction.atomic():
            yield
    except DatabaseError as exc:
        mapped = translate_staff_database_error(exc)
        if mapped is not None:
            raise mapped from None
        raise
