"""HTTP route for cardless PME self-serve workspace creation (`POST /api/v1/workspaces/self-serve`)."""

from __future__ import annotations

import json
import logging
from typing import Any

from django.core.exceptions import RequestDataTooBig
from django.http import HttpRequest, HttpResponse

from apps.workspaces.quota_http import respond_once
from apps.workspaces.self_serve import (
    SelfServeAuthForbiddenError,
    SelfServeCaller,
    SelfServeRateLimitError,
    SelfServeSlugTakenError,
    SelfServeUnavailableError,
    SelfServeValidationError,
    create_self_serve_workspace,
    parse_self_serve_request,
    resolve_self_serve_caller_from_token,
)
from core.api.idempotency import PROBLEM_TYPE, StoredResponse
from core.api.scopes import declares
from services.identity.access_tokens import TokenVerificationError

from . import responses
from .permissions import CREATE_SELF_SERVE_WORKSPACE

LOG = logging.getLogger(__name__)
MAX_BODY_BYTES = 16 * 1024


def _resolve_caller(request: HttpRequest) -> SelfServeCaller:
    return resolve_self_serve_caller_from_token(responses.bearer(request))


def _parse_json_body(request: HttpRequest) -> dict[str, Any] | tuple[int, str]:
    content_type = (request.content_type or "").split(";")[0].strip().lower()
    if content_type != "application/json":
        return 415, "unsupported-media-type"
    try:
        raw = request.body
    except RequestDataTooBig:
        return 413, "payload-too-large"
    if len(raw) > MAX_BODY_BYTES:
        return 413, "payload-too-large"
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return 400, "malformed-request"
    if not isinstance(parsed, dict):
        return 400, "malformed-request"
    return parsed


def _problem_stored(
    status: int,
    kind: str,
    title: str,
    request_id: str,
    extra: dict[str, Any] | None = None,
) -> StoredResponse:
    doc: dict[str, Any] = {
        "type": f"https://kodera.io/problems/{kind}",
        "title": title,
        "status": status,
        "request_id": request_id,
    }
    if extra:
        doc.update(extra)
    return StoredResponse(
        status=status,
        body=json.dumps(doc, separators=(",", ":")).encode("utf-8"),
        content_type=PROBLEM_TYPE,
    )


def _execute_self_serve(
    request: HttpRequest, caller: SelfServeCaller, request_id: str
) -> StoredResponse:
    parsed = _parse_json_body(request)
    if isinstance(parsed, tuple):
        status_code, kind = parsed
        titles = {
            400: "Malformed request",
            413: "Payload too large",
            415: "Unsupported media type",
        }
        return _problem_stored(status_code, kind, titles[status_code], request_id)

    try:
        payload = parse_self_serve_request(parsed)
        created = create_self_serve_workspace(
            caller=caller,
            payload=payload,
            request_id=request_id,
        )
    except SelfServeValidationError as exc:
        return _problem_stored(
            422,
            "validation-error",
            "Validation error",
            request_id,
            {"errors": exc.errors},
        )
    except SelfServeSlugTakenError as exc:
        return _problem_stored(
            409,
            "slug-taken",
            "Slug taken",
            request_id,
            {"slug": exc.slug, "suggestions": exc.suggestions},
        )

    return StoredResponse(
        status=201,
        body=json.dumps(created, separators=(",", ":")).encode("utf-8"),
        content_type="application/json",
    )


@declares(CREATE_SELF_SERVE_WORKSPACE)
def self_serve_workspace(request: HttpRequest) -> HttpResponse:
    request_id = responses.request_id(request)
    try:
        if request.method != "POST":
            response = responses.problem("method-not-allowed", request_id, allowed=["POST"])
            response["Allow"] = "POST"
            return responses.finish(response, request_id)

        caller = _resolve_caller(request)

        def authority(_event: object) -> None:
            _resolve_caller(request)

        response = respond_once(
            request,
            issuer=caller.issuer,
            subject=caller.subject,
            request_id=request_id,
            authority=authority,
            handler=lambda: _execute_self_serve(request, caller, request_id),
        )
    except TokenVerificationError:
        response = responses.problem("unauthenticated", request_id)
    except SelfServeAuthForbiddenError:
        response = responses.problem("forbidden", request_id)
    except SelfServeRateLimitError as exc:
        body = {
            "type": "https://kodera.io/problems/rate-limited",
            "title": "Too many requests",
            "status": 429,
            "request_id": request_id,
            "code": "self_serve_workspace_limit",
            "retry_after_s": exc.retry_after_s,
        }
        response = HttpResponse(
            json.dumps(body, separators=(",", ":")),
            status=429,
            content_type=PROBLEM_TYPE,
        )
        response["Retry-After"] = str(exc.retry_after_s)
    except SelfServeUnavailableError:
        response = responses.problem(
            "service-unavailable", request_id, code="shared_realm_unavailable"
        )
        response["Retry-After"] = "60"
    except Exception as failure:
        LOG.error(
            "createSelfServeWorkspace failed: %s request_id=%s",
            type(failure).__name__,
            request_id,
        )
        response = responses.problem("internal-error", request_id)
    return responses.finish(response, request_id)
