"""Verified customer HTTP admission, bounded JSON bodies, and RFC 9457 problem responses."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any, cast
from uuid import UUID

from django.conf import settings
from django.core.exceptions import RequestDataTooBig
from django.db import transaction
from django.http import HttpRequest, HttpResponse

from core.api import lanes, problems
from core.api.idempotency import KEY_HEADER, StoredResponse, is_malformed, is_missing, respond_once
from core.api.scopes import Operation
from core.db.ids import new_uuid7
from services.identity.access_tokens import MAX_TOKEN, TokenVerificationError, VerifiedAccessToken
from services.identity.trusted_issuers import verify_configured_token

from ..services import read_admin, read_member
from ..wire import ExtensionIdentityUnknownError, ExtensionRefusedError

REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,64}\Z")
MAX_JSON_BODY = 1024 * 1024  # Matches body_guard.py 1 MiB /api/* ceiling.
Handler = Callable[[VerifiedAccessToken, str], HttpResponse]

PROBLEM_KINDS: dict[int, str] = {
    400: "malformed-request",
    401: "unauthenticated",
    403: "forbidden",
    404: "not-found",
    405: "method-not-allowed",
    409: "conflict",
    410: "gone",
    413: "payload-too-large",
    422: "validation-error",
    429: "rate-limited",
    502: "service-unavailable",
    503: "service-unavailable",
}


def request_id(request: HttpRequest) -> str:
    supplied = request.headers.get("X-Request-Id", "")
    return supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())


def bearer(request: HttpRequest) -> str:
    authorization = request.headers.get("Authorization", "")
    if len(authorization) > MAX_TOKEN + 7:
        raise TokenVerificationError()
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise TokenVerificationError()
    return parts[1]


def finish(response: HttpResponse, req_id: str) -> HttpResponse:
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = req_id
    return response


def json_response(payload: Any, status: int = 200) -> HttpResponse:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return HttpResponse(encoded, status=status, content_type="application/json")


def problem(
    status: int,
    req_id: str,
    *,
    reason: str | None = None,
    allowed: list[str] | None = None,
    www_authenticate: str = "Bearer",
) -> HttpResponse:
    kind = PROBLEM_KINDS.get(status, "validation-error")
    payload: dict[str, Any] = {
        "type": f"https://kodera.io/problems/{kind}",
        "title": "Extension request refused",
        "status": status,
        "request_id": req_id,
    }
    if reason:
        payload["detail"] = reason
    if allowed is not None:
        payload["allowed"] = allowed
    if status in {502, 503}:
        payload["retry_after_s"] = 1
    response = HttpResponse(
        json.dumps(payload, separators=(",", ":")),
        status=status,
        content_type="application/problem+json",
    )
    if status == 401:
        response["WWW-Authenticate"] = www_authenticate
    if status == 405 and allowed is not None:
        response["Allow"] = ", ".join(allowed)
    if status in {502, 503}:
        response["Retry-After"] = "1"
    return response


def parse_json_body(
    request: HttpRequest, *, fields: set[str], required: set[str]
) -> dict[str, Any]:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for key, value in pairs:
            if key in out:
                raise ExtensionRefusedError("malformed_duplicate_key", 400)
            out[key] = value
        return out

    content_type = (request.content_type or "").lower()
    if content_type != "application/json":
        raise ExtensionRefusedError("unsupported_content_type", 400)
    raw = request.body
    if not raw or len(raw) > MAX_JSON_BODY:
        raise ExtensionRefusedError(
            "payload_too_large" if len(raw) > MAX_JSON_BODY else "empty_request_body",
            413 if len(raw) > MAX_JSON_BODY else 400,
        )
    try:
        parsed = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=unique,
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError()),
        )
    except ExtensionRefusedError:
        raise
    except (UnicodeError, ValueError, RecursionError):
        raise ExtensionRefusedError("invalid_json", 400) from None
    if not isinstance(parsed, dict) or not required <= parsed.keys() or parsed.keys() - fields:
        raise ExtensionRefusedError("invalid_request_fields", 422)
    return parsed


def parse_uuid(value: Any) -> UUID:
    if not isinstance(value, str):
        raise ExtensionRefusedError("invalid_uuid", 422)
    try:
        parsed = UUID(value)
    except ValueError:
        raise ExtensionRefusedError("invalid_uuid", 422) from None
    if str(parsed) != value.lower():
        raise ExtensionRefusedError("invalid_uuid", 422)
    return parsed


def require_idempotency_key(request: HttpRequest) -> str:
    value = request.headers.get(KEY_HEADER, "")
    if is_missing(value):
        raise ExtensionRefusedError("idempotency_key_missing", 400)
    if is_malformed(value):
        raise ExtensionRefusedError("idempotency_key_malformed", 400)
    return value


def _admit_owner_or_admin(verified: VerifiedAccessToken, organisation_id: UUID) -> None:
    with transaction.atomic():
        read_admin(verified, organisation_id)


def _admit_member(verified: VerifiedAccessToken, organisation_id: UUID) -> None:
    with transaction.atomic():
        read_member(verified, organisation_id)


def serve_authenticated(
    request: HttpRequest,
    *,
    organisation_id: UUID,
    handlers: dict[str, Handler],
    operations: tuple[Operation, ...] = (),
    idempotent_post: bool = True,
    require_admin: bool = True,
) -> HttpResponse:
    req_id = request_id(request)
    method = request.method or ""
    operation_id = next(
        (
            operation.operation_id
            for operation in operations
            if operation.method.upper() == method.upper()
        ),
        "",
    )
    admit_caller = _admit_owner_or_admin if require_admin else _admit_member
    try:
        if method not in handlers:
            return finish(problem(405, req_id, allowed=list(handlers.keys())), req_id)
        verified, lane = verify_configured_token(
            bearer(request), trusted=cast(Any, settings).KODERA_AUTH_TRUST
        )
        verified, lane = lanes.admit(verified, lane)
        if lane == "staff":
            raise ExtensionRefusedError("staff_lane_forbidden", 403)
        admit_caller(verified, organisation_id)

        def run_handler() -> HttpResponse:
            try:
                return handlers[method](verified, req_id)
            except ExtensionIdentityUnknownError:
                # AUTHZ.md §2 step 6: the one shared answer and its one WARNING line.
                return problems.identity_unknown(req_id, operation_id)
            except ExtensionRefusedError as refused:
                return problem(refused.status, req_id, reason=refused.reason)

        if method == "POST" and idempotent_post:

            def effect() -> StoredResponse:
                res = run_handler()
                return StoredResponse(
                    status=res.status_code,
                    body=res.content,
                    content_type=res.get("Content-Type", "application/json"),
                    etag=res.get("ETag"),
                )

            response = respond_once(
                request,
                issuer=verified.issuer,
                subject=verified.subject,
                request_id=req_id,
                handler=effect,
                authority=lambda _: admit_caller(verified, organisation_id),
            )
            if response.status_code in {502, 503}:
                response["Retry-After"] = "1"
        else:
            response = run_handler()
    except ExtensionIdentityUnknownError:
        response = problems.identity_unknown(req_id, operation_id)
    except TokenVerificationError:
        response = problem(401, req_id)
    except RequestDataTooBig:
        response = problem(413, req_id, reason="payload_too_large")
    except ExtensionRefusedError as refused:
        response = problem(refused.status, req_id, reason=refused.reason)
    return finish(response, req_id)
