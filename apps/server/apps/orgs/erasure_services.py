"""Worker-only durable Core erasure and explicit, authenticated external-store receipts."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol
from uuid import UUID

from django.db import connection, transaction

from core.db.ids import new_uuid7

from .privacy_models import ErasureReceipt, PrivacyErasure

DOMAINS = frozenset(
    {"matrix", "objects", "identity_provider", "private_exports", "external_extension_receivers"}
)


@dataclass(frozen=True)
class ErasureScope:
    request_id: UUID
    organisation_id: UUID
    cutoff_at: datetime
    inventory: dict[str, Any]

    @property
    def inventory_sha256(self) -> str:
        return hashlib.sha256(
            json.dumps(
                self.inventory, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ).encode()
        ).hexdigest()


@dataclass(frozen=True)
class AbsenceProof:
    request_id: UUID
    organisation_id: UUID
    cutoff_at: datetime
    domain: str
    inventory_sha256: str
    evidence_sha256: str
    adapter_revision: str
    verified_at: datetime


class ErasureAdapter(Protocol):
    """Trusted worker implementation must fence writes and freshly verify complete absence.

    Implementations must include every resource under the immutable scope inventory, not
    merely report that one sampled object was removed. No adapter is configured by default.
    """

    domain: str
    revision: str

    def erase_and_verify(self, scope: ErasureScope) -> AbsenceProof: ...

    def verify_proof(self, scope: ErasureScope, proof: AbsenceProof) -> bool: ...


def database_now() -> datetime:
    """Use the same trusted database clock as durable cutoff and receipt guards."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        return cursor.fetchone()[0]


def _json(value: Any) -> dict[str, Any]:
    return json.loads(value) if isinstance(value, str) else value


@transaction.atomic
def begin_erasure(
    *,
    organisation_id: UUID,
    instruction_ref: str,
    instruction_sha256: str,
    purge_not_before: datetime,
    actor_identity_id: UUID,
) -> PrivacyErasure:
    """The operator's validated controller instruction is identified by ref and digest.

    The SQL boundary independently requires a current enabled staff_operator identity.
    This source API does not authenticate a bearer token or validate the legal instruction.
    """
    if purge_not_before.tzinfo is None or purge_not_before.utcoffset() is None:
        raise ValueError("aware recovery deadline required")
    request_id = new_uuid7()
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT privacy_begin_erasure(%s,%s,%s,%s,%s,%s)",
            [
                request_id,
                organisation_id,
                instruction_ref,
                instruction_sha256,
                purge_not_before,
                actor_identity_id,
            ],
        )
    row = PrivacyErasure.objects.get(pk=request_id)
    scope = ErasureScope(row.id, row.organisation_reference, row.cutoff_at, row.inventory)
    if row.inventory_sha256 != scope.inventory_sha256:
        raise ValueError("erasure inventory digest mismatch")
    if _extension_store():
        _extension_step(scope)

    return row


def purge_core(request_id: UUID) -> dict[str, int]:
    with connection.cursor() as cursor:
        cursor.execute("SELECT privacy_purge_core(%s)", [request_id])
        return _json(cursor.fetchone()[0])


@transaction.atomic
def persist_absence(scope: ErasureScope, proof: AbsenceProof, adapter: ErasureAdapter) -> None:
    """Only a trusted configured adapter's fresh verified proof can enter the journal."""
    row = PrivacyErasure.objects.select_for_update().get(pk=scope.request_id)
    now = database_now()
    if (
        row.organisation_reference != scope.organisation_id
        or row.cutoff_at != scope.cutoff_at
        or row.inventory != scope.inventory
        or row.inventory_sha256 != scope.inventory_sha256
        or proof.domain not in DOMAINS
        or proof.domain not in row.inventory.get("required_domains", [])
        or proof.domain != adapter.domain
        or proof.adapter_revision != adapter.revision
        or not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", proof.adapter_revision)
        or proof.request_id != scope.request_id
        or proof.organisation_id != scope.organisation_id
        or proof.cutoff_at != scope.cutoff_at
        or proof.inventory_sha256 != scope.inventory_sha256
        or not re.fullmatch(r"[0-9a-f]{64}", proof.evidence_sha256)
        or proof.verified_at.tzinfo is None
        or not scope.cutoff_at <= proof.verified_at <= now
        or not adapter.verify_proof(scope, proof)
    ):
        raise ValueError("external erasure proof refused")
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT privacy_record_absence(%s,%s,%s,%s,%s,%s)",
            [
                scope.request_id,
                proof.domain,
                proof.cutoff_at,
                proof.evidence_sha256,
                proof.adapter_revision,
                proof.verified_at,
            ],
        )


def _extension_store() -> bool:
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regclass('public.extensions_installation') IS NOT NULL")
        present = bool(cursor.fetchone()[0])
        if present:
            cursor.execute(
                "SELECT to_regprocedure('public.extension_erasure_step(uuid,uuid,timestamptz,text,integer)') IS NOT NULL"
            )
            if not cursor.fetchone()[0]:
                raise ValueError("extension erasure integration unavailable")
    return present


def _extension_step(scope: ErasureScope) -> dict[str, Any]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT extension_erasure_step(%s,%s,%s,%s,%s)",
            [
                scope.request_id,
                scope.organisation_id,
                scope.cutoff_at,
                scope.inventory_sha256,
                1000,
            ],
        )
        return _json(cursor.fetchone()[0])


def advance_erasure(request_id: UUID, adapters: dict[str, ErasureAdapter]) -> dict[str, Any]:
    """Purge actual Core payloads; every absent external adapter remains an explicit hold."""
    if set(adapters) - DOMAINS:
        raise ValueError("unknown erasure adapter domain")
    row = PrivacyErasure.objects.get(pk=request_id)
    scope = ErasureScope(row.id, row.organisation_reference, row.cutoff_at, row.inventory)
    if row.inventory_sha256 != scope.inventory_sha256:
        raise ValueError("erasure inventory digest mismatch")
    if database_now() < row.purge_not_before:
        raise ValueError("erasure cutoff not due")
    required = frozenset(row.inventory["required_domains"])
    if not required or not required <= DOMAINS:
        raise ValueError("erasure required domains invalid")
    extension = _extension_store()
    counts = purge_core(request_id) if not extension else None
    for domain in sorted(required):
        if (
            domain not in adapters
            or ErasureReceipt.objects.filter(erasure=row, domain=domain).exists()
        ):
            continue
        adapter = adapters[domain]
        persist_absence(scope, adapter.erase_and_verify(scope), adapter)
    held = sorted(
        required - set(ErasureReceipt.objects.filter(erasure=row).values_list("domain", flat=True))
    )
    if extension:
        progress = _extension_step(scope)
        if (
            progress.get("payloads_complete") is not True
            or progress.get("native_documents_released") is not True
        ):
            return {
                "request_id": str(row.id),
                "core_purged": False,
                "complete": False,
                "held_domains": held,
                "completion_hold": "extension receiver or local metadata erasure pending",
                "extension_progress": progress,
            }
    if counts is None:
        counts = purge_core(request_id)
    with connection.cursor() as cursor:
        cursor.execute("SELECT privacy_complete_erasure(%s)", [request_id])
        complete = bool(cursor.fetchone()[0])
    return {
        "request_id": str(row.id),
        "core_purged": True,
        "complete": complete,
        "held_domains": held,
        "counts": counts,
    }
