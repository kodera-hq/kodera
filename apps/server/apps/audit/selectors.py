"""Reads of the audit record for other applications' services: docs/dev/PROJECT_LAYOUT.md §2.

Nothing here writes.
"""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from .models import AuditEvent

# FIRST_OWNER_BOOTSTRAP.md §8.7, pilot: the intake recorder's confirmation that the customer holds
# the owner account. The event is the record of that confirmation; no other row holds it.
OWNER_CONFIRMED = "owner_claim.confirmed"


@dataclass(frozen=True, slots=True)
class WorkspaceAuditEventSnapshot:
    id: UUID
    occurred_at: datetime
    actor_id: UUID | None
    actor_type: str
    action: str
    target_urn: str
    request_id: str | None


def list_workspace_audit_events(
    *,
    organisation_id: UUID,
    limit: int,
    actor_id: UUID | None = None,
    action: str | None = None,
    before_id: UUID | None = None,
) -> list[WorkspaceAuditEventSnapshot]:
    """Workspace-scoped audit events (`workspace.*`) for an organisation, redacting non-tenant actor IDs."""
    events = AuditEvent.objects.filter(
        organisation_id=organisation_id,
        action__startswith="workspace.",
    )
    if actor_id is not None:
        events = events.filter(actor_type="tenant", actor_id=actor_id)
    if action is not None:
        events = events.filter(action=action)
    if before_id is not None:
        events = events.filter(id__lt=before_id)
    return [
        WorkspaceAuditEventSnapshot(
            id=event.id,
            occurred_at=event.occurred_at,
            actor_id=event.actor_id if event.actor_type == "tenant" else None,
            actor_type=event.actor_type,
            action=event.action,
            target_urn=event.target_urn,
            request_id=event.request_id,
        )
        for event in events.order_by("-id")[: limit + 1]
    ]


def owner_confirmation_recorded(*, organisation_id: UUID) -> bool:
    """Whether the organisation's `owner_claim.confirmed` is recorded, by its staff actor."""
    return AuditEvent.objects.filter(
        organisation_id=organisation_id, action=OWNER_CONFIRMED, actor_type="staff"
    ).exists()


def claim_confirmation_recorded(*, organisation_id: UUID, claim_id: UUID) -> bool:
    """Only the exact claim's staff confirmation counts for its idempotent command."""
    return AuditEvent.objects.filter(
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:owner_claim:{claim_id}",
        action=OWNER_CONFIRMED,
        actor_type="staff",
    ).exists()
