"""Cross-application selectors and safe 1-click key rotation for workspace extension secret hygiene."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID

from django.utils import timezone

from apps.audit.services import record_extension_event
from core.db.ids import new_uuid7

from .models import CoexistenceBridge, Installation

EXTENSION_KEY_ROTATION_MAX_AGE_DAYS = 90


@dataclass(frozen=True, slots=True)
class ExtensionSecretPostureSnapshot:
    active_installation_count: int
    stale_installation_ids: tuple[UUID, ...]
    active_bridge_count: int
    stale_bridge_ids: tuple[UUID, ...]

    @property
    def stale_total(self) -> int:
        return len(self.stale_installation_ids) + len(self.stale_bridge_ids)


def workspace_extension_secret_posture(
    *, workspace_id: UUID, now: datetime | None = None
) -> ExtensionSecretPostureSnapshot:
    current = now or timezone.now()
    cutoff = current - timedelta(days=EXTENSION_KEY_ROTATION_MAX_AGE_DAYS)
    installations = list(
        Installation.objects.filter(workspace_id=workspace_id, revoked_at__isnull=True)
        .order_by("id")
        .values_list("id", "updated_at")
    )
    bridges = list(
        CoexistenceBridge.objects.filter(workspace_id=workspace_id, revoked_at__isnull=True)
        .order_by("id")
        .values_list("id", "updated_at")
    )
    stale_inst = tuple(inst_id for inst_id, updated_at in installations if updated_at < cutoff)
    stale_br = tuple(bridge_id for bridge_id, updated_at in bridges if updated_at < cutoff)
    return ExtensionSecretPostureSnapshot(
        active_installation_count=len(installations),
        stale_installation_ids=stale_inst,
        active_bridge_count=len(bridges),
        stale_bridge_ids=stale_br,
    )


def rotate_stale_workspace_extension_keys(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    actor_identity_id: UUID,
    now: datetime | None = None,
) -> int:
    """Atomically rotate stale (>90d) active Installation generations with a 1-hour dual-key grace window.

    CoexistenceBridge signing secrets require out-of-band peer webhook reconfiguration and are never
    auto-rotated by 1-click remediations so live bridges are never disrupted.
    """
    current = now or timezone.now()
    cutoff = current - timedelta(days=EXTENSION_KEY_ROTATION_MAX_AGE_DAYS)
    rotated = 0

    stale_installations = list(
        Installation.objects.select_for_update()
        .filter(
            workspace_id=workspace_id,
            revoked_at__isnull=True,
            updated_at__lt=cutoff,
        )
        .order_by("id")
    )
    grace_until = current + timedelta(hours=1)
    for row in stale_installations:
        if row.grace_expires_at is not None and row.grace_expires_at > current:
            continue
        row.previous_generation = row.generation
        row.generation = new_uuid7()
        row.grace_expires_at = grace_until
        row.save(
            update_fields=["previous_generation", "generation", "grace_expires_at", "updated_at"]
        )
        record_extension_event(
            action="rotated",
            identity_id=actor_identity_id,
            organisation_id=organisation_id,
            target_id=row.id,
            metadata={
                "generation": str(row.generation),
                "previous_generation": str(row.previous_generation),
                "grace_expires_at": grace_until.isoformat(),
            },
        )
        rotated += 1

    return rotated
