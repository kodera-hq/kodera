"""Mobile Universal Links and Android App Links association documents (`/.well-known/*`)."""

from __future__ import annotations

import json
import re
from collections.abc import Sequence

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny

from core.db.ids import new_uuid7

ANDROID_PACKAGE_NAME = "io.kodera.app"
IOS_APP_ID_RE = re.compile(r"[A-Z0-9]{10}\.io\.kodera\.app(?:\.[A-Za-z0-9-]+)*\Z")
ANDROID_SHA256_RE = re.compile(r"(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}\Z")
MAX_ENTRIES = 16

UNIVERSAL_LINK_COMPONENTS = (
    {"/": "/auth/*"},
    {"/": "/invite/*"},
    {"/": "/invitations/*"},
    {"/": "/workspace/*"},
    {"/": "/spaces/*"},
)


def _unconfigured_response(request: HttpRequest, detail: str) -> HttpResponse:
    request_id = request.META.get("HTTP_X_REQUEST_ID") or str(new_uuid7())
    response = HttpResponse(
        json.dumps(
            {
                "type": "about:blank",
                "title": "Service unavailable",
                "detail": detail,
                "code": "well_known_unconfigured",
                "status": 503,
                "request_id": request_id,
            }
        ),
        status=503,
        content_type="application/json",
    )
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response


def _json_document(request: HttpRequest, payload: object) -> HttpResponse:
    request_id = request.META.get("HTTP_X_REQUEST_ID") or str(new_uuid7())
    response = HttpResponse(
        json.dumps(payload),
        status=200,
        content_type="application/json",
    )
    response["Cache-Control"] = "public, max-age=300"
    response["X-Content-Type-Options"] = "nosniff"
    response["X-Request-Id"] = request_id
    return response


def _resolve_ios_app_ids(configured: object) -> tuple[str, ...]:
    items: list[str]
    if configured is None:
        return ()
    if isinstance(configured, str):
        stripped = configured.strip()
        if not stripped:
            return ()
        items = [part.strip() for part in stripped.split(",")]
    elif isinstance(configured, Sequence):
        items = [item.strip() if isinstance(item, str) else "" for item in configured]
    else:
        return ()
    if (
        not items
        or len(items) > MAX_ENTRIES
        or any(not item or IOS_APP_ID_RE.fullmatch(item) is None for item in items)
    ):
        return ()
    return tuple(dict.fromkeys(items))


def _resolve_android_fingerprints(configured: object) -> tuple[str, ...]:
    items: list[str]
    if configured is None:
        return ()
    if isinstance(configured, str):
        stripped = configured.strip()
        if not stripped:
            return ()
        items = [part.strip() for part in stripped.split(",")]
    elif isinstance(configured, Sequence):
        items = [item.strip() if isinstance(item, str) else "" for item in configured]
    else:
        return ()
    if (
        not items
        or len(items) > MAX_ENTRIES
        or any(not item or ANDROID_SHA256_RE.fullmatch(item) is None for item in items)
    ):
        return ()
    return tuple(dict.fromkeys(item.upper() for item in items))


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def apple_app_site_association(request: HttpRequest) -> HttpResponse:
    app_ids = _resolve_ios_app_ids(getattr(settings, "KODERA_IOS_APP_IDS", ()))
    if not app_ids:
        return _unconfigured_response(
            request, "Apple Universal Links app identifiers are not configured"
        )
    payload = {
        "applinks": {
            "details": [
                {
                    "appIDs": list(app_ids),
                    "components": list(UNIVERSAL_LINK_COMPONENTS),
                }
            ]
        },
        "webcredentials": {
            "apps": list(app_ids),
        },
    }
    return _json_document(request, payload)


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def assetlinks(request: HttpRequest) -> HttpResponse:
    fingerprints = _resolve_android_fingerprints(
        getattr(settings, "KODERA_ANDROID_ASSETLINKS_SHA256", ())
    )
    if not fingerprints:
        return _unconfigured_response(
            request, "Android App Links certificate fingerprints are not configured"
        )
    payload = [
        {
            "relation": ["delegate_permission/common.handle_all_urls"],
            "target": {
                "namespace": "android_app",
                "package_name": ANDROID_PACKAGE_NAME,
                "sha256_cert_fingerprints": list(fingerprints),
            },
        }
    ]
    return _json_document(request, payload)
