"""Issuer-authorized, current stored relationship pages with no lazy model escape.

Directory privacy (docs/specs/MEMBERSHIP_LIFECYCLE.md §2.1) is decided here too, by one rule for
`listMemberships` and `getMembership`, the contract's `Membership` schema: the five private member
facts are disclosed on a row only to the person the row describes, or to a caller who holds
`org_owner` or `org_admin` in that organisation. To every other caller the reads admit they are
withheld: absent from the answer, never a placeholder, a masked value or a partial one. Both reads
decide through `discloses_private_facts` and nowhere else, so that neither can drift from the
other, and a withheld fact never leaves the service layer: the row a serializer receives does not
carry it.
"""

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


# The contract's five private member facts. Core stores two of them today (`email`, `identity_id`);
# the other three are never emitted, and are named so that a read that starts emitting one is held
# to the same rule (tests/test_directory_privacy.py).
PRIVATE_MEMBER_FACTS = ("email", "identity_id", "account_kind", "mfa_enrolled", "last_seen_at")
# The roles that administer the directory, and so read every row in full.
DISCLOSING_ROLES = frozenset({"org_owner", "org_admin"})


def discloses_private_facts(*, caller_role: str, own_row: bool) -> bool:
    """Whether a row's private member facts are disclosed to this caller: their own row
    (`own_row`), or any row when they hold `org_owner` or `org_admin` in the row's organisation."""
    return own_row or caller_role in DISCLOSING_ROLES


def withhold_private_facts(row: dict[str, object]) -> dict[str, object]:
    """The row without its private member facts: each is omitted, never replaced."""
    return {name: value for name, value in row.items() if name not in PRIVATE_MEMBER_FACTS}


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
