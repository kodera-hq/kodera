"""Reads of the audit record for other applications' services: docs/dev/PROJECT_LAYOUT.md §2.

Nothing here writes.
"""

from uuid import UUID

from .models import AuditEvent

# FIRST_OWNER_BOOTSTRAP.md §8.7, pilot: the intake recorder's confirmation that the customer holds
# the owner account. The event is the record of that confirmation; no other row holds it.
OWNER_CONFIRMED = "owner_claim.confirmed"


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
