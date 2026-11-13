"""Closed private-export audit writes with scalar request bindings."""

from .models import AuditEvent


def record_export_event(
    *,
    action: str,
    identity_id: str,
    organisation_id: str | None,
    export_id: str,
    scope: str,
) -> None:
    if action not in {"export.requested", "export.ready"}:
        raise ValueError("unsupported private export audit action")
    AuditEvent.objects.create(
        action=action,
        actor_type="tenant",
        actor_id=identity_id,
        actor_label=f"urn:kodera:identity:{identity_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:export:{export_id}",
        retention_class="standard",
        metadata={"scope": scope},
    )
