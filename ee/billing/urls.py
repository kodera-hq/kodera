# SPDX-License-Identifier: LicenseRef-Kodera-EE
"""Bounded Django HTTP adapter for Enterprise commercial billing (`ee/billing/urls.py`).

Mounted dynamically at `/api/v1/ee/billing/*` via `core.api.ee_billing.EnterpriseBillingMiddleware`
with zero static `ee` imports inside `apps/server/`. In Community mode (`KODERA_EDITION != enterprise`),
`EnterpriseBillingRouter.dispatch()` fails closed with `404 Not found`.
"""

from __future__ import annotations

from typing import cast

from django.http import HttpRequest, HttpResponse
from django.urls import path, re_path
from django.views.decorators.csrf import csrf_exempt

from .api import (
    FINOPS_RECONCILE_PATH,
    MAX_BODY_BYTES,
    MAX_FINOPS_BODY_BYTES,
    EnterpriseBillingRouter,
)

_DEFAULT_ROUTER = EnterpriseBillingRouter(backend="auto")


def get_router() -> EnterpriseBillingRouter:
    return _DEFAULT_ROUTER


def _read_request_body(request: HttpRequest) -> bytes:
    limit = MAX_FINOPS_BODY_BYTES if request.path == FINOPS_RECONCILE_PATH else MAX_BODY_BYTES
    environ = getattr(request, "environ", {})
    if environ.get("wsgi.input_terminated"):
        return cast(bytes, environ["wsgi.input"].read(limit + 1))
    content_length = request.META.get("CONTENT_LENGTH", "")
    if isinstance(content_length, str) and content_length.isdigit():
        if int(content_length) > limit:
            return b"x" * (limit + 1)
    return bytes(request.body[: limit + 1])


@csrf_exempt
def handle_django_request(request: HttpRequest) -> HttpResponse:
    """Translate a Django `HttpRequest` into `EnterpriseBillingRouter.dispatch` and back."""
    qs = request.META.get("QUERY_STRING", "")
    dispatch_path = (
        f"{request.path}?{qs}"
        if qs
        and request.path in ("/api/v1/ee/billing/warm-pool", "/api/v1/ee/billing/warm-pool/claims")
        else request.path
    )
    result = _DEFAULT_ROUTER.dispatch(
        request.method or "GET",
        dispatch_path,
        body=_read_request_body(request),
        headers={str(k): str(v) for k, v in request.headers.items()},
    )
    response = HttpResponse(
        result.body,
        status=result.status_code,
        content_type=result.content_type,
    )
    for header_name, header_value in result.headers.items():
        response[header_name] = header_value
    return response


urlpatterns = [
    path(
        "api/v1/ee/billing/finops/reconcile",
        handle_django_request,
        name="ee-billing-finops-reconcile",
    ),
    re_path(r"^.*$", handle_django_request, name="ee-billing-dispatch"),
]
