"""Bounded anonymous WSGI realm discovery; no bearer or generic POST replay."""

import json
import logging
import re
from typing import cast

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from apps.identity.discovery import DiscoveryRefusedError, discover
from core.api.edge import client_address
from core.api.scopes import declares
from core.db.ids import new_uuid7
from services.identity.discovery_policy import DiscoveryUnavailableError, QuotaDecision

from .discovery_permissions import DISCOVER_REALM

log = logging.getLogger(__name__)
REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,64}\Z")
PREFIX = "https://kodera.io/problems/"
TITLES = {
    "malformed-request": "Malformed request",
    "idempotency-key-missing": "Idempotency key required",
    "payload-too-large": "Payload too large",
    "unsupported-media-type": "Unsupported media type",
    "validation-error": "Validation failed",
    "rate-limited": "Rate limit reached",
    "service-unavailable": "Service unavailable",
    "internal-error": "Internal error",
    "method-not-allowed": "Method not allowed",
    "forbidden": "Forbidden",
}


def _problem(status: int, kind: str, request_id: str, **extra: object) -> HttpResponse:
    return HttpResponse(
        json.dumps(
            {
                "type": PREFIX + kind,
                "title": TITLES[kind],
                "status": status,
                "request_id": request_id,
                **extra,
            }
        ),
        status=status,
        content_type="application/problem+json",
    )


def _received_bytes(request: HttpRequest) -> bytes:
    # Gunicorn supplies the framing boundary for terminated/chunked WSGI input.
    # Django's LimitedStream otherwise uses CONTENT_LENGTH; never read an unbounded body.
    environ = getattr(request, "environ", {})
    stream = environ["wsgi.input"] if environ.get("wsgi.input_terminated") else request
    return cast(bytes, stream.read(4097))


def _errors(reason: str) -> list[dict[str, str]]:
    pointer = "/slug" if reason == "slug-shape" else "/email" if reason.startswith("email-") else ""
    codes = {
        "slug-shape": "invalid-slug",
        "email-shape": "invalid-email",
        "email-local-shape": "invalid-email",
        "email-domain-shape": "invalid-email",
        "duplicate-json-key": "duplicate-key",
        "key-shape": "invalid-key",
        "invalid-json": "invalid-json",
        "body-read": "invalid-body",
    }
    return [{"pointer": pointer, "code": codes.get(reason, "invalid-input")}]


def _log_internal(request_id: str, cause_class: str | None) -> None:
    """Correlate a 500 with its request: the id and the exception's class name, nothing else."""
    log.error(
        "discovery internal error request_id=%s exception=%s",
        request_id,
        cause_class or "unknown",
    )


@declares(DISCOVER_REALM)
def discovery(request: HttpRequest) -> HttpResponse:
    supplied = request.META.get("HTTP_X_REQUEST_ID", "")
    request_id = supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
    quota: QuotaDecision | None = None
    try:
        if request.method != "POST":
            response = _problem(405, "method-not-allowed", request_id, allowed=["POST"])
            response["Allow"] = "POST"
        else:
            result = discover(
                lambda: _received_bytes(request),
                peer=client_address(request.META, settings.KODERA_TRUSTED_EDGE),
                content_type=request.META.get("CONTENT_TYPE"),
                compatibility_key=request.META.get("HTTP_IDEMPOTENCY_KEY"),
                origin=request.META.get("HTTP_ORIGIN"),
                fetch_site=request.META.get("HTTP_SEC_FETCH_SITE"),
            )
            quota = result.quota
            response = HttpResponse(json.dumps(result.selection), content_type="application/json")
    except DiscoveryRefusedError as error:
        quota = error.quota
        kind = error.problem_type.removeprefix(PREFIX)
        extra: dict[str, object] = {}
        if error.status in (400, 422) and error.reason not in ("key-missing", "key-shape"):
            extra["errors"] = _errors(error.reason)
        if error.status == 413:
            extra["limit_bytes"] = 4096
        if error.status == 415:
            extra["supported"] = ["application/json"]
        if error.status == 429 and quota is not None:
            extra.update(retry_after_s=quota.retry_after_s, scope=quota.scope)
        if error.status == 500:
            _log_internal(request_id, error.cause_class)
        response = _problem(error.status, kind, request_id, **extra)
        if error.status == 429 and quota is not None:
            response["Retry-After"] = str(quota.retry_after_s)
    except DiscoveryUnavailableError as error:
        quota = error.quota
        response = _problem(503, "service-unavailable", request_id, retry_after_s=5)
        response["Retry-After"] = "5"
    except Exception as error:
        # No exception text, raw body, header, bearer or lookup value is logged or echoed.
        _log_internal(request_id, type(error).__name__)
        response = _problem(500, "internal-error", request_id)
    if quota is not None:
        response["RateLimit-Limit"] = str(quota.limit)
        response["RateLimit-Remaining"] = str(quota.remaining)
        response["RateLimit-Reset"] = str(quota.reset_s)
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response
