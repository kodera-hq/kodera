"""Verified customer and public HTTP admission, strict JSON parsing, and idempotency replay."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any, cast
from uuid import UUID

from django.conf import settings
from django.core.exceptions import RequestDataTooBig
from django.http import HttpRequest, HttpResponse

from core.api import idempotency, lanes, problems
from core.api.guarded_replay import respond_once
from core.api.idempotency import StoredResponse
from core.api.scopes import Operation
from services.identity.access_tokens import TokenVerificationError, VerifiedAccessToken
from services.identity.trusted_issuers import verify_configured_token

from ..errors import CalendarRefusalError
from ..services import authorize, quota_replay_policy
from . import responses

Handler = Callable[[VerifiedAccessToken, str], HttpResponse]
PublicHandler = Callable[[str], HttpResponse]


def json_response(
    payload: Any,
    status: int = 200,
    *,
    etag: str | None = None,
) -> HttpResponse:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode(
        "utf-8"
    )
    resp = HttpResponse(encoded, status=status, content_type="application/json")
    if etag is not None:
        resp["ETag"] = etag
    return resp


def problem(
    failure: CalendarRefusalError,
    request_id: str,
    operation_id: str = "",
) -> HttpResponse:
    if failure.status == 403 and (
        failure.kind == "identity-unknown" or failure.reason == "identity-unknown"
    ):
        return problems.identity_unknown(request_id, operation_id)
    kinds = {
        400: "malformed-request",
        401: "unauthenticated",
        403: "forbidden",
        404: "not-found",
        405: "method-not-allowed",
        409: "conflict",
        412: "precondition-failed",
        422: "validation-error",
        428: "precondition-required",
        429: "rate-limited",
        503: "service-unavailable",
    }
    kind = failure.kind or kinds.get(failure.status, "validation-error")
    payload: dict[str, Any] = {
        "type": f"https://kodera.io/problems/{kind}",
        "title": "Workspace calendar request refused",
        "status": failure.status,
        "request_id": request_id,
    }
    if failure.reason is not None:
        payload["reason"] = failure.reason
    if failure.current_etag is not None:
        payload["current_etag"] = failure.current_etag
    if failure.status in {429, 503}:
        payload["retry_after_s"] = 1
    response = HttpResponse(
        json.dumps(payload, separators=(",", ":"), allow_nan=False),
        status=failure.status,
        content_type="application/problem+json",
    )
    if failure.status == 401:
        response["WWW-Authenticate"] = "Bearer"
    if failure.status in {429, 503}:
        response["Retry-After"] = "1"
    return response


def body(request: HttpRequest, fields: set[str], required: set[str]) -> dict[str, Any]:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for name, value in pairs:
            if name in result:
                raise CalendarRefusalError(400, None, "malformed-request")
            result[name] = value
        return result

    def reject_constant(_: str) -> None:
        raise CalendarRefusalError(400, None, "malformed-request")

    content_type = (request.content_type or "").split(";")[0].strip().lower()
    if (
        content_type not in {"application/json", "application/merge-patch+json"}
        or len(request.body) > 32768
    ):
        raise CalendarRefusalError(400, None, "malformed-request")
    try:
        parsed = json.loads(
            request.body.decode("utf-8"),
            object_pairs_hook=unique,
            parse_constant=reject_constant,
        )
    except (ValueError, UnicodeError, RecursionError):
        raise CalendarRefusalError(400, None, "malformed-request") from None
    if not isinstance(parsed, dict) or not required <= parsed.keys() or (parsed.keys() - fields):
        raise CalendarRefusalError(422, "unexpected_or_missing_fields", "validation-error")
    return parsed


def serve(
    request: HttpRequest,
    handlers: dict[str, Handler],
    organisation_id: UUID,
    *,
    operations: tuple[Operation, ...] = (),
) -> HttpResponse:
    req_id = responses.request_id(request)
    method = (request.method or "").upper()
    operation_id = next(
        (op.operation_id for op in operations if op.method.upper() == method),
        "",
    )
    try:
        if method not in handlers:
            resp = problem(
                CalendarRefusalError(405, None, "method-not-allowed"), req_id, operation_id
            )
            resp["Allow"] = ", ".join(sorted(handlers))
            return responses.finish(resp, req_id)
        verified, lane = verify_configured_token(
            responses.bearer(request), trusted=cast(Any, settings).KODERA_AUTH_TRUST
        )
        verified, lane = lanes.admit(verified, lane)
        if lane == "staff":
            raise CalendarRefusalError(403, None, "forbidden")
        authorize(verified, organisation_id)

        handler = handlers[method]

        def execute() -> HttpResponse:
            try:
                return handler(verified, req_id)
            except CalendarRefusalError as failure:
                return problem(failure, req_id, operation_id)

        if method == "POST":

            def effect() -> StoredResponse:
                result = execute()
                return StoredResponse(
                    status=result.status_code,
                    body=result.content,
                    content_type=result.get("Content-Type", "application/json"),
                    etag=result.get("ETag"),
                )

            def check_authority(_event: Any) -> None:
                authorize(verified, organisation_id)

            response = respond_once(
                request,
                issuer=verified.issuer,
                subject=verified.subject,
                request_id=req_id,
                handler=effect,
                policy=quota_replay_policy(),
                authority=check_authority,
            )
        else:
            response = execute()
    except TokenVerificationError:
        response = problem(CalendarRefusalError(401, None, "unauthenticated"), req_id, operation_id)
    except RequestDataTooBig:
        response = problem(
            CalendarRefusalError(400, None, "malformed-request"), req_id, operation_id
        )
    except CalendarRefusalError as failure:
        response = problem(failure, req_id, operation_id)
    return responses.finish(response, req_id)


def serve_public(
    request: HttpRequest,
    handlers: dict[str, PublicHandler],
    *,
    booking_slug: str,
    operations: tuple[Operation, ...] = (),
) -> HttpResponse:
    req_id = responses.request_id(request)
    method = (request.method or "").upper()
    operation_id = next(
        (op.operation_id for op in operations if op.method.upper() == method),
        "",
    )
    try:
        if method not in handlers:
            resp = problem(
                CalendarRefusalError(405, None, "method-not-allowed"), req_id, operation_id
            )
            resp["Allow"] = ", ".join(sorted(handlers))
            return responses.finish(resp, req_id)

        handler = handlers[method]

        def execute() -> HttpResponse:
            try:
                return handler(req_id)
            except CalendarRefusalError as failure:
                return problem(failure, req_id, operation_id)

        if method == "POST":
            supplied = request.headers.get(idempotency.KEY_HEADER, "")
            if idempotency.is_missing(supplied):
                raise CalendarRefusalError(
                    400, "missing_idempotency_key", "idempotency-key-missing"
                )
            if idempotency.is_malformed(supplied):
                raise CalendarRefusalError(400, "malformed_idempotency_key", "malformed-request")
            # Ephemeral execution: never persist guest .ics PII or single-disclosure
            # cancellationToken plaintext in shared idempotency_record.body.
            response = execute()
        else:
            response = execute()
    except RequestDataTooBig:
        response = problem(
            CalendarRefusalError(400, None, "malformed-request"), req_id, operation_id
        )
    except CalendarRefusalError as failure:
        response = problem(failure, req_id, operation_id)
    return responses.finish(response, req_id)
