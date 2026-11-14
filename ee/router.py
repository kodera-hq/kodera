"""HTTP router for Kodera Enterprise Edition (`/api/v1/ee/*`).

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import json

from django.http import HttpRequest, HttpResponse
from django.urls import Resolver404, URLPattern, URLResolver, include, path
from django.urls.resolvers import RegexPattern

from ee.edition import edition_capabilities, is_enterprise_enabled


def _json_response(payload: dict[str, object], *, status: int = 200) -> HttpResponse:
    response = HttpResponse(
        json.dumps(payload).encode("utf-8"),
        status=status,
        content_type="application/json",
    )
    response["Cache-Control"] = "no-store"
    return response


def status_view(request: HttpRequest) -> HttpResponse:
    """Return Enterprise Edition status and registered governance modules."""
    if request.method != "GET":
        resp = _json_response(
            {"detail": "Method not allowed", "code": "method_not_allowed"},
            status=405,
        )
        resp["Allow"] = "GET"
        return resp
    return _json_response(edition_capabilities(), status=200)


urlpatterns: list[URLPattern | URLResolver] = [
    path("api/v1/ee/status", status_view, name="ee-status"),
    path("api/v1/ee/sso/saml/", include("ee.saml.urls")),
    path("api/v1/ee/scim/v2/", include("ee.scim.urls")),
    path("api/v1/ee/compliance/", include("ee.audit_export.urls")),
]

_RESOLVER = URLResolver(RegexPattern(r"^/"), urlpatterns)


def dispatch(request: HttpRequest) -> HttpResponse:
    """Dispatch `/api/v1/ee/*` requests with defense-in-depth edition enforcement."""
    if not is_enterprise_enabled():
        return _json_response(
            {
                "detail": "Enterprise Edition required",
                "code": "enterprise_edition_required",
            },
            status=403,
        )

    try:
        match = _RESOLVER.resolve(request.path_info)
    except Resolver404:
        if request.path_info.startswith("/api/v1/ee/scim/v2"):
            scim_err = {
                "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"],
                "status": "404",
                "detail": "Requested SCIM resource endpoint does not exist",
            }
            response = HttpResponse(
                json.dumps(scim_err).encode("utf-8"),
                status=404,
                content_type="application/scim+json",
            )
            response["Cache-Control"] = "no-store"
            return response
        return _json_response(
            {"detail": "Enterprise endpoint not found", "code": "not_found"},
            status=404,
        )

    dispatched: HttpResponse = match.func(request, *match.args, **match.kwargs)
    if "Cache-Control" not in dispatched:
        dispatched["Cache-Control"] = "no-store"
    return dispatched
