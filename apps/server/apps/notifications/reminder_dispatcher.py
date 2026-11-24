"""Operator-only personal reminder dispatcher with delivery-time policy and erasure checks."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from django.db import connection, transaction
from django.db.models import Q
from django.utils import timezone

from apps.e2ee.services import has_confidential_room
from apps.orgs.selectors import (
    lock_erasure_cutoff_fences,
    membership_delivery_state,
    organisation_delivery_state,
    privacy_cutoff_reason,
)
from apps.orgs.workspace_members import for_workspace
from apps.workspaces.moderation import member_restrictions
from apps.workspaces.selectors import (
    MatrixTransportError,
    configured_matrix_directory_client as configured_matrix_client,
    has_foreign_partner_room_binding,
    is_designated_confidential_channel,
    may_view_channel_for_reminder,
    partner_channel_matrix_room_id,
    resolve_authoritative_channel_room,
    undeleted_text_channel_exists,
    verify_channel_room_binding,
    workspace_id_for,
)

from . import services
from .models import PersonalReminder

LEASE_TTL_SECONDS = 60


@dataclass(frozen=True, slots=True)
class ClaimedReminderJob:
    id: UUID
    organisation_id: UUID
    membership_id: UUID
    channel_id: UUID | None
    room_id: str
    lease_id: UUID


def _evaluate_reminder_authority(
    *,
    row: PersonalReminder,
    now: datetime,
    resolved_synapse_room_id: str | None = None,
    check_synapse_binding: bool = False,
) -> tuple[str, str, UUID | None]:
    """Return `(verdict, reason, user_id)` where verdict is `ok|obsolete`."""
    member_row = membership_delivery_state(
        membership_id=row.membership_id, organisation_id=row.organisation_id
    )
    user_id: UUID | None = member_row[0] if member_row is not None else None

    cutoff = privacy_cutoff_reason(organisation_id=row.organisation_id, user_id=user_id)
    if cutoff is not None:
        return "obsolete", cutoff, user_id

    org_row = organisation_delivery_state(organisation_id=row.organisation_id)
    if org_row is None or org_row[0] != "active":
        return "obsolete", "organisation_inactive", user_id

    if (
        member_row is None
        or member_row[2] != "active"
        or member_row[3] is None
        or member_row[4] is not None
        or for_workspace(
            organisation_id=row.organisation_id, membership_id=row.membership_id, lock=False
        )
        is None
    ):
        return "obsolete", "membership_inactive", user_id

    workspace_id = workspace_id_for(organisation_id=row.organisation_id)
    if workspace_id is None:
        return "obsolete", "workspace_absent", user_id

    denied, _ = member_restrictions(workspace_id, row.membership_id, now=now)
    if denied:
        return "obsolete", "member_banned_or_kicked", user_id

    if row.channel_id is None:
        return "obsolete", "channel_binding_required", user_id

    if is_designated_confidential_channel(
        workspace_id=workspace_id, channel_id=row.channel_id
    ) or has_confidential_room(channel_id=row.channel_id, organisation_id=row.organisation_id):
        return "obsolete", "confidential_channel_refused", user_id

    if not undeleted_text_channel_exists(workspace_id=workspace_id, channel_id=row.channel_id):
        return "obsolete", "channel_deleted", user_id

    if check_synapse_binding:
        room_ok, _ = verify_channel_room_binding(
            workspace_id=workspace_id,
            channel_id=row.channel_id,
            room_id=row.room_id,
            resolved_synapse_room_id=resolved_synapse_room_id,
        )
        if not room_ok:
            return "obsolete", "channel_room_mismatch", user_id
    elif row.room_id:
        if has_foreign_partner_room_binding(channel_id=row.channel_id, room_id=row.room_id):
            return "obsolete", "channel_room_mismatch", user_id
        partner_room = partner_channel_matrix_room_id(channel_id=row.channel_id)
        if partner_room is not None and row.room_id != partner_room:
            return "obsolete", "channel_room_mismatch", user_id

    view_verdict = may_view_channel_for_reminder(
        channel_id=row.channel_id,
        organisation_id=row.organisation_id,
        membership_id=row.membership_id,
        authority_revision=org_row[1],
    )
    if view_verdict is None:
        return "obsolete", "channel_policy_unavailable", user_id
    if not view_verdict:
        return "obsolete", "channel_view_denied", user_id

    return "ok", "", user_id


def _claim_next_reminder(
    *, organisation_id: UUID | None = None, now: datetime | None = None
) -> tuple[str, ClaimedReminderJob | None]:
    ref = timezone.now() if now is None else now
    with transaction.atomic():
        qs = PersonalReminder.objects.select_for_update(skip_locked=True).filter(
            Q(
                state__in=(PersonalReminder.State.PENDING, PersonalReminder.State.SNOOZED),
                remind_at__lte=ref,
            )
            | Q(state=PersonalReminder.State.IN_FLIGHT, lease_expires_at__lte=ref)
        )
        if organisation_id is not None:
            qs = qs.filter(organisation_id=organisation_id)
        row = qs.order_by("remind_at", "id").first()
        if row is None:
            return "empty", None

        verdict, _, _ = _evaluate_reminder_authority(row=row, now=ref)
        if verdict != "ok":
            PersonalReminder.objects.filter(pk=row.pk).update(
                state=PersonalReminder.State.OBSOLETE,
                lease_id=None,
                lease_expires_at=None,
                updated_at=ref,
            )
            return "obsoleted", None

        lease = uuid4()
        expires_at = ref + timedelta(seconds=LEASE_TTL_SECONDS)
        PersonalReminder.objects.filter(pk=row.pk).update(
            state=PersonalReminder.State.IN_FLIGHT,
            lease_id=lease,
            lease_expires_at=expires_at,
            updated_at=ref,
        )
        return (
            "claimed",
            ClaimedReminderJob(
                id=row.id,
                organisation_id=row.organisation_id,
                membership_id=row.membership_id,
                channel_id=row.channel_id,
                room_id=row.room_id,
                lease_id=lease,
            ),
        )


def dispatch_reminders(
    *,
    organisation_id: UUID | None = None,
    max_jobs: int = 25,
    matrix_client: Any | None = None,
    mid_flight_hook: Callable[[ClaimedReminderJob], None] | None = None,
) -> dict[str, int]:
    """Drain up to `max_jobs` due personal reminders, emitting inbox notifications + push wakeups."""
    if connection.in_atomic_block:
        raise RuntimeError("dispatch_reminders must run outside an enclosing atomic transaction")
    if type(max_jobs) is not int or not 1 <= max_jobs <= 100:
        raise ValueError("max_jobs must be between 1 and 100")

    active_matrix_client = (
        matrix_client if matrix_client is not None else configured_matrix_client()
    )
    counts = {"fired": 0, "obsoleted": 0}
    for _ in range(max_jobs):
        status, job = _claim_next_reminder(organisation_id=organisation_id)
        if status == "empty":
            break
        if status == "obsoleted":
            counts["obsoleted"] += 1
            continue
        if job is None or connection.in_atomic_block:
            raise RuntimeError("claimed reminder job invariant violated")

        resolved_synapse_room_id: str | None = None
        if job.channel_id is not None and job.room_id:
            try:
                resolved_synapse_room_id = resolve_authoritative_channel_room(
                    channel_id=job.channel_id,
                    matrix_client=active_matrix_client,
                )
            except MatrixTransportError as exc:
                if exc.retryable:
                    with transaction.atomic():
                        PersonalReminder.objects.filter(
                            pk=job.id,
                            state=PersonalReminder.State.IN_FLIGHT,
                            lease_id=job.lease_id,
                        ).update(
                            state=PersonalReminder.State.PENDING,
                            lease_id=None,
                            lease_expires_at=None,
                            updated_at=timezone.now(),
                        )
                    continue
                resolved_synapse_room_id = None

        if mid_flight_hook is not None:
            mid_flight_hook(job)

        with transaction.atomic():
            now_fire = timezone.now()
            row = PersonalReminder.objects.select_for_update().filter(pk=job.id).first()
            if row is None:
                counts["obsoleted"] += 1
                continue
            if row.state != PersonalReminder.State.IN_FLIGHT or row.lease_id != job.lease_id:
                continue

            verdict, _, user_id = _evaluate_reminder_authority(
                row=row,
                now=now_fire,
                resolved_synapse_room_id=resolved_synapse_room_id,
                check_synapse_binding=True,
            )
            if verdict != "ok":
                PersonalReminder.objects.filter(pk=job.id).update(
                    state=PersonalReminder.State.OBSOLETE,
                    lease_id=None,
                    lease_expires_at=None,
                    updated_at=now_fire,
                )
                counts["obsoleted"] += 1
                continue

            if user_id is not None:
                lock_erasure_cutoff_fences(organisation_id=row.organisation_id, user_id=user_id)
            if (
                privacy_cutoff_reason(organisation_id=row.organisation_id, user_id=user_id)
                is not None
            ):
                PersonalReminder.objects.filter(pk=job.id).update(
                    state=PersonalReminder.State.OBSOLETE,
                    lease_id=None,
                    lease_expires_at=None,
                    updated_at=now_fire,
                )
                counts["obsoleted"] += 1
                continue

            notif = services.record(
                organisation_id=row.organisation_id,
                membership_id=row.membership_id,
                kind="reminder",
                resource_id=row.id,
            )
            PersonalReminder.objects.filter(pk=job.id).update(
                state=PersonalReminder.State.FIRED,
                notification_id=notif.id,
                lease_id=None,
                lease_expires_at=None,
                updated_at=now_fire,
            )
            counts["fired"] += 1

    return counts
