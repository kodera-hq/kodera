"""Tenant agent reads for the tenant status view."""

from datetime import datetime
from uuid import UUID

from .models import EngineAgentCredential


def last_heartbeat(*, organisation_id: UUID, tenant_id: UUID) -> datetime | None:
    """The newest pull by an active credential serving this tenant; failing one, by an active
    credential serving the organisation as a whole. None when neither has pulled."""
    active = EngineAgentCredential.objects.filter(
        organisation_id=organisation_id, state="active", last_seen_at__isnull=False
    ).order_by("-last_seen_at")
    seen: datetime | None = (
        active.filter(tenant_ref=tenant_id).values_list("last_seen_at", flat=True).first()
    )
    if seen is None:
        seen = active.filter(tenant_ref__isnull=True).values_list("last_seen_at", flat=True).first()
    return seen
