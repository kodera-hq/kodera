"""Verified customer HTTP admission, strict JSON bodies, and Core idempotency replay."""

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
from core.idempotency.store import Scope
from services.identity.access_tokens import TokenVerificationError, VerifiedAccessToken
from services.identity.trusted_issuers import verify_configured_token

from ..adapters import AiGatewayRefusalError
from ..services import authorize, quota_replay_policy
from . import responses

Handler = Callable[[VerifiedAccessToken, str], HttpResponse]


def json_response(payload: Any, status: int = 200) -> HttpResponse:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode(
        "utf-8"
    )
    return HttpResponse(encoded, status=status, content_type="application/json")


def problem(
    failure: AiGatewayRefusalError, request_id: str, operation_id: str = ""
) -> HttpResponse:
    if failure.status == 403 and (
        failure.kind == "identity-unknown" or failure.reason == "identity-unknown"
    ):
        # AUTHZ.md §2 step 6: a verified token with no stored identity gets the one shared
        # answer and its one WARNING line, never the generic forbidden problem.
        return problems.identity_unknown(request_id, operation_id)
    kinds = {
        400: "malformed-request",
        401: "unauthenticated",
        403: "forbidden",
        404: "not-found",
        405: "method-not-allowed",
        409: "conflict",
        422: "validation-error",
        429: "rate-limited",
        503: "service-unavailable",
    }
    kind = failure.kind or kinds.get(failure.status, "validation-error")
    payload: dict[str, Any] = {
        "type": f"https://kodera.io/problems/{kind}",
        "title": "Workspace AI request refused",
        "status": failure.status,
        "request_id": request_id,
    }
    if failure.reason is not None:
        payload["reason"] = failure.reason
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


def body(
    request: HttpRequest,
    fields: set[str],
    required: set[str],
    *,
    max_bytes: int = 16384,
) -> dict[str, Any]:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for name, value in pairs:
            if name in result:
                raise AiGatewayRefusalError(400, None, "malformed-request")
            result[name] = value
        return result

    def reject_constant(_: str) -> None:
        raise AiGatewayRefusalError(400, None, "malformed-request")

    content_type = (request.content_type or "").split(";")[0].strip().lower()
    if content_type != "application/json" or len(request.body) > max_bytes:
        raise AiGatewayRefusalError(400, None, "malformed-request")
    try:
        parsed = json.loads(
            request.body.decode("utf-8"),
            object_pairs_hook=unique,
            parse_constant=reject_constant,
        )
    except (ValueError, UnicodeError, RecursionError):
        raise AiGatewayRefusalError(400, None, "malformed-request") from None
    if not isinstance(parsed, dict) or not required <= parsed.keys() or (parsed.keys() - fields):
        raise AiGatewayRefusalError(422, "unexpected_or_missing_fields", "validation-error")
    return parsed


def serve(
    request: HttpRequest,
    handlers: dict[str, Handler],
    organisation_id: UUID,
    *,
    operations: tuple[Operation, ...] = (),
    prepare: Callable[[VerifiedAccessToken, str], Handler] | None = None,
    replay_authorize: Callable[[VerifiedAccessToken], None] | None = None,
    ephemeral_response: bool = False,
) -> HttpResponse:
    req_id = responses.request_id(request)
    method = (request.method or "").upper()
    operation_id = next(
        (operation.operation_id for operation in operations if operation.method.upper() == method),
        "",
    )
    try:
        if method not in handlers:
            response = problem(
                AiGatewayRefusalError(405, None, "method-not-allowed"), req_id, operation_id
            )
            response["Allow"] = ", ".join(sorted(handlers))
            return responses.finish(response, req_id)
        verified, lane = verify_configured_token(
            responses.bearer(request), trusted=cast(Any, settings).KODERA_AUTH_TRUST
        )
        verified, lane = lanes.admit(verified, lane)
        if lane == "staff":
            raise AiGatewayRefusalError(403, None, "forbidden")
        authorize(verified, organisation_id)

        handler = handlers[method]
        prepared_failure: AiGatewayRefusalError | None = None
        supplied = request.headers.get(idempotency.KEY_HEADER, "")
        fence: Scope | None = None
        try:
            if (
                method == "POST"
                and prepare is not None
                and not idempotency.is_missing(supplied)
                and not idempotency.is_malformed(supplied)
            ):
                scope = idempotency.scope_for(
                    request, issuer=verified.issuer, subject=verified.subject, key=supplied
                )
                if scope is not None and not idempotency.holds_answer(
                    request, issuer=verified.issuer, subject=verified.subject, key=supplied
                ):
                    # Claim durable per-(scope, key) execution ownership BEFORE prepare() runs
                    # any external I/O: a concurrent duplicate key is fenced here with a 409
                    # conflict instead of consuming provider work and refunding it afterwards.
                    if not idempotency.claim_execution(scope):
                        return responses.finish(
                            idempotency.render(idempotency.in_flight_problem(req_id)), req_id
                        )
                    fence = scope
                    if not idempotency.holds_answer(
                        request, issuer=verified.issuer, subject=verified.subject, key=supplied
                    ):
                        try:
                            handler = prepare(verified, req_id)
                        except AiGatewayRefusalError as failure:
                            prepared_failure = failure

            def execute() -> HttpResponse:
                try:
                    if prepared_failure is not None:
                        raise prepared_failure
                    return handler(verified, req_id)
                except AiGatewayRefusalError as failure:
                    return problem(failure, req_id, operation_id)

            if method == "POST":
                live_ephemeral_response: list[HttpResponse] = []

                def effect() -> StoredResponse:
                    result = execute()
                    if ephemeral_response and 200 <= result.status_code <= 299:
                        # Zero DB persistence of ephemeral AI translations and call transcripts:
                        # return the 2xx body only from process memory on the executing request and
                        # persist a content-free 409 receipt in `idempotency_record`.
                        live_ephemeral_response.append(result)
                        receipt = problem(
                            AiGatewayRefusalError(
                                409,
                                "ephemeral_output_not_replayed",
                                "conflict",
                            ),
                            req_id,
                            operation_id,
                        )
                        return StoredResponse(
                            status=receipt.status_code,
                            body=receipt.content,
                            content_type=receipt.get("Content-Type", "application/problem+json"),
                        )
                    return StoredResponse(
                        status=result.status_code,
                        body=result.content,
                        content_type=result.get("Content-Type", "application/json"),
                        etag=result.get("ETag"),
                    )

                def check_authority(event: Any) -> None:
                    authorize(verified, organisation_id)
                    status = getattr(event, "status", None)
                    if (
                        replay_authorize is not None
                        and isinstance(status, int)
                        and 200 <= status <= 299
                    ):
                        replay_authorize(verified)

                response = respond_once(
                    request,
                    issuer=verified.issuer,
                    subject=verified.subject,
                    request_id=req_id,
                    handler=effect,
                    policy=quota_replay_policy(),
                    authority=check_authority,
                )
                if live_ephemeral_response:
                    response = live_ephemeral_response[0]
            else:
                response = execute()
        finally:
            # The stored answer (or the rolled-back attempt) now owns the scope durably, so the
            # session claim can go; a prepare that raised before provider work completed leaves
            # nothing to fence, and a completed one reconciled its budget inside the step.
            if fence is not None:
                idempotency.release_execution(fence)
    except TokenVerificationError:
        response = problem(
            AiGatewayRefusalError(401, None, "unauthenticated"), req_id, operation_id
        )
    except RequestDataTooBig:
        response = problem(
            AiGatewayRefusalError(400, None, "malformed-request"), req_id, operation_id
        )
    except AiGatewayRefusalError as failure:
        response = problem(failure, req_id, operation_id)
    return responses.finish(response, req_id)
