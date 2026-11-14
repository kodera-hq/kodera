"""Kodera Passport cross-workspace HTTP endpoints (`apps/identity/api/passport.py`)."""

from __future__ import annotations

import json
import logging
import re
from typing import cast

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from apps.identity.passport import (
    MAX_BODY_BYTES,
    PassportForbiddenError,
    PassportMalformedError,
    PassportRateLimitedError,
    PassportUnauthorizedError,
    list_passport_workspaces,
    passport_secret,
    request_magic_link,
    switch_passport_workspace,
    verify_magic_link,
)
from apps.identity.services import UnknownCustomerError
from core.api import lanes, problems
from core.api.edge import client_address
from core.api.scopes import declares
from core.db.ids import new_uuid7
from core.passport import (
    PASSPORT_SESSION_PREFIX,
    PassportInputError,
    PassportSessionClaims,
    PassportSessionError,
    verify_passport_session_token,
)
from services.identity.access_tokens import (
    MAX_TOKEN,
    TokenVerificationError,
    VerifiedAccessToken,
)
from services.identity.trusted_issuers import verify_configured_token

from .permissions import (
    LIST_PASSPORT_WORKSPACES,
    REQUEST_PASSPORT_MAGIC_LINK,
    SWITCH_PASSPORT_WORKSPACE,
    VERIFY_PASSPORT_MAGIC_LINK,
)

log = logging.getLogger(__name__)
REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,64}\Z")
PREFIX = "https://kodera.io/problems/"
TITLES = {
    "malformed-request": "Malformed request",
    "payload-too-large": "Payload too large",
    "unsupported-media-type": "Unsupported media type",
    "validation-error": "Validation failed",
    "unauthenticated": "Authentication required",
    "forbidden": "Access refused",
    "method-not-allowed": "Method not allowed",
    "rate-limited": "Too many requests",
    "internal-error": "Internal error",
}
SAFE_POINTERS: dict[str, str] = {
    "": "",
    "/email": "/email",
    "/code_challenge": "/code_challenge",
    "/code_challenge_method": "/code_challenge_method",
    "/device_challenge": "/device_challenge",
    "/token": "/token",
    "/code_verifier": "/code_verifier",
    "/device_verifier": "/device_verifier",
    "/organisation_id": "/organisation_id",
}
SAFE_CODES: dict[str, str] = {
    "unknown-field": "unknown-field",
    "invalid-email": "invalid-email",
    "unsupported-challenge-method": "unsupported-challenge-method",
    "invalid-code-challenge": "invalid-code-challenge",
    "invalid-device-challenge": "invalid-device-challenge",
    "invalid-token": "invalid-token",
    "invalid-code-verifier": "invalid-code-verifier",
    "invalid-device-verifier": "invalid-device-verifier",
    "invalid-organisation-id": "invalid-organisation-id",
}
SAFE_RATE_SCOPES: dict[str, str] = {
    "ip": "Rate limit exceeded (ip).",
    "email": "Rate limit exceeded (email).",
}
SAFE_MALFORMED_RESPONSES: dict[str, tuple[int, str, str]] = {
    "payload-too-large": (413, "payload-too-large", f"Body exceeds {MAX_BODY_BYTES} bytes."),
    "unsupported-media-type": (415, "unsupported-media-type", "Expected application/json."),
    "invalid-encoding": (400, "malformed-request", "Request body must be valid UTF-8 JSON."),
    "invalid-json": (400, "malformed-request", "Request body must be valid JSON."),
    "json-not-object": (400, "malformed-request", "Request body must be a JSON object."),
}


def _safe_validation_error(error: PassportInputError) -> dict[str, str]:
    return {
        "pointer": SAFE_POINTERS.get(error.pointer, ""),
        "code": SAFE_CODES.get(error.code, "invalid-value"),
    }


def _safe_malformed_problem(error: PassportMalformedError, request_id: str) -> HttpResponse:
    status, kind, detail = SAFE_MALFORMED_RESPONSES.get(
        error.reason, (400, "malformed-request", "Malformed request.")
    )
    return _problem(status, kind, request_id, detail=detail)


def _request_id(request: HttpRequest) -> str:
    supplied = request.headers.get("X-Request-Id", "") or request.META.get("HTTP_X_REQUEST_ID", "")
    return supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())


def _problem(status: int, kind: str, request_id: str, **extra: object) -> HttpResponse:
    body: dict[str, object] = {
        "type": PREFIX + kind,
        "title": TITLES[kind],
        "status": status,
        "request_id": request_id,
        **extra,
    }
    response = HttpResponse(
        json.dumps(body),
        status=status,
        content_type="application/problem+json",
    )
    if status == 401:
        response["WWW-Authenticate"] = "Bearer"
    return response


def _finalize(response: HttpResponse, request_id: str) -> HttpResponse:
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response


def _read_body(request: HttpRequest) -> bytes:
    environ = getattr(request, "environ", {})
    if environ.get("wsgi.input_terminated"):
        return cast(bytes, environ["wsgi.input"].read(MAX_BODY_BYTES + 1))
    content_length = request.META.get("CONTENT_LENGTH", "")
    if isinstance(content_length, str) and content_length.isdigit():
        if int(content_length) > MAX_BODY_BYTES:
            raise PassportMalformedError(
                413,
                "payload-too-large",
                "payload-too-large",
                detail=f"Body exceeds {MAX_BODY_BYTES} bytes.",
            )
    return bytes(request.body[: MAX_BODY_BYTES + 1])


def _bearer(request: HttpRequest) -> str:
    authorization = request.headers.get("Authorization", "")
    if len(authorization) > MAX_TOKEN + 7:
        raise TokenVerificationError()
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise TokenVerificationError()
    return parts[1]


def _authenticate_customer(
    request: HttpRequest,
) -> tuple[VerifiedAccessToken | None, PassportSessionClaims | None]:
    token = _bearer(request)
    if token.startswith(PASSPORT_SESSION_PREFIX):
        try:
            claims = verify_passport_session_token(token, secret=passport_secret())
        except PassportSessionError as exc:
            raise TokenVerificationError() from exc
        return None, claims

    verified, lane = verify_configured_token(token, trusted=settings.KODERA_AUTH_TRUST)
    verified, lane = lanes.admit(verified, lane)
    if lane != "customer":
        raise TokenVerificationError()
    return verified, None


@declares(REQUEST_PASSPORT_MAGIC_LINK)
def passport_magic_link_request(request: HttpRequest) -> HttpResponse:
    request_id = _request_id(request)
    try:
        if request.method != "POST":
            response = _problem(405, "method-not-allowed", request_id, allowed=["POST"])
            response["Allow"] = "POST"
            return _finalize(response, request_id)

        accepted = request_magic_link(
            raw_body=_read_body(request),
            content_type=request.META.get("CONTENT_TYPE"),
            peer=client_address(request.META, settings.KODERA_TRUSTED_EDGE),
        )
        response = HttpResponse(
            json.dumps(
                {
                    "status": "accepted",
                    "expires_in_seconds": accepted.expires_in_seconds,
                }
            ),
            status=202,
            content_type="application/json",
        )
        response["RateLimit-Limit"] = str(accepted.quota.limit)
        response["RateLimit-Remaining"] = str(accepted.quota.remaining)
        response["RateLimit-Reset"] = str(accepted.quota.reset_s)
    except PassportInputError as error:
        response = _problem(
            422,
            "validation-error",
            request_id,
            errors=[_safe_validation_error(error)],
        )
    except PassportMalformedError as error:
        response = _safe_malformed_problem(error, request_id)
    except PassportRateLimitedError as error:
        response = _problem(
            429,
            "rate-limited",
            request_id,
            retry_after_s=int(error.retry_after_s),
            detail=SAFE_RATE_SCOPES.get(error.scope, "Rate limit exceeded."),
        )
        response["Retry-After"] = str(int(error.retry_after_s))
        response["RateLimit-Limit"] = str(int(error.limit))
        response["RateLimit-Remaining"] = str(int(error.remaining))
        response["RateLimit-Reset"] = str(int(error.reset_s))
    except Exception as error:
        log.error(
            "passport magic-link request internal error request_id=%s exception=%s",
            request_id,
            type(error).__name__,
        )
        response = _problem(500, "internal-error", request_id)
    return _finalize(response, request_id)


@declares(VERIFY_PASSPORT_MAGIC_LINK)
def passport_magic_link_verify(request: HttpRequest) -> HttpResponse:
    request_id = _request_id(request)
    try:
        if request.method != "POST":
            response = _problem(405, "method-not-allowed", request_id, allowed=["POST"])
            response["Allow"] = "POST"
            return _finalize(response, request_id)

        verified_session = verify_magic_link(
            raw_body=_read_body(request),
            content_type=request.META.get("CONTENT_TYPE"),
            request_id=request_id,
        )
        response = HttpResponse(
            json.dumps(verified_session.to_dict()),
            status=200,
            content_type="application/json",
        )
    except PassportUnauthorizedError:
        response = _problem(401, "unauthenticated", request_id)
    except PassportInputError as error:
        response = _problem(
            422,
            "validation-error",
            request_id,
            errors=[_safe_validation_error(error)],
        )
    except PassportMalformedError as error:
        response = _safe_malformed_problem(error, request_id)
    except Exception as error:
        log.error(
            "passport magic-link verify internal error request_id=%s exception=%s",
            request_id,
            type(error).__name__,
        )
        response = _problem(500, "internal-error", request_id)
    return _finalize(response, request_id)


@declares(LIST_PASSPORT_WORKSPACES)
def passport_workspaces(request: HttpRequest) -> HttpResponse:
    request_id = _request_id(request)
    try:
        if request.method != "GET":
            response = _problem(405, "method-not-allowed", request_id, allowed=["GET"])
            response["Allow"] = "GET"
            return _finalize(response, request_id)

        verified, session_claims = _authenticate_customer(request)
        directory = list_passport_workspaces(
            verified=verified,
            session_claims=session_claims,
        )
        response = HttpResponse(
            json.dumps(directory.to_dict()),
            status=200,
            content_type="application/json",
        )
    except TokenVerificationError:
        response = _problem(401, "unauthenticated", request_id)
    except UnknownCustomerError:
        response = problems.identity_unknown(request_id, LIST_PASSPORT_WORKSPACES.operation_id)
    except PassportForbiddenError:
        response = _problem(403, "forbidden", request_id)
    except Exception as error:
        log.error(
            "passport workspaces internal error request_id=%s exception=%s",
            request_id,
            type(error).__name__,
        )
        response = _problem(500, "internal-error", request_id)
    return _finalize(response, request_id)


@declares(SWITCH_PASSPORT_WORKSPACE)
def passport_switch_workspace(request: HttpRequest) -> HttpResponse:
    request_id = _request_id(request)
    try:
        if request.method != "POST":
            response = _problem(405, "method-not-allowed", request_id, allowed=["POST"])
            response["Allow"] = "POST"
            return _finalize(response, request_id)

        verified, session_claims = _authenticate_customer(request)
        switched = switch_passport_workspace(
            verified=verified,
            session_claims=session_claims,
            raw_body=_read_body(request),
            content_type=request.META.get("CONTENT_TYPE"),
            request_id=request_id,
        )
        response = HttpResponse(
            json.dumps(switched.to_dict()),
            status=200,
            content_type="application/json",
        )
    except TokenVerificationError:
        response = _problem(401, "unauthenticated", request_id)
    except UnknownCustomerError:
        response = problems.identity_unknown(request_id, SWITCH_PASSPORT_WORKSPACE.operation_id)
    except PassportForbiddenError:
        response = _problem(403, "forbidden", request_id)
    except PassportInputError as error:
        response = _problem(
            422,
            "validation-error",
            request_id,
            errors=[_safe_validation_error(error)],
        )
    except PassportMalformedError as error:
        response = _safe_malformed_problem(error, request_id)
    except Exception as error:
        log.error(
            "passport switch-workspace internal error request_id=%s exception=%s",
            request_id,
            type(error).__name__,
        )
        response = _problem(500, "internal-error", request_id)
    return _finalize(response, request_id)
