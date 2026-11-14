"""JSON response and structured error helpers for `/staff/v1/*`."""

from __future__ import annotations

import json

from django.http import HttpRequest, HttpResponse

from core.db.ids import new_uuid7


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
    if isinstance(existing, str) and existing:
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


def staff_json_response(request: HttpRequest, payload: object, *, status: int = 200) -> HttpResponse:
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
