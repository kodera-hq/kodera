"""Cross-application selectors and SFrame v1 media policy helpers for E2EE rooms."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from django.db.models import Exists, OuterRef

from .models import Participant, Room

SFRAME_V1_MEDIA_POLICY = "sframe-v1"


@dataclass(frozen=True, slots=True)
class ConfidentialPostureSnapshot:
    total_rooms: int
    empty_rekey_room_ids: tuple[UUID, ...]
    active_rekey_room_ids: tuple[UUID, ...]

    @property
    def rekey_required_room_ids(self) -> tuple[UUID, ...]:
        return self.empty_rekey_room_ids + self.active_rekey_room_ids


def confidential_audio_room_policy(
    *,
    e2ee_room_id: str | UUID | None = None,
    rekey_required: bool = False,
    listen_only: bool = False,
    may_publish: list[str] | tuple[str, ...] = (),
    archived: bool = False,
) -> dict[str, object]:
    """Canonical Matrix `io.kodera.room.policy` content for an SFrame v1 confidential audio room."""
    payload: dict[str, object] = {
        "version": 1,
        "kind": "audio",
        "archived": bool(archived),
        "confidential": True,
        "io.kodera.room.confidential": True,
        "ai_enabled": False,
        "e2ee_media": SFRAME_V1_MEDIA_POLICY,
        "rekey_required": bool(rekey_required),
        "listen_only": bool(listen_only),
        "may_publish": list(may_publish),
    }
    if e2ee_room_id is not None:
        payload["e2ee_room_id"] = str(e2ee_room_id)
    return payload


def confidential_room_grant_ready(*, channel_id: UUID, organisation_id: UUID | None = None) -> bool:
    """Return True iff an initialized confidential Room (`epoch >= 1`) exists and is not `rekey_required`."""
    qs = Room.objects.filter(channel_id=channel_id)
    if organisation_id is not None:
        qs = qs.filter(organisation_id=organisation_id)
    row = qs.values_list("epoch", "rekey_required").first()
    if row is None:
        return False
    epoch, rekey_required = row
    return int(epoch) >= 1 and not bool(rekey_required)


def channel_has_e2ee_room(*, channel_id: UUID, organisation_id: UUID) -> bool:
    """Return True if any E2EE room record is bound to `channel_id` within `organisation_id`."""
    return Room.objects.filter(channel_id=channel_id, organisation_id=organisation_id).exists()


def workspace_confidential_posture(
    *, organisation_id: UUID, workspace_id: UUID
) -> ConfidentialPostureSnapshot:
    """Read confidential E2EE room counts and classify empty vs active `rekey_required` rooms."""
    active_participants = Participant.objects.filter(
        room_id=OuterRef("pk"),
        left_epoch__isnull=True,
        device__revoked_at__isnull=True,
    )
    rows = list(
        Room.objects.filter(
            organisation_id=organisation_id,
            channel__workspace_id=workspace_id,
        )
        .exclude(channel__lifecycle="deleted")
        .annotate(has_active=Exists(active_participants))
        .order_by("id")
        .values_list("id", "rekey_required", "has_active")
    )
    empty_rekey = tuple(
        room_id for room_id, rekey_required, has_active in rows if rekey_required and not has_active
    )
    active_rekey = tuple(
        room_id for room_id, rekey_required, has_active in rows if rekey_required and has_active
    )
    return ConfidentialPostureSnapshot(
        total_rooms=len(rows),
        empty_rekey_room_ids=empty_rekey,
        active_rekey_room_ids=active_rekey,
    )
