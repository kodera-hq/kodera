"""Kodera Passport cross-workspace magic-link sign-in and workspace context service.

Implements Track 2 (`Kodera Passport`):
- Enumerator-safe, rate-limited magic-link issuance (`10 min` TTL, 32-byte CSPRNG, SHA-256 at rest,
  PKCE S256 + optional device challenge binding, and recipient-bound sealed outbox delivery).
- Atomic single-use token verification (`SELECT ... FOR UPDATE` burn; replay returns `401`).
- Cross-organisation workspace listing and audited active-workspace switching across realms
  (one realm per organisation) under in-transaction current-authority + privacy cutoff fences.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db import DatabaseError, connection, transaction
from django.utils import timezone

from apps.audit.services import record_authz_denied, record_passport_login_succeeded
from apps.orgs.selectors import (
    PassportMembershipRow,
    organisation_slug_or_none,
    passport_memberships,
)
from apps.tenancy.selectors import organisation_tenant_urls
from apps.workspaces.selectors import passport_unrestricted_workspaces
from core.db.ids import new_uuid7
from core.passport import (
    MAGIC_LINK_TTL_SECONDS,
    PASSPORT_SESSION_TTL_SECONDS,
    PassportDeliveryUnavailableError as PassportDeliveryUnavailableError,
    PassportInputError,
    PassportSessionClaims,
    PassportSessionError,
    enqueue_passport_magic_link,
    generate_magic_link_token,
    hash_magic_link_token,
    issue_passport_session_token,
    normalize_passport_email,
    rate_limit_digest,
    resolve_passport_outbox_config,
    validate_device_challenge,
    validate_pkce_challenge,
    verify_device_verifier,
    verify_pkce_verifier,
)
from services.identity.access_tokens import TokenVerificationError, VerifiedAccessToken

from .models import (
    STAFF_REALM,
    Identity,
    PassportMagicLinkToken,
    PassportOutboxBinding,
    PassportRateLimitEvent,
    PassportWorkspaceContext,
    User,
)
from .selectors import PersonSnapshot, current_identity, is_storable_subject
from .services import UnknownCustomerError

RATE_WINDOW_SECONDS = 600
DEFAULT_IP_LIMIT = 20
DEFAULT_EMAIL_LIMIT = 5
MAX_RATE_EVENTS = 20_000
MAX_BODY_BYTES = 4096
LOCK_CONFLICT_SQLSTATES = frozenset({"55P03", "40P01", "40001"})
PRIVACY_REFUSAL_SQLSTATE = "23514"
ELIGIBLE_MEMBERSHIP_ROLES = frozenset({"org_owner", "org_admin", "org_billing", "org_member"})


class PassportMalformedError(Exception):
    """Malformed HTTP framing, media type, JSON syntax, or body size."""

    def __init__(self, status: int, kind: str, reason: str, **extra: object) -> None:
        super().__init__(reason)
        self.status = status
        self.kind = kind
        self.reason = reason
        self.extra = extra


class PassportRateLimitedError(Exception):
    """Rolling magic-link request rate limit exceeded."""

    def __init__(
        self, *, scope: str, limit: int, remaining: int, reset_s: int, retry_after_s: int
    ) -> None:
        super().__init__(f"passport rate limit exceeded ({scope})")
        self.scope = scope
        self.limit = limit
        self.remaining = remaining
        self.reset_s = reset_s
        self.retry_after_s = retry_after_s


class PassportUnauthorizedError(Exception):
    """Invalid, expired, replayed, or unbound magic-link token (`401 unauthenticated`)."""


class PassportForbiddenError(Exception):
    """Authenticated person is not an active member of the target organisation (`403 forbidden`)."""


class PassportConflictError(Exception):
    """Concurrent authority or privacy cutoff lock contention (`409 conflict`)."""


def _sqlstate_of(exc: BaseException) -> str | None:
    current: BaseException | None = exc
    while current is not None:
        code = getattr(current, "sqlstate", None) or getattr(current, "pgcode", None)
        if isinstance(code, str) and code:
            return code
        current = current.__cause__ or current.__context__
    return None


def _is_lock_conflict(exc: BaseException) -> bool:
    return _sqlstate_of(exc) in LOCK_CONFLICT_SQLSTATES


@dataclass(frozen=True, slots=True)
class PassportRateQuota:
    limit: int
    remaining: int
    reset_s: int


@dataclass(frozen=True, slots=True)
class PassportMagicLinkDelivery:
    """Internal-only magic-link dispatch payload; never serialized to HTTP or logs."""

    email_normalized: str
    raw_token: str
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class PassportMagicLinkAccepted:
    expires_in_seconds: int
    quota: PassportRateQuota


@dataclass(frozen=True, slots=True)
class PassportWorkspaceEntry:
    organisation_id: UUID
    organisation_slug: str
    organisation_name: str
    realm: str
    issuer: str
    membership_id: UUID
    role: str
    workspace_id: UUID | None
    default_urls: dict[str, str]
    active: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "organisation_id": str(self.organisation_id),
            "organisation_slug": self.organisation_slug,
            "organisation_name": self.organisation_name,
            "realm": self.realm,
            "issuer": self.issuer,
            "membership_id": str(self.membership_id),
            "role": self.role,
            "workspace_id": None if self.workspace_id is None else str(self.workspace_id),
            "default_urls": dict(self.default_urls),
            "active": self.active,
        }


@dataclass(frozen=True, slots=True)
class PassportWorkspaceDirectory:
    person: PersonSnapshot
    active_organisation_id: UUID | None
    active_workspace_id: UUID | None
    workspaces: tuple[PassportWorkspaceEntry, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "user": {
                "id": str(self.person.id),
                "email": self.person.email,
                "display_name": self.person.display_name,
            },
            "active_organisation_id": (
                None if self.active_organisation_id is None else str(self.active_organisation_id)
            ),
            "active_workspace_id": (
                None if self.active_workspace_id is None else str(self.active_workspace_id)
            ),
            "workspaces": [entry.to_dict() for entry in self.workspaces],
        }


@dataclass(frozen=True, slots=True)
class PassportVerifiedSession:
    directory: PassportWorkspaceDirectory
    session_token: str
    expires_in_seconds: int

    def to_dict(self) -> dict[str, Any]:
        payload = self.directory.to_dict()
        payload["session_token"] = self.session_token
        payload["expires_in_seconds"] = self.expires_in_seconds
        return payload


@dataclass(frozen=True, slots=True)
class PassportSwitchedWorkspace:
    active_organisation_id: UUID
    active_workspace_id: UUID | None
    workspace: PassportWorkspaceEntry
    session_token: str
    expires_in_seconds: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "active_organisation_id": str(self.active_organisation_id),
            "active_workspace_id": (
                None if self.active_workspace_id is None else str(self.active_workspace_id)
            ),
            "workspace": self.workspace.to_dict(),
            "session_token": self.session_token,
            "expires_in_seconds": self.expires_in_seconds,
        }


@dataclass(frozen=True, slots=True)
class _PassportFenceResult:
    person: PersonSnapshot
    origin_organisation_id: UUID | None
    caller_identity_id: UUID | None
    memberships: tuple[PassportMembershipRow, ...]
    identities_by_org: dict[UUID, tuple[UUID, str]]
    user_ids_by_org: dict[UUID, UUID]
    fenced_user_ids: tuple[UUID, ...]


def passport_secret() -> str:
    configured = getattr(settings, "KODERA_PASSPORT_HMAC_KEY", None)
    if isinstance(configured, str) and len(configured.strip()) >= 16:
        return configured.strip()
    fallback = getattr(settings, "SECRET_KEY", "")
    if isinstance(fallback, str) and len(fallback) >= 16:
        return fallback
    raise RuntimeError("passport signing secret is not configured")


def _database_now() -> datetime:
    return timezone.now()


def _parse_json_object(raw_body: bytes, *, content_type: str | None) -> dict[str, Any]:
    media = (content_type or "").split(";", 1)[0].strip().lower()
    if media != "application/json":
        raise PassportMalformedError(
            415,
            "unsupported-media-type",
            "unsupported-media-type",
            detail="Expected application/json.",
        )
    if len(raw_body) > MAX_BODY_BYTES:
        raise PassportMalformedError(
            413,
            "payload-too-large",
            "payload-too-large",
            detail=f"Body exceeds {MAX_BODY_BYTES} bytes.",
        )
    try:
        decoded_text = raw_body.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PassportMalformedError(400, "malformed-request", "invalid-encoding") from exc

    def _no_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        seen: set[str] = set()
        obj: dict[str, Any] = {}
        for key, val in pairs:
            if key in seen:
                raise PassportMalformedError(400, "malformed-request", "duplicate-json-key")
            seen.add(key)
            obj[key] = val
        return obj

    try:
        parsed = json.loads(decoded_text, object_pairs_hook=_no_duplicate_pairs)
    except PassportMalformedError:
        raise
    except ValueError as exc:
        raise PassportMalformedError(400, "malformed-request", "invalid-json") from exc
    if not isinstance(parsed, dict):
        raise PassportMalformedError(400, "malformed-request", "json-not-object")
    return parsed


def _configured_int(name: str, default: int) -> int:
    raw = getattr(settings, name, default)
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 1:
        return default
    return raw


def purge_expired_passport_tokens(
    *,
    now: datetime | None = None,
    batch_size: int = 500,
    max_batches: int = 20,
) -> dict[str, int]:
    """Bounded time-driven purge of expired Passport magic-link tokens and rate-limit events."""
    if batch_size < 1 or max_batches < 1:
        raise ValueError("batch_size and max_batches must be positive integers")

    effective_now = now if now is not None else _database_now()
    rate_horizon = effective_now - timedelta(seconds=RATE_WINDOW_SECONDS)
    tokens_deleted = 0
    rate_events_deleted = 0

    for _ in range(max_batches):
        with transaction.atomic():
            token_ids = list(
                PassportMagicLinkToken.objects.filter(expires_at__lte=effective_now)
                .order_by("expires_at", "id")
                .values_list("id", flat=True)[:batch_size]
            )
            if not token_ids:
                break
            deleted_count, _ = PassportMagicLinkToken.objects.filter(id__in=token_ids).delete()
            tokens_deleted += deleted_count
            if len(token_ids) < batch_size:
                break

    for _ in range(max_batches):
        with transaction.atomic():
            event_ids = list(
                PassportRateLimitEvent.objects.filter(occurred_at__lte=rate_horizon)
                .order_by("occurred_at", "id")
                .values_list("id", flat=True)[:batch_size]
            )
            if not event_ids:
                break
            deleted_count, _ = PassportRateLimitEvent.objects.filter(id__in=event_ids).delete()
            rate_events_deleted += deleted_count
            if len(event_ids) < batch_size:
                break

    return {
        "expired_tokens_deleted": tokens_deleted,
        "expired_rate_events_deleted": rate_events_deleted,
    }


def _charge_rate_limits(*, peer: str, email_normalized: str) -> PassportRateQuota:
    secret = passport_secret()
    ip_digest = rate_limit_digest(secret=secret, scope="ip", value=peer or "unknown")
    email_digest = rate_limit_digest(secret=secret, scope="email", value=email_normalized)
    ip_limit = _configured_int("KODERA_PASSPORT_IP_RATE_LIMIT", DEFAULT_IP_LIMIT)
    email_limit = _configured_int("KODERA_PASSPORT_EMAIL_RATE_LIMIT", DEFAULT_EMAIL_LIMIT)
    window = timedelta(seconds=RATE_WINDOW_SECONDS)

    buckets = sorted((("ip", ip_digest), ("email", email_digest)))
    with transaction.atomic():
        with connection.cursor() as cursor:
            for b_scope, b_digest in buckets:
                cursor.execute(
                    "SELECT pg_advisory_xact_lock("
                    "hashtextextended('passport_rl:' || %s || ':' || %s, 0))",
                    [b_scope, b_digest],
                )
        now = _database_now()
        horizon = now - window
        PassportRateLimitEvent.objects.filter(
            scope="ip", digest=ip_digest, occurred_at__lte=horizon
        ).delete()
        PassportRateLimitEvent.objects.filter(
            scope="email", digest=email_digest, occurred_at__lte=horizon
        ).delete()

        ip_times = list(
            PassportRateLimitEvent.objects.filter(scope="ip", digest=ip_digest)
            .order_by("occurred_at")
            .values_list("occurred_at", flat=True)
        )
        if len(ip_times) >= ip_limit:
            oldest_ip = ip_times[len(ip_times) - ip_limit]
            wait_ip = max(1, math.ceil((oldest_ip + window - now).total_seconds()))
            raise PassportRateLimitedError(
                scope="ip",
                limit=ip_limit,
                remaining=0,
                reset_s=wait_ip,
                retry_after_s=wait_ip,
            )

        email_times = list(
            PassportRateLimitEvent.objects.filter(scope="email", digest=email_digest)
            .order_by("occurred_at")
            .values_list("occurred_at", flat=True)
        )
        if len(email_times) >= email_limit:
            # Record the IP attempt when capacity permits so distributed email spraying still
            # burns IP quota, and return a generic `passport` scope to prevent user enumeration.
            if PassportRateLimitEvent.objects.count() < MAX_RATE_EVENTS:
                PassportRateLimitEvent.objects.create(scope="ip", digest=ip_digest, occurred_at=now)
            oldest_email = email_times[len(email_times) - email_limit]
            wait_email = max(1, math.ceil((oldest_email + window - now).total_seconds()))
            raise PassportRateLimitedError(
                scope="passport",
                limit=email_limit,
                remaining=0,
                reset_s=wait_email,
                retry_after_s=wait_email,
            )

        if PassportRateLimitEvent.objects.count() >= MAX_RATE_EVENTS:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM identity_passportratelimitevent WHERE id IN ("
                    " SELECT id FROM identity_passportratelimitevent"
                    " WHERE occurred_at <= %s ORDER BY occurred_at, id"
                    " LIMIT 512 FOR UPDATE SKIP LOCKED)",
                    [horizon],
                )
                cursor.execute(
                    "DELETE FROM identity_passportmagiclinktoken WHERE id IN ("
                    " SELECT id FROM identity_passportmagiclinktoken"
                    " WHERE expires_at <= %s ORDER BY expires_at, id"
                    " LIMIT 256 FOR UPDATE SKIP LOCKED)",
                    [now],
                )
            if PassportRateLimitEvent.objects.count() >= MAX_RATE_EVENTS:
                oldest_global = (
                    PassportRateLimitEvent.objects.order_by("occurred_at")
                    .values_list("occurred_at", flat=True)
                    .first()
                )
                wait_global = (
                    max(1, math.ceil((oldest_global + window - now).total_seconds()))
                    if oldest_global is not None
                    else RATE_WINDOW_SECONDS
                )
                raise PassportRateLimitedError(
                    scope="global",
                    limit=ip_limit,
                    remaining=0,
                    reset_s=wait_global,
                    retry_after_s=wait_global,
                )

        PassportRateLimitEvent.objects.create(scope="ip", digest=ip_digest, occurred_at=now)
        PassportRateLimitEvent.objects.create(scope="email", digest=email_digest, occurred_at=now)
        ip_after = len(ip_times) + 1
        first_ip = ip_times[0] if ip_times else now
        ip_reset = max(1, math.ceil((first_ip + window - now).total_seconds()))
        return PassportRateQuota(
            limit=ip_limit,
            remaining=max(0, ip_limit - ip_after),
            reset_s=ip_reset,
        )


def _select_user_for_email(email_normalized: str) -> User | None:
    """Resolve an enabled, undeleted User matching normalized email."""
    candidates = list(
        User.objects.filter(
            email__iexact=email_normalized,
            enabled=True,
            deleted_at__isnull=True,
        ).order_by("created_at", "id")
    )
    matched: list[User] = []
    for candidate in candidates:
        try:
            cand_norm, _ = normalize_passport_email(candidate.email)
        except PassportInputError:
            continue
        if cand_norm == email_normalized:
            matched.append(candidate)
    if not matched:
        return None
    matched_ids = [u.id for u in matched]
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT user_reference FROM orgs_accounterasure WHERE user_reference = ANY(%s)",
            [matched_ids],
        )
        erasing_ids = {UUID(str(r[0])) for r in cursor.fetchall() if r[0] is not None}
    matched = [u for u in matched if u.id not in erasing_ids]
    if not matched:
        return None
    if len(matched) == 1:
        return matched[0]
    for candidate in matched:
        if passport_memberships(user_id=candidate.id):
            return candidate
    return matched[0]


def _resolve_verified_email_user_ids(
    email_normalized: str,
    *,
    primary_user_id: UUID,
) -> tuple[UUID, ...]:
    """Resolve sibling per-realm `User` rows holding verified customer `Identity` rows for the
    same normalized email (excluding any user under account erasure)."""
    candidates = list(
        User.objects.filter(
            email__iexact=email_normalized,
            enabled=True,
            deleted_at__isnull=True,
        )
        .exclude(id=primary_user_id)
        .values_list("id", "email")
    )
    if not candidates:
        return (primary_user_id,)
    candidate_ids: list[UUID] = []
    for cand_id, cand_email in candidates:
        try:
            cand_norm, _ = normalize_passport_email(cand_email)
        except PassportInputError:
            continue
        if cand_norm == email_normalized:
            candidate_ids.append(cand_id)
    if not candidate_ids:
        return (primary_user_id,)

    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT user_reference FROM orgs_accounterasure WHERE user_reference = ANY(%s)",
            [candidate_ids],
        )
        erasing_ids = {UUID(str(r[0])) for r in cursor.fetchall() if r[0] is not None}

    non_erasing_ids = [uid for uid in candidate_ids if uid not in erasing_ids]
    if not non_erasing_ids:
        return (primary_user_id,)

    ident_rows = list(
        Identity.objects.filter(
            user_id__in=non_erasing_ids,
            organisation_id__isnull=False,
            enabled=True,
            deleted_at__isnull=True,
        )
        .exclude(realm=STAFF_REALM)
        .values_list("user_id", "email")
    )
    admitted: set[UUID] = {primary_user_id}
    for uid, ident_email in ident_rows:
        try:
            ident_norm, _ = normalize_passport_email(ident_email)
        except PassportInputError:
            continue
        if ident_norm == email_normalized:
            admitted.add(uid)
    return tuple(sorted(admitted, key=lambda u: u.hex))


def _persist_workspace_context(
    *,
    user_ids: tuple[UUID, ...],
    active_org_id: UUID,
    active_ws_id: UUID | None,
) -> None:
    now_ts = _database_now()
    with connection.cursor() as cursor:
        for uid in dict.fromkeys(user_ids):
            cursor.execute(
                """
                INSERT INTO identity_passportworkspacecontext
                    (id, user_id, active_organisation_id, active_workspace_id, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (user_id) DO UPDATE SET
                    active_organisation_id = EXCLUDED.active_organisation_id,
                    active_workspace_id = EXCLUDED.active_workspace_id,
                    updated_at = EXCLUDED.updated_at
                """,
                [new_uuid7(), uid, active_org_id, active_ws_id, now_ts, now_ts],
            )


def _acquire_passport_fence(
    *,
    user_id: UUID,
    sibling_user_ids: tuple[UUID, ...] = (),
    verified: VerifiedAccessToken | None = None,
    session_claims: PassportSessionClaims | None = None,
    extra_org_ids: tuple[UUID, ...] = (),
) -> _PassportFenceResult | None:
    """Acquire Core's current-authority + privacy cutoff fence in canonical lock order (`NOWAIT`).

    Must run inside `transaction.atomic()`. Holds shared cutoff advisory locks and `FOR SHARE NOWAIT`
    row locks on `identity_user`, `orgs_organisation`, `orgs_membership`, and `identity_identity`
    until transaction commit/rollback. Raises `PassportConflictError` on lock contention.
    """
    if not connection.in_atomic_block:
        raise RuntimeError("_acquire_passport_fence must execute inside transaction.atomic()")

    all_user_ids = sorted({user_id, *sibling_user_ids}, key=lambda u: u.hex)

    try:
        with connection.cursor() as cursor:
            for uid in all_user_ids:
                cursor.execute(
                    "SELECT pg_try_advisory_xact_lock_shared("
                    "hashtextextended('privacy_account_cutoff:' || %s, 0))",
                    [str(uid)],
                )
                row_lock_ok = cursor.fetchone()
                if not row_lock_ok or not row_lock_ok[0]:
                    raise PassportConflictError()

            cursor.execute(
                "SELECT DISTINCT organisation_id FROM orgs_membership WHERE user_id = ANY(%s) "
                "UNION "
                "SELECT DISTINCT organisation_id FROM identity_identity "
                "WHERE user_id = ANY(%s) AND organisation_id IS NOT NULL",
                [all_user_ids, all_user_ids],
            )
            discovered_org_ids = {UUID(str(r[0])) for r in cursor.fetchall() if r[0] is not None}
            candidate_org_ids = sorted(discovered_org_ids | set(extra_org_ids), key=lambda u: u.hex)

            for org_id in candidate_org_ids:
                cursor.execute(
                    "SELECT pg_try_advisory_xact_lock_shared("
                    "hashtextextended('privacy_erasure_cutoff:' || %s, 0))",
                    [str(org_id)],
                )
                org_lock_ok = cursor.fetchone()
                if not org_lock_ok or not org_lock_ok[0]:
                    raise PassportConflictError()

            cursor.execute(
                "SELECT id, email, display_name, enabled, deleted_at "
                "FROM identity_user WHERE id = ANY(%s) ORDER BY id FOR SHARE NOWAIT",
                [all_user_ids],
            )
            locked_users = cursor.fetchall()
            cursor.execute(
                "SELECT user_reference FROM orgs_accounterasure WHERE user_reference = ANY(%s)",
                [all_user_ids],
            )
            erasing_user_ids = {UUID(str(r[0])) for r in cursor.fetchall() if r[0] is not None}

            valid_users: dict[UUID, PersonSnapshot] = {}
            for u_id_raw, u_email, u_display_name, u_enabled, u_deleted_at in locked_users:
                uid = UUID(str(u_id_raw))
                if not u_enabled or u_deleted_at is not None or uid in erasing_user_ids:
                    continue
                valid_users[uid] = PersonSnapshot(uid, str(u_email), u_display_name)

            person = valid_users.get(user_id)
            if person is None:
                return None
            admitted_user_ids = sorted(valid_users.keys(), key=lambda u: u.hex)

            orgs_by_id: dict[UUID, tuple[str, str, str, str, str, object]] = {}
            if candidate_org_ids:
                cursor.execute(
                    "SELECT id, slug, name, realm, issuer, state, deleted_at "
                    "FROM orgs_organisation WHERE id = ANY(%s) ORDER BY id FOR SHARE NOWAIT",
                    [candidate_org_ids],
                )
                for (
                    o_id,
                    o_slug,
                    o_name,
                    o_realm,
                    o_issuer,
                    o_state,
                    o_deleted_at,
                ) in cursor.fetchall():
                    orgs_by_id[UUID(str(o_id))] = (
                        str(o_slug),
                        str(o_name),
                        str(o_realm),
                        str(o_issuer),
                        str(o_state),
                        o_deleted_at,
                    )

            cursor.execute(
                "SELECT id, user_id, organisation_id, role, state, accepted_at, deleted_at "
                "FROM orgs_membership WHERE user_id = ANY(%s) ORDER BY id FOR SHARE NOWAIT",
                [admitted_user_ids],
            )
            locked_memberships = cursor.fetchall()

            cursor.execute(
                "SELECT id, user_id, organisation_id, realm, issuer, subject, enabled, deleted_at "
                "FROM identity_identity WHERE user_id = ANY(%s) AND organisation_id IS NOT NULL "
                "ORDER BY id FOR SHARE NOWAIT",
                [admitted_user_ids],
            )
            locked_identities = cursor.fetchall()
    except PassportConflictError:
        raise
    except DatabaseError as exc:
        if _is_lock_conflict(exc):
            raise PassportConflictError() from exc
        raise

    active_identities_by_user_org: dict[tuple[UUID, UUID], list[tuple[UUID, str, str, str]]] = {}
    caller_identity_id: UUID | None = None
    origin_org_id: UUID | None = None

    for (
        i_id_raw,
        i_user_raw,
        i_org_raw,
        i_realm,
        i_issuer,
        i_subject,
        i_enabled,
        i_deleted_at,
    ) in locked_identities:
        if not i_enabled or i_deleted_at is not None or i_org_raw is None:
            continue
        i_id = UUID(str(i_id_raw))
        i_uid = UUID(str(i_user_raw))
        i_org_id = UUID(str(i_org_raw))
        realm_str = str(i_realm)
        issuer_str = str(i_issuer)
        subject_str = str(i_subject)
        if realm_str == STAFF_REALM:
            continue
        active_identities_by_user_org.setdefault((i_uid, i_org_id), []).append(
            (i_id, realm_str, issuer_str, subject_str)
        )
        if (
            verified is not None
            and i_uid == user_id
            and issuer_str == verified.issuer
            and subject_str == verified.subject
            and caller_identity_id is None
        ):
            caller_identity_id = i_id
            origin_org_id = i_org_id

    if verified is not None and caller_identity_id is None:
        return None

    ordered_memberships = sorted(
        locked_memberships,
        key=lambda row: (0 if UUID(str(row[1])) == user_id else 1, str(row[0])),
    )
    eligible_rows: list[PassportMembershipRow] = []
    primary_identity_by_org: dict[UUID, tuple[UUID, str]] = {}
    user_ids_by_org: dict[UUID, UUID] = {}

    for (
        m_id_raw,
        m_user_raw,
        m_org_raw,
        m_role,
        m_state,
        m_accepted_at,
        m_deleted_at,
    ) in ordered_memberships:
        m_uid = UUID(str(m_user_raw))
        m_org_id = UUID(str(m_org_raw))
        if m_org_id in user_ids_by_org:
            continue
        org_info = orgs_by_id.get(m_org_id)
        if org_info is None:
            continue
        o_slug, o_name, o_realm, o_issuer, o_state, o_deleted_at = org_info
        if (
            o_state != "active"
            or o_deleted_at is not None
            or o_realm == STAFF_REALM
            or m_state != "active"
            or m_accepted_at is None
            or m_deleted_at is not None
            or str(m_role) not in ELIGIBLE_MEMBERSHIP_ROLES
        ):
            continue
        matching_idents = [
            (ident_id, ident_realm)
            for ident_id, ident_realm, ident_issuer, _ in active_identities_by_user_org.get(
                (m_uid, m_org_id), []
            )
            if ident_realm == o_realm and ident_issuer == o_issuer
        ]
        if not matching_idents:
            continue
        primary_identity_by_org[m_org_id] = matching_idents[0]
        user_ids_by_org[m_org_id] = m_uid
        eligible_rows.append(
            PassportMembershipRow(
                membership_id=UUID(str(m_id_raw)),
                organisation_id=m_org_id,
                organisation_slug=o_slug,
                organisation_name=o_name,
                realm=o_realm,
                issuer=o_issuer,
                role=str(m_role),
            )
        )

    eligible_rows.sort(key=lambda r: (r.organisation_slug, str(r.membership_id)))
    memberships_tuple = tuple(eligible_rows)

    if verified is not None and origin_org_id is not None:
        # Verify caller's originating organisation itself is still active and undeleted,
        # and that the caller holds a live active membership grant in that originating organisation.
        origin_info = orgs_by_id.get(origin_org_id)
        if origin_info is None or origin_info[4] != "active" or origin_info[5] is not None:
            return None
        if not any(m.organisation_id == origin_org_id for m in memberships_tuple):
            raise PassportForbiddenError()

    if verified is None and session_claims is not None:
        if not memberships_tuple:
            raise TokenVerificationError()
        claimed_org = session_claims.active_organisation_id
        if claimed_org is not None:
            claimed_mem = next(
                (m for m in memberships_tuple if m.organisation_id == claimed_org),
                None,
            )
            if claimed_mem is None or claimed_org not in primary_identity_by_org:
                raise TokenVerificationError()
            if (
                session_claims.membership_id is not None
                and claimed_mem.membership_id != session_claims.membership_id
            ):
                raise TokenVerificationError()
            if session_claims.role is not None and claimed_mem.role != session_claims.role:
                raise TokenVerificationError()
            origin_org_id = claimed_org
            caller_identity_id = primary_identity_by_org[claimed_org][0]
        else:
            first_org = memberships_tuple[0].organisation_id
            caller_identity_id = primary_identity_by_org[first_org][0]

    return _PassportFenceResult(
        person=person,
        origin_organisation_id=origin_org_id,
        caller_identity_id=caller_identity_id,
        memberships=memberships_tuple,
        identities_by_org=primary_identity_by_org,
        user_ids_by_org=user_ids_by_org,
        fenced_user_ids=tuple(admitted_user_ids),
    )


def _build_directory(
    *,
    person: PersonSnapshot,
    memberships: tuple[PassportMembershipRow, ...],
    preferred_organisation_id: UUID | None,
    persist_context: bool,
) -> PassportWorkspaceDirectory:
    org_ids = tuple(m.organisation_id for m in memberships)
    workspaces_by_org = passport_unrestricted_workspaces(
        memberships=tuple((m.organisation_id, m.membership_id) for m in memberships)
    )
    urls_by_org = organisation_tenant_urls(organisation_ids=org_ids)

    stored = PassportWorkspaceContext.objects.filter(user_id=person.id).first()
    eligible_org_ids = {m.organisation_id for m in memberships}

    active_org_id: UUID | None = None
    if preferred_organisation_id is not None and preferred_organisation_id in eligible_org_ids:
        active_org_id = preferred_organisation_id
    elif stored is not None and stored.active_organisation_id in eligible_org_ids:
        active_org_id = stored.active_organisation_id
    elif memberships:
        active_org_id = memberships[0].organisation_id

    active_ws_id = None if active_org_id is None else workspaces_by_org.get(active_org_id)

    if persist_context and active_org_id is not None:
        now_ts = _database_now()
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO identity_passportworkspacecontext
                    (id, user_id, active_organisation_id, active_workspace_id, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (user_id) DO UPDATE SET
                    active_organisation_id = EXCLUDED.active_organisation_id,
                    active_workspace_id = EXCLUDED.active_workspace_id,
                    updated_at = EXCLUDED.updated_at
                """,
                [new_uuid7(), person.id, active_org_id, active_ws_id, now_ts, now_ts],
            )

    entries = tuple(
        PassportWorkspaceEntry(
            organisation_id=m.organisation_id,
            organisation_slug=m.organisation_slug,
            organisation_name=m.organisation_name,
            realm=m.realm,
            issuer=m.issuer,
            membership_id=m.membership_id,
            role=m.role,
            workspace_id=workspaces_by_org.get(m.organisation_id),
            default_urls=urls_by_org.get(m.organisation_id, {}),
            active=(m.organisation_id == active_org_id),
        )
        for m in memberships
    )
    return PassportWorkspaceDirectory(
        person=person,
        active_organisation_id=active_org_id,
        active_workspace_id=active_ws_id,
        workspaces=entries,
    )


def request_magic_link(
    *,
    raw_body: bytes,
    content_type: str | None,
    peer: str,
    on_issue: Callable[[PassportMagicLinkDelivery], None] | None = None,
) -> PassportMagicLinkAccepted:
    """Validate, rate-limit, and persist a hashed magic-link token with constant `202` response."""
    payload = _parse_json_object(raw_body, content_type=content_type)
    allowed_fields = {"email", "code_challenge", "code_challenge_method", "device_challenge"}
    unexpected = sorted(set(payload) - allowed_fields)
    if unexpected:
        raise PassportInputError(f"/{unexpected[0]}", "unknown-field")

    email_normalized, domain_normalized = normalize_passport_email(payload.get("email"))
    code_challenge, code_challenge_method = validate_pkce_challenge(
        payload.get("code_challenge"),
        payload.get("code_challenge_method", "S256"),
    )
    device_challenge_sha256 = validate_device_challenge(payload.get("device_challenge"))

    sink = on_issue or getattr(settings, "KODERA_PASSPORT_DELIVERY_SINK", None)
    outbox_config: tuple[bytes, str] | None = None
    if not callable(sink):
        outbox_config = resolve_passport_outbox_config()

    quota = _charge_rate_limits(peer=peer, email_normalized=email_normalized)
    raw_token, token_sha256 = generate_magic_link_token()

    try:
        with transaction.atomic():
            now = _database_now()
            expires_at = now + timedelta(seconds=MAGIC_LINK_TTL_SECONDS)
            user = _select_user_for_email(email_normalized)
            enqueued_delivery_id: UUID | None = None

            if callable(sink) and user is not None:
                PassportMagicLinkToken.objects.create(
                    token_sha256=token_sha256,
                    user_id=user.id,
                    delivery_id=None,
                    email_normalized=email_normalized,
                    domain_normalized=domain_normalized,
                    code_challenge=code_challenge,
                    code_challenge_method=code_challenge_method,
                    device_challenge_sha256=device_challenge_sha256,
                    expires_at=expires_at,
                )
                delivery = PassportMagicLinkDelivery(
                    email_normalized=email_normalized,
                    raw_token=raw_token,
                    expires_at=expires_at,
                )
                transaction.on_commit(lambda: sink(delivery))
            elif outbox_config is not None and user is not None:
                sibling_ids = _resolve_verified_email_user_ids(
                    email_normalized, primary_user_id=user.id
                )
                fenced = _acquire_passport_fence(user_id=user.id, sibling_user_ids=sibling_ids)
                memberships = fenced.memberships if fenced is not None else ()
                if memberships and fenced is not None:
                    stored_org_id = (
                        PassportWorkspaceContext.objects.filter(user_id__in=fenced.fenced_user_ids)
                        .order_by("-updated_at")
                        .values_list("active_organisation_id", flat=True)
                        .first()
                    )
                    target = next(
                        (m for m in memberships if m.organisation_id == stored_org_id),
                        memberships[0],
                    )
                    binding_user_id = fenced.user_ids_by_org.get(target.organisation_id, user.id)
                    seal_key, magic_link_url = outbox_config
                    candidate_delivery_id = new_uuid7()
                    PassportOutboxBinding.objects.create(
                        delivery_id=candidate_delivery_id,
                        user_id=binding_user_id,
                        organisation_id=target.organisation_id,
                        created_at=now,
                    )
                    enqueued_delivery_id = enqueue_passport_magic_link(
                        seal_key=seal_key,
                        link=magic_link_url,
                        organisation_id=target.organisation_id,
                        organisation_name=target.organisation_name,
                        recipient=email_normalized,
                        raw_token=raw_token,
                        expires_at=expires_at,
                        delivery_id=candidate_delivery_id,
                    )
                PassportMagicLinkToken.objects.create(
                    token_sha256=token_sha256,
                    user_id=user.id if fenced is not None else None,
                    delivery_id=enqueued_delivery_id,
                    email_normalized=email_normalized,
                    domain_normalized=domain_normalized,
                    code_challenge=code_challenge,
                    code_challenge_method=code_challenge_method,
                    device_challenge_sha256=device_challenge_sha256,
                    expires_at=expires_at,
                )
            else:
                PassportMagicLinkToken.objects.create(
                    token_sha256=token_sha256,
                    user_id=None,
                    delivery_id=None,
                    email_normalized=email_normalized,
                    domain_normalized=domain_normalized,
                    code_challenge=code_challenge,
                    code_challenge_method=code_challenge_method,
                    device_challenge_sha256=device_challenge_sha256,
                    expires_at=expires_at,
                )
    except PassportConflictError:
        # Preserve constant-shape enumerator-safe 202 response during concurrent privacy cutoff.
        pass
    except DatabaseError as exc:
        if _sqlstate_of(exc) == PRIVACY_REFUSAL_SQLSTATE or _is_lock_conflict(exc):
            pass
        else:
            raise

    return PassportMagicLinkAccepted(expires_in_seconds=MAGIC_LINK_TTL_SECONDS, quota=quota)


def verify_magic_link(
    *,
    raw_body: bytes,
    content_type: str | None,
    request_id: str,
) -> PassportVerifiedSession:
    """Atomically consume a single-use magic-link token and return verified Passport workspaces."""
    payload = _parse_json_object(raw_body, content_type=content_type)
    allowed_fields = {"token", "code_verifier", "device_verifier"}
    unexpected = sorted(set(payload) - allowed_fields)
    if unexpected:
        raise PassportInputError(f"/{unexpected[0]}", "unknown-field")

    try:
        token_sha256 = hash_magic_link_token(payload.get("token"))
    except PassportSessionError as exc:
        raise PassportUnauthorizedError() from exc

    code_verifier = payload.get("code_verifier")
    device_verifier = payload.get("device_verifier")

    refused = False
    try:
        with transaction.atomic():
            now = _database_now()
            row = (
                PassportMagicLinkToken.objects.select_for_update()
                .filter(token_sha256=token_sha256)
                .first()
            )
            if row is None or row.consumed_at is not None or row.expires_at <= now:
                refused = True
            else:
                # Always burn single-use token on first verification attempt so PKCE/device mismatch
                # or disabled-account probes can never replay or brute-force the token.
                row.consumed_at = now
                row.save(update_fields=["consumed_at", "updated_at"])

                pkce_ok = verify_pkce_verifier(
                    code_verifier=code_verifier,
                    expected_challenge=row.code_challenge,
                )
                device_ok = verify_device_verifier(
                    device_verifier=device_verifier,
                    expected_sha256=row.device_challenge_sha256,
                )
                if not pkce_ok or not device_ok:
                    refused = True
                else:
                    target_user_id: UUID | None = row.user_id
                    if target_user_id is None:
                        selected = _select_user_for_email(row.email_normalized)
                        target_user_id = None if selected is None else selected.id
                    if target_user_id is None:
                        refused = True
                    else:
                        sibling_ids = _resolve_verified_email_user_ids(
                            row.email_normalized, primary_user_id=target_user_id
                        )
                        fenced = _acquire_passport_fence(
                            user_id=target_user_id, sibling_user_ids=sibling_ids
                        )
                        if fenced is None or not fenced.memberships:
                            refused = True
                        else:
                            try:
                                person_norm, _ = normalize_passport_email(fenced.person.email)
                            except PassportInputError:
                                person_norm = ""
                            if person_norm != row.email_normalized:
                                refused = True
                            else:
                                stored_ctx = (
                                    PassportWorkspaceContext.objects.filter(
                                        user_id__in=fenced.fenced_user_ids
                                    )
                                    .order_by("-updated_at")
                                    .first()
                                )
                                directory = _build_directory(
                                    person=fenced.person,
                                    memberships=fenced.memberships,
                                    preferred_organisation_id=(
                                        None
                                        if stored_ctx is None
                                        else stored_ctx.active_organisation_id
                                    ),
                                    persist_context=True,
                                )
                                active_org = directory.active_organisation_id
                                active_mem = next(
                                    (
                                        m
                                        for m in fenced.memberships
                                        if m.organisation_id == active_org
                                    ),
                                    None,
                                )
                                session_user_id = (
                                    fenced.user_ids_by_org.get(active_org, fenced.person.id)
                                    if active_org is not None
                                    else fenced.person.id
                                )
                                if active_org is not None and session_user_id != fenced.person.id:
                                    _persist_workspace_context(
                                        user_ids=(session_user_id,),
                                        active_org_id=active_org,
                                        active_ws_id=directory.active_workspace_id,
                                    )
                                audit_identity = (
                                    fenced.identities_by_org.get(active_org)
                                    if active_org is not None
                                    else None
                                )
                                if audit_identity is not None and active_org is not None:
                                    identity_id, realm = audit_identity
                                    amr = (
                                        ("magic_link", "pkce", "device")
                                        if row.device_challenge_sha256 is not None
                                        else ("magic_link", "pkce")
                                    )
                                    record_passport_login_succeeded(
                                        identity_id=identity_id,
                                        organisation_id=active_org,
                                        realm=realm,
                                        amr=amr,
                                        request_id=request_id,
                                    )
                                now_epoch = int(now.timestamp())
                                session_token = issue_passport_session_token(
                                    secret=passport_secret(),
                                    user_id=session_user_id,
                                    active_organisation_id=active_org,
                                    now=now_epoch,
                                    auth_time=now_epoch,
                                    max_expires_at=now_epoch + PASSPORT_SESSION_TTL_SECONDS,
                                    membership_id=(
                                        None if active_mem is None else active_mem.membership_id
                                    ),
                                    role=None if active_mem is None else active_mem.role,
                                )
                                return PassportVerifiedSession(
                                    directory=directory,
                                    session_token=session_token,
                                    expires_in_seconds=PASSPORT_SESSION_TTL_SECONDS,
                                )
    except PassportConflictError:
        raise
    except DatabaseError as exc:
        if _is_lock_conflict(exc):
            raise PassportConflictError() from exc
        if _sqlstate_of(exc) == PRIVACY_REFUSAL_SQLSTATE:
            raise PassportUnauthorizedError() from exc
        raise

    if refused:
        raise PassportUnauthorizedError()
    raise PassportUnauthorizedError()  # pragma: no cover


def _resolve_initial_user_ids(
    *,
    verified: VerifiedAccessToken | None,
    session_claims: PassportSessionClaims | None,
) -> tuple[UUID, tuple[UUID, ...]]:
    """Locate primary `user_id` and verified-email sibling `User` IDs before fencing."""
    if verified is not None:
        if not is_storable_subject(verified.subject):
            raise UnknownCustomerError()
        resolved = current_identity(issuer=verified.issuer, subject=verified.subject)
        if resolved is None:
            raise UnknownCustomerError()
        person, _ = resolved
        if not verified.email_verified:
            return person.id, (person.id,)
        try:
            person_norm, _ = normalize_passport_email(person.email)
        except PassportInputError:
            return person.id, (person.id,)
        if verified.email is not None:
            try:
                claim_norm, _ = normalize_passport_email(verified.email)
            except PassportInputError:
                return person.id, (person.id,)
            if claim_norm != person_norm:
                return person.id, (person.id,)
        siblings = _resolve_verified_email_user_ids(person_norm, primary_user_id=person.id)
        return person.id, siblings

    if session_claims is not None:
        user_row = (
            User.objects.filter(
                id=session_claims.user_id,
                enabled=True,
                deleted_at__isnull=True,
            )
            .values_list("email", flat=True)
            .first()
        )
        if user_row is None:
            raise TokenVerificationError()
        try:
            email_norm, _ = normalize_passport_email(user_row)
        except PassportInputError:
            return session_claims.user_id, (session_claims.user_id,)
        siblings = _resolve_verified_email_user_ids(
            email_norm, primary_user_id=session_claims.user_id
        )
        return session_claims.user_id, siblings

    raise UnknownCustomerError()


def list_passport_workspaces(
    *,
    verified: VerifiedAccessToken | None = None,
    session_claims: PassportSessionClaims | None = None,
) -> PassportWorkspaceDirectory:
    """List active workspaces across realms under an in-transaction authority + privacy fence."""
    user_id, sibling_ids = _resolve_initial_user_ids(
        verified=verified, session_claims=session_claims
    )
    try:
        with transaction.atomic():
            fenced = _acquire_passport_fence(
                user_id=user_id,
                sibling_user_ids=sibling_ids,
                verified=verified,
                session_claims=session_claims,
            )
            if fenced is None:
                if session_claims is not None:
                    raise TokenVerificationError()
                raise UnknownCustomerError()
            if verified is None and not fenced.memberships:
                raise TokenVerificationError()
            stored = (
                PassportWorkspaceContext.objects.filter(user_id__in=fenced.fenced_user_ids)
                .order_by("-updated_at")
                .first()
            )
            effective_pref = (
                stored.active_organisation_id
                if stored is not None
                else fenced.origin_organisation_id
            )
            return _build_directory(
                person=fenced.person,
                memberships=fenced.memberships,
                preferred_organisation_id=effective_pref,
                persist_context=False,
            )
    except PassportConflictError:
        raise
    except DatabaseError as exc:
        if _is_lock_conflict(exc):
            raise PassportConflictError() from exc
        raise


def switch_passport_workspace(
    *,
    verified: VerifiedAccessToken | None = None,
    session_claims: PassportSessionClaims | None = None,
    raw_body: bytes,
    content_type: str | None,
    request_id: str,
) -> PassportSwitchedWorkspace:
    """Switch active workspace context inside a single fenced authority + privacy transaction."""
    user_id, sibling_ids = _resolve_initial_user_ids(
        verified=verified, session_claims=session_claims
    )
    payload = _parse_json_object(raw_body, content_type=content_type)
    if set(payload) - {"organisation_id"}:
        extra = sorted(set(payload) - {"organisation_id"})[0]
        raise PassportInputError(f"/{extra}", "unknown-field")

    raw_org_id = payload.get("organisation_id")
    if not isinstance(raw_org_id, str):
        raise PassportInputError("/organisation_id", "invalid-organisation-id")
    try:
        target_org_id = UUID(raw_org_id)
    except ValueError as exc:
        raise PassportInputError("/organisation_id", "invalid-organisation-id") from exc

    denied = False
    try:
        with transaction.atomic():
            fenced = _acquire_passport_fence(
                user_id=user_id,
                sibling_user_ids=sibling_ids,
                verified=verified,
                session_claims=session_claims,
                extra_org_ids=(target_org_id,),
            )
            if fenced is None:
                if session_claims is not None:
                    raise TokenVerificationError()
                raise UnknownCustomerError()
            if verified is None and not fenced.memberships:
                raise TokenVerificationError()

            matching = next(
                (m for m in fenced.memberships if m.organisation_id == target_org_id),
                None,
            )
            if matching is None:
                slug = organisation_slug_or_none(organisation_id=target_org_id)
                target_urn = (
                    f"urn:kodera:organisation:{slug}"
                    if slug is not None
                    else f"urn:kodera:organisation:{target_org_id}"
                )
                record_authz_denied(
                    actor_type="tenant",
                    actor_id=fenced.caller_identity_id,
                    organisation_id=fenced.origin_organisation_id,
                    target_urn=target_urn,
                    request_id=request_id,
                    required_scope="identity:act",
                    reason="role_missing",
                )
                denied = True
            else:
                now = _database_now()
                now_epoch = int(now.timestamp())
                if session_claims is not None:
                    auth_time_claim = session_claims.auth_time
                    max_exp_claim = session_claims.max_expires_at
                    if max_exp_claim <= now_epoch:
                        raise TokenVerificationError()
                else:
                    auth_time_claim = now_epoch
                    max_exp_claim = now_epoch + PASSPORT_SESSION_TTL_SECONDS

                directory = _build_directory(
                    person=fenced.person,
                    memberships=fenced.memberships,
                    preferred_organisation_id=target_org_id,
                    persist_context=True,
                )
                target_uid = fenced.user_ids_by_org.get(target_org_id, fenced.person.id)
                if target_uid != fenced.person.id:
                    _persist_workspace_context(
                        user_ids=(target_uid,),
                        active_org_id=target_org_id,
                        active_ws_id=directory.active_workspace_id,
                    )
                switched = next(
                    entry
                    for entry in directory.workspaces
                    if entry.organisation_id == target_org_id
                )
                audit_identity = fenced.identities_by_org.get(target_org_id)
                if audit_identity is not None:
                    identity_id, _ = audit_identity
                    record_passport_login_succeeded(
                        identity_id=identity_id,
                        organisation_id=target_org_id,
                        realm=matching.realm,
                        amr=("passport_switch",),
                        request_id=request_id,
                    )
                try:
                    session_token = issue_passport_session_token(
                        secret=passport_secret(),
                        user_id=target_uid,
                        active_organisation_id=target_org_id,
                        now=now_epoch,
                        auth_time=auth_time_claim,
                        max_expires_at=max_exp_claim,
                        membership_id=matching.membership_id,
                        role=matching.role,
                    )
                except PassportSessionError as exc:
                    raise TokenVerificationError() from exc
                effective_exp = min(now_epoch + PASSPORT_SESSION_TTL_SECONDS, max_exp_claim)
                return PassportSwitchedWorkspace(
                    active_organisation_id=target_org_id,
                    active_workspace_id=directory.active_workspace_id,
                    workspace=switched,
                    session_token=session_token,
                    expires_in_seconds=max(1, effective_exp - now_epoch),
                )
    except PassportConflictError:
        raise
    except DatabaseError as exc:
        if _is_lock_conflict(exc):
            raise PassportConflictError() from exc
        if _sqlstate_of(exc) == PRIVACY_REFUSAL_SQLSTATE:
            if session_claims is not None:
                raise TokenVerificationError() from exc
            raise UnknownCustomerError() from exc
        raise

    if denied:
        raise PassportForbiddenError()
    raise PassportForbiddenError()  # pragma: no cover
