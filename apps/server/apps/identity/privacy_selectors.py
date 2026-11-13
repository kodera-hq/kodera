"""Scoped identity authority for private export workers."""

from uuid import UUID

from .models import Identity


def current_export_organisation(*, identity_id: str, user_id: str) -> UUID | None:
    return (
        Identity.objects.filter(
            id=identity_id,
            user_id=user_id,
            enabled=True,
            deleted_at__isnull=True,
            user__enabled=True,
            user__deleted_at__isnull=True,
            organisation__isnull=False,
        )
        .values_list("organisation_id", flat=True)
        .first()
    )
