"""Tenant reads: `listTenants`, `getTenant`, `getTenantStatus` and `getOrganisationStatusSummary`.

What Core knows today, and nothing it does not: the tenant row an order wrote (desired state), each
application's default URL from KODERA_TENANT_APP_URLS, and the tenant agent's last pull as its
freshness. No job provisions a tenant yet, so there are no provisioning steps; no component, no
incident and no maintenance window is recorded, so those lists are empty and that window is null;
and only seats are measured, so the capacity gauge is null. The caller's access is checked by
apps/billing/access.py before any of these runs; every query here is scoped to that organisation.
The rows come from each application's selectors, never its models.
"""

from datetime import timedelta
from typing import Any
from uuid import UUID

from django.utils import timezone

from apps.billing.switch import UNBILLED_PACK, billing_enabled
from apps.engine_intents.selectors import last_heartbeat
from apps.tenancy import selectors as tenancy

from .pagination import ListQuery
from .representations import instant
from .selectors import _newest_first, _newest_position, _page, dunning

JSON = dict[str, Any]

TENANT_STATUSES = tenancy.STATUSES
APP_NAMES = {
    "visio": "Visio",
    "docs": "Docs",
    "drive": "Drive",
    "messaging": "Espace",
    "grist": "Grist",
}
# TenantApp.state, by tenant status; any other status is `unavailable`.
APP_STATE = {
    "ordered": "pending",
    "provisioning": "pending",
    "ready": "live",
    "active": "live",
    "upgrading": "maintenance",
    "maintenance": "maintenance",
}
# OrganisationStatusSummary.overall, by tenant status; any other status is `operational`.
OVERALL = {
    "upgrading": "maintenance",
    "maintenance": "maintenance",
    "suspended": "major_outage",
    "failed": "major_outage",
}
# TenantObserved.stale: three missed heartbeats, "roughly 180 seconds".
STALE_AFTER = timedelta(seconds=180)


default_urls = tenancy.default_urls


def _tenant(row: Any) -> JSON:
    return {
        "id": str(row.id),
        "organisation_id": str(row.organisation_id),
        "slug": row.slug,
        "name": row.name,
        "status": row.status,
        "status_changed_at": instant(row.status_changed_at),
        "pack_code": row.pack_code,
        "capacity_tier_code": row.capacity_tier_code,
        "apps": list(row.apps),
        "region": row.region,
        "realm": row.realm,
        "profile_ref": row.profile_ref,
        "default_urls": default_urls(row),
        "locale": row.locale,
        "created_at": instant(row.created_at),
        "updated_at": instant(row.updated_at),
    }


def list_tenants(*, organisation_id: UUID, query: ListQuery) -> JSON:
    rows = tenancy.tenants_of(organisation_id, status=query.filters.get("status"))
    return _page(
        _newest_first(rows, query, "created_at"),
        query=query,
        operation="listTenants",
        scope=str(organisation_id),
        position=_newest_position("created_at"),
        render=_tenant,
    )


tenant_owner = tenancy.tenant_owner


def get_tenant(organisation_id: UUID, tenant_id: UUID) -> JSON | None:
    row = tenancy.tenant_of(organisation_id=organisation_id, tenant_id=tenant_id)
    return None if row is None else _tenant(row)


def _agent(row: Any) -> JSON:
    seen = last_heartbeat(organisation_id=row.organisation_id, tenant_id=row.id)
    return {
        "stale": seen is None or timezone.now() - seen > STALE_AFTER,
        "last_heartbeat_at": instant(seen),
        "agent_version": None,
        "maintenance": row.status == "maintenance",
    }


def tenant_status(organisation_id: UUID, tenant_id: UUID) -> JSON | None:
    row = tenancy.tenant_of(organisation_id=organisation_id, tenant_id=tenant_id)
    if row is None:
        return None
    state = APP_STATE.get(row.status, "unavailable")
    apps = [
        {
            "code": code,
            "name": APP_NAMES[code],
            "url": url,
            "default_url": url,
            "custom_domain": None,
            "state": state,
            "version": None,
        }
        for code, url in default_urls(row).items()
    ]
    return {
        "tenant_id": str(row.id),
        "status": row.status,
        "status_changed_at": instant(row.status_changed_at),
        "message_key": f"status.tenant.{row.status}",
        "provisioning_steps": [],
        "current_job": None,
        "apps": apps,
        "capacity": None,
        "components": [],
        "agent": _agent(row),
        "domains": [],
    }


def status_summary(organisation_id: UUID) -> JSON:
    """The shell's one call. The tenant is the organisation's newest one not deleted."""
    row = tenancy.newest_tenant_not_deleted(organisation_id)
    dunning_state, oldest_overdue = dunning(organisation_id)
    bills = billing_enabled()
    return {
        "organisation_id": str(organisation_id),
        "tenant_id": None if row is None else str(row.id),
        "overall": "operational" if row is None else OVERALL.get(row.status, "operational"),
        "components": [],
        "capacity": None,
        "billing": {
            "dunning_state": dunning_state,
            "oldest_overdue_invoice_id": oldest_overdue,
            "amount_due": None,
        },
        "maintenance": None,
        "open_incident_ids": [],
        "measured_at": instant(timezone.now()),
        # QUICK_WORKSPACE.md §2.3: the console reads the switch here, never from its own build.
        "billing_enabled": bills,
        "workspace_pack_code": None if bills else UNBILLED_PACK,
    }
