"""Workspace-owned canonical template provisioning and explicit staff policy grants."""

from dataclasses import dataclass
from uuid import UUID

from services.identity.access_tokens import VerifiedAccessToken

from .channel_access import READ_ONLY
from .models import Category, Channel, ResourcePolicy, ResourcePolicyRule, Workspace


@dataclass(frozen=True, slots=True)
class CommunityWorkspace:
    id: UUID
    organisation_id: UUID


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


def provision_community_workspace(
    *, organisation_id: UUID, administrator_ids: tuple[UUID, ...]
) -> CommunityWorkspace:
    workspace, _ = Workspace.objects.get_or_create(organisation_id=organisation_id)
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
            for membership_id in administrator_ids:
                ResourcePolicyRule.objects.get_or_create(
                    policy=category.default_policy, kind="allow_member", membership_id=membership_id
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
    return CommunityWorkspace(workspace.id, organisation_id)


def refresh_staff_grants(*, organisation_id: UUID, administrator_ids: tuple[UUID, ...]) -> None:
    category = Category.objects.filter(
        workspace__organisation_id=organisation_id, template_key="core_kodera"
    ).first()
    if category is None or category.default_policy_id is None:
        return
    wanted = set(administrator_ids)
    rules = ResourcePolicyRule.objects.filter(
        policy_id=category.default_policy_id, kind="allow_member"
    )
    rules.exclude(membership_id__in=wanted).delete()
    for membership_id in wanted:
        ResourcePolicyRule.objects.get_or_create(
            policy_id=category.default_policy_id, kind="allow_member", membership_id=membership_id
        )


def prepare_community_read(*, organisation_id: UUID, verified: VerifiedAccessToken) -> bool:
    """Prepare only canonical membership and report the narrowly admitted shared workspace."""
    from apps.orgs.community import ensure_community_membership, is_community

    shared = is_community(organisation_id)
    if shared:
        ensure_community_membership(verified=verified)
    return shared
