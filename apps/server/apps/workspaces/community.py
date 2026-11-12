"""Workspace-owned canonical template provisioning and explicit staff policy grants.

The layout names rooms by what they are for. It names no organisation outside Kodera: a partner's
room is granted to the partner (`allow_member`), never named after them
(docs/specs/DEFAULT_COMMUNITY.md, "The layout").
"""

from dataclasses import dataclass
from uuid import UUID

from django.db.models import F
from django.utils import timezone

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
    ("design_partners", "Design Partners", ("partner-onboarding", "partner-feedback")),
)


# The categories whose rooms an earlier layout named differently. On a re-run, a templated channel
# of such a category whose template key the layout no longer names is that earlier room: it is
# renamed in place onto the layout's channel that does not exist yet, never left beside a new one.
RENAMED_SINCE_AN_EARLIER_LAYOUT = frozenset({"design_partners"})


def _template_key(channel_name: str) -> str:
    return channel_name.replace("-", "_")


def _rename_earlier_layout(
    workspace: Workspace, category: Category, channels: tuple[str, ...]
) -> int:
    """Rename this category's rooms of an earlier layout onto the layout's present names, in place.

    A room keeps its row, and so its id, its Matrix room, its history, its access policy, its
    position and its room state: only `name` and `template_key` change, with `version` and
    `updated_at`, what `patchChannel` changes on a rename (ESPACE_STRUCTURE.md §3). The
    engines learn the new name from the channel set the bootstrap records after provisioning.

    The earlier rooms are found by what they are, not by what they were called: templated channels
    of this category (only this provisioner sets a template key here; a room an administrator
    renamed has none and is theirs) whose key the layout no longer names. They are paired, by
    position, with the layout's channels that have no row yet. Nothing is created here and nothing
    is deleted: an earlier room with no layout name left to take stays as it is. Returns how many
    rooms were renamed; a second run finds none."""
    present = {_template_key(name) for _, _, names in CATEGORIES for name in names}
    existing = set(
        Channel.objects.filter(workspace=workspace, template_key__isnull=False).values_list(
            "template_key", flat=True
        )
    )
    earlier = list(
        Channel.objects.filter(workspace=workspace, category=category, template_key__isnull=False)
        .exclude(template_key__in=present)
        .order_by("position", "id")
    )
    missing = [name for name in channels if _template_key(name) not in existing]
    renamed = 0
    for channel, name in zip(earlier, missing, strict=False):
        renamed += Channel.objects.filter(id=channel.id).update(
            name=name,
            template_key=_template_key(name),
            version=F("version") + 1,
            updated_at=timezone.now(),
        )
    return renamed


def _free_position(workspace: Workspace, category: Category, wanted: int) -> int:
    taken = set(
        Channel.objects.filter(workspace=workspace, category=category).values_list(
            "position", flat=True
        )
    )
    return wanted if wanted not in taken else max(taken) + 1


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
        if key in RENAMED_SINCE_AN_EARLIER_LAYOUT and _rename_earlier_layout(
            workspace, category, channels
        ):
            # A structural change, as a rename through the API is (ESPACE_STRUCTURE.md §3).
            Workspace.objects.filter(pk=workspace.pk).update(
                structure_revision=F("structure_revision") + 1
            )
        for index, channel_name in enumerate(channels):
            channel, created = Channel.objects.get_or_create(
                workspace=workspace,
                template_key=_template_key(channel_name),
                defaults={
                    "category": category,
                    # Its place in the layout, or the end of the category when a room kept from
                    # an earlier layout, or an administrator's own, already stands there.
                    "position": _free_position(workspace, category, index),
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
