"""Issuer-authorized, current stored relationship pages with no lazy model escape."""

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from .membership_pagination import DirectoryQuery
from .models import Membership

# The People directory's population: `removed` relationships are not in it (contract
# listMemberships), so a `state=removed` filter finds nothing, in the list as in its count.
DIRECTORY_STATES = ("invited", "active", "suspended")
# The roles that read the People directory (contract listMemberships and countMemberships).
DIRECTORY_ROLES = frozenset({"org_owner", "org_admin", "org_member"})


@dataclass(frozen=True, slots=True, repr=False)
class DirectoryMembership:
    id: UUID
    user_id: UUID
    organisation_id: UUID
    role: str
    state: str
    created_at: datetime
    updated_at: datetime


def directory_role(*, user_id: UUID, organisation_id: UUID) -> str | None:
    return (
        Membership.objects.filter(
            user_id=user_id,
            organisation_id=organisation_id,
            deleted_at__isnull=True,
        )
        .values_list("role", flat=True)
        .first()
    )


def _eligible(*, organisation_id: UUID, role: str | None, state: str | None) -> Any:
    eligible = Membership.objects.filter(
        organisation_id=organisation_id,
        deleted_at__isnull=True,
        user__deleted_at__isnull=True,
        state__in=DIRECTORY_STATES,
    )
    if role is not None:
        eligible = eligible.filter(role=role)
    if state is not None:
        eligible = eligible.filter(state=state)
    return eligible


def count_memberships(*, organisation_id: UUID, role: str | None, state: str | None) -> int:
    """How many rows `directory_memberships` would page through for the same filters."""
    count: int = _eligible(organisation_id=organisation_id, role=role, state=state).count()
    return count


def directory_memberships(
    *, organisation_id: UUID, query: DirectoryQuery, continuation: tuple[UUID, UUID] | None
) -> tuple[tuple[DirectoryMembership, ...], UUID | None]:
    eligible = _eligible(organisation_id=organisation_id, role=query.role, state=query.state)
    if continuation is None:
        ceiling = eligible.order_by("-id").values_list("id", flat=True).first()
    else:
        after, ceiling = continuation
        eligible = eligible.filter(id__gt=after)
    if ceiling is None:
        return (), None
    values = (
        eligible.filter(id__lte=ceiling)
        .order_by("id")
        .values_list(
            "id", "user_id", "organisation_id", "role", "state", "created_at", "updated_at"
        )[: query.limit + 1]
    )
    return tuple(DirectoryMembership(*row) for row in values), ceiling
