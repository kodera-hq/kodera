"""Authenticated customer HTTP admission and strict Zero-GPS JSON parsing for `#proximity`."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any, cast
from uuid import UUID

from django.conf import settings
from django.core.exceptions import RequestDataTooBig
from django.http import HttpRequest, HttpResponse

from core.api import lanes
from core.db.ids import new_uuid7
from services.identity.access_tokens import MAX_TOKEN, TokenVerificationError, VerifiedAccessToken
from services.identity.trusted_issuers import verify_configured_token

from ..services import ProximityRefusalError, assert_zero_gps_payload, assert_zero_gps_query

REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,64}\Z")
Handler = Callable[[VerifiedAccessToken], HttpResponse]


def resolve_request_id(request: HttpRequest) -> str:
    supplied = request.headers.get("X-Request-Id", "")
    return supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())


def extract_bearer(request: HttpRequest) -> str:
    authorization = request.headers.get("Authorization", "")
    if len(authorization) > MAX_TOKEN + 7:
        raise TokenVerificationError()
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise TokenVerificationError()
    return parts[1]


def finish(response: HttpResponse, request_id: str) -> HttpResponse:
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response


def json_response(payload: dict[str, Any], status: int = 200) -> HttpResponse:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return HttpResponse(encoded, status=status, content_type="application/json")


def problem_response(failure: ProximityRefusalError, request_id: str) -> HttpResponse:
    default_kinds = {
        400: "malformed-request",
        401: "unauthenticated",
        403: "forbidden",
        404: "not-found",
        405: "method-not-allowed",
        409: "conflict",
        422: "validation-error",
        503: "service-unavailable",
    }
    kind = failure.kind or default_kinds.get(failure.status, "validation-error")
    payload: dict[str, Any] = {
        "type": f"https://kodera.io/problems/{kind}",
        "title": "Proximity request refused",
        "status": failure.status,
        "request_id": request_id,
    }
    if failure.reason is not None:
        payload["reason"] = failure.reason
    response = HttpResponse(
        json.dumps(payload, separators=(",", ":")),
        status=failure.status,
        content_type="application/problem+json",
    )
    if failure.status == 401:
        response["WWW-Authenticate"] = "Bearer"
    if failure.status == 503:
        response["Retry-After"] = "1"
    return response


def parse_json_body(
    request: HttpRequest, *, allowed_fields: set[str], required_fields: set[str]
) -> dict[str, Any]:
    def unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        obj: dict[str, Any] = {}
        for key, val in pairs:
            if key in obj:
                raise ProximityRefusalError(400)
            obj[key] = val
        return obj

    assert_zero_gps_query(request.GET)
    content_type = (request.content_type or "").split(";")[0].strip().lower()
    if content_type != "application/json" or len(request.body) > 16384:
        raise ProximityRefusalError(400)
    try:
        parsed = json.loads(request.body.decode("utf-8"), object_pairs_hook=unique_pairs)
    except (ValueError, UnicodeError):
        raise ProximityRefusalError(400) from None
    if not isinstance(parsed, dict):
        raise ProximityRefusalError(422)

    # Zero-GPS privacy wall runs BEFORE field whitelist rejection so any GPS coordinate
    # payload receives the explicit `gps-coordinates-forbidden` 422 problem response.
    assert_zero_gps_payload(parsed)

    if not required_fields <= parsed.keys() or (parsed.keys() - allowed_fields):
        raise ProximityRefusalError(422, reason="unexpected_or_missing_fields")
    return parsed


def parse_uuid(value: Any) -> UUID:
    if not isinstance(value, str):
        raise ProximityRefusalError(422, reason="invalid_workspace_id")
    try:
        parsed = UUID(value)
    except ValueError:
        raise ProximityRefusalError(422, reason="invalid_workspace_id") from None
    if parsed.int == 0:
        raise ProximityRefusalError(422, reason="invalid_workspace_id")
    return parsed


def principal_key_for(verified: VerifiedAccessToken) -> str:
    return f"{verified.issuer}|{verified.subject}"


def serve(request: HttpRequest, handlers: dict[str, Handler]) -> HttpResponse:
    req_id = resolve_request_id(request)
    method = (request.method or "").upper()
    try:
        if method not in handlers:
            response = problem_response(ProximityRefusalError(405), req_id)
            response["Allow"] = ", ".join(sorted(handlers))
            return finish(response, req_id)
        verified, lane = verify_configured_token(
            extract_bearer(request),
            trusted=cast(Any, settings).KODERA_AUTH_TRUST,
        )
        verified, lane = lanes.admit(verified, lane)
        if lane == "staff":
            raise ProximityRefusalError(403)
        response = handlers[method](verified)
    except TokenVerificationError:
        response = problem_response(ProximityRefusalError(401), req_id)
    except RequestDataTooBig:
        response = problem_response(ProximityRefusalError(400), req_id)
    except ProximityRefusalError as failure:
        response = problem_response(failure, req_id)
    return finish(response, req_id)
