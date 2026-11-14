"""SHA-256 hash-chained `StaffAuditEntry` writer and verifier."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from datetime import UTC, datetime
from uuid import UUID

from django.db import connection, transaction

from .models import StaffAuditEntry

AUDIT_HASH_DOMAIN = "kodera-staff-audit-v1"


def normalize_audit_timestamp(value: datetime) -> datetime:
    """Normalize to UTC at microsecond precision so PostgreSQL round-trips identically."""
    utc_dt = value.astimezone(UTC)
    return utc_dt.replace(tzinfo=UTC)


def compute_audit_entry_hash(
    *,
    scope_key: str,
    sequence_no: int,
    previous_hash: str | None,
    actor_identity_id: UUID | str,
    actor_roles: Sequence[str],
    action: str,
    target_type: str,
    target_id: str,
    request_id: str,
    recorded_at: datetime,
    metadata: dict[str, object],
) -> str:
    canonical_payload = {
        "domain": AUDIT_HASH_DOMAIN,
        "scope_key": scope_key,
        "sequence_no": sequence_no,
        "previous_hash": previous_hash,
        "actor_identity_id": str(actor_identity_id),
        "actor_roles": sorted(str(role) for role in actor_roles),
        "action": action,
        "target_type": target_type,
        "target_id": target_id,
        "request_id": request_id,
        "recorded_at": normalize_audit_timestamp(recorded_at).isoformat(timespec="microseconds"),
        "metadata": metadata,
    }
    encoded = json.dumps(canonical_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _append_single_scope(
    *,
    scope_key: str,
    actor_identity_id: UUID,
    actor_roles: Sequence[str],
    action: str,
    target_type: str,
    target_id: str,
    request_id: str,
    recorded_at: datetime,
    metadata: dict[str, object],
) -> StaffAuditEntry:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_advisory_xact_lock(hashtext(%s))",
            [f"staff_audit:{scope_key}"],
        )
    head = (
        StaffAuditEntry.objects.filter(scope_key=scope_key)
        .order_by("-sequence_no")
        .values("sequence_no", "entry_hash")
        .first()
    )
    if head is None:
        sequence_no = 1
        previous_hash: str | None = None
    else:
        sequence_no = int(head["sequence_no"]) + 1
        previous_hash = str(head["entry_hash"])
    sorted_roles = sorted(dict.fromkeys(str(r) for r in actor_roles))
    normalized_at = normalize_audit_timestamp(recorded_at)
    entry_hash = compute_audit_entry_hash(
        scope_key=scope_key,
        sequence_no=sequence_no,
        previous_hash=previous_hash,
        actor_identity_id=actor_identity_id,
        actor_roles=sorted_roles,
        action=action,
        target_type=target_type,
        target_id=target_id,
        request_id=request_id,
        recorded_at=normalized_at,
        metadata=metadata,
    )
    return StaffAuditEntry.objects.create(
        scope_key=scope_key,
        sequence_no=sequence_no,
        previous_hash=previous_hash,
        entry_hash=entry_hash,
        actor_identity_id=actor_identity_id,
        actor_roles=sorted_roles,
        action=action,
        target_type=target_type,
        target_id=target_id,
        request_id=request_id,
        recorded_at=normalized_at,
        metadata=metadata,
    )


def append_staff_audit_entry(
    *,
    actor_identity_id: UUID,
    actor_roles: Sequence[str],
    action: str,
    target_type: str,
    target_id: str,
    request_id: str,
    metadata: dict[str, object] | None = None,
    organisation_slug: str | None = None,
    recorded_at: datetime | None = None,
) -> StaffAuditEntry:
    """Append to the `fleet` hash chain (and `org:<slug>` when organisation-scoped)."""
    effective_at = normalize_audit_timestamp(recorded_at or datetime.now(UTC))
    safe_metadata = dict(metadata or {})
    with transaction.atomic():
        fleet_entry = _append_single_scope(
            scope_key="fleet",
            actor_identity_id=actor_identity_id,
            actor_roles=actor_roles,
            action=action,
            target_type=target_type,
            target_id=target_id,
            request_id=request_id,
            recorded_at=effective_at,
            metadata=safe_metadata,
        )
        if organisation_slug:
            _append_single_scope(
                scope_key=f"org:{organisation_slug}",
                actor_identity_id=actor_identity_id,
                actor_roles=actor_roles,
                action=action,
                target_type=target_type,
                target_id=target_id,
                request_id=request_id,
                recorded_at=effective_at,
                metadata=safe_metadata,
            )
    return fleet_entry


def verify_staff_audit_chain(scope_key: str = "fleet") -> dict[str, object]:
    """Verify contiguous sequence numbers, `previous_hash` links, and SHA-256 digests."""
    entries = list(StaffAuditEntry.objects.filter(scope_key=scope_key).order_by("sequence_no", "id"))
    if not entries:
        return {
            "scope_key": scope_key,
            "verified": True,
            "checked_count": 0,
            "head_sequence_no": None,
            "head_hash": None,
            "broken_at_sequence_no": None,
            "reason": None,
        }

    expected_seq = 1
    expected_prev: str | None = None
    checked = 0
    for entry in entries:
        if entry.sequence_no != expected_seq:
            return {
                "scope_key": scope_key,
                "verified": False,
                "checked_count": checked,
                "head_sequence_no": entries[-1].sequence_no,
                "head_hash": entries[-1].entry_hash,
                "broken_at_sequence_no": entry.sequence_no,
                "reason": f"sequence_gap: expected {expected_seq}, got {entry.sequence_no}",
            }
        if entry.previous_hash != expected_prev:
            return {
                "scope_key": scope_key,
                "verified": False,
                "checked_count": checked,
                "head_sequence_no": entries[-1].sequence_no,
                "head_hash": entries[-1].entry_hash,
                "broken_at_sequence_no": entry.sequence_no,
                "reason": "previous_hash_mismatch",
            }
        roles_list = entry.actor_roles if isinstance(entry.actor_roles, list) else []
        meta_dict = entry.metadata if isinstance(entry.metadata, dict) else {}
        recomputed = compute_audit_entry_hash(
            scope_key=entry.scope_key,
            sequence_no=entry.sequence_no,
            previous_hash=entry.previous_hash,
            actor_identity_id=entry.actor_identity_id,
            actor_roles=[str(r) for r in roles_list],
            action=entry.action,
            target_type=entry.target_type,
            target_id=entry.target_id,
            request_id=entry.request_id,
            recorded_at=entry.recorded_at,
            metadata=meta_dict,
        )
        if entry.entry_hash != recomputed:
            return {
                "scope_key": scope_key,
                "verified": False,
                "checked_count": checked,
                "head_sequence_no": entries[-1].sequence_no,
                "head_hash": entries[-1].entry_hash,
                "broken_at_sequence_no": entry.sequence_no,
                "reason": "entry_hash_mismatch",
            }
        checked += 1
        expected_seq += 1
        expected_prev = entry.entry_hash

    return {
        "scope_key": scope_key,
        "verified": True,
        "checked_count": checked,
        "head_sequence_no": entries[-1].sequence_no,
        "head_hash": entries[-1].entry_hash,
        "broken_at_sequence_no": None,
        "reason": None,
    }
