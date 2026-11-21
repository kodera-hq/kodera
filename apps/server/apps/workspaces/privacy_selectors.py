"""Materialized workspace identifiers scoped by the export worker's organisation bindings."""

from uuid import UUID

from django.db import models

from .models import Workspace, WorkspaceMemberRestriction


class PrivacyWorkspaceRefusalError(Exception):
    """The complete workspace binding set exceeds the export bound."""


def workspace_member_restricted(*, workspace_id: UUID, membership_id: UUID) -> bool:
    return (
        WorkspaceMemberRestriction.objects.filter(
            workspace_id=workspace_id,
            membership_id=membership_id,
        )
        .filter(models.Q(banned=True) | models.Q(kicked=True))
        .exists()
    )


def export_workspace_ids(
    *,
    organisation_ids: tuple[UUID, ...],
    max_entries: int,
    user_id: str | UUID | None = None,
) -> tuple[UUID, ...]:
    queryset = Workspace.objects.filter(organisation_id__in=organisation_ids)
    if user_id is not None:
        restricted = WorkspaceMemberRestriction.objects.filter(
            workspace_id=models.OuterRef("pk"),
            membership__user_id=user_id,
        ).filter(models.Q(banned=True) | models.Q(kicked=True))
        queryset = queryset.exclude(models.Exists(restricted))
    rows = tuple(queryset.values_list("id", flat=True)[: max_entries + 1])
    if len(rows) > max_entries:
        raise PrivacyWorkspaceRefusalError("Core export workspace binding bound")
    return rows
