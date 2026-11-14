"""Public signed Stripe webhook HTTP endpoint (`POST /api/v1/billing/webhooks/stripe`).

Exempt from OIDC bearer tokens; authenticated strictly via `Stripe-Signature` HMAC-SHA256
(`t=...,v1=...`) with 300-second replay protection and constant-time digest comparison.
"""

from __future__ import annotations

import json
import logging
import re
from typing import cast

from django.http import HttpRequest, HttpResponse

from apps.billing.payments.stripe_webhook import (
    MAX_WEBHOOK_BYTES,
    StripeWebhookMalformedError,
    StripeWebhookSecretMissingError,
    StripeWebhookSignatureError,
    receive_stripe_webhook,
)
from core.api.scopes import declares
from core.db.ids import new_uuid7

from .permissions import RECEIVE_STRIPE_WEBHOOK

log = logging.getLogger(__name__)
REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,64}\Z")
PREFIX = "https://kodera.io/problems/"
TITLES = {
    "malformed-request": "Malformed request",
    "unauthenticated": "Invalid webhook signature",
    "method-not-allowed": "Method not allowed",
    "service-unavailable": "Service unavailable",
    "internal-error": "Internal error",
}
MALFORMED_DETAILS: dict[str, str] = {
    "payload-too-large": "payload-too-large",
    "missing-signature-header": "missing-signature-header",
    "malformed-signature-header": "malformed-signature-header",
    "duplicate-signature-timestamp": "duplicate-signature-timestamp",
    "invalid-json": "invalid-json",
    "event-not-object": "event-not-object",
    "invalid-event-envelope": "invalid-event-envelope",
    "invalid-event-object": "invalid-event-object",
    "invalid-event-timestamp": "invalid-event-timestamp",
}


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
    return HttpResponse(
        json.dumps(body),
        status=status,
        content_type="application/problem+json",
    )


def _read_body(request: HttpRequest) -> bytes:
    environ = getattr(request, "environ", {})
    if environ.get("wsgi.input_terminated"):
        return cast(bytes, environ["wsgi.input"].read(MAX_WEBHOOK_BYTES + 1))
    content_length = request.META.get("CONTENT_LENGTH", "")
    if isinstance(content_length, str) and content_length.isdigit():
        if int(content_length) > MAX_WEBHOOK_BYTES:
            raise StripeWebhookMalformedError("payload-too-large")
    return bytes(request.body[: MAX_WEBHOOK_BYTES + 1])


@declares(RECEIVE_STRIPE_WEBHOOK)
def stripe_webhook(request: HttpRequest) -> HttpResponse:
    request_id = _request_id(request)
    try:
        if request.method != "POST":
            response = _problem(405, "method-not-allowed", request_id, allowed=["POST"])
            response["Allow"] = "POST"
        else:
            receipt = receive_stripe_webhook(
                raw_body=_read_body(request),
                headers=dict(request.headers),
            )
            response = HttpResponse(
                json.dumps(receipt.to_dict()),
                status=200,
                content_type="application/json",
            )
    except StripeWebhookSecretMissingError:
        response = _problem(503, "service-unavailable", request_id, retry_after_s=30)
        response["Retry-After"] = "30"
    except StripeWebhookMalformedError as error:
        detail = MALFORMED_DETAILS.get(error.reason, "malformed-request")
        response = _problem(400, "malformed-request", request_id, detail=detail)
    except StripeWebhookSignatureError:
        response = _problem(401, "unauthenticated", request_id)
        response["WWW-Authenticate"] = "Stripe-Signature"
    except Exception as error:
        log.error(
            "stripe webhook internal error request_id=%s exception=%s",
            request_id,
            type(error).__name__,
        )
        response = _problem(500, "internal-error", request_id)
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response
