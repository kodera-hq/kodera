"""Explicit canonical community provisioning and membership, isolated from tenant grants."""

from uuid import UUID

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import transaction
from django.utils import timezone

from apps.identity.models import Identity, User
from apps.identity.selectors import is_storable_subject
from apps.tenancy.models import Tenant
from apps.workspaces.channel_access import READ_ONLY
from apps.workspaces.models import Category, Channel, ResourcePolicy, ResourcePolicyRule, Workspace
from services.identity.access_tokens import VerifiedAccessToken
from services.identity.trusted_issuers import is_trusted_issuer

from .models import Membership, Organisation, SlugReservation

CATEGORIES = (
    (
        "community",
        "Community",
        (
            "announcements",
            "general",
            "developers-community",
            "support",
            "extensions",
            "self-hosting",
            "show-and-tell",
            "office-hours",
        ),
    ),
    ("core_kodera", "Core Kodera", ("dev", "strategy", "ops-oncall", "kodera-git-tracker")),
    ("design_partners", "Design Partners", ("partner-dinum", "partner-octo")),
)


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
def bootstrap_community_workspace(*, owner_user_id: UUID | None = None) -> Workspace:
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
        owner = User.objects.get(id=owner_user_id, enabled=True, deleted_at__isnull=True)
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
            user=owner,
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
    tenant, _ = Tenant.objects.get_or_create(
        slug="community",
        defaults={
            "organisation": organisation,
            "is_default_community": True,
            "name": "Kodera Community",
            "status": "provisioning",
            "status_changed_at": timezone.now(),
            "pack_code": "workspace",
            "capacity_tier_code": "S",
            "apps": ["messaging"],
            "realm": "community",
            "locale": "en",
        },
    )
    if (
        not tenant.is_default_community
        or tenant.organisation_id != organisation.id
        or tenant.realm != "community"
        or tenant.apps != ["messaging"]
        or tenant.status in {"deleted", "decommissioning"}
    ):
        raise ValueError("Existing community tenant binding requires operator reconciliation")
    workspace, _ = Workspace.objects.get_or_create(organisation=organisation)
    if workspace.default_policy_id is None:
        workspace.default_policy = ResourcePolicy.objects.create(
            workspace=workspace, visibility="organisation"
        )
        workspace.save(update_fields=["default_policy"])
    for position, (key, name, channels) in enumerate(CATEGORIES):
        category, _ = Category.objects.get_or_create(
            workspace=workspace, template_key=key, defaults={"name": name, "position": position}
        )
        if category.default_policy_id is None:
            category.default_policy = ResourcePolicy.objects.create(
                workspace=workspace,
                visibility="organisation" if key == "community" else "restricted",
            )
            category.save(update_fields=["default_policy"])
        expected_visibility = "organisation" if key == "community" else "restricted"
        if (
            category.default_policy is None
            or category.default_policy.visibility != expected_visibility
        ):
            raise ValueError("Canonical category policy drift requires operator reconciliation")
        if key == "core_kodera":
            # Explicit administrator membership grants; ordinary signup never promotes staff roles.
            for member in Membership.objects.filter(
                organisation=organisation,
                role__in=("org_owner", "org_admin"),
                state="active",
                deleted_at__isnull=True,
            ):
                ResourcePolicyRule.objects.get_or_create(
                    policy=category.default_policy, kind="allow_member", membership=member
                )
        for index, channel_name in enumerate(channels):
            channel, created = Channel.objects.get_or_create(
                workspace=workspace,
                template_key=channel_name.replace("-", "_"),
                defaults={
                    "category": category,
                    "position": index,
                    "name": channel_name,
                    "kind": "audio" if channel_name == "office-hours" else "text",
                    "lifecycle": "active",
                },
            )
            expected_kind = "audio" if channel_name == "office-hours" else "text"
            expected_mode = "explicit" if channel_name == "announcements" else "inherit"
            if (
                channel.category_id != category.id
                or channel.kind != expected_kind
                or channel.lifecycle != "active"
                or (not created and channel.policy_mode != expected_mode)
            ):
                raise ValueError("Canonical channel drift requires operator reconciliation")
            if channel_name == "announcements":
                if channel.explicit_policy_id is None:
                    channel.explicit_policy = ResourcePolicy.objects.create(
                        workspace=workspace, visibility="organisation"
                    )
                    channel.policy_mode = "explicit"
                    channel.save(update_fields=["explicit_policy", "policy_mode"])
                if (
                    channel.explicit_policy is None
                    or channel.explicit_policy.visibility != "organisation"
                ):
                    raise ValueError("Canonical announcement policy drift requires reconciliation")
                for capability in READ_ONLY:
                    ResourcePolicyRule.objects.get_or_create(
                        policy=channel.explicit_policy,
                        kind="deny_capability",
                        capability=capability,
                    )
    from .member_set_hooks import member_set_changed

    member_set_changed(organisation_id=organisation.id, reason="community_bootstrap")
    return workspace


def _identity(verified: VerifiedAccessToken) -> Identity | None:
    if not is_storable_subject(verified.subject):
        return None
    return (
        Identity.objects.select_related("user")
        .filter(
            issuer=verified.issuer,
            subject=verified.subject,
            enabled=True,
            deleted_at__isnull=True,
            user__enabled=True,
            user__deleted_at__isnull=True,
        )
        .first()
    )


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
    principal = _identity(verified)
    if principal is None:
        if Identity.objects.filter(issuer=verified.issuer, subject=verified.subject).exists():
            return None
        if verified.issuer != community.issuer or not verified.email_verified or not verified.email:
            return None
        try:
            validate_email(verified.email)
        except ValidationError:
            return None
        if len(verified.email) > 254:
            return None
        user = User.objects.create(email=verified.email)
        principal = Identity.objects.create(
            user=user,
            organisation=community,
            issuer=community.issuer,
            realm=community.realm,
            subject=verified.subject,
            email=verified.email,
        )
    membership = (
        Membership.objects.filter(user=principal.user, organisation=community)
        .order_by("-created_at")
        .first()
    )
    if membership is not None:
        return membership
    membership = Membership.objects.create(
        user=principal.user,
        organisation=community,
        role="org_member",
        state="active",
        accepted_at=timezone.now(),
    )
    from .member_set_hooks import member_set_changed

    member_set_changed(organisation_id=community.id, reason="community_signup")
    return membership


def community_member(*, verified: VerifiedAccessToken) -> tuple[Identity, Membership] | None:
    """Current persisted authority only; safe within a caller's read-only snapshot."""
    community = canonical_community()
    principal = _identity(verified)
    if community is None or principal is None:
        return None
    member = Membership.objects.filter(
        user=principal.user,
        organisation=community,
        state="active",
        accepted_at__isnull=False,
        deleted_at__isnull=True,
    ).first()
    return None if member is None else (principal, member)


@transaction.atomic
def bind_community_identity(*, user_id: UUID, subject: str) -> Identity:
    """Operator-only binding after proof of control of both accounts; never email matching."""
    community = canonical_community()
    if community is None or not is_storable_subject(subject):
        raise ValueError("An active community and a valid realm subject are required")
    Organisation.objects.select_for_update().get(id=community.id)
    user = User.objects.get(id=user_id, enabled=True, deleted_at__isnull=True)
    member = Membership.objects.filter(
        user=user, organisation=community, state="active", deleted_at__isnull=True
    ).first()
    if member is None:
        raise ValueError("The person requires an active community membership")
    principal, _ = Identity.objects.get_or_create(
        issuer=community.issuer,
        subject=subject,
        defaults={
            "user": user,
            "organisation": community,
            "realm": community.realm,
            "email": user.email,
        },
    )
    if principal.user_id != user.id or not principal.enabled or principal.deleted_at is not None:
        raise ValueError("The realm subject already has a different or disabled binding")
    from .member_set_hooks import member_set_changed

    member_set_changed(organisation_id=community.id, reason="community_identity_bound")
    return principal


def refresh_community_staff_grants(organisation_id: UUID) -> None:
    """Keep managed staff-category grants aligned with current administrator roles."""
    if not is_community(organisation_id):
        return
    category = Category.objects.filter(
        workspace__organisation_id=organisation_id, template_key="core_kodera"
    ).first()
    if category is None or category.default_policy_id is None:
        return
    administrators = Membership.objects.filter(
        organisation_id=organisation_id,
        role__in=("org_owner", "org_admin"),
        state="active",
        deleted_at__isnull=True,
    ).values_list("id", flat=True)
    wanted = set(administrators)
    rules = ResourcePolicyRule.objects.filter(
        policy_id=category.default_policy_id, kind="allow_member"
    )
    rules.exclude(membership_id__in=wanted).delete()
    for membership_id in wanted:
        ResourcePolicyRule.objects.get_or_create(
            policy_id=category.default_policy_id, kind="allow_member", membership_id=membership_id
        )
