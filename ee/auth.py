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
from django.db import connection, transaction
from django.http import HttpRequest

from core.api import lanes
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
    target_tenant_slug: str | None = None,
) -> Iterator[FencedTenantOperation]:
    """Execute a privileged EE read/export/write inside a cutoff- and revision-fenced transaction.

    Acquires shared privacy-erasure advisory locks (`privacy_account_cutoff` and
    `privacy_erasure_cutoff`), locks `identity_user` before `orgs_organisation` (`FOR KEY SHARE`),
    and verifies `authority_revision`, active membership state/role, and absence of erasure cutoffs.
    """
    if target_tenant_slug is not None and target_tenant_slug != principal.tenant_slug:
        raise EeAuthError("cross_tenant_forbidden", status=403)

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

            # Global lock order (member-authority-revision.md): User first, then Organisation.
            cur.execute(
                """
                SELECT u.email, u.enabled, u.deleted_at
                FROM public.identity_user u
                WHERE u.id = %s
                FOR KEY SHARE OF u
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
                FOR KEY SHARE OF o
                """,
                [principal.organisation_id],
            )
            o_row = cur.fetchone()
            if o_row is None or str(o_row[1]) != "active" or o_row[2] is not None:
                raise EeAuthError("tenant_cutoff_fenced", status=403)
            if (
                str(o_row[0]) != principal.tenant_slug
                or int(o_row[3]) != principal.authority_revision
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
                FOR KEY SHARE OF m
                """,
                [principal.membership_id, principal.organisation_id, principal.user_id],
            )
            m_row = cur.fetchone()
            if m_row is None or str(m_row[0]) != principal.role:
                raise EeAuthError("authority_fenced", status=409)

        yield FencedTenantOperation(
            organisation_id=principal.organisation_id,
            tenant_slug=principal.tenant_slug,
            user_id=principal.user_id,
            identity_id=principal.identity_id,
            membership_id=principal.membership_id,
            role=principal.role,
            authority_revision=principal.authority_revision,
            actor_email=actor_email,
        )
