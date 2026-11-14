"""Kodera Passport cross-workspace magic-link sign-in and workspace context service.

Implements Track 2 (`Kodera Passport`):
- Enumerator-safe, rate-limited magic-link issuance (`10 min` TTL, 32-byte CSPRNG, SHA-256 at rest,
  PKCE S256 + optional device challenge binding).
- Atomic single-use token verification (`SELECT ... FOR UPDATE` burn; replay returns `401`).
- Cross-organisation workspace listing and audited active-workspace switching across realms
  (one realm per organisation).
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
from django.db import connection, transaction
from django.utils import timezone

from apps.audit.services import record_authz_denied, record_passport_login_succeeded
from apps.orgs.selectors import (
    PassportMembershipRow,
    organisation_slug_or_none,
    passport_memberships,
)
from apps.tenancy.selectors import organisation_tenant_urls
from apps.workspaces.selectors import passport_unrestricted_workspaces
from core.passport import (
    MAGIC_LINK_TTL_SECONDS,
    PASSPORT_SESSION_TTL_SECONDS,
    PassportInputError,
    PassportSessionClaims,
    PassportSessionError,
    generate_magic_link_token,
    hash_magic_link_token,
    issue_passport_session_token,
    normalize_passport_email,
    rate_limit_digest,
    validate_device_challenge,
    validate_pkce_challenge,
    verify_device_verifier,
    verify_pkce_verifier,
)
from services.identity.access_tokens import VerifiedAccessToken

from .models import (
    Identity,
    PassportMagicLinkToken,
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
        raise PassportMalformedError(400, "malformed-request", "invalid-utf8") from exc

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


def _charge_rate_limits(*, peer: str, email_normalized: str) -> PassportRateQuota:
    secret = passport_secret()
    ip_digest = rate_limit_digest(secret=secret, scope="ip", value=peer or "unknown")
    email_digest = rate_limit_digest(secret=secret, scope="email", value=email_normalized)
    ip_limit = _configured_int("KODERA_PASSPORT_IP_RATE_LIMIT", DEFAULT_IP_LIMIT)
    email_limit = _configured_int("KODERA_PASSPORT_EMAIL_RATE_LIMIT", DEFAULT_EMAIL_LIMIT)
    window = timedelta(seconds=RATE_WINDOW_SECONDS)

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(739184625)")
        now = _database_now()
        horizon = now - window
        PassportRateLimitEvent.objects.filter(occurred_at__lte=horizon).delete()
        PassportMagicLinkToken.objects.filter(expires_at__lte=horizon).delete()
        if PassportRateLimitEvent.objects.count() >= MAX_RATE_EVENTS:
            raise RuntimeError("passport rate-limit capacity exhausted")

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
            # Record the IP attempt so distributed email spraying still burns IP quota,
            # and return a generic `passport` scope so email bucket state cannot enumerate users.
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
    """Resolve an enabled, undeleted User matching normalized email without cross-linking rows."""
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
    if len(matched) == 1:
        return matched[0]
    for candidate in matched:
        if passport_memberships(user_id=candidate.id):
            return candidate
    return matched[0]


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
        PassportWorkspaceContext.objects.update_or_create(
            user_id=person.id,
            defaults={
                "active_organisation_id": active_org_id,
                "active_workspace_id": active_ws_id,
            },
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


def _audit_identity_for_user(
    *, user_id: UUID, active_organisation_id: UUID | None
) -> tuple[UUID, str] | None:
    """Find a usable customer Identity `(identity_id, realm)` of `user_id` for audit attribution."""
    if active_organisation_id is not None:
        bound = (
            Identity.objects.filter(
                user_id=user_id,
                organisation_id=active_organisation_id,
                enabled=True,
                deleted_at__isnull=True,
            )
            .order_by("id")
            .values_list("id", "realm")
            .first()
        )
        if bound is not None:
            return bound[0], bound[1]
    fallback = (
        Identity.objects.filter(
            user_id=user_id,
            organisation__isnull=False,
            enabled=True,
            deleted_at__isnull=True,
        )
        .order_by("id")
        .values_list("id", "realm")
        .first()
    )
    if fallback is not None:
        return fallback[0], fallback[1]
    return None


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

    quota = _charge_rate_limits(peer=peer, email_normalized=email_normalized)
    raw_token, token_sha256 = generate_magic_link_token()

    sink = on_issue or getattr(settings, "KODERA_PASSPORT_DELIVERY_SINK", None)
    with transaction.atomic():
        now = _database_now()
        expires_at = now + timedelta(seconds=MAGIC_LINK_TTL_SECONDS)
        PassportMagicLinkToken.objects.create(
            token_sha256=token_sha256,
            email_normalized=email_normalized,
            domain_normalized=domain_normalized,
            code_challenge=code_challenge,
            code_challenge_method=code_challenge_method,
            device_challenge_sha256=device_challenge_sha256,
            expires_at=expires_at,
        )
        has_eligible_user = _select_user_for_email(email_normalized) is not None
        if callable(sink) and has_eligible_user:
            delivery = PassportMagicLinkDelivery(
                email_normalized=email_normalized,
                raw_token=raw_token,
                expires_at=expires_at,
            )
            transaction.on_commit(lambda: sink(delivery))

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
                user = _select_user_for_email(row.email_normalized)
                if user is None:
                    refused = True
                else:
                    person = PersonSnapshot(user.id, user.email, user.display_name)
                    memberships = passport_memberships(user_id=person.id)
                    directory = _build_directory(
                        person=person,
                        memberships=memberships,
                        preferred_organisation_id=None,
                        persist_context=True,
                    )
                    audit_identity = _audit_identity_for_user(
                        user_id=person.id,
                        active_organisation_id=directory.active_organisation_id,
                    )
                    if audit_identity is not None:
                        identity_id, realm = audit_identity
                        amr = (
                            ("magic_link", "pkce", "device")
                            if row.device_challenge_sha256 is not None
                            else ("magic_link", "pkce")
                        )
                        record_passport_login_succeeded(
                            identity_id=identity_id,
                            organisation_id=directory.active_organisation_id,
                            realm=realm,
                            amr=amr,
                            request_id=request_id,
                        )
                    session_token = issue_passport_session_token(
                        secret=passport_secret(),
                        user_id=person.id,
                        active_organisation_id=directory.active_organisation_id,
                        now=int(now.timestamp()),
                    )
                    return PassportVerifiedSession(
                        directory=directory,
                        session_token=session_token,
                        expires_in_seconds=PASSPORT_SESSION_TTL_SECONDS,
                    )

    if refused:
        raise PassportUnauthorizedError()
    raise PassportUnauthorizedError()  # pragma: no cover


def _resolve_principal(
    *,
    verified: VerifiedAccessToken | None,
    session_claims: PassportSessionClaims | None,
) -> tuple[PersonSnapshot, UUID | None, UUID | None]:
    """Resolve `(person, preferred_organisation_id, caller_identity_id)` or raise `UnknownCustomerError`."""
    if verified is not None:
        if not is_storable_subject(verified.subject):
            raise UnknownCustomerError()
        resolved = current_identity(issuer=verified.issuer, subject=verified.subject)
        if resolved is None:
            raise UnknownCustomerError()
        person, identity = resolved
        return person, identity.organisation_id, identity.id

    if session_claims is not None:
        user = User.objects.filter(
            id=session_claims.user_id,
            enabled=True,
            deleted_at__isnull=True,
        ).first()
        if user is None:
            raise UnknownCustomerError()
        person = PersonSnapshot(user.id, user.email, user.display_name)
        audit_identity = _audit_identity_for_user(
            user_id=person.id,
            active_organisation_id=session_claims.active_organisation_id,
        )
        caller_identity_id = None if audit_identity is None else audit_identity[0]
        return person, session_claims.active_organisation_id, caller_identity_id

    raise UnknownCustomerError()


def list_passport_workspaces(
    *,
    verified: VerifiedAccessToken | None = None,
    session_claims: PassportSessionClaims | None = None,
) -> PassportWorkspaceDirectory:
    """List active workspaces across realms for an authenticated Passport or OIDC customer."""
    with transaction.atomic():
        person, preferred_org_id, _ = _resolve_principal(
            verified=verified,
            session_claims=session_claims,
        )
        memberships = passport_memberships(user_id=person.id)
        # Stored context takes precedence over token's originating realm if already chosen.
        stored = PassportWorkspaceContext.objects.filter(user_id=person.id).first()
        effective_pref = stored.active_organisation_id if stored is not None else preferred_org_id
        return _build_directory(
            person=person,
            memberships=memberships,
            preferred_organisation_id=effective_pref,
            persist_context=False,
        )


def switch_passport_workspace(
    *,
    verified: VerifiedAccessToken | None = None,
    session_claims: PassportSessionClaims | None = None,
    raw_body: bytes,
    content_type: str | None,
    request_id: str,
) -> PassportSwitchedWorkspace:
    """Switch active workspace context with strict membership authorization and audit trail."""
    person, origin_org_id, caller_identity_id = _resolve_principal(
        verified=verified,
        session_claims=session_claims,
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

    memberships = passport_memberships(user_id=person.id)
    matching = next((m for m in memberships if m.organisation_id == target_org_id), None)
    if matching is None:
        slug = organisation_slug_or_none(organisation_id=target_org_id)
        target_urn = (
            f"urn:kodera:organisation:{slug}"
            if slug is not None
            else f"urn:kodera:organisation:{target_org_id}"
        )
        with transaction.atomic():
            record_authz_denied(
                actor_type="tenant",
                actor_id=caller_identity_id,
                organisation_id=origin_org_id,
                target_urn=target_urn,
                request_id=request_id,
                required_scope="identity:act",
                reason="role_missing",
            )
        raise PassportForbiddenError()

    with transaction.atomic():
        now = _database_now()
        directory = _build_directory(
            person=person,
            memberships=memberships,
            preferred_organisation_id=target_org_id,
            persist_context=True,
        )
        switched = next(
            entry for entry in directory.workspaces if entry.organisation_id == target_org_id
        )
        audit_identity = _audit_identity_for_user(
            user_id=person.id,
            active_organisation_id=target_org_id,
        )
        if audit_identity is not None:
            identity_id, _ = audit_identity
            record_passport_login_succeeded(
                identity_id=identity_id,
                organisation_id=target_org_id,
                realm=matching.realm,
                amr=("passport_switch",),
                request_id=request_id,
            )
        session_token = issue_passport_session_token(
            secret=passport_secret(),
            user_id=person.id,
            active_organisation_id=target_org_id,
            now=int(now.timestamp()),
        )
        return PassportSwitchedWorkspace(
            active_organisation_id=target_org_id,
            active_workspace_id=directory.active_workspace_id,
            workspace=switched,
            session_token=session_token,
            expires_in_seconds=PASSPORT_SESSION_TTL_SECONDS,
        )
