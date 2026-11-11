"""The tenant caller of an organisation-scoped operation, read in the caller's transaction.

Unlike `authority_selectors`, whose readers keep the active-organisation limit of the content
policy, this reader admits a `suspended` organisation as well: a suspended organisation may still
be read (docs/api/AUTHZ.md §2 step 8), and a mutation on it is refused by the operation's own state
check, with the state the operation needs (docs/specs/PILOT_WORKSPACE_ONBOARDING.md §§3, 6).
"""

from dataclasses import dataclass
from uuid import UUID

from django.db import connection

from apps.identity.selectors import current_identity, is_storable_subject
from services.identity.access_tokens import VerifiedAccessToken

from .models import Organisation
from .selectors import current_membership, has_current_read_grant


class TenantCallerUnknownError(Exception):
    """No enabled identity for the verified `(iss, sub)`: Core does not know the caller."""


class TenantCallerNotFoundError(Exception):
    """The organisation is not the caller's, or the caller holds no current membership in it."""


@dataclass(frozen=True, slots=True, repr=False)
class TenantCaller:
    organisation_id: UUID
    organisation_state: str
    issuer: str
    authority_revision: int
    identity_id: UUID
    membership_id: UUID
    role: str


def read_tenant_caller(
    *, verified: VerifiedAccessToken, organisation_id: UUID, allow_community: bool = False
) -> TenantCaller:
    """The caller's current membership in `organisation_id`, of an active or suspended
    organisation. The caller owns the transaction; nothing here is a permission to cache."""
    if not connection.in_atomic_block:
        raise RuntimeError("the tenant caller is read in the caller's transaction")
    if not is_storable_subject(verified.subject):
        raise TenantCallerUnknownError()
    from .community import community_member, is_community

    if allow_community and is_community(organisation_id):
        shared = community_member(verified=verified)
        if shared is None:
            raise TenantCallerNotFoundError()
        principal, membership = shared
        shared_organisation = membership.organisation
        return TenantCaller(
            organisation_id=shared_organisation.id,
            organisation_state=shared_organisation.state,
            issuer=shared_organisation.issuer,
            authority_revision=shared_organisation.authority_revision,
            identity_id=principal.id,
            membership_id=membership.id,
            role=membership.role,
        )
    resolved = current_identity(issuer=verified.issuer, subject=verified.subject)
    if resolved is None:
        raise TenantCallerUnknownError()
    person, identity = resolved
    if identity.organisation_id != organisation_id:
        raise TenantCallerNotFoundError()
    if not has_current_read_grant(
        user_id=person.id,
        organisation_id=organisation_id,
        issuer=identity.issuer,
        realm=identity.realm,
    ):
        raise TenantCallerNotFoundError()
    member = current_membership(user_id=person.id, organisation_id=organisation_id)
    organisation = (
        Organisation.objects.filter(
            id=organisation_id,
            issuer=identity.issuer,
            realm=identity.realm,
            deleted_at__isnull=True,
        )
        .values_list("state", "authority_revision")
        .first()
    )
    if member is None or organisation is None:
        raise TenantCallerNotFoundError()
    return TenantCaller(
        organisation_id=organisation_id,
        organisation_state=organisation[0],
        issuer=identity.issuer,
        authority_revision=organisation[1],
        identity_id=identity.id,
        membership_id=member[0],
        role=member[1],
    )


def organisation_slug(*, organisation_id: UUID) -> str | None:
    """The organisation's slug, its URN identifier (AUDIT_TAXONOMY.md §2), or None when absent."""
    slug: str | None = (
        Organisation.objects.filter(id=organisation_id).values_list("slug", flat=True).first()
    )
    return slug


def organisation_name_and_slug(*, organisation_id: UUID) -> tuple[str, str] | None:
    """The organisation's name and slug, as a support ticket's mail shows them, or None."""
    found: tuple[str, str] | None = (
        Organisation.objects.filter(id=organisation_id).values_list("name", "slug").first()
    )
    return found


def organisation_state(*, organisation_id: UUID) -> str | None:
    """The organisation's stored state, or None when it is absent or deleted."""
    state: str | None = (
        Organisation.objects.filter(id=organisation_id, deleted_at__isnull=True)
        .values_list("state", flat=True)
        .first()
    )
    return state


def organisation_authority_revision(*, organisation_id: UUID) -> int | None:
    """The organisation's stored authority revision, or None when it is absent or deleted."""
    revision: int | None = (
        Organisation.objects.filter(id=organisation_id, deleted_at__isnull=True)
        .values_list("authority_revision", flat=True)
        .first()
    )
    return revision
