"""Middleware enforcing `/staff/v1/*` JSON-only 404s, C2/C3 workspace wall, and listed CORS."""

from __future__ import annotations

from collections.abc import Callable

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.utils.cache import patch_vary_headers

from services.identity.discovery_input import allowed_origins

from .errors import staff_problem_response

STAFF_PREFIX = "/staff/"
STAFF_V1_PREFIX = "/staff/v1/"
ADMITTED_STAFF_PLANES = ("/staff/v1/read/", "/staff/v1/triage/", "/staff/v1/ops/")

FORBIDDEN_WORKSPACE_SEGMENTS = frozenset(
    {
        "workspaces",
        "workspace",
        "channels",
        "channel",
        "messages",
        "message",
        "rooms",
        "documents",
        "document",
        "yjs",
        "recordings",
        "attachments",
        "media",
        "secrets",
        "keys",
        "e2ee",
        "ciphertext",
        "blobs",
    }
)

STAFF_CORS_METHODS = ("GET", "POST", "OPTIONS")
STAFF_CORS_HEADERS = ("Authorization", "Content-Type", "X-Request-Id")
STAFF_CORS_EXPOSED_HEADERS = ("X-Request-Id", "WWW-Authenticate")
STAFF_PREFLIGHT_MAX_AGE_S = 600


def _staff_admin_origins() -> frozenset[str]:
    listed = allowed_origins(
        getattr(settings, "KODERA_STAFF_ADMIN_ORIGINS", None),
        loopback_http=getattr(settings, "KODERA_LOOPBACK_ISSUERS", False) is True,
    )
    return frozenset() if listed is None else listed


def _listed_staff_origin(request: HttpRequest) -> str | None:
    origin = request.META.get("HTTP_ORIGIN")
    if isinstance(origin, str) and origin in _staff_admin_origins():
        return origin
    return None


def _attach_cors(response: HttpResponse, origin: str | None) -> HttpResponse:
    patch_vary_headers(response, ("Origin",))
    if origin is not None:
        response["Access-Control-Allow-Origin"] = origin
        response["Access-Control-Expose-Headers"] = ", ".join(STAFF_CORS_EXPOSED_HEADERS)
    return response


class StaffPlaneMiddleware:
    """Guarantee JSON-only responses, C2/C3 route wall, and strict CORS on `/staff/*`."""

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        if not request.path.startswith(STAFF_PREFIX):
            return self.get_response(request)

        origin = _listed_staff_origin(request)
        is_preflight = (
            request.method == "OPTIONS"
            and "HTTP_ORIGIN" in request.META
            and "HTTP_ACCESS_CONTROL_REQUEST_METHOD" in request.META
        )
        if is_preflight:
            requested_method = request.META.get("HTTP_ACCESS_CONTROL_REQUEST_METHOD", "")
            if origin is None or requested_method not in ("GET", "POST"):
                refused = staff_problem_response(
                    request,
                    status=403,
                    code="cors_origin_forbidden",
                    title="Origin refused",
                    detail="Cross-origin preflight refused on /staff/v1/*",
                )
                patch_vary_headers(
                    refused,
                    ("Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"),
                )
                return refused
            preflight_ok = HttpResponse(status=204)
            preflight_ok["Access-Control-Allow-Origin"] = origin
            preflight_ok["Access-Control-Allow-Methods"] = ", ".join(STAFF_CORS_METHODS)
            preflight_ok["Access-Control-Allow-Headers"] = ", ".join(STAFF_CORS_HEADERS)
            preflight_ok["Access-Control-Max-Age"] = str(STAFF_PREFLIGHT_MAX_AGE_S)
            patch_vary_headers(
                preflight_ok,
                ("Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"),
            )
            return preflight_ok

        segments = [seg.lower() for seg in request.path.split("/") if seg]
        if any(seg in FORBIDDEN_WORKSPACE_SEGMENTS for seg in segments):
            wall_resp = staff_problem_response(
                request,
                status=404,
                code="c2_c3_surface_absent",
                title="Not found",
                detail="C2/C3 customer content and secret routes do not exist on /staff/v1/*",
            )
            return _attach_cors(wall_resp, origin)

        if not request.path.startswith(STAFF_V1_PREFIX) or not any(
            request.path.startswith(prefix) for prefix in ADMITTED_STAFF_PLANES
        ):
            unlisted = staff_problem_response(
                request,
                status=404,
                code="not_found",
                title="Not found",
                detail="Unlisted /staff/v1/* route",
            )
            return _attach_cors(unlisted, origin)

        response = self.get_response(request)
        if response.status_code == 404 and getattr(request, "resolver_match", None) is None:
            response = staff_problem_response(
                request,
                status=404,
                code="not_found",
                title="Not found",
                detail="Unlisted /staff/v1/* route",
            )
        elif response.status_code >= 400 and "application/json" not in response.get(
            "Content-Type", ""
        ):
            response = staff_problem_response(
                request,
                status=response.status_code,
                code=f"http_{response.status_code}",
                title="Staff API error",
                detail=f"Staff API returned HTTP {response.status_code}",
            )
        return _attach_cors(response, origin)
