"""Verified customer admission and current-authority encrypted response replay."""

import json
import re
from collections.abc import Callable
from typing import Any, cast
from uuid import UUID

from django.conf import settings
from django.core.exceptions import RequestDataTooBig
from django.http import HttpRequest, HttpResponse

from core.api import lanes
from core.api.idempotency import StoredResponse, respond_once
from services.identity.access_tokens import TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

from .. import services
from . import responses

MAX_BODY = 768 * 1024
COUNTER = re.compile(r"(?:0|[1-9][0-9]{0,18})\Z")


def json_response(body: Any, status: int = 200) -> HttpResponse:
    return HttpResponse(
        json.dumps(body, sort_keys=True, separators=(",", ":"), allow_nan=False),
        status=status,
        content_type="application/json",
    )


def problem(failure: services.RefusalError, request_id: str) -> HttpResponse:
    kinds = {
        400: "malformed-request",
        401: "unauthenticated",
        403: "forbidden",
        404: "not-found",
        405: "method-not-allowed",
        409: "conflict",
        422: "validation-error",
        503: "service-unavailable",
    }
    response = json_response(
        {
            "type": "https://kodera.io/problems/" + (failure.kind or kinds[failure.status]),
            "title": "Confidential transport request refused",
            "status": failure.status,
            "request_id": request_id,
        },
        failure.status,
    )
    response["Content-Type"] = "application/problem+json"
    if failure.status == 401:
        response["WWW-Authenticate"] = "Bearer"
    if failure.status == 503:
        response["Retry-After"] = "1"
    return response


def body(request: HttpRequest, operation: str) -> dict[str, Any]:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result = {}
        for key, value in pairs:
            if key in result:
                raise services.RefusalError(400)
            result[key] = value
        return result

    def invalid_constant(_: str) -> None:
        raise services.RefusalError(400)

    if request.content_type != "application/json" or len(request.body) > MAX_BODY:
        raise services.RefusalError(400)
    try:
        value = json.loads(request.body, object_pairs_hook=unique, parse_constant=invalid_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise services.RefusalError(400) from None
    required, optional = services.REQUEST_FIELDS[operation]
    if (
        not isinstance(value, dict)
        or not required <= value.keys()
        or value.keys() - required - optional
    ):
        raise services.RefusalError(422)
    return value


def query(request: HttpRequest) -> tuple[str, int]:
    if set(request.GET) - {"deviceId", "after"} or any(
        len(request.GET.getlist(key)) != 1 for key in request.GET
    ):
        raise services.RefusalError(422)
    device = request.GET.get("deviceId", "")
    value = request.GET.get("after", "0")
    if not COUNTER.fullmatch(value) or int(value) > services.MAX_EPOCH:
        raise services.RefusalError(422)
    return device, int(value)


def serve(
    request: HttpRequest,
    *,
    organisation_id: UUID,
    operation: str,
    effect: Callable[..., dict[str, Any]],
    room_id: UUID | None = None,
    status: int = 200,
) -> HttpResponse:
    request_id = responses.request_id(request)
    try:
        if getattr(settings, "KODERA_E2EE_RELAY_ENABLED", False) is not True:
            raise services.RefusalError(503)
        expected = "GET" if operation == "read-envelopes" else "POST"
        if request.method != expected:
            response = problem(services.RefusalError(405), request_id)
            response["Allow"] = expected
            return responses.finish(response, request_id)
        verified, lane = verify_configured_token(
            responses.bearer(request), trusted=cast(Any, settings).KODERA_AUTH_TRUST
        )
        verified, lane = lanes.admit(verified, lane)
        if lane == "staff":
            raise services.RefusalError(403)
        arguments: dict[str, Any] = {"verified": verified, "organisation_id": organisation_id}
        if room_id is not None:
            arguments["room_id"] = room_id
        if expected == "GET":
            device, after = query(request)
            response = json_response(effect(**arguments, device_id=device, after=after))
        else:
            data = body(request, operation)

            def authority(_: Any) -> None:
                services.authorize_request(**arguments, operation=operation, body=data)

            # Admission also precedes missing-key errors. The replay callbacks repeat it
            # inside the store-owned transaction before exposing any stored metadata.
            authority(None)

            def execute() -> StoredResponse:
                try:
                    result = json_response(
                        effect(**arguments, body=data, request_id=request_id), status
                    )
                except services.RefusalError as failure:
                    # Each service owns a savepoint. Its partial mutation has
                    # rolled back before a terminal failure enters the replay
                    # store; the earlier authority observation remains fenced.
                    result = problem(failure, request_id)
                return StoredResponse(
                    status=result.status_code,
                    body=result.content,
                    content_type=result.get("Content-Type", "application/json"),
                )

            response = respond_once(
                request,
                issuer=verified.issuer,
                subject=verified.subject,
                request_id=request_id,
                handler=execute,
                authority=authority,
            )
    except TokenVerificationError:
        response = problem(services.RefusalError(401), request_id)
    except RequestDataTooBig:
        response = problem(services.RefusalError(400), request_id)
    except services.RefusalError as failure:
        response = problem(failure, request_id)
    if response.status_code == 503:
        response["Retry-After"] = "1"
    return responses.finish(response, request_id)
