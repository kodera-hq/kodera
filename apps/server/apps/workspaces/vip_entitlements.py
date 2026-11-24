"""Atomic workspace IAM, Matrix channel-set, and LiveKit room-access convergence for VIP passes.

Runs strictly in the caller's billing settlement/revocation transaction without importing foreign
`models` modules (`apps.billing` calls into this port with plain UUIDs and booleans). Lock order
matches `apps/workspaces/channel_sets.py`: workspace domain rows first (`lock_workspace`), then
`CreatorConnectAccount` / `VipMembershipEntitlement` (in caller), then
`orgs_organisation.authority_revision`, then `record_member_set` and `record_channel_set`.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from django.db import connection, transaction
from django.db.models import Q

from apps.engine_intents.services import emit_member_set
from apps.orgs.authority_selectors import bump_organisation_authority_revision
from apps.orgs.selectors import current_member_roles

from . import channel_sets
from .administration import ADMINISTERING_ROLES
from .channel_access import expand_override_capabilities
from .models import (
    Channel,
    ResourcePolicy,
    ResourcePolicyRule,
    Workspace,
    WorkspaceChannelRoleOverride,
    WorkspaceMemberRole,
    WorkspaceRole,
)

VIP_CHANNEL_ALLOW_CAPABILITIES: tuple[str, ...] = tuple(
    expand_override_capabilities(
        (
            "channel.view",
            "message.post",
            "media.connect",
            "media.speak",
        )
    )
)


def lock_workspace_for_vip(organisation_id: UUID) -> UUID | None:
    """Acquire the canonical workspace row lock (`SELECT id ... FOR UPDATE`) first in transaction."""
    return channel_sets.lock_workspace(organisation_id)


@dataclass(frozen=True, slots=True)
class VipConvergenceOutcome:
    organisation_id: UUID
    workspace_id: UUID
    membership_id: UUID
    role_id: UUID
    holds_role: bool
    role_granted: bool
    role_revoked: bool
    authority_revision: int
    member_set_recorded: bool
    channel_set_recorded: bool


@dataclass(frozen=True, slots=True)
class VipConvergencePorts:
    """Injectable ports for deterministic unit verification and transactional ORM execution."""

    has_role: Callable[[UUID, UUID, UUID], bool]
    grant_role: Callable[[UUID, UUID, UUID], None]
    revoke_role: Callable[[UUID, UUID, UUID], None]
    bump_authority_revision: Callable[[UUID], int]
    record_member_set: Callable[[UUID, str], None]
    record_channel_set: Callable[[UUID, UUID, str], None]


def record_member_set(*, organisation_id: UUID, reason: str) -> None:
    """Record the organisation's next member set for Synapse and LiveKit agents."""
    normalized_reason = reason.strip().lower().replace(".", "_").replace("-", "_")
    emit_member_set(organisation_id=organisation_id, reason=normalized_reason)


def record_channel_set(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    reason: str,
    computed: channel_sets.Input | None = None,
) -> None:
    """Record the workspace's next channel set directly via `emit_for` (never swallowing `ChannelSetError`)."""
    channel_sets.emit_for(
        organisation_id=organisation_id,
        workspace_id=workspace_id,
        reason=reason,
        computed=computed,
    )


def project_vip_room_policy(
    *,
    kind: str,
    admitted_matrix_users: Sequence[str],
    banned_matrix_users: Sequence[str] = (),
    listen_only: bool = False,
) -> dict[str, Any]:
    """Build the `io.kodera.room.policy` payload enforced by Synapse and `room_access.Service`."""
    if kind not in {"text", "audio"}:
        raise ValueError(f"unsupported channel kind {kind!r}")
    members = sorted({u.strip() for u in admitted_matrix_users if u.strip()})
    banned = sorted({u.strip() for u in banned_matrix_users if u.strip()})
    admitted = [u for u in members if u not in set(banned)]
    return {
        "version": 1,
        "kind": kind,
        "archived": False,
        "audience": "listed",
        "members": admitted,
        "banned": banned,
        "listen_only": listen_only,
        "may_publish": [] if listen_only else list(admitted),
    }


def reconcile_vip_role_with_ports(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    membership_id: UUID,
    role_id: UUID,
    should_hold_role: bool,
    reason: str,
    ports: VipConvergencePorts,
) -> VipConvergenceOutcome:
    """Converge a member's VIP role, `authority_revision`, `member_set`, and `channel_set`."""
    currently_holds = ports.has_role(workspace_id, membership_id, role_id)
    granted = False
    revoked = False
    if should_hold_role and not currently_holds:
        ports.grant_role(workspace_id, membership_id, role_id)
        granted = True
    elif not should_hold_role and currently_holds:
        ports.revoke_role(workspace_id, membership_id, role_id)
        revoked = True

    revision = ports.bump_authority_revision(organisation_id)
    ports.record_member_set(organisation_id, reason)
    ports.record_channel_set(organisation_id, workspace_id, reason)
    return VipConvergenceOutcome(
        organisation_id=organisation_id,
        workspace_id=workspace_id,
        membership_id=membership_id,
        role_id=role_id,
        holds_role=should_hold_role,
        role_granted=granted,
        role_revoked=revoked,
        authority_revision=revision,
        member_set_recorded=True,
        channel_set_recorded=True,
    )


def _ensure_role_override_allows_vip(
    *,
    workspace_id: UUID,
    channel: Channel,
    role_id: UUID,
) -> None:
    override, created = WorkspaceChannelRoleOverride.objects.get_or_create(
        workspace_id=workspace_id,
        channel=channel,
        role_id=role_id,
        defaults={
            "allow": list(VIP_CHANNEL_ALLOW_CAPABILITIES),
            "deny": [],
        },
    )
    if not created:
        merged_allow = expand_override_capabilities(
            set(override.allow) | set(VIP_CHANNEL_ALLOW_CAPABILITIES)
        )
        cleaned_deny = [c for c in override.deny if c not in VIP_CHANNEL_ALLOW_CAPABILITIES]
        if merged_allow != override.allow or cleaned_deny != override.deny:
            override.allow = merged_allow
            override.deny = cleaned_deny
            override.save(update_fields=["allow", "deny", "updated_at"])


def configure_vip_channel_gate(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    role_id: UUID,
    channel_ids: Sequence[UUID],
) -> tuple[UUID, ...]:
    """Bind `channel_ids` to `RESTRICTED` access admitting `role_id` while preserving workspace
    owners/admins (`allow_members` + `allow_roles`) and inherited `DENY_*` rules."""
    with transaction.atomic():
        locked_ws = channel_sets.lock_workspace(organisation_id)
        if locked_ws is None or locked_ws != workspace_id:
            raise ValueError("workspace does not belong to organisation")
        workspace = Workspace.objects.get(id=workspace_id, organisation_id=organisation_id)
        if not WorkspaceRole.objects.filter(id=role_id, workspace_id=workspace_id).exists():
            raise ValueError("VIP workspace role does not belong to workspace")

        unique_ids = tuple(dict.fromkeys(channel_ids))
        channels = list(
            Channel.objects.select_for_update(of=("self",))
            .select_related("category")
            .filter(workspace_id=workspace_id, id__in=unique_ids)
            .exclude(lifecycle=Channel.Lifecycle.DELETED)
        )
        if len(channels) != len(unique_ids):
            raise ValueError("all VIP gated channels must be active channels of workspace")

        member_roles = current_member_roles(organisation_id=organisation_id)
        admin_member_ids = {
            m_id for m_id, role_name in member_roles.items() if role_name in ADMINISTERING_ROLES
        }
        admin_workspace_role_ids = list(
            WorkspaceRole.objects.filter(workspace_id=workspace_id)
            .filter(Q(kind__in=("owner", "admin")) | Q(slug__in=("owner", "admin")))
            .values_list("id", flat=True)
        )

        for ch in channels:
            source_policy_id: UUID | None
            if ch.policy_mode == Channel.PolicyMode.EXPLICIT and ch.explicit_policy_id is not None:
                source_policy_id = ch.explicit_policy_id
            elif ch.category is not None and ch.category.default_policy_id is not None:
                source_policy_id = ch.category.default_policy_id
            else:
                source_policy_id = workspace.default_policy_id

            inherited_rules = (
                list(
                    ResourcePolicyRule.objects.filter(policy_id=source_policy_id).values_list(
                        "kind", "membership_id", "capability"
                    )
                )
                if source_policy_id is not None
                else []
            )

            if ch.policy_mode != Channel.PolicyMode.EXPLICIT or ch.explicit_policy_id is None:
                policy = ResourcePolicy.objects.create(
                    workspace_id=workspace_id,
                    visibility=ResourcePolicy.Visibility.RESTRICTED,
                )
                for rule_kind, rule_member_id, rule_cap in inherited_rules:
                    ResourcePolicyRule.objects.get_or_create(
                        policy=policy,
                        kind=rule_kind,
                        membership_id=rule_member_id,
                        capability=rule_cap,
                    )
                ch.policy_mode = Channel.PolicyMode.EXPLICIT
                ch.explicit_policy = policy
                ch.version += 1
                ch.save(
                    update_fields=[
                        "policy_mode",
                        "explicit_policy",
                        "version",
                        "updated_at",
                    ]
                )
            else:
                policy = ResourcePolicy.objects.select_for_update().get(
                    id=ch.explicit_policy_id,
                    workspace_id=workspace_id,
                )
                if policy.visibility != ResourcePolicy.Visibility.RESTRICTED:
                    ResourcePolicy.objects.filter(id=policy.id).update(
                        visibility=ResourcePolicy.Visibility.RESTRICTED
                    )

            denied_member_ids = set(
                ResourcePolicyRule.objects.filter(
                    policy=policy,
                    kind=ResourcePolicyRule.Kind.DENY_MEMBER,
                    membership_id__isnull=False,
                ).values_list("membership_id", flat=True)
            )
            existing_allowed_member_ids = set(
                ResourcePolicyRule.objects.filter(
                    policy=policy,
                    kind=ResourcePolicyRule.Kind.ALLOW_MEMBER,
                    membership_id__isnull=False,
                ).values_list("membership_id", flat=True)
            )
            for admin_m_id in sorted(
                admin_member_ids - denied_member_ids - existing_allowed_member_ids, key=str
            ):
                ResourcePolicyRule.objects.create(
                    policy=policy,
                    kind=ResourcePolicyRule.Kind.ALLOW_MEMBER,
                    membership_id=admin_m_id,
                )

            for preserved_role_id in (*admin_workspace_role_ids, role_id):
                _ensure_role_override_allows_vip(
                    workspace_id=workspace_id,
                    channel=ch,
                    role_id=preserved_role_id,
                )

        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE workspaces_workspace SET structure_revision = structure_revision + 1, "
                "updated_at = clock_timestamp() WHERE id = %s",
                [workspace_id],
            )
        record_channel_set(
            organisation_id=organisation_id,
            workspace_id=workspace_id,
            reason="vip.channel_gate.configured",
        )
        return unique_ids


def sync_vip_member_entitlement(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    membership_id: UUID,
    role_id: UUID,
    should_hold_role: bool,
    reason: str,
) -> VipConvergenceOutcome:
    """Atomically grant/revoke bound `WorkspaceMemberRole`, bump `authority_revision`, and emit
    both `member_set` and `channel_set` (`emit_for`, failing closed on `ChannelSetError`)."""
    with transaction.atomic():
        locked_ws = channel_sets.lock_workspace(organisation_id)
        if locked_ws is None or locked_ws != workspace_id:
            raise ValueError("workspace does not belong to organisation")
        if not Workspace.objects.filter(id=workspace_id, organisation_id=organisation_id).exists():
            raise ValueError("workspace not found")

        existing = WorkspaceMemberRole.objects.filter(
            workspace_id=workspace_id,
            membership_id=membership_id,
            role_id=role_id,
        ).exists()
        granted = False
        revoked = False
        if should_hold_role and not existing:
            WorkspaceMemberRole.objects.create(
                workspace_id=workspace_id,
                membership_id=membership_id,
                role_id=role_id,
            )
            granted = True
        elif not should_hold_role and existing:
            WorkspaceMemberRole.objects.filter(
                workspace_id=workspace_id,
                membership_id=membership_id,
                role_id=role_id,
            ).delete()
            revoked = True

        revision = bump_organisation_authority_revision(organisation_id=organisation_id)
        computed = channel_sets.channel_set_input(workspace_id)
        record_member_set(organisation_id=organisation_id, reason=reason)
        record_channel_set(
            organisation_id=organisation_id,
            workspace_id=workspace_id,
            reason=reason,
            computed=computed,
        )
        return VipConvergenceOutcome(
            organisation_id=organisation_id,
            workspace_id=workspace_id,
            membership_id=membership_id,
            role_id=role_id,
            holds_role=should_hold_role,
            role_granted=granted,
            role_revoked=revoked,
            authority_revision=revision,
            member_set_recorded=True,
            channel_set_recorded=True,
        )
