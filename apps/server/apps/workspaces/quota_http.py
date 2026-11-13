"""Structured quota refusals after the failing operation transaction has rolled back."""

import json

from django.db import connection, transaction
from django.http import HttpResponse

from core.api.guarded_replay import respond_once as guarded_respond_once
from core.api.idempotency import StoredResponse

from .api.responses import finish, request_id
from .quotas import violation


class QuotaReplayPolicy:
    """Retain terminal quota refusals without retaining the refused operation's effects.

    Database quota triggers abort the operation's savepoint. Translate only after that
    rollback, inside the replay store's outer transaction, so the same key cannot later
    become a successful write merely because an operator raises its quota.
    """

    def execute(self, handler, request_id):
        try:
            with transaction.atomic():
                result = handler()
                # Seat admission is deferred until the membership/invitation pair is coherent.
                # Flush these exact constraints before releasing the operation savepoint so a
                # commit-time quota refusal can still become a durable terminal replay answer.
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SET CONSTRAINTS public.membership_seat_quota, "
                        "public.invitation_seat_quota IMMEDIATE"
                    )
                    cursor.execute(
                        "SET CONSTRAINTS public.membership_seat_quota, "
                        "public.invitation_seat_quota DEFERRED"
                    )
                return result
        except Exception as failure:
            if (
                getattr(getattr(failure.__cause__, "diag", None), "constraint_name", None)
                == "workspace_quota_missing"
            ):
                # Configuration failures are transient: preserve the outer middleware's
                # Retry-After response and roll back the entire replay transaction.
                raise
            response = refusal_response(failure, request_id)
            if response is None:
                raise
            return StoredResponse(
                status=response.status_code,
                body=response.content,
                content_type=response["Content-Type"],
            )


def respond_once(request, *, handler, request_id, **kwargs):
    """Compatibility adapter for workspace-owned HTTP callers."""
    return guarded_respond_once(
        request, handler=handler, request_id=request_id, policy=QuotaReplayPolicy(), **kwargs
    )


class QuotaRefusalMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        return self.get_response(request)

    def process_exception(self, request, exception, *, correlation=None):
        return refusal_response(exception, correlation or request_id(request))


def refusal_response(exception, correlation):
    if (
        getattr(getattr(exception.__cause__, "diag", None), "constraint_name", None)
        == "workspace_quota_missing"
    ):
        body = {
            "type": "https://kodera.io/problems/service-unavailable",
            "title": "Workspace quota policy unavailable",
            "status": 503,
            "request_id": correlation,
            "retry_after_s": 1,
        }
        response = finish(
            HttpResponse(json.dumps(body), status=503, content_type="application/problem+json"),
            correlation,
        )
        response["Retry-After"] = "1"
        return response
    detail = violation(exception)
    if detail is None:
        return None
    body = {
        "type": "https://kodera.io/problems/"
        + {402: "subscription-required", 413: "payload-too-large", 429: "rate-limited"}[
            detail["status"]
        ],
        "title": "Workspace quota exceeded",
        "request_id": correlation,
        **detail,
    }
    return finish(
        HttpResponse(
            json.dumps(body), status=detail["status"], content_type="application/problem+json"
        ),
        correlation,
    )
