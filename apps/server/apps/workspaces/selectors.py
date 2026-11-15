"""Scoped workspace values and caller-owned transaction fences."""

from uuid import UUID

from .models import Workspace, WorkspaceMemberRestriction


def workspace_organisation(*, workspace_id: UUID) -> UUID:
    return Workspace.objects.values_list("organisation_id", flat=True).get(id=workspace_id)


def lock_workspace(*, workspace_id: UUID) -> None:
    Workspace.objects.select_for_update().get(id=workspace_id)


def lock_organisation_workspace(*, organisation_id: UUID) -> UUID:
    return (
        Workspace.objects.select_for_update()
        .values_list("id", flat=True)
        .get(organisation_id=organisation_id)
    )


def digest_workspace(*, organisation_id: UUID, membership_id: UUID) -> UUID | None:
    workspace = Workspace.objects.filter(organisation_id=organisation_id).first()
    if (
        workspace is None
        or WorkspaceMemberRestriction.objects.filter(
            workspace=workspace, membership_id=membership_id, banned=True
        ).exists()
        or WorkspaceMemberRestriction.objects.filter(
            workspace=workspace, membership_id=membership_id, kicked=True
        ).exists()
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
        .filter(banned=True)
        .values_list("workspace_id", "membership_id")
    ) | set(
        WorkspaceMemberRestriction.objects.filter(
            workspace_id__in=list(workspaces.values()),
            membership_id__in=list(membership_by_org.values()),
        )
        .filter(kicked=True)
        .values_list("workspace_id", "membership_id")
    )
    result: dict[UUID, UUID] = {}
    for org_id, ws_id in workspaces.items():
        membership_id = membership_by_org[org_id]
        if (ws_id, membership_id) not in restricted_pairs:
            result[org_id] = ws_id
    return result
