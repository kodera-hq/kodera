"""Bounded nonstatutory payload disposal and an explicit local workspace cutoff hook.

These rows are not accounting evidence. External receivers and imported native documents need
separate completeness/erasure proofs; local payload disposal never claims provider absence.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from django.db import connection, transaction
from django.db.models import Q
from django.utils import timezone

from apps.orgs.models import Organisation
from apps.workspaces.models import Workspace
from core.db.ids import new_uuid7

from .models import (
    Delivery,
    DeliveryAttempt,
    DeliveryDecision,
    DigestConsent,
    DigestJob,
    ImportBatch,
    ImportedObject,
    Installation,
    WorkspaceCutoff,
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


def cutoff_workspace(*, organisation_id: UUID, cutoff_at: datetime) -> dict[str, int]:
    """Caller holds its authorized erasure transaction; stop future sends and shorten retention.

    Inventory/progress keys are local only: external_extension_receivers remains a required
    independent provider domain, and native imported documents belong to the Docs purge graph.
    """
    if not connection.in_atomic_block or cutoff_at.tzinfo is None or cutoff_at > database_now():
        raise ExtensionRefusedError("extension_cutoff_transaction_or_clock")
    marker, created = WorkspaceCutoff.objects.get_or_create(
        organisation_id=organisation_id, defaults={"cutoff_at": cutoff_at}
    )
    if not created and marker.cutoff_at != cutoff_at:
        raise ExtensionRefusedError("extension_cutoff_replay_binding", 409)
    Organisation.objects.select_for_update().get(id=organisation_id)
    workspace = Workspace.objects.select_for_update().get(organisation_id=organisation_id)
    revoked = Installation.objects.filter(workspace=workspace, revoked_at__isnull=True).update(
        revoked_at=cutoff_at, version=new_uuid7(), updated_at=timezone.now()
    )
    consents = DigestConsent.objects.filter(
        membership__organisation_id=organisation_id, enabled=True
    ).update(enabled=False, revoked_at=cutoff_at, version=new_uuid7(), updated_at=timezone.now())
    DigestJob.objects.filter(consent__membership__organisation_id=organisation_id).exclude(
        state="obsolete"
    ).update(state="obsolete", updated_at=timezone.now())
    # Shortening an expiry never renews a payload. Active send transactions serialize on the
    # same organisation/workspace before this fence can commit.
    expired = Delivery.objects.filter(
        installation__workspace=workspace, expires_at__gt=cutoff_at, purged_at__isnull=True
    ).update(expires_at=cutoff_at, updated_at=timezone.now())
    return {
        "installations_revoked": revoked,
        "digest_consents_revoked": consents,
        "payload_expiries_shortened": expired,
    }


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


def purge_workspace_metadata(*, organisation_id: UUID, limit: int = 100) -> dict[str, int]:
    """Only the erasure coordinator calls after verified scoped external receiver receipts.

    Return at most limit deleted rows across the graph, never an assertion that a receiver deleted its data. The
    marker remains to prevent reuse after all personal linkage/endpoint metadata is removed.
    """
    if not connection.in_atomic_block or type(limit) is not int or not 1 <= limit <= 1000:
        raise ExtensionRefusedError("extension_erasure_transaction_or_bound")
    if (
        not WorkspaceCutoff.objects.filter(organisation_id=organisation_id).exists()
        or Installation.objects.filter(
            workspace__organisation_id=organisation_id, revoked_at__isnull=True
        ).exists()
        or not local_payloads_absent(organisation_id=organisation_id)
    ):
        raise ExtensionRefusedError("extension_erasure_cutoff_or_payloads_missing")
    Organisation.objects.select_for_update().get(id=organisation_id)
    Workspace.objects.select_for_update().get(organisation_id=organisation_id)
    # Use fixed model querysets, never caller-provided table names. Child evidence is deleted
    # first; separate invocations converge when a large parent still has pending children.
    scoped = {
        "decisions": DeliveryDecision.objects.filter(
            delivery__installation__workspace__organisation_id=organisation_id
        ),
        "attempts": DeliveryAttempt.objects.filter(
            delivery__installation__workspace__organisation_id=organisation_id,
            deliverydecision__isnull=True,
        ),
        "deliveries": Delivery.objects.filter(
            installation__workspace__organisation_id=organisation_id, deliveryattempt__isnull=True
        ),
        "import_objects": ImportedObject.objects.filter(workspace__organisation_id=organisation_id),
        "import_batches": ImportBatch.objects.filter(
            workspace__organisation_id=organisation_id, importedobject__isnull=True
        ),
        "digest_jobs": DigestJob.objects.filter(
            consent__membership__organisation_id=organisation_id
        ),
        "digest_consents": DigestConsent.objects.filter(
            membership__organisation_id=organisation_id, digestjob__isnull=True
        ),
        "installations": Installation.objects.filter(
            workspace__organisation_id=organisation_id, delivery__isnull=True
        ),
    }
    counts = {}
    remaining = limit
    for name, query in scoped.items():
        ids = list(query.order_by("pk").values_list("pk", flat=True)[:remaining])
        counts[name] = query.filter(pk__in=ids)._raw_delete(query.db) if ids else 0
        remaining -= counts[name]
    return counts
