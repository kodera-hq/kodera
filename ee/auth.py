"""Kodera Bearer token authentication, single-snapshot authority & cutoff fencing for EE endpoints.

Authenticates callers via the core Kodera OIDC Bearer verifier (`verify_configured_token` +
`lanes.admit`), resolves `MemberAuthorityFacts` inside a single owned `REPEATABLE READ READ ONLY`
snapshot (`apps.orgs.authority_selectors.resolve_member_authority`), and fences every privileged
Enterprise read/export/write operation against concurrent `authority_revision` changes and
organisation/account privacy erasure cutoffs.

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Final
from uuid import UUID

from apps.identity.selectors import current_identity, is_storable_subject
from apps.orgs.authority_selectors import (
    MemberAuthorityNotFoundError,
    MemberAuthorityUnavailableError,
    resolve_member_authority,
)
from apps.orgs.models import Membership
from django.conf import settings
from django.db import DatabaseError, connection, transaction
from django.http import HttpRequest

from core.api import lanes
from ee.store import is_retriable_lock_contention
from services.identity.access_tokens import MAX_TOKEN, TokenVerificationError
from services.identity.trusted_issuers import TrustedIssuer, verify_configured_token

ADMIN_ROLES: Final[frozenset[str]] = frozenset({Membership.Role.OWNER, Membership.Role.ADMIN})
OWNER_ROLES: Final[frozenset[str]] = frozenset({Membership.Role.OWNER})


class EeAuthError(PermissionError):
    """Structured authentication (`401`), authorization (`403`), or fence (`409`/`503`) failure."""

    def __init__(self, code: str, *, status: int = 403) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass(frozen=True, slots=True)
class AuthenticatedTenantPrincipal:
    """Single-snapshot authority facts for one HTTP request; never cached across requests."""

    organisation_id: UUID
    tenant_slug: str
    realm: str
    user_id: UUID
    identity_id: UUID
    membership_id: UUID
    role: str
    authority_revision: int
    issuer: str
    subject: str


@dataclass(frozen=True, slots=True)
class FencedTenantOperation:
    """Verified live authority + privacy-cutoff fence inside an active database transaction."""

    organisation_id: UUID
    tenant_slug: str
    user_id: UUID
    identity_id: UUID
    membership_id: UUID
    role: str
    authority_revision: int
    actor_email: str


def _extract_bearer_token(request: HttpRequest) -> str:
    authorization = request.headers.get("Authorization", "")
    if not authorization or len(authorization) > MAX_TOKEN + 7:
        raise EeAuthError("unauthenticated", status=401)
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise EeAuthError("unauthenticated", status=401)
    return parts[1]


def authenticate_tenant_request(
    request: HttpRequest,
    *,
    required_roles: frozenset[str] = ADMIN_ROLES,
    target_tenant_slug: str | None = None,
) -> AuthenticatedTenantPrincipal:
    """Verify Kodera customer Bearer token via a single `resolve_member_authority` snapshot."""
    compact_token = _extract_bearer_token(request)
    trusted: tuple[TrustedIssuer, ...] = getattr(settings, "KODERA_AUTH_TRUST", ())
    if not trusted:
        raise EeAuthError("unauthenticated", status=401)

    try:
        verified, lane = verify_configured_token(compact_token, trusted=trusted)
        verified, lane = lanes.admit(verified, lane)
    except TokenVerificationError as exc:
        raise EeAuthError("unauthenticated", status=401) from exc

    if lane != "customer":
        raise EeAuthError("forbidden_lane", status=403)

    if not is_storable_subject(verified.subject):
        raise EeAuthError("identity_unknown", status=403)

    try:
        facts = resolve_member_authority(verified=verified)
    except MemberAuthorityUnavailableError as exc:
        raise EeAuthError("authority_unavailable", status=503) from exc
    except MemberAuthorityNotFoundError as exc:
        if current_identity(issuer=verified.issuer, subject=verified.subject) is None:
            raise EeAuthError("identity_unknown", status=403) from exc
        raise EeAuthError("tenant_membership_required", status=403) from exc

    if target_tenant_slug is not None and target_tenant_slug != facts.realm:
        raise EeAuthError("cross_tenant_forbidden", status=403)

    if facts.stored_role not in required_roles:
        raise EeAuthError("insufficient_role", status=403)

    return AuthenticatedTenantPrincipal(
        organisation_id=facts.organisation_id,
        tenant_slug=facts.realm,
        realm=facts.realm,
        user_id=facts.user_id,
        identity_id=facts.identity_id,
        membership_id=facts.membership_id,
        role=facts.stored_role,
        authority_revision=facts.authority_revision,
        issuer=facts.issuer,
        subject=facts.subject,
    )


@contextmanager
def fence_authenticated_ee_operation(
    principal: AuthenticatedTenantPrincipal,
    *,
    required_roles: frozenset[str] = ADMIN_ROLES,
    target_tenant_slug: str | None = None,
) -> Iterator[FencedTenantOperation]:
    """Execute a privileged EE read/export/write inside a cutoff- and revision-fenced transaction.

    Acquires shared privacy-erasure advisory locks (`privacy_account_cutoff` and
    `privacy_erasure_cutoff`), locks `identity_user` with `FOR SHARE`, and locks dependent
    `orgs_organisation` and `orgs_membership` rows with `FOR SHARE ... NOWAIT` so reverse-order
    membership tuple writes never stall in a lock cycle or surface HTTP 500s. Any PostgreSQL
    `55P03`/`40P01`/`40001` contention rolls back `transaction.atomic()` first and translates
    outside the aborted transaction into a retriable `EeAuthError("authority_fenced", status=409)`.
    """
    if target_tenant_slug is not None and target_tenant_slug != principal.tenant_slug:
        raise EeAuthError("cross_tenant_forbidden", status=403)

    try:
        with transaction.atomic():
            with connection.cursor() as cur:
                cur.execute(
                    "SELECT pg_advisory_xact_lock_shared("
                    "hashtextextended('privacy_account_cutoff:' || %s, 0))",
                    [str(principal.user_id)],
                )
                cur.execute(
                    "SELECT pg_advisory_xact_lock_shared("
                    "hashtextextended('privacy_erasure_cutoff:' || %s, 0))",
                    [str(principal.organisation_id)],
                )

                # Root lock: User (`FOR SHARE`). Dependent Organisation and Membership locks use
                # `FOR SHARE ... NOWAIT` so an in-flight `membership_lifecycle` update holding the
                # Membership tuple lock while waiting for User inside its BEFORE trigger fails fast
                # with `55P03`, rolls back immediately, and returns a typed `409 authority_fenced`.
                cur.execute(
                    """
                    SELECT u.email, u.enabled, u.deleted_at
                    FROM public.identity_user u
                    WHERE u.id = %s
                    FOR SHARE OF u
                    """,
                    [principal.user_id],
                )
                u_row = cur.fetchone()
                if u_row is None or u_row[2] is not None or str(u_row[0]).startswith("erased:"):
                    raise EeAuthError("account_cutoff_fenced", status=403)
                if not bool(u_row[1]):
                    raise EeAuthError("authority_fenced", status=409)
                actor_email = str(u_row[0])

                cur.execute(
                    """
                    SELECT o.slug, o.state, o.deleted_at, o.authority_revision
                    FROM public.orgs_organisation o
                    WHERE o.id = %s
                    FOR SHARE OF o NOWAIT
                    """,
                    [principal.organisation_id],
                )
                o_row = cur.fetchone()
                if o_row is None or str(o_row[1]) != "active" or o_row[2] is not None:
                    raise EeAuthError("tenant_cutoff_fenced", status=403)
                live_authority_revision = int(o_row[3])
                if (
                    str(o_row[0]) != principal.tenant_slug
                    or live_authority_revision != principal.authority_revision
                ):
                    raise EeAuthError("authority_fenced", status=409)

                cur.execute(
                    """
                    SELECT m.role
                    FROM public.orgs_membership m
                    WHERE m.id = %s
                      AND m.organisation_id = %s
                      AND m.user_id = %s
                      AND m.state = 'active'
                      AND m.accepted_at IS NOT NULL
                      AND m.deleted_at IS NULL
                    FOR SHARE OF m NOWAIT
                    """,
                    [principal.membership_id, principal.organisation_id, principal.user_id],
                )
                m_row = cur.fetchone()
                if m_row is None:
                    raise EeAuthError("authority_fenced", status=409)
                live_role = str(m_row[0])
                if live_role != principal.role or live_role not in required_roles:
                    raise EeAuthError("authority_fenced", status=409)

                cur.execute(
                    """
                    SELECT 1
                    FROM public.identity_identity i
                    WHERE i.id = %s
                      AND i.organisation_id = %s
                      AND i.user_id = %s
                      AND i.deleted_at IS NULL
                    """,
                    [principal.identity_id, principal.organisation_id, principal.user_id],
                )
                if cur.fetchone() is None:
                    raise EeAuthError("authority_fenced", status=409)

            yield FencedTenantOperation(
                organisation_id=principal.organisation_id,
                tenant_slug=principal.tenant_slug,
                user_id=principal.user_id,
                identity_id=principal.identity_id,
                membership_id=principal.membership_id,
                role=live_role,
                authority_revision=live_authority_revision,
                actor_email=actor_email,
            )
    except DatabaseError as exc:
        if is_retriable_lock_contention(exc):
            raise EeAuthError("authority_fenced", status=409) from exc
        raise
