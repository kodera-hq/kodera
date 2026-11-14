"""PostgreSQL persistence helpers, privacy-cutoff fencing & HKDF key derivation for Kodera EE.

Enterprise Edition (`ee_*`) tables are provisioned exclusively via Django migrations
(`apps/server/apps/orgs/migrations/0032_ee_enterprise_store.py`) and operated under the narrow
table/column grants enumerated in `apps/server/core/db/api_writer_role.py` (zero runtime DDL,
zero `BIGSERIAL` sequences, and append-only `ee_audit_ledger` / `ee_audit_signing_key`).

Falls back to process-local storage ONLY when no PostgreSQL database is configured or inside pure
database-less unit tests where `pytest-django` blocks database connections.

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import secrets
from typing import Any, Final
from uuid import UUID

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from django.conf import settings
from django.db import connection, transaction

_PROCESS_FALLBACK_SEED: Final[bytes] = secrets.token_bytes(32)
_HKDF_SALT: Final[bytes] = b"kodera-ee-hkdf-salt-v1"


class TenantCutoffError(PermissionError):
    """Raised when an organisation or person is absent, inactive, or fenced by privacy erasure."""

    def __init__(self, code: str, *, status: int = 403) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


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


def resolve_tenant_organisation(
    cur: Any,
    *,
    tenant_slug: str,
    organisation_id: UUID | None = None,
    require_open: bool = True,
) -> tuple[UUID, str] | None:
    """Resolve `(organisation_id, effective_tenant_slug)` without executing any DDL."""
    if organisation_id is not None:
        if require_open:
            cur.execute(
                """
                SELECT id
                FROM public.orgs_organisation
                WHERE id = %s AND state <> 'closed' AND deleted_at IS NULL
                LIMIT 1
                """,
                [organisation_id],
            )
        else:
            cur.execute(
                """
                SELECT id
                FROM public.orgs_organisation
                WHERE id = %s
                LIMIT 1
                """,
                [organisation_id],
            )
        row = cur.fetchone()
        if row is None:
            return None
        raw_id = row[0]
        resolved_id = raw_id if isinstance(raw_id, UUID) else UUID(str(raw_id))
        return resolved_id, tenant_slug

    if require_open:
        cur.execute(
            """
            SELECT id, slug
            FROM public.orgs_organisation
            WHERE slug = %s AND state <> 'closed' AND deleted_at IS NULL
            LIMIT 1
            """,
            [tenant_slug],
        )
    else:
        cur.execute(
            """
            SELECT id, slug
            FROM public.orgs_organisation
            WHERE slug = %s
            ORDER BY (deleted_at IS NULL) DESC, created_at DESC
            LIMIT 1
            """,
            [tenant_slug],
        )
    row = cur.fetchone()
    if row is None:
        return None
    raw_id = row[0]
    resolved_id = raw_id if isinstance(raw_id, UUID) else UUID(str(raw_id))
    return resolved_id, str(row[1])


def acquire_active_tenant_fence(
    cur: Any,
    *,
    tenant_slug: str,
    organisation_id: UUID | None = None,
    user_id: UUID | None = None,
) -> tuple[UUID, str]:
    """Acquire shared erasure-cutoff locks and lock live `User` (optional) + `Organisation` rows.

    Follows Core's global lock order (`identity_user` before `orgs_organisation`) and fails closed
    when the organisation does not exist (`404`) or when privacy cutoff / closure has started (`403`).
    """
    found = resolve_tenant_organisation(
        cur,
        tenant_slug=tenant_slug,
        organisation_id=organisation_id,
        require_open=False,
    )
    if found is None:
        raise TenantCutoffError("organisation_not_found", status=404)
    resolved_org_id, resolved_slug = found

    if user_id is not None:
        cur.execute(
            "SELECT pg_advisory_xact_lock_shared(hashtextextended('privacy_account_cutoff:' || %s, 0))",
            [str(user_id)],
        )
        cur.execute(
            """
            SELECT u.enabled, u.deleted_at, u.email
            FROM public.identity_user u
            WHERE u.id = %s
            FOR SHARE OF u
            """,
            [user_id],
        )
        u_row = cur.fetchone()
        if (
            u_row is None
            or not bool(u_row[0])
            or u_row[1] is not None
            or str(u_row[2]).startswith("erased:")
        ):
            raise TenantCutoffError("account_cutoff_fenced", status=403)

    cur.execute(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('privacy_erasure_cutoff:' || %s, 0))",
        [str(resolved_org_id)],
    )
    cur.execute(
        """
        SELECT o.id
        FROM public.orgs_organisation o
        WHERE o.id = %s
          AND o.state <> 'closed'
          AND o.deleted_at IS NULL
        FOR SHARE OF o
        """,
        [resolved_org_id],
    )
    locked_org = cur.fetchone()
    if locked_org is None:
        raise TenantCutoffError("tenant_cutoff_fenced", status=403)
    return resolved_org_id, resolved_slug


def resolve_org_member_user_id(
    cur: Any,
    *,
    organisation_id: UUID,
    email: str,
) -> UUID | None:
    """Resolve an existing Core `identity_user.id` for `(organisation_id, email)` with cutoff check."""
    normalized_email = email.strip().lower()
    if not normalized_email:
        return None
    cur.execute(
        """
        SELECT i.user_id
        FROM public.identity_identity i
        WHERE i.organisation_id = %s
          AND lower(i.email) = %s
          AND i.deleted_at IS NULL
        ORDER BY i.created_at ASC
        LIMIT 1
        """,
        [organisation_id, normalized_email],
    )
    row = cur.fetchone()
    if row is None or row[0] is None:
        return None
    person_id = row[0] if isinstance(row[0], UUID) else UUID(str(row[0]))
    cur.execute(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('privacy_account_cutoff:' || %s, 0))",
        [str(person_id)],
    )
    cur.execute(
        """
        SELECT u.deleted_at, u.email
        FROM public.identity_user u
        WHERE u.id = %s
        FOR SHARE OF u
        """,
        [person_id],
    )
    u_row = cur.fetchone()
    if u_row is None or u_row[0] is not None or str(u_row[1]).startswith("erased:"):
        raise TenantCutoffError("account_cutoff_fenced", status=403)
    return person_id


def reset_ee_tables(scope: str) -> None:
    """Test-only helper: truncate `ee_*` rows when connected as table owner."""
    if not can_use_postgres():
        return
    with connection.cursor() as cur:
        cur.execute(
            """
            SELECT pg_catalog.pg_get_userbyid(relowner) = current_user
            FROM pg_catalog.pg_class
            WHERE oid = to_regclass('public.ee_audit_ledger')
            """
        )
        owner_row = cur.fetchone()
        if owner_row is None or not bool(owner_row[0]):
            return

    with transaction.atomic(), connection.cursor() as cur:
        if scope == "saml":
            cur.execute(
                "TRUNCATE TABLE public.ee_saml_pending_request, "
                "public.ee_saml_replay_assertion, public.ee_saml_principal, public.ee_saml_idp"
            )
        elif scope == "scim_tokens":
            cur.execute("TRUNCATE TABLE public.ee_scim_token")
        elif scope == "scim":
            cur.execute(
                "TRUNCATE TABLE public.ee_scim_session, public.ee_scim_group_member, "
                "public.ee_scim_deprovision, public.ee_scim_group, public.ee_scim_user"
            )
        elif scope == "audit":
            cur.execute("TRUNCATE TABLE public.ee_audit_signing_key, public.ee_audit_ledger")
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
