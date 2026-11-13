"""Structured quota refusals after the failing operation transaction has rolled back."""

import json

from django.http import HttpResponse

from apps.docs.api.responses import finish, request_id

from .quotas import violation


class QuotaRefusalMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        return self.get_response(request)

    def process_exception(self, request, exception):
        if (
            getattr(getattr(exception.__cause__, "diag", None), "constraint_name", None)
            == "workspace_quota_missing"
        ):
            correlation = request_id(request)
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
        correlation = request_id(request)
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
