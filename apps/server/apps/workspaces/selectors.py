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
