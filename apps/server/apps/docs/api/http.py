"""Verified customer HTTP admission, strict bodies and shared Core replay semantics."""

import hashlib
import json
from collections.abc import Callable
from typing import Any, cast
from uuid import UUID

from django.conf import settings
from django.core.exceptions import RequestDataTooBig
from django.http import HttpRequest, HttpResponse

from core.api import lanes
from core.api.idempotency import StoredResponse, respond_once
from services.identity.access_tokens import TokenVerificationError, VerifiedAccessToken
from services.identity.trusted_issuers import verify_configured_token

from ..services import RefusalError, authorize
from . import responses

Handler = Callable[[VerifiedAccessToken, str], HttpResponse]


def json_response(body: Any, status: int = 200, *, etag: bool = False) -> HttpResponse:
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    response = HttpResponse(encoded, status=status, content_type="application/json")
    if etag:
        response["ETag"] = '"' + hashlib.sha256(encoded).hexdigest() + '"'
    return response


def problem(failure: RefusalError, request_id: str) -> HttpResponse:
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
        503: "service-unavailable",
    }
    body: dict[str, Any] = {
        "type": "https://kodera.io/problems/" + (failure.kind or kinds[failure.status]),
        "title": "Workspace request refused",
        "status": failure.status,
        "request_id": request_id,
    }
    if failure.status == 503:
        body["retry_after_s"] = 1
    response = HttpResponse(
        json.dumps(body, separators=(",", ":")),
        status=failure.status,
        content_type="application/problem+json",
    )
    if failure.status == 401:
        response["WWW-Authenticate"] = "Bearer"
    if failure.status == 503:
        response["Retry-After"] = "1"
    return response


def body(request: HttpRequest, fields: set[str], required: set[str]) -> dict[str, Any]:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result = {}
        for name, value in pairs:
            if name in result:
                raise RefusalError(400)
            result[name] = value
        return result

    if request.content_type != "application/json" or len(request.body) > 2 * 1024 * 1024:
        raise RefusalError(400)
    try:
        result = json.loads(request.body, object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        raise RefusalError(400) from None
    if not isinstance(result, dict) or not required <= result.keys() or result.keys() - fields:
        raise RefusalError(422)
    return result


def uuid(value: Any) -> UUID:
    if not isinstance(value, str):
        raise RefusalError(422)
    try:
        return UUID(value)
    except ValueError:
        raise RefusalError(422) from None


def serve(
    request: HttpRequest,
    handlers: dict[str, Handler],
    organisation_id: UUID,
    authority: Callable[[VerifiedAccessToken], None] | None = None,
) -> HttpResponse:
    request_id = responses.request_id(request)
    method = request.method or ""
    try:
        if method not in handlers:
            response = problem(RefusalError(405), request_id)
            response["Allow"] = ", ".join(handlers)
            return responses.finish(response, request_id)
        verified, lane = verify_configured_token(
            responses.bearer(request), trusted=cast(Any, settings).KODERA_AUTH_TRUST
        )
        verified, lane = lanes.admit(verified, lane)
        if lane == "staff":
            raise RefusalError(403)
        admit = authority or (lambda principal: authorize(principal, organisation_id))
        admit(verified)

        def execute() -> HttpResponse:
            try:
                return handlers[method](verified, request_id)
            except RefusalError as failure:
                return problem(failure, request_id)

        if method == "POST":

            def effect() -> StoredResponse:
                result = execute()
                return StoredResponse(
                    status=result.status_code,
                    body=result.content,
                    content_type=result.get("Content-Type", "application/json"),
                    etag=result.get("ETag"),
                )

            response = respond_once(
                request,
                issuer=verified.issuer,
                subject=verified.subject,
                request_id=request_id,
                handler=effect,
                authority=lambda _: admit(verified),
            )
            if response.status_code == 503:
                response["Retry-After"] = "1"
        else:
            response = execute()
    except TokenVerificationError:
        response = problem(RefusalError(401), request_id)
    except RequestDataTooBig:
        response = problem(RefusalError(400), request_id)
    except RefusalError as failure:
        response = problem(failure, request_id)
    return responses.finish(response, request_id)
