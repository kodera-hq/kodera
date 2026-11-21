"""Bounded dynamic HTTP adapter for `/api/v1/ee/billing/*` (`core/api/ee_billing.py`).

Respects `GOVERNANCE.md` open-core boundary and ADR-0003:
- Zero static `ee` imports inside `apps/server/`.
- When `ee.billing.urls` is absent (Community image build) or `KODERA_EDITION != enterprise`,
  every `/api/v1/ee/billing*` request answers `404` (`application/problem+json`).
"""

from __future__ import annotations

import importlib
import json
from collections.abc import Callable

from django.http import HttpRequest, HttpResponse

from core.api.edition import _ensure_ee_importable

_EE_BILLING_ROOT = "/api/v1/ee/billing"
_EE_BILLING_PREFIX = "/api/v1/ee/billing/"


def _not_found_problem() -> HttpResponse:
    body = json.dumps(
        {
            "type": "https://kodera.io/problems/not-found",
            "title": "Not found",
            "status": 404,
        }
    )
    response = HttpResponse(body, status=404, content_type="application/problem+json")
    response["Cache-Control"] = "no-store"
    return response


class EnterpriseBillingMiddleware:
    """Delegate `/api/v1/ee/billing/*` dynamically to `ee.billing.urls` when installed."""

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        path = request.path
        if path != _EE_BILLING_ROOT and not path.startswith(_EE_BILLING_PREFIX):
            return self.get_response(request)
        _ensure_ee_importable()
        try:
            ee_urls = importlib.import_module("ee.billing.urls")
        except ModuleNotFoundError:
            return _not_found_problem()
        handler = getattr(ee_urls, "handle_django_request", None)
        if not callable(handler):
            return _not_found_problem()
        response: HttpResponse = handler(request)
        return response
