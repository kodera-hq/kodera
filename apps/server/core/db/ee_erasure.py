"""PostgreSQL session GUC hook for Enterprise Edition audit erasure seals.

Lives in `core.db` (outside `core.api`) so both the HTTP API image and the isolated
provisioning worker image (`Dockerfile.worker`, WK-09) can load `config.settings.base`
without importing any HTTP/API surface or anything under `ee/`.
"""

from __future__ import annotations

from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from django.conf import settings
from django.core.signals import setting_changed
from django.db import connections
from django.db.backends.signals import connection_created

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
