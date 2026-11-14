"""Kodera Bearer token authentication & tenant membership authority for Enterprise admin endpoints.

Authenticates callers via the core Kodera OIDC Bearer verifier (`verify_configured_token` +
`lanes.admit`), resolves the active `User`, `Identity`, `Organisation`, and accepted `Membership`,
and enforces strict tenant isolation (`403` on cross-tenant `tenant_slug` mismatch) and role-based
authorization (`org_owner` / `org_admin`).

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final
from uuid import UUID

from apps.identity.selectors import current_identity, is_storable_subject
from apps.orgs.models import Membership, Organisation
from apps.orgs.selectors import has_current_read_grant
from django.conf import settings
from django.http import HttpRequest

from core.api import lanes
from services.identity.access_tokens import MAX_TOKEN, TokenVerificationError
from services.identity.trusted_issuers import TrustedIssuer, verify_configured_token

ADMIN_ROLES: Final[frozenset[str]] = frozenset({Membership.Role.OWNER, Membership.Role.ADMIN})
OWNER_ROLES: Final[frozenset[str]] = frozenset({Membership.Role.OWNER})


class EeAuthError(PermissionError):
    """Structured authentication (`401`) or authorization (`403`) failure for Enterprise endpoints."""

    def __init__(self, code: str, *, status: int = 403) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass(frozen=True, slots=True)
class AuthenticatedTenantPrincipal:
    organisation_id: UUID
    tenant_slug: str
    user_id: UUID
    identity_id: UUID
    membership_id: UUID
    role: str
    email: str
    issuer: str
    subject: str


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
    """Verify Kodera customer Bearer token and enforce active tenant `Organisation` + `Membership`."""
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

    resolved = current_identity(issuer=verified.issuer, subject=verified.subject)
    if resolved is None:
        raise EeAuthError("identity_unknown", status=403)
    person, identity = resolved

    if not has_current_read_grant(
        user_id=person.id,
        organisation_id=identity.organisation_id,
        issuer=identity.issuer,
        realm=identity.realm,
    ):
        raise EeAuthError("tenant_membership_required", status=403)

    org = (
        Organisation.objects.filter(
            id=identity.organisation_id,
            issuer=identity.issuer,
            realm=identity.realm,
            state=Organisation.State.ACTIVE,
            deleted_at__isnull=True,
        )
        .only("id", "slug", "realm", "issuer", "state")
        .first()
    )
    membership = (
        Membership.objects.filter(
            user_id=person.id,
            organisation_id=identity.organisation_id,
            state=Membership.State.ACTIVE,
            accepted_at__isnull=False,
            deleted_at__isnull=True,
        )
        .only("id", "role", "state", "accepted_at")
        .first()
    )
    if org is None or membership is None:
        raise EeAuthError("tenant_membership_required", status=403)

    if target_tenant_slug is not None and target_tenant_slug != org.slug:
        raise EeAuthError("cross_tenant_forbidden", status=403)

    if membership.role not in required_roles:
        raise EeAuthError("insufficient_role", status=403)

    return AuthenticatedTenantPrincipal(
        organisation_id=org.id,
        tenant_slug=org.slug,
        user_id=person.id,
        identity_id=identity.id,
        membership_id=membership.id,
        role=membership.role,
        email=person.email,
        issuer=verified.issuer,
        subject=verified.subject,
    )
