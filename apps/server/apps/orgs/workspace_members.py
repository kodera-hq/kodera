"""Membership snapshots and the narrow write port used by workspace invitations."""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from django.db import connection
from django.utils import timezone

from .models import Membership


@dataclass(frozen=True, slots=True, repr=False)
class WorkspaceMembership:
    id: UUID
    organisation_id: UUID
    user_id: UUID
    role: str
    state: str
    accepted_at: datetime | None


def _snapshot(row: Membership) -> WorkspaceMembership:
    return WorkspaceMembership(
        row.id, row.organisation_id, row.user_id, row.role, row.state, row.accepted_at
    )


def for_workspace(*, organisation_id: UUID, membership_id: UUID) -> WorkspaceMembership | None:
    """Lock one current target while the caller holds its workspace domain lock."""
    if not connection.in_atomic_block:
        raise RuntimeError("workspace membership is read in its operation transaction")
    row = (
        Membership.objects.select_for_update()
        .filter(
            id=membership_id,
            organisation_id=organisation_id,
            deleted_at__isnull=True,
            state="active",
            accepted_at__isnull=False,
        )
        .first()
    )
    return _snapshot(row) if row is not None else None


def for_user(
    *, organisation_id: UUID, user_id: UUID, lock: bool = False
) -> WorkspaceMembership | None:
    """Include inactive memberships so an invitation cannot silently recreate or replay one."""
    if not connection.in_atomic_block:
        raise RuntimeError("workspace membership is read in its operation transaction")
    rows = Membership.objects.filter(
        organisation_id=organisation_id, user_id=user_id, deleted_at__isnull=True
    )
    if lock:
        rows = rows.select_for_update()
    row = rows.first()
    return _snapshot(row) if row is not None else None


def create_from_workspace_link(*, organisation_id: UUID, user_id: UUID) -> WorkspaceMembership:
    """Create an ordinary member; the caller atomically records the link use and projections."""
    if not connection.in_atomic_block:
        raise RuntimeError("workspace membership is created in its operation transaction")
    return _snapshot(
        Membership.objects.create(
            organisation_id=organisation_id,
            user_id=user_id,
            role="org_member",
            state="active",
            accepted_at=timezone.now(),
        )
    )
