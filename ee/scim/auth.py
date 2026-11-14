"""Constant-time SHA-256 per-tenant SCIM 2.0 bearer token authentication and revocation.

Security invariants:
- Raw SCIM bearer tokens (`scim_<token_id>.<secret>`) are returned ONCE at issuance; only the
  domain-separated SHA-256 digest of the secret is stored in memory/persistence.
- Token lookup + verification runs constant-time `hmac.compare_digest` over fixed-length 32-byte
  SHA-256 digests, enforces token expiry, instant revocation, required scopes, and strict tenant
  binding.

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from ee.edition import require_enterprise_edition

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
_SLUG_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")


class ScimAuthError(PermissionError):
    """Raised when SCIM bearer authentication, revocation, scope, or tenant check fails."""

    def __init__(self, message: str, *, status: int = 401, scim_type: str | None = None) -> None:
        super().__init__(message)
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
    """Manage per-tenant hashed SCIM bearer tokens with instant revocation."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tokens: dict[str, ScimTokenRecord] = {}

    def reset(self) -> None:
        with self._lock:
            self._tokens.clear()

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
        if not _SLUG_RE.fullmatch(tenant_slug):
            raise ValueError(f"Invalid tenant_slug: {tenant_slug!r}")
        resolved_scopes = frozenset(scopes) if scopes is not None else DEFAULT_SCIM_SCOPES
        if not resolved_scopes or not resolved_scopes <= ALL_SCIM_SCOPES:
            raise ValueError("Invalid or empty SCIM token scopes")

        token_id = secrets.token_hex(8)
        raw_secret = secrets.token_urlsafe(32)
        digest = _hash_secret(token_id, raw_secret)
        created = (now or datetime.now(UTC)).astimezone(UTC)

        record = ScimTokenRecord(
            token_id=token_id,
            tenant_slug=tenant_slug,
            secret_sha256=digest,
            scopes=resolved_scopes,
            created_at=created,
            expires_at=expires_at.astimezone(UTC) if expires_at is not None else None,
            organisation_id=organisation_id,
            description=description[:255],
        )
        with self._lock:
            self._tokens[token_id] = record
        plaintext = f"scim_{token_id}.{raw_secret}"
        return plaintext, record

    def revoke_token(self, token_id: str, *, now: datetime | None = None) -> bool:
        """Instantly revoke a SCIM bearer token by `token_id`."""
        require_enterprise_edition()
        revoked_time = (now or datetime.now(UTC)).astimezone(UTC)
        with self._lock:
            rec = self._tokens.get(token_id)
            if rec is None:
                return False
            if rec.revoked_at is None:
                rec.revoked_at = revoked_time
            return True

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
            raise ScimAuthError("Missing SCIM Bearer token", status=401)
        if len(authorization_header) > 512:
            raise ScimAuthError("Malformed Authorization header", status=401)

        parts = authorization_header.strip().split(" ")
        if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
            raise ScimAuthError("Authorization header must use Bearer scheme", status=401)

        raw_token = parts[1]
        if not raw_token.startswith("scim_") or "." not in raw_token:
            hmac.compare_digest(_DUMMY_DIGEST, _DUMMY_DIGEST)
            raise ScimAuthError("Invalid SCIM Bearer token", status=401)

        prefix_part, _, raw_secret = raw_token.partition(".")
        token_id = prefix_part.removeprefix("scim_")
        if not token_id or not raw_secret:
            hmac.compare_digest(_DUMMY_DIGEST, _DUMMY_DIGEST)
            raise ScimAuthError("Invalid SCIM Bearer token", status=401)

        candidate_digest = _hash_secret(token_id, raw_secret)
        with self._lock:
            record = self._tokens.get(token_id)

        if record is None:
            hmac.compare_digest(candidate_digest, _DUMMY_DIGEST)
            raise ScimAuthError("Invalid SCIM Bearer token", status=401)

        matched = hmac.compare_digest(candidate_digest, record.secret_sha256)
        if not matched:
            raise ScimAuthError("Invalid SCIM Bearer token", status=401)

        current_time = (now or datetime.now(UTC)).astimezone(UTC)
        if record.revoked_at is not None:
            raise ScimAuthError("SCIM Bearer token has been revoked", status=401)
        if record.expires_at is not None and current_time >= record.expires_at:
            raise ScimAuthError("SCIM Bearer token has expired", status=401)

        if expected_tenant_slug is not None and record.tenant_slug != expected_tenant_slug:
            raise ScimAuthError(
                "SCIM Bearer token is not authorized for the target tenant",
                status=403,
            )

        if not _scope_satisfies(record.scopes, required_scope):
            raise ScimAuthError(
                f"SCIM Bearer token lacks required scope '{required_scope}'",
                status=403,
            )

        return record
