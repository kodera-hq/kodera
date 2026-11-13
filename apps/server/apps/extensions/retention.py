"""Bounded nonstatutory payload disposal and the approved request-bound retention worker adapter.

These rows are not accounting evidence. External receivers and imported native documents need
separate completeness/erasure proofs; local payload disposal never claims provider absence.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from django.db import connection, transaction
from django.db.models import Q

from .models import (
    Delivery,
    DeliveryAttempt,
    DigestConsent,
    ImportBatch,
    ImportedObject,
    Installation,
)
from .wire import ExtensionRefusedError


def database_now() -> datetime:
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        return cursor.fetchone()[0]


@transaction.atomic
def purge_due(*, limit: int = 100, organisation_id: UUID | None = None) -> int:
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise ExtensionRefusedError("extension_purge_bound")
    now = database_now()
    rows = (
        Delivery.objects.select_for_update(skip_locked=True)
        .filter(expires_at__lte=now, purged_at__isnull=True)
        .order_by("expires_at", "id")
    )
    if organisation_id is not None:
        rows = rows.filter(installation__workspace__organisation_id=organisation_id)
    count = 0
    for row in rows[:limit]:
        DeliveryAttempt.objects.filter(delivery=row, outcome="started").update(
            outcome="uncertain", updated_at=now
        )
        row.event = b""
        row.purged_at = now
        if row.state not in {"delivered", "dead_letter", "obsolete"}:
            row.state = "obsolete"
        row.lease_id = row.lease_expires_at = None
        row.save(
            update_fields=[
                "event",
                "purged_at",
                "state",
                "lease_id",
                "lease_expires_at",
                "updated_at",
            ]
        )
        count += 1
    return count


def local_payloads_absent(*, organisation_id: UUID) -> bool:
    return (
        not Delivery.objects.filter(installation__workspace__organisation_id=organisation_id)
        .filter(Q(purged_at__isnull=True) | ~Q(event=b""))
        .exists()
    )


def receiver_inventory(*, organisation_id: UUID) -> tuple[str, ...]:
    import hashlib

    return tuple(
        f"urn:kodera:extension-installation:{row.id}:endpoint-sha256:{hashlib.sha256(row.endpoint.encode()).hexdigest()}"
        for row in Installation.objects.filter(workspace__organisation_id=organisation_id).order_by(
            "id"
        )
    )


def metadata_absent(*, organisation_id: UUID) -> bool:
    return not any(
        (
            Installation.objects.filter(workspace__organisation_id=organisation_id).exists(),
            ImportBatch.objects.filter(workspace__organisation_id=organisation_id).exists(),
            ImportedObject.objects.filter(workspace__organisation_id=organisation_id).exists(),
            DigestConsent.objects.filter(membership__organisation_id=organisation_id).exists(),
        )
    )


def worker_step(
    *,
    erasure_id: UUID,
    organisation_id: UUID,
    cutoff_at: datetime,
    inventory_sha256: str,
    limit: int = 100,
) -> dict:
    """One bound SQL definer call; the processing role receives no raw extension table grants."""
    import json

    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT public.extension_erasure_step(%s,%s,%s,%s,%s)",
            [erasure_id, organisation_id, cutoff_at, inventory_sha256, limit],
        )
        value = cursor.fetchone()[0]
    return json.loads(value) if isinstance(value, str) else value
