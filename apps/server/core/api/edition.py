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
from typing import Any, Protocol, cast

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from django.conf import settings
from django.core.signals import setting_changed
from django.db import connections
from django.db.backends.signals import connection_created
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


_EE_HKDF_SALT = b"kodera-ee-hkdf-salt-v1"
_EE_AUDIT_ERASURE_ROOT_INFO = b"kodera-ee-audit-erasure-root-v1"
_ERASURE_KEY_SIGNALS_INSTALLED = False


def derive_server_ee_audit_erasure_key_hex() -> str | None:
    """Derive 64-hex HKDF key for PostgreSQL EE audit erasure seals without importing `ee/`."""
    if not settings.configured:
        return None
    seed_bytes: bytes | None = None
    ee_seed = getattr(settings, "KODERA_EE_AUDIT_SIGNING_SEED", None)
    if isinstance(ee_seed, bytes) and ee_seed:
        seed_bytes = ee_seed
    elif isinstance(ee_seed, str) and ee_seed.strip():
        seed_bytes = ee_seed.strip().encode("utf-8")
    else:
        django_secret = getattr(settings, "SECRET_KEY", None)
        if isinstance(django_secret, str) and django_secret.strip():
            seed_bytes = django_secret.encode("utf-8")
    if seed_bytes is None or len(seed_bytes) < 16:
        return None
    key = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_EE_HKDF_SALT,
        info=_EE_AUDIT_ERASURE_ROOT_INFO,
    ).derive(seed_bytes)
    return key.hex()


def _apply_erasure_key_to_db_wrapper(db_wrapper: Any) -> None:
    if getattr(db_wrapper, "vendor", None) != "postgresql":
        return
    if getattr(db_wrapper, "closed_in_transaction", False):
        return
    raw_conn = getattr(db_wrapper, "connection", None)
    if raw_conn is None or getattr(raw_conn, "closed", True):
        return
    key_hex = derive_server_ee_audit_erasure_key_hex()
    if not key_hex:
        return
    try:
        raw_conn.execute(
            "SELECT set_config('kodera.ee_audit_erasure_key_hex', %s, false)",
            [key_hex],
        )
    except Exception:
        return


def _on_postgres_connection_created(
    sender: object,
    connection: Any,
    **kwargs: object,
) -> None:
    _apply_erasure_key_to_db_wrapper(connection)


def _on_erasure_seed_setting_changed(
    sender: object,
    setting: str,
    **kwargs: object,
) -> None:
    if setting not in {"KODERA_EE_AUDIT_SIGNING_SEED", "SECRET_KEY"}:
        return
    for db_wrapper in connections.all(initialized_only=True):
        _apply_erasure_key_to_db_wrapper(db_wrapper)


def install_ee_erasure_key_sync() -> None:
    """Register session GUC sync so PostgreSQL erasure hooks use the server HKDF secret."""
    global _ERASURE_KEY_SIGNALS_INSTALLED
    if _ERASURE_KEY_SIGNALS_INSTALLED:
        return
    connection_created.connect(
        _on_postgres_connection_created,
        dispatch_uid="kodera_ee_audit_erasure_key_on_connect",
    )
    setting_changed.connect(
        _on_erasure_seed_setting_changed,
        dispatch_uid="kodera_ee_audit_erasure_key_on_setting_change",
    )
    _ERASURE_KEY_SIGNALS_INSTALLED = True
