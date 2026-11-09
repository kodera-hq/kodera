"""The pilot's operator override of a tenant's status (docs/specs/QUICK_WORKSPACE.md §5).

`manage.py tenant_status` lists tenants and moves one along the paths below, under a current
`staff_operator` grant. It is an override: it does not check the T2 guards (a verified project
bootstrap, complete contacts), the T5 guards (the same idempotency key, orphan recovery first) nor
the T6 guards (a live domain, a queued welcome notice), and records the operator's reason instead. It moves only a tenant no order ever named, the
unbilled tenant `createTenant` creates. Each transition writes its own audit row in the same
transaction as the status, so `--to active` writes two.

Not in the API image: `.dockerignore` admits no line that names it. The command runs from the
operator image.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from django.db import transaction
from django.utils import timezone

from apps.audit.services import record_tenant_status_event
from apps.billing.selectors import tenant_has_order
from apps.identity.selectors import current_staff_grant
from apps.identity.staff import StaffPrincipal

from .models import TENANT_STATUSES, Tenant

OPERATOR = "staff_operator"
MAX_REASON = 500

Step = tuple[str, str, str]

# `--to` → the status it starts from → the transitions it takes, each (from, to, audit action) of
# TENANT_STATE_MACHINE.md §3: T2 or T5, T3 then T6, T4, T21.
PATHS: dict[str, dict[str, tuple[Step, ...]]] = {
    "provisioning": {
        "ordered": (("ordered", "provisioning", "tenant.provision_requested"),),
        "failed": (("failed", "provisioning", "tenant.provision_requested"),),
    },
    "active": {
        "provisioning": (
            ("provisioning", "ready", "tenant.ready"),
            ("ready", "active", "tenant.activated"),
        ),
    },
    "failed": {"provisioning": (("provisioning", "failed", "tenant.failed"),)},
    "deleted": {"ordered": (("ordered", "deleted", "tenant.deleted"),)},
}


class StatusRefusedError(Exception):
    """A refusal that wrote nothing; the message says why and names the allowed state."""


@dataclass(frozen=True, slots=True)
class Listed:
    id: UUID
    slug: str
    organisation: str
    status: str
    apps: tuple[str, ...]
    created_at: datetime


def list_tenants(*, state: str | None) -> list[Listed]:
    """Every tenant, or those in `state`, oldest first."""
    if state is not None and state not in TENANT_STATUSES:
        raise StatusRefusedError(f"unknown state {state!r}")
    rows = Tenant.objects.order_by("created_at", "id")
    if state is not None:
        rows = rows.filter(status=state)
    return [
        Listed(row[0], row[1], row[2], row[3], tuple(row[4]), row[5])
        for row in rows.values_list(
            "id", "slug", "organisation__slug", "status", "apps", "created_at"
        )
    ]


def set_status(*, principal: StaffPrincipal, tenant_id: UUID, to: str, reason: str) -> list[str]:
    """Move the tenant along `PATHS[to][its status]`; returns the statuses it passed through, in order."""
    paths = PATHS.get(to)
    if paths is None:
        raise StatusRefusedError(f"--to must be one of {', '.join(PATHS)}")
    reason = reason.strip()
    if not reason or len(reason) > MAX_REASON or not reason.isprintable():
        raise StatusRefusedError(f"--reason must be 1 to {MAX_REASON} printable characters")
    with transaction.atomic():
        # Locked, so a revocation of the grant cannot commit between this read and the change.
        grant = current_staff_grant(
            identity_id=principal.identity_id, role=OPERATOR, lock_principal=True
        )
        if grant is None:
            raise StatusRefusedError("the staff identity holds no current staff_operator grant")
        # Locked FOR UPDATE, so two moves of one tenant run one after the other, each reading the
        # status the other committed.
        tenant = Tenant.objects.select_for_update().filter(id=tenant_id).first()
        if tenant is None:
            raise StatusRefusedError("no tenant has that id")
        # Only a tenant no order ever named: an order's tenant moves with its order (T2, and the
        # cancellation that deletes it), which would otherwise leave an `active` tenant behind a
        # cancelled order. No order is ever re-pointed at another tenant, so the read needs no lock.
        if tenant_has_order(tenant_id=tenant.id):
            raise StatusRefusedError("an order names the tenant; it moves with its order")
        if tenant.status == to:
            raise StatusRefusedError(f"the tenant is already {to}")
        path = paths.get(tenant.status)
        if path is None:
            raise StatusRefusedError(
                f"the tenant is {tenant.status}; --to {to} is allowed from "
                f"{' or '.join(paths)} only"
            )
        passed = []
        for before, after, action in path:
            now = timezone.now()
            moved = Tenant.objects.filter(id=tenant.id, status=before).update(
                status=after, status_changed_at=now, updated_at=now
            )
            # The row is locked and its status read above; anything else is a defect, not a race,
            # and raising rolls back every row this call wrote.
            if moved != 1:
                raise RuntimeError(f"tenant {tenant.id} was not {before}; nothing written")
            record_tenant_status_event(
                action=action,
                tenant_id=tenant.id,
                organisation_id=tenant.organisation_id,
                actor_id=principal.identity_id,
                metadata={"from": before, "to": after, "override": True, "reason": reason},
            )
            passed.append(after)
    return passed
