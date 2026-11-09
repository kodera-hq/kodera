"""The audit actions billing writes: docs/domain/AUDIT_TAXONOMY.md §Billing.

Each is written in the transaction of the change it records, through the audit application's
writer, which refuses an action outside the billing rows of the taxonomy.
"""

from collections.abc import Mapping
from uuid import UUID

from apps.audit.services import record_billing_event

from .actors import Actor


def record(
    action: str,
    *,
    actor: Actor,
    organisation_id: UUID | None,
    target: tuple[str, UUID | str],
    metadata: Mapping[str, object],
) -> None:
    kind, target_id = target
    record_billing_event(
        action=action,
        actor_type=actor.type,
        actor_id=actor.id,
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:{kind}:{target_id}",
        request_id=actor.request_id,
        metadata=metadata,
    )
