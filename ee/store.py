"""PostgreSQL persistence & deterministic HKDF key derivation for Kodera Enterprise Edition.

Provides idempotent `ee_*` PostgreSQL table bootstrap via `django.db.connection` (keeping zero
migrations inside open-source `apps/server/apps/*/migrations/` per `GOVERNANCE.md`) so multiple
Gunicorn workers (`preload_app=False`) and process restarts share SAML IdP configurations,
single-use `RelayState` nonces, SAML assertion replay protection, SCIM bearer token hashes and
revocations, SCIM directory state, and compliance audit hash chains + tenant signing keys.

Falls back to process-local storage ONLY when no PostgreSQL database is configured or inside pure
database-less unit tests where `pytest-django` blocks database connections.

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import secrets
from typing import Final

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from django.conf import settings
from django.db import connection, transaction

from ee.edition import is_enterprise_enabled

_PROCESS_FALLBACK_SEED: Final[bytes] = secrets.token_bytes(32)
_HKDF_SALT: Final[bytes] = b"kodera-ee-hkdf-salt-v1"

_EE_DDL_STATEMENTS: Final[tuple[str, ...]] = (
    """
    CREATE TABLE IF NOT EXISTS ee_saml_idps (
        tenant_slug TEXT NOT NULL,
        idp_id TEXT NOT NULL,
        idp_entity_id TEXT NOT NULL,
        idp_sso_url TEXT NOT NULL,
        public_key_pem TEXT NOT NULL,
        verified_domains_json TEXT NOT NULL,
        group_role_mapping_json TEXT NOT NULL,
        default_role TEXT NOT NULL,
        want_assertions_signed BOOLEAN NOT NULL,
        clock_skew_seconds INTEGER NOT NULL,
        organisation_id TEXT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_slug, idp_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS ee_saml_pending_requests (
        relay_state TEXT PRIMARY KEY,
        tenant_slug TEXT NOT NULL,
        idp_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        return_path TEXT NOT NULL,
        sp_base_url TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS ee_saml_replay_assertions (
        tenant_slug TEXT NOT NULL,
        idp_entity_id TEXT NOT NULL,
        assertion_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_slug, idp_entity_id, assertion_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS ee_saml_principals (
        tenant_slug TEXT NOT NULL,
        email_lower TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_slug, email_lower)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS ee_scim_tokens (
        token_id TEXT PRIMARY KEY,
        tenant_slug TEXT NOT NULL,
        secret_sha256 BYTEA NOT NULL,
        scopes_json TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NULL,
        revoked_at TIMESTAMPTZ NULL,
        organisation_id TEXT NULL,
        description TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS ee_scim_users (
        tenant_slug TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name_lower TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_slug, user_id),
        UNIQUE (tenant_slug, user_name_lower)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS ee_scim_groups (
        tenant_slug TEXT NOT NULL,
        group_id TEXT NOT NULL,
        display_name_lower TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_slug, group_id),
        UNIQUE (tenant_slug, display_name_lower)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS ee_scim_sessions (
        tenant_slug TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        PRIMARY KEY (tenant_slug, user_id, session_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS ee_scim_deprovision_events (
        event_id TEXT PRIMARY KEY,
        tenant_slug TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        reason TEXT NOT NULL,
        revoked_sessions_json TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS ee_audit_events (
        tenant_slug TEXT NOT NULL,
        sequence BIGINT NOT NULL,
        event_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_label TEXT NOT NULL,
        action TEXT NOT NULL,
        target_urn TEXT NOT NULL,
        source_ip TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        entry_hash TEXT NOT NULL,
        PRIMARY KEY (tenant_slug, sequence),
        UNIQUE (tenant_slug, event_id)
    )
    """,
)


def is_postgres_configured() -> bool:
    """Return True when Django `DATABASES['default']` uses a PostgreSQL backend."""
    if not settings.configured:
        return False
    databases = getattr(settings, "DATABASES", None)
    if not isinstance(databases, dict):
        return False
    default_db = databases.get("default")
    if not isinstance(default_db, dict):
        return False
    engine = str(default_db.get("ENGINE", ""))
    return ("postgresql" in engine) or ("postgis" in engine)


def can_use_postgres() -> bool:
    """Return True when PostgreSQL is configured and database access is active.

    Real PostgreSQL/driver errors propagate (fail-closed); only unconfigured settings or
    `pytest-django`'s unit-test DB blocker (`Database access not allowed`) returns False.
    """
    if not is_postgres_configured():
        return False
    try:
        connection.ensure_connection()
    except RuntimeError as exc:
        if "Database access not allowed" in str(exc):
            return False
        raise
    return bool(connection.vendor == "postgresql")


def ensure_ee_tables() -> None:
    """Idempotently create Enterprise `ee_*` tables in PostgreSQL under an advisory lock."""
    if not is_enterprise_enabled() or not can_use_postgres():
        return
    with connection.cursor() as cur:
        cur.execute("SELECT to_regclass('public.ee_audit_events')")
        existing = cur.fetchone()
        if existing is not None and existing[0] is not None:
            return

    with transaction.atomic(), connection.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(hashtext('kodera_ee_schema_bootstrap_v1'))")
        for statement in _EE_DDL_STATEMENTS:
            cur.execute(statement)


def reset_ee_tables(scope: str) -> None:
    """Delete persisted rows for a service scope (`saml`, `scim_tokens`, `scim`, `audit`)."""
    if not can_use_postgres():
        return
    with connection.cursor() as cur:
        cur.execute("SELECT to_regclass('public.ee_audit_events')")
        existing = cur.fetchone()
        if existing is None or existing[0] is None:
            return

    with transaction.atomic(), connection.cursor() as cur:
        if scope == "saml":
            cur.execute("DELETE FROM ee_saml_pending_requests")
            cur.execute("DELETE FROM ee_saml_replay_assertions")
            cur.execute("DELETE FROM ee_saml_principals")
            cur.execute("DELETE FROM ee_saml_idps")
        elif scope == "scim_tokens":
            cur.execute("DELETE FROM ee_scim_tokens")
        elif scope == "scim":
            cur.execute("DELETE FROM ee_scim_sessions")
            cur.execute("DELETE FROM ee_scim_deprovision_events")
            cur.execute("DELETE FROM ee_scim_groups")
            cur.execute("DELETE FROM ee_scim_users")
        elif scope == "audit":
            cur.execute("DELETE FROM ee_audit_events")
        else:
            raise ValueError(f"Unsupported ee table reset scope: {scope}")


def _resolve_master_seed_bytes(explicit_seed: bytes | str | None = None) -> bytes:
    if explicit_seed is not None:
        raw_bytes = (
            explicit_seed.encode("utf-8") if isinstance(explicit_seed, str) else explicit_seed
        )
        if len(raw_bytes) < 16:
            raise ValueError("Explicit key derivation seed must be at least 16 bytes")
        return raw_bytes

    if settings.configured:
        ee_seed = getattr(settings, "KODERA_EE_AUDIT_SIGNING_SEED", None)
        if isinstance(ee_seed, bytes) and ee_seed:
            return ee_seed
        if isinstance(ee_seed, str) and ee_seed.strip():
            return ee_seed.strip().encode("utf-8")

        django_secret = getattr(settings, "SECRET_KEY", None)
        if isinstance(django_secret, str) and django_secret.strip():
            return django_secret.encode("utf-8")

    return _PROCESS_FALLBACK_SEED


def derive_ee_hkdf_bytes(
    *,
    domain_info: bytes,
    seed_material: bytes | str | None = None,
) -> bytes:
    """Derive 32 deterministic bytes via HKDF-SHA256 from `KODERA_EE_AUDIT_SIGNING_SEED`/`SECRET_KEY`."""
    ikm = _resolve_master_seed_bytes(seed_material)
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_HKDF_SALT,
        info=domain_info,
    )
    return hkdf.derive(ikm)
