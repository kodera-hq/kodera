"""Clean-room Enterprise Edition HTTP boundary (`KODERA_EDITION`, GOVERNANCE.md §1).

Community Edition (`KODERA_EDITION=community`, the default) passes every core route untouched,
imports nothing from `ee/`, and refuses `/api/v1/ee/*` with a fixed `403` JSON payload.
Enterprise Edition (`KODERA_EDITION=enterprise`) dynamically delegates `/api/v1/ee/*` to
`ee.router.dispatch` when `ee/` is installed.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Protocol, cast

from django.conf import settings
from django.http import HttpRequest, HttpResponse

COMMUNITY_EDITION = "community"
ENTERPRISE_EDITION = "enterprise"
EE_PATH_PREFIX = "/api/v1/ee"

_EDITION_REQUIRED_BODY = json.dumps(
    {
        "detail": "Enterprise Edition required",
        "code": "enterprise_edition_required",
    }
).encode("utf-8")

_MODULE_UNAVAILABLE_BODY = json.dumps(
    {
        "detail": "Enterprise Edition module unavailable",
        "code": "enterprise_module_unavailable",
    }
).encode("utf-8")


class _EnterpriseRouter(Protocol):
    def dispatch(self, request: HttpRequest) -> HttpResponse: ...


def _is_ee_path(path: str) -> bool:
    return path == EE_PATH_PREFIX or path.startswith(EE_PATH_PREFIX + "/")


def active_edition() -> str:
    """Return `enterprise` only when explicitly configured via settings override or environment."""
    wrapped = getattr(settings, "_wrapped", None)
    if (
        wrapped is not None
        and type(wrapped).__name__ == "UserSettingsHolder"
        and "KODERA_EDITION" in wrapped.__dict__
    ):
        override_val = wrapped.__dict__["KODERA_EDITION"]
        return ENTERPRISE_EDITION if override_val == ENTERPRISE_EDITION else COMMUNITY_EDITION

    env_raw = os.environ.get("KODERA_EDITION")
    if env_raw is not None:
        cleaned = env_raw.strip()
        if cleaned == "":
            return COMMUNITY_EDITION
        return ENTERPRISE_EDITION if cleaned == ENTERPRISE_EDITION else COMMUNITY_EDITION

    configured = getattr(settings, "KODERA_EDITION", COMMUNITY_EDITION)
    return ENTERPRISE_EDITION if configured == ENTERPRISE_EDITION else COMMUNITY_EDITION


def _ensure_ee_importable() -> None:
    if "ee" in sys.modules:
        return
    resolved = Path(__file__).resolve()
    for ancestor in resolved.parents:
        if (ancestor / "ee" / "__init__.py").is_file():
            root_str = str(ancestor)
            if root_str not in sys.path:
                sys.path.insert(0, root_str)
            return


def _load_ee_router() -> _EnterpriseRouter | None:
    _ensure_ee_importable()
    try:
        module = importlib.import_module("ee.router")
    except ModuleNotFoundError as exc:
        if exc.name == "ee" or (exc.name is not None and exc.name.startswith("ee.")):
            return None
        raise
    return cast(_EnterpriseRouter, module)


class EnterpriseEditionMiddleware:
    """Gate `/api/v1/ee/*` on `KODERA_EDITION=enterprise` while leaving core routes untouched."""

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        if not _is_ee_path(request.path):
            return self.get_response(request)

        if active_edition() != ENTERPRISE_EDITION:
            response = HttpResponse(
                _EDITION_REQUIRED_BODY,
                status=403,
                content_type="application/json",
            )
            response["Cache-Control"] = "no-store"
            return response

        router = _load_ee_router()
        if router is None:
            response = HttpResponse(
                _MODULE_UNAVAILABLE_BODY,
                status=503,
                content_type="application/json",
            )
            response["Cache-Control"] = "no-store"
            return response

        response = router.dispatch(request)
        if "Cache-Control" not in response:
            response["Cache-Control"] = "no-store"
        return response
