"""Constant-time SHA-256 per-tenant SCIM 2.0 bearer token authentication and revocation.

Security invariants:
- Raw SCIM bearer tokens (`scim_<token_id>.<secret>`) are returned ONCE at issuance; only the
  domain-separated SHA-256 digest of the secret is persisted in PostgreSQL (`ee_scim_token`).
- Token lookup + verification runs constant-time `hmac.compare_digest` over fixed-length 32-byte
  SHA-256 digests, enforces token expiry, instant cross-worker revocation, organisation privacy
  cutoff refusal, required scopes, and strict tenant binding.

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from django.db import DatabaseError, IntegrityError, connection, transaction

from ee.edition import require_enterprise_edition
from ee.store import (
    TenantCutoffError,
    acquire_active_tenant_fence,
    can_use_postgres,
    is_retriable_lock_contention,
    reset_ee_tables,
)

ALL_SCIM_SCOPES = frozenset(
    {
        "scim:read",
        "scim:write",
        "scim:users:read",
        "scim:users:write",
        "scim:groups:read",
        "scim:groups:write",
    }
)
DEFAULT_SCIM_SCOPES = frozenset({"scim:read", "scim:write"})

_TOKEN_HASH_DOMAIN = b"kodera-scim-bearer-v1\x00"
_DUMMY_DIGEST = hashlib.sha256(_TOKEN_HASH_DOMAIN + b"dummy-constant-time-pad").digest()


def _is_valid_slug(value: str) -> bool:
    if not (1 <= len(value) <= 63):
        return False
    first, last = value[0], value[-1]
    if not (("a" <= first <= "z") or ("0" <= first <= "9")):
        return False
    if not (("a" <= last <= "z") or ("0" <= last <= "9")):
        return False
    return all(("a" <= ch <= "z") or ("0" <= ch <= "9") or ch == "-" for ch in value)


class ScimAuthError(PermissionError):
    """Raised when SCIM bearer authentication, revocation, scope, or tenant check fails."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "invalid_token",
        status: int = 401,
        scim_type: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.scim_type = scim_type


@dataclass(slots=True)
class ScimTokenRecord:
    token_id: str
    tenant_slug: str
    secret_sha256: bytes
    scopes: frozenset[str]
    created_at: datetime
    expires_at: datetime | None = None
    revoked_at: datetime | None = None
    organisation_id: UUID | None = None
    description: str = ""

    @property
    def is_revoked(self) -> bool:
        return self.revoked_at is not None


def _coerce_utc(value: object) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(UTC)
    return datetime.fromisoformat(str(value)).astimezone(UTC)


def _token_from_row(row: tuple[object, ...]) -> tuple[ScimTokenRecord, bool]:
    raw_sha = row[2]
    if isinstance(raw_sha, memoryview):
        sha_bytes = raw_sha.tobytes()
    elif isinstance(raw_sha, (bytes, bytearray)):
        sha_bytes = bytes(raw_sha)
    else:
        raise TypeError("Unexpected secret_sha256 column type")

    scopes_list = json.loads(str(row[3]))
    scopes_set = (
        frozenset(str(s) for s in scopes_list) if isinstance(scopes_list, list) else frozenset()
    )
    created_dt = _coerce_utc(row[4])
    if created_dt is None:
        raise ValueError("Missing created_at on SCIM token row")
    org_str = str(row[7]) if row[7] is not None else None
    org_cutoff = bool(row[9]) if len(row) > 9 else False
    return (
        ScimTokenRecord(
            token_id=str(row[0]),
            tenant_slug=str(row[1]),
            secret_sha256=sha_bytes,
            scopes=scopes_set,
            created_at=created_dt,
            expires_at=_coerce_utc(row[5]),
            revoked_at=_coerce_utc(row[6]),
            organisation_id=UUID(org_str) if org_str else None,
            description=str(row[8]),
        ),
        org_cutoff,
    )


def _hash_secret(token_id: str, raw_secret: str) -> bytes:
    return hashlib.sha256(
        _TOKEN_HASH_DOMAIN + token_id.encode("utf-8") + b"\x00" + raw_secret.encode("utf-8")
    ).digest()


def _scope_satisfies(granted: frozenset[str], required: str) -> bool:
    if required in granted:
        return True
    if required.endswith(":read") and "scim:read" in granted:
        return True
    if required.endswith(":write") and "scim:write" in granted:
        return True
    if required == "scim:read" and ("scim:write" in granted):
        return True
    return False


class ScimTokenManager:
    """Manage per-tenant hashed SCIM bearer tokens with PostgreSQL multi-worker persistence."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tokens: dict[str, ScimTokenRecord] = {}

    def reset(self) -> None:
        with self._lock:
            self._tokens.clear()
        reset_ee_tables("scim_tokens")

    def issue_token(
        self,
        *,
        tenant_slug: str,
        scopes: Iterable[str] | None = None,
        expires_at: datetime | None = None,
        organisation_id: UUID | None = None,
        description: str = "",
        now: datetime | None = None,
    ) -> tuple[str, ScimTokenRecord]:
        """Issue a new tenant-scoped SCIM bearer token and return `(plaintext_token, record)`."""
        require_enterprise_edition()
        if not _is_valid_slug(tenant_slug):
            raise ValueError("Invalid tenant_slug")
        resolved_scopes = frozenset(scopes) if scopes is not None else DEFAULT_SCIM_SCOPES
        if not resolved_scopes or not resolved_scopes <= ALL_SCIM_SCOPES:
            raise ValueError("Invalid or empty SCIM token scopes")

        token_id = secrets.token_hex(8)
        raw_secret = secrets.token_urlsafe(32)
        digest = _hash_secret(token_id, raw_secret)
        created = (now or datetime.now(UTC)).astimezone(UTC)
        exp_utc = expires_at.astimezone(UTC) if expires_at is not None else None
        desc_clean = description[:255]

        record = ScimTokenRecord(
            token_id=token_id,
            tenant_slug=tenant_slug,
            secret_sha256=digest,
            scopes=resolved_scopes,
            created_at=created,
            expires_at=exp_utc,
            organisation_id=organisation_id,
            description=desc_clean,
        )

        if can_use_postgres():
            scopes_json = json.dumps(sorted(resolved_scopes))
            try:
                with transaction.atomic(), connection.cursor() as cur:
                    resolved_org_id, _ = acquire_active_tenant_fence(
                        cur,
                        tenant_slug=tenant_slug,
                        organisation_id=organisation_id,
                    )
                    cur.execute(
                        "INSERT INTO public.ee_scim_token ("
                        "token_id, organisation_id, tenant_slug, secret_sha256, scopes_json, "
                        "description, created_at, expires_at, revoked_at"
                        ") VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                        [
                            token_id,
                            resolved_org_id,
                            tenant_slug,
                            digest,
                            scopes_json,
                            desc_clean,
                            created,
                            exp_utc,
                            None,
                        ],
                    )
                record.organisation_id = resolved_org_id
            except TenantCutoffError as exc:
                raise ScimAuthError(
                    "Target tenant is unavailable or under privacy erasure cutoff",
                    code=exc.code,
                    status=exc.status,
                ) from exc
            except IntegrityError as exc:
                if "cutoff refuses write" in str(exc):
                    raise ScimAuthError(
                        "Target tenant is under privacy erasure cutoff",
                        code="tenant_cutoff_fenced",
                        status=403,
                    ) from exc
                raise
            except DatabaseError as exc:
                if is_retriable_lock_contention(exc):
                    raise ScimAuthError(
                        "Organisation authority changed concurrently; retry request",
                        code="authority_fenced",
                        status=409,
                    ) from exc
                raise
        else:
            with self._lock:
                self._tokens[token_id] = record

        plaintext = f"scim_{token_id}.{raw_secret}"
        return plaintext, record

    def revoke_token(
        self,
        token_id: str,
        *,
        now: datetime | None = None,
        tenant_slug: str | None = None,
        organisation_id: UUID | None = None,
    ) -> bool:
        """Instantly revoke a SCIM bearer token by `token_id` across all workers."""
        require_enterprise_edition()
        revoked_time = (now or datetime.now(UTC)).astimezone(UTC)
        if can_use_postgres():
            try:
                with transaction.atomic(), connection.cursor() as cur:
                    if organisation_id is not None:
                        cur.execute(
                            "UPDATE public.ee_scim_token SET revoked_at = COALESCE(revoked_at, %s) "
                            "WHERE token_id = %s AND organisation_id = %s RETURNING token_id",
                            [revoked_time, token_id, organisation_id],
                        )
                    elif tenant_slug is not None:
                        cur.execute(
                            "UPDATE public.ee_scim_token SET revoked_at = COALESCE(revoked_at, %s) "
                            "WHERE token_id = %s AND tenant_slug = %s RETURNING token_id",
                            [revoked_time, token_id, tenant_slug],
                        )
                    else:
                        cur.execute(
                            "UPDATE public.ee_scim_token SET revoked_at = COALESCE(revoked_at, %s) "
                            "WHERE token_id = %s RETURNING token_id",
                            [revoked_time, token_id],
                        )
                    updated = cur.fetchone()
                return updated is not None
            except IntegrityError as exc:
                if "cutoff refuses write" in str(exc):
                    raise ScimAuthError(
                        "Target tenant is under privacy erasure cutoff",
                        code="tenant_cutoff_fenced",
                        status=403,
                    ) from exc
                raise
            except DatabaseError as exc:
                if is_retriable_lock_contention(exc):
                    raise ScimAuthError(
                        "Organisation authority changed concurrently; retry request",
                        code="authority_fenced",
                        status=409,
                    ) from exc
                raise

        with self._lock:
            rec = self._tokens.get(token_id)
            if rec is None:
                return False
            if organisation_id is not None and rec.organisation_id != organisation_id:
                return False
            if tenant_slug is not None and rec.tenant_slug != tenant_slug:
                return False
            if rec.revoked_at is None:
                rec.revoked_at = revoked_time
            return True

    def list_tokens(
        self,
        *,
        tenant_slug: str,
        organisation_id: UUID | None = None,
    ) -> list[ScimTokenRecord]:
        """List SCIM token metadata (never secrets) scoped strictly to the target tenant."""
        require_enterprise_edition()
        if can_use_postgres():
            with connection.cursor() as cur:
                if organisation_id is not None:
                    cur.execute(
                        """
                        SELECT
                            t.token_id,
                            t.tenant_slug,
                            t.secret_sha256,
                            t.scopes_json,
                            t.created_at,
                            t.expires_at,
                            t.revoked_at,
                            t.organisation_id,
                            t.description
                        FROM public.ee_scim_token t
                        WHERE t.organisation_id = %s
                        ORDER BY t.created_at DESC, t.token_id ASC
                        """,
                        [organisation_id],
                    )
                else:
                    cur.execute(
                        """
                        SELECT
                            t.token_id,
                            t.tenant_slug,
                            t.secret_sha256,
                            t.scopes_json,
                            t.created_at,
                            t.expires_at,
                            t.revoked_at,
                            t.organisation_id,
                            t.description
                        FROM public.ee_scim_token t
                        WHERE t.tenant_slug = %s
                        ORDER BY t.created_at DESC, t.token_id ASC
                        """,
                        [tenant_slug],
                    )
                rows = cur.fetchall()
            return [_token_from_row(r)[0] for r in rows]

        with self._lock:
            return [
                rec
                for rec in self._tokens.values()
                if (
                    rec.organisation_id == organisation_id
                    if organisation_id is not None
                    else rec.tenant_slug == tenant_slug
                )
            ]

    def _lookup_token(self, token_id: str) -> tuple[ScimTokenRecord | None, bool]:
        if can_use_postgres():
            with connection.cursor() as cur:
                cur.execute(
                    """
                    SELECT
                        t.token_id,
                        t.tenant_slug,
                        t.secret_sha256,
                        t.scopes_json,
                        t.created_at,
                        t.expires_at,
                        t.revoked_at,
                        t.organisation_id,
                        t.description,
                        (o.state = 'closed' OR o.deleted_at IS NOT NULL) AS org_cutoff
                    FROM public.ee_scim_token t
                    JOIN public.orgs_organisation o ON o.id = t.organisation_id
                    WHERE t.token_id = %s
                    """,
                    [token_id],
                )
                row = cur.fetchone()
            return _token_from_row(row) if row is not None else (None, False)

        with self._lock:
            return self._tokens.get(token_id), False

    def authenticate(
        self,
        authorization_header: str | None,
        *,
        required_scope: str,
        expected_tenant_slug: str | None = None,
        now: datetime | None = None,
    ) -> ScimTokenRecord:
        """Verify `Authorization: Bearer scim_<id>.<secret>` in constant time."""
        require_enterprise_edition()
        if not authorization_header or not isinstance(authorization_header, str):
            raise ScimAuthError("Missing SCIM Bearer token", code="missing_token", status=401)
        if len(authorization_header) > 512:
            raise ScimAuthError(
                "Malformed Authorization header", code="malformed_auth_header", status=401
            )

        parts = authorization_header.strip().split(" ")
        if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
            raise ScimAuthError(
                "Authorization header must use Bearer scheme",
                code="invalid_auth_scheme",
                status=401,
            )

        raw_token = parts[1]
        if not raw_token.startswith("scim_") or "." not in raw_token:
            hmac.compare_digest(_DUMMY_DIGEST, _DUMMY_DIGEST)
            raise ScimAuthError("Invalid SCIM Bearer token", code="invalid_token", status=401)

        prefix_part, _, raw_secret = raw_token.partition(".")
        token_id = prefix_part.removeprefix("scim_")
        if not token_id or not raw_secret:
            hmac.compare_digest(_DUMMY_DIGEST, _DUMMY_DIGEST)
            raise ScimAuthError("Invalid SCIM Bearer token", code="invalid_token", status=401)

        candidate_digest = _hash_secret(token_id, raw_secret)
        record, org_cutoff = self._lookup_token(token_id)

        if record is None:
            hmac.compare_digest(candidate_digest, _DUMMY_DIGEST)
            raise ScimAuthError("Invalid SCIM Bearer token", code="invalid_token", status=401)

        matched = hmac.compare_digest(candidate_digest, record.secret_sha256)
        if not matched:
            raise ScimAuthError("Invalid SCIM Bearer token", code="invalid_token", status=401)

        current_time = (now or datetime.now(UTC)).astimezone(UTC)
        if record.revoked_at is not None:
            raise ScimAuthError(
                "SCIM Bearer token has been revoked", code="token_revoked", status=401
            )
        if record.expires_at is not None and current_time >= record.expires_at:
            raise ScimAuthError("SCIM Bearer token has expired", code="token_expired", status=401)

        if org_cutoff:
            raise ScimAuthError(
                "Target tenant is closed or under privacy erasure cutoff",
                code="tenant_cutoff_fenced",
                status=403,
            )

        if expected_tenant_slug is not None and record.tenant_slug != expected_tenant_slug:
            raise ScimAuthError(
                "SCIM Bearer token is not authorized for the target tenant",
                code="tenant_forbidden",
                status=403,
            )

        if not _scope_satisfies(record.scopes, required_scope):
            raise ScimAuthError(
                "SCIM Bearer token lacks required scope",
                code="insufficient_scope",
                status=403,
            )

        return record
