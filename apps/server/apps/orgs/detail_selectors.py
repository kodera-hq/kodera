"""Materialized organisation fields scoped to the resolved customer identity."""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from .models import Organisation


@dataclass(frozen=True, slots=True, repr=False)
class OrganisationDetail:
    id: UUID
    slug: str
    name: str
    state: str
    created_at: datetime
    updated_at: datetime


def organisation_detail(
    *, organisation_id: UUID, issuer: str, realm: str
) -> OrganisationDetail | None:
    row = (
        Organisation.objects.filter(
            id=organisation_id,
            issuer=issuer,
            realm=realm,
            deleted_at__isnull=True,
            state__in=[Organisation.State.ACTIVE, Organisation.State.SUSPENDED],
        )
        .values("id", "slug", "name", "state", "created_at", "updated_at")
        .first()
    )
    return OrganisationDetail(**row) if row is not None else None
