"""Scoped workspace values and caller-owned transaction fences."""

import json
from collections.abc import Iterable
from dataclasses import dataclass
from uuid import UUID

from django.db import connection
from django.db.models import Q

from .models import Channel, Workspace, WorkspaceMemberRestriction, WorkspaceQuota


def active_channel_id(*, workspace_id: UUID, channel_id: UUID) -> UUID | None:
    """An active text or audio channel in the exact workspace, without exporting its model."""
    return (
        Channel.objects.filter(
            id=channel_id,
            workspace_id=workspace_id,
            kind__in=("text", "audio"),
            lifecycle="active",
        )
        .values_list("id", flat=True)
        .first()
    )


def active_text_channel_id(*, workspace_id: UUID, channel_id: UUID) -> UUID | None:
    """An active text channel in the exact workspace, without exporting its model."""
    return (
        Channel.objects.filter(
            id=channel_id, workspace_id=workspace_id, kind="text", lifecycle="active"
        )
        .values_list("id", flat=True)
        .first()
    )


def is_confidential_channel(*, channel_id: UUID, organisation_id: UUID) -> bool:
    """Read the confidential designation within the exact organisation."""
    return Channel.objects.filter(
        id=channel_id, workspace__organisation_id=organisation_id, is_confidential=True
    ).exists()


def is_confidential_text_channel(*, workspace_id: UUID, channel_id: UUID) -> bool:
    """Whether the active text channel carries the immutable confidential designation."""
    return Channel.objects.filter(
        id=channel_id,
        workspace_id=workspace_id,
        kind="text",
        lifecycle="active",
        is_confidential=True,
    ).exists()


def is_designated_confidential_channel(*, workspace_id: UUID, channel_id: UUID) -> bool:
    """Whether an active or archived text channel carries the immutable confidential designation."""
    return Channel.objects.filter(
        id=channel_id,
        workspace_id=workspace_id,
        kind="text",
        lifecycle__in=("active", "archived"),
        is_confidential=True,
    ).exists()


def undeleted_channel_id(*, workspace_id: UUID, channel_id: UUID) -> UUID | None:
    """A non-deleted channel in the exact workspace, without exporting its model."""
    return (
        Channel.objects.filter(id=channel_id, workspace_id=workspace_id)
        .exclude(lifecycle__in=["deletion_pending", "deleted"])
        .values_list("id", flat=True)
        .first()
    )


def workspace_organisation(*, workspace_id: UUID) -> UUID:
    return Workspace.objects.values_list("organisation_id", flat=True).get(id=workspace_id)


def workspace_id_for(*, organisation_id: UUID) -> UUID | None:
    """Resolve the workspace without taking a row lock."""
    return (
        Workspace.objects.filter(organisation_id=organisation_id)
        .order_by("id")
        .values_list("id", flat=True)
        .first()
    )


def link_previews_allowed(organisation_id: UUID) -> bool:
    """Whether URL previews are permitted for the organisation's workspace."""
    return not Workspace.objects.filter(
        organisation_id=organisation_id, allow_link_previews=False
    ).exists()


def lock_workspace(*, workspace_id: UUID) -> None:
    Workspace.objects.select_for_update().get(id=workspace_id)


def lock_workspace_if_present(*, workspace_id: UUID) -> bool:
    return (
        Workspace.objects.select_for_update().filter(id=workspace_id).order_by("id").first()
        is not None
    )


def lock_organisation_workspace(*, organisation_id: UUID) -> UUID:
    return (
        Workspace.objects.select_for_update()
        .order_by("id")
        .values_list("id", flat=True)
        .get(organisation_id=organisation_id)
    )


def lock_organisation_workspace_if_present(*, organisation_id: UUID) -> UUID | None:
    return (
        Workspace.objects.select_for_update()
        .filter(organisation_id=organisation_id)
        .order_by("id")
        .values_list("id", flat=True)
        .first()
    )


def digest_workspace(*, organisation_id: UUID, membership_id: UUID) -> UUID | None:
    workspace = Workspace.objects.filter(organisation_id=organisation_id).order_by("id").first()
    if (
        workspace is None
        or WorkspaceMemberRestriction.objects.filter(
            workspace=workspace, membership_id=membership_id
        )
        .filter(Q(banned=True) | Q(kicked=True))
        .exists()
    ):
        return None
    return workspace.id


def passport_unrestricted_workspaces(
    *, memberships: tuple[tuple[UUID, UUID], ...]
) -> dict[UUID, UUID]:
    """Map `organisation_id -> workspace_id` for memberships not banned or kicked in the workspace."""
    if not memberships:
        return {}
    org_ids = [org_id for org_id, _ in memberships]
    membership_by_org = dict(memberships)
    workspaces = {
        ws.organisation_id: ws.id for ws in Workspace.objects.filter(organisation_id__in=org_ids)
    }
    if not workspaces:
        return {}
    restricted_pairs = set(
        WorkspaceMemberRestriction.objects.filter(
            workspace_id__in=list(workspaces.values()),
            membership_id__in=list(membership_by_org.values()),
        )
        .filter(Q(banned=True) | Q(kicked=True))
        .values_list("workspace_id", "membership_id")
    )
    result: dict[UUID, UUID] = {}
    for org_id, ws_id in workspaces.items():
        membership_id = membership_by_org[org_id]
        if (ws_id, membership_id) not in restricted_pairs:
            result[org_id] = ws_id
    return result


def restricted_workspace_membership_ids(
    *, workspace_id: UUID, membership_ids: Iterable[UUID]
) -> set[UUID]:
    """Membership ids banned or kicked in `workspace_id`."""
    return set(
        WorkspaceMemberRestriction.objects.filter(
            workspace_id=workspace_id,
            membership_id__in=membership_ids,
        )
        .filter(Q(banned=True) | Q(kicked=True))
        .values_list("membership_id", flat=True)
    )


def is_workspace_membership_restricted(*, membership_id: UUID) -> bool:
    """Whether `membership_id` is currently banned or kicked in its workspace."""
    return (
        WorkspaceMemberRestriction.objects.filter(membership_id=membership_id)
        .filter(Q(banned=True) | Q(kicked=True))
        .exists()
    )


@dataclass(frozen=True, slots=True)
class ChannelSnapshot:
    id: UUID
    name: str
    kind: str
    lifecycle: str
    room_state: str
    is_confidential: bool


def _channel_snapshot(channel: Channel) -> ChannelSnapshot:
    return ChannelSnapshot(
        channel.id,
        channel.name,
        channel.kind,
        channel.lifecycle,
        channel.room_state,
        channel.is_confidential,
    )


def channel_snapshot(
    *, workspace_id: UUID, channel_id: UUID, for_update: bool = False
) -> ChannelSnapshot | None:
    """Read the exact channel, retaining a caller-owned row lock when requested."""
    rows = Channel.objects.filter(id=channel_id, workspace_id=workspace_id)
    if for_update:
        rows = rows.select_for_update()
    row = rows.first()
    return None if row is None else _channel_snapshot(row)


def importable_channel_snapshots(*, workspace_id: UUID) -> tuple[ChannelSnapshot, ...]:
    return tuple(
        _channel_snapshot(row)
        for row in Channel.objects.filter(workspace_id=workspace_id, kind="text").exclude(
            lifecycle__in=("deletion_pending", "deleted")
        )
    )


def workspace_page_limit(*, workspace_id: UUID) -> int | None:
    return (
        WorkspaceQuota.objects.filter(workspace_id=workspace_id)
        .values_list("pages", flat=True)
        .first()
    )


def workspace_pages_used(*, workspace_id: UUID) -> int:
    with connection.cursor() as cursor:
        cursor.execute("SELECT workspace_quota_usage(%s)", [workspace_id])
        raw_usage = cursor.fetchone()[0]
    usage = json.loads(raw_usage) if isinstance(raw_usage, str) else raw_usage
    if isinstance(usage, dict) and type(usage.get("pages")) is int:
        return int(usage["pages"])
    return 0
