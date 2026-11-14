"""Materialized workspace identifiers scoped by the export worker's organisation bindings."""

from uuid import UUID

from .models import Workspace


class PrivacyWorkspaceRefusalError(Exception):
    """The complete workspace binding set exceeds the export bound."""


def export_workspace_ids(
    *, organisation_ids: tuple[UUID, ...], max_entries: int
) -> tuple[UUID, ...]:
    rows = tuple(
        Workspace.objects.filter(organisation_id__in=organisation_ids).values_list("id", flat=True)[
            : max_entries + 1
        ]
    )
    if len(rows) > max_entries:
        raise PrivacyWorkspaceRefusalError("Core export workspace binding bound")
    return rows
