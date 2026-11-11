"""Explicit canonical community provisioning and membership, isolated from tenant grants."""

from uuid import UUID

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.identity.community import (
    CommunityPrincipal,
    bind_proven_community_identity,
    community_identity,
    materialize_community_identity,
    require_enabled_person,
)
from apps.identity.selectors import is_storable_subject
from apps.tenancy.community import provision_community_tenant
from apps.workspaces.community import (
    CommunityWorkspace,
    provision_community_workspace,
    refresh_staff_grants,
)
from services.identity.access_tokens import VerifiedAccessToken
from services.identity.trusted_issuers import is_trusted_issuer

from .models import Membership, Organisation, SlugReservation


def configured_slug() -> str:
    value = getattr(settings, "KODERA_DEFAULT_COMMUNITY_ORG_SLUG", "")
    if value not in ("", "community"):
        raise ValueError("The canonical community slug must be community or unset")
    return value


def canonical_community() -> Organisation | None:
    slug = configured_slug()
    if not slug:
        return None
    return Organisation.objects.filter(
        slug=slug,
        issuer=getattr(settings, "KODERA_DEFAULT_COMMUNITY_ISSUER", ""),
        is_default_community=True,
        deleted_at__isnull=True,
        state="active",
    ).first()


def is_community(organisation_id: UUID) -> bool:
    community = canonical_community()
    return community is not None and community.id == organisation_id


@transaction.atomic
def bootstrap_community_workspace(*, owner_user_id: UUID | None = None) -> CommunityWorkspace:
    """Repeatable operator step; never creates an owner account or a remote room."""
    if not configured_slug():
        raise ValueError("KODERA_DEFAULT_COMMUNITY_ORG_SLUG must be configured")
    issuer = getattr(settings, "KODERA_DEFAULT_COMMUNITY_ISSUER", "")
    if not issuer.endswith("/realms/community") or not is_trusted_issuer(
        issuer, trusted=settings.KODERA_AUTH_TRUST
    ):
        raise ValueError("The exact community issuer must be configured and trusted")
    # One stable transaction lock serializes first creation, including its reserved slug.
    from apps.jobs.kinds import Lock
    from apps.jobs.locks import lock_for_transaction

    lock_for_transaction(Lock("organisation", UUID(int=0), "exclusive"))
    organisation = Organisation.objects.select_for_update().filter(slug="community").first()
    if organisation is None:
        if owner_user_id is None:
            raise ValueError("First bootstrap requires an existing enabled owner user")
        require_enabled_person(owner_user_id)
        organisation = Organisation.objects.create(
            slug="community",
            realm="community",
            issuer=issuer,
            name="Kodera Community",
            state="active",
            is_default_community=True,
        )
        SlugReservation.objects.create(
            organisation=organisation,
            slug="community",
            state="permanent",
            protected_at=timezone.now(),
        )
        Membership.objects.create(
            user_id=owner_user_id,
            organisation=organisation,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
    elif (
        not organisation.is_default_community
        or organisation.issuer != issuer
        or organisation.state != "active"
        or organisation.deleted_at is not None
    ):
        raise ValueError("Existing community binding must be reconciled by an operator")
    provision_community_tenant(organisation_id=organisation.id)
    workspace = provision_community_workspace(
        organisation_id=organisation.id, administrator_ids=_administrator_ids(organisation.id)
    )
    from .member_set_hooks import member_set_changed

    member_set_changed(organisation_id=organisation.id, reason="community_bootstrap")
    return workspace


@transaction.atomic
def ensure_community_membership(*, verified: VerifiedAccessToken) -> Membership | None:
    """Only verified issuer/subject identify a person; never link people by email.

    Existing revoked, suspended or deleted memberships are retained and never revived.
    Public signup materialization is confined to the canonical realm and verified email.
    """
    community = canonical_community()
    if community is None or not is_storable_subject(verified.subject):
        return None
    # Serialize membership bootstrap and signup identity creation across process races.
    community = Organisation.objects.select_for_update().get(id=community.id)
    principal = community_identity(verified)
    if principal is None:
        principal = materialize_community_identity(
            verified=verified,
            organisation_id=community.id,
            issuer=community.issuer,
            realm=community.realm,
        )
    if principal is None:
        return None
    membership = (
        Membership.objects.filter(user_id=principal.user_id, organisation=community)
        .order_by("-created_at")
        .first()
    )
    if membership is not None:
        return membership
    membership = Membership.objects.create(
        user_id=principal.user_id,
        organisation=community,
        role="org_member",
        state="active",
        accepted_at=timezone.now(),
    )
    from .member_set_hooks import member_set_changed

    member_set_changed(organisation_id=community.id, reason="community_signup")
    return membership


def community_member(
    *, verified: VerifiedAccessToken
) -> tuple[CommunityPrincipal, Membership] | None:
    """Current persisted authority only; safe within a caller's read-only snapshot."""
    community = canonical_community()
    if community is None:
        return None
    principal = community_identity(verified)
    if community is None or principal is None:
        return None
    member = Membership.objects.filter(
        user_id=principal.user_id,
        organisation=community,
        state="active",
        accepted_at__isnull=False,
        deleted_at__isnull=True,
    ).first()
    return None if member is None else (principal, member)


@transaction.atomic
def bind_community_identity(*, user_id: UUID, subject: str) -> CommunityPrincipal:
    """Operator-only binding after proof of control of both accounts; never email matching."""
    community = canonical_community()
    if community is None or not is_storable_subject(subject):
        raise ValueError("An active community and a valid realm subject are required")
    Organisation.objects.select_for_update().get(id=community.id)
    require_enabled_person(user_id)
    member = Membership.objects.filter(
        user_id=user_id, organisation=community, state="active", deleted_at__isnull=True
    ).first()
    if member is None:
        raise ValueError("The person requires an active community membership")
    principal = bind_proven_community_identity(
        user_id=user_id,
        subject=subject,
        organisation_id=community.id,
        issuer=community.issuer,
        realm=community.realm,
    )
    from .member_set_hooks import member_set_changed

    member_set_changed(organisation_id=community.id, reason="community_identity_bound")
    return principal


def refresh_community_staff_grants(organisation_id: UUID) -> None:
    """Keep managed staff-category grants aligned with current administrator roles."""
    if not is_community(organisation_id):
        return
    refresh_staff_grants(
        organisation_id=organisation_id, administrator_ids=_administrator_ids(organisation_id)
    )


def _administrator_ids(organisation_id: UUID) -> tuple[UUID, ...]:
    return tuple(
        Membership.objects.filter(
            organisation_id=organisation_id,
            role__in=("org_owner", "org_admin"),
            state="active",
            deleted_at__isnull=True,
        ).values_list("id", flat=True)
    )
