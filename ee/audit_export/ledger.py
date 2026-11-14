"""Append-only SHA-256 hash-chained compliance audit ledger (`ee/audit_export/ledger.py`).

Persists hash-chained audit events in PostgreSQL (`ee_audit_events`) under a per-tenant transaction
advisory lock so all Gunicorn workers share a single contiguous, tamper-evident chain, and derives
per-tenant Ed25519 & HMAC-SHA256 signing keys deterministically via HKDF-SHA256.

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import json
import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from django.db import connection, transaction
from uuid6 import uuid7

from ee.audit_export.crypto import (
    GENESIS_PREV_HASH,
    LEDGER_HASH_DOMAIN,
    Ed25519AuditSigner,
    HmacAuditSigner,
    compute_domain_sha256,
    derive_tenant_ed25519_signer,
    derive_tenant_hmac_signer,
)
from ee.edition import require_enterprise_edition
from ee.store import can_use_postgres, ensure_ee_tables, reset_ee_tables

SUPPORTED_FRAMEWORKS = frozenset({"SOC2", "ISO27001", "SECNUMCLOUD"})

FRAMEWORK_CONTROL_CATALOG: Mapping[str, tuple[str, ...]] = {
    "SOC2": ("CC6.1", "CC6.2", "CC7.2", "CC7.3"),
    "ISO27001": ("A.5.17", "A.8.2", "A.8.15", "A.8.16"),
    "SECNUMCLOUD": ("SNC-11.2", "SNC-12.1", "SNC-12.4", "SNC-16.1"),
}


def _is_valid_slug(value: str) -> bool:
    if not (1 <= len(value) <= 63):
        return False
    first, last = value[0], value[-1]
    if not (("a" <= first <= "z") or ("0" <= first <= "9")):
        return False
    if not (("a" <= last <= "z") or ("0" <= last <= "9")):
        return False
    return all(("a" <= ch <= "z") or ("0" <= ch <= "9") or ch == "-" for ch in value)


def format_utc_iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def parse_utc_iso(raw: str) -> datetime:
    cleaned = raw.strip()
    if cleaned.endswith("Z"):
        cleaned = cleaned[:-1] + "+00:00"
    parsed = datetime.fromisoformat(cleaned)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


@dataclass(frozen=True, slots=True)
class ComplianceAuditEvent:
    sequence: int
    event_id: str
    occurred_at: str
    tenant_slug: str
    actor_type: str
    actor_id: str
    actor_label: str
    action: str
    target_urn: str
    source_ip: str
    metadata: Mapping[str, object]
    prev_hash: str
    entry_hash: str

    def ledger_payload(self) -> dict[str, object]:
        return {
            "sequence": self.sequence,
            "event_id": self.event_id,
            "occurred_at": self.occurred_at,
            "tenant_slug": self.tenant_slug,
            "actor_type": self.actor_type,
            "actor_id": self.actor_id,
            "actor_label": self.actor_label,
            "action": self.action,
            "target_urn": self.target_urn,
            "source_ip": self.source_ip,
            "metadata": dict(self.metadata),
            "prev_hash": self.prev_hash,
        }


class ComplianceAuditLedger:
    """Multi-worker PostgreSQL-backed append-only SHA-256 hash-chained audit stream per tenant."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._streams: dict[str, list[ComplianceAuditEvent]] = {}
        self._ed25519_overrides: dict[str, Ed25519AuditSigner] = {}
        self._hmac_overrides: dict[str, HmacAuditSigner] = {}

    def reset(self) -> None:
        with self._lock:
            self._streams.clear()
            self._ed25519_overrides.clear()
            self._hmac_overrides.clear()
        reset_ee_tables("audit")

    def ed25519_signer_for_tenant(self, tenant_slug: str) -> Ed25519AuditSigner:
        """Return deterministic HKDF-derived Ed25519 signer for `tenant_slug`."""
        require_enterprise_edition()
        with self._lock:
            override = self._ed25519_overrides.get(tenant_slug)
        if override is not None:
            return override
        return derive_tenant_ed25519_signer(tenant_slug)

    def hmac_signer_for_tenant(
        self,
        tenant_slug: str,
        *,
        secret_key: bytes | None = None,
    ) -> HmacAuditSigner:
        """Return deterministic HKDF-derived HMAC-SHA256 signer for `tenant_slug`."""
        require_enterprise_edition()
        if secret_key is not None:
            signer = HmacAuditSigner(secret_key)
            with self._lock:
                self._hmac_overrides[tenant_slug] = signer
            return signer
        with self._lock:
            override = self._hmac_overrides.get(tenant_slug)
        if override is not None:
            return override
        return derive_tenant_hmac_signer(tenant_slug)

    def append_event(
        self,
        *,
        tenant_slug: str,
        actor_type: str,
        actor_id: str,
        actor_label: str = "",
        action: str,
        target_urn: str,
        source_ip: str = "",
        metadata: Mapping[str, object] | None = None,
        occurred_at: datetime | str | None = None,
        event_id: str | None = None,
    ) -> ComplianceAuditEvent:
        """Append one immutable event linked via `prev_hash -> entry_hash`."""
        require_enterprise_edition()
        if not _is_valid_slug(tenant_slug):
            raise ValueError("Invalid tenant_slug")
        if not action or not action.strip():
            raise ValueError("Audit event action must be non-empty")
        if not actor_type or not actor_type.strip():
            raise ValueError("Audit event actor_type must be non-empty")

        if occurred_at is None:
            ts_str = format_utc_iso(datetime.now(UTC))
        elif isinstance(occurred_at, datetime):
            ts_str = format_utc_iso(occurred_at)
        else:
            ts_str = format_utc_iso(parse_utc_iso(occurred_at))

        eid = event_id or str(uuid7())
        clean_meta = dict(metadata) if metadata is not None else {}
        clean_actor_type = actor_type.strip()
        clean_actor_id = actor_id.strip()
        clean_actor_label = actor_label.strip()
        clean_action = action.strip()
        clean_target = target_urn.strip()
        clean_ip = source_ip.strip()

        if can_use_postgres():
            ensure_ee_tables()
            meta_json = json.dumps(clean_meta, sort_keys=True, separators=(",", ":"))
            with transaction.atomic(), connection.cursor() as cur:
                cur.execute(
                    "SELECT pg_advisory_xact_lock(hashtext('kodera_ee_audit:' || %s))",
                    [tenant_slug],
                )
                cur.execute(
                    "SELECT sequence, entry_hash FROM ee_audit_events "
                    "WHERE tenant_slug = %s ORDER BY sequence DESC LIMIT 1",
                    [tenant_slug],
                )
                last_row = cur.fetchone()
                if last_row is None:
                    seq = 1
                    prev = GENESIS_PREV_HASH
                else:
                    seq = int(last_row[0]) + 1
                    prev = str(last_row[1])

                unsigned_fields: dict[str, object] = {
                    "sequence": seq,
                    "event_id": eid,
                    "occurred_at": ts_str,
                    "tenant_slug": tenant_slug,
                    "actor_type": clean_actor_type,
                    "actor_id": clean_actor_id,
                    "actor_label": clean_actor_label,
                    "action": clean_action,
                    "target_urn": clean_target,
                    "source_ip": clean_ip,
                    "metadata": clean_meta,
                    "prev_hash": prev,
                }
                digest = compute_domain_sha256(LEDGER_HASH_DOMAIN, unsigned_fields)
                cur.execute(
                    "INSERT INTO ee_audit_events ("
                    "tenant_slug, sequence, event_id, occurred_at, actor_type, actor_id, "
                    "actor_label, action, target_urn, source_ip, metadata_json, prev_hash, entry_hash"
                    ") VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    [
                        tenant_slug,
                        seq,
                        eid,
                        ts_str,
                        clean_actor_type,
                        clean_actor_id,
                        clean_actor_label,
                        clean_action,
                        clean_target,
                        clean_ip,
                        meta_json,
                        prev,
                        digest,
                    ],
                )
            return ComplianceAuditEvent(
                sequence=seq,
                event_id=eid,
                occurred_at=ts_str,
                tenant_slug=tenant_slug,
                actor_type=clean_actor_type,
                actor_id=clean_actor_id,
                actor_label=clean_actor_label,
                action=clean_action,
                target_urn=clean_target,
                source_ip=clean_ip,
                metadata=clean_meta,
                prev_hash=prev,
                entry_hash=digest,
            )

        with self._lock:
            chain = self._streams.setdefault(tenant_slug, [])
            seq = len(chain) + 1
            prev = GENESIS_PREV_HASH if seq == 1 else chain[-1].entry_hash
            unsigned_fields_mem: dict[str, object] = {
                "sequence": seq,
                "event_id": eid,
                "occurred_at": ts_str,
                "tenant_slug": tenant_slug,
                "actor_type": clean_actor_type,
                "actor_id": clean_actor_id,
                "actor_label": clean_actor_label,
                "action": clean_action,
                "target_urn": clean_target,
                "source_ip": clean_ip,
                "metadata": clean_meta,
                "prev_hash": prev,
            }
            digest = compute_domain_sha256(LEDGER_HASH_DOMAIN, unsigned_fields_mem)
            event = ComplianceAuditEvent(
                sequence=seq,
                event_id=eid,
                occurred_at=ts_str,
                tenant_slug=tenant_slug,
                actor_type=clean_actor_type,
                actor_id=clean_actor_id,
                actor_label=clean_actor_label,
                action=clean_action,
                target_urn=clean_target,
                source_ip=clean_ip,
                metadata=clean_meta,
                prev_hash=prev,
                entry_hash=digest,
            )
            chain.append(event)
            return event

    def snapshot_events(self, tenant_slug: str) -> tuple[ComplianceAuditEvent, ...]:
        require_enterprise_edition()
        if can_use_postgres():
            ensure_ee_tables()
            with connection.cursor() as cur:
                cur.execute(
                    "SELECT sequence, event_id, occurred_at, tenant_slug, actor_type, actor_id, "
                    "actor_label, action, target_urn, source_ip, metadata_json, prev_hash, entry_hash "
                    "FROM ee_audit_events WHERE tenant_slug = %s ORDER BY sequence ASC",
                    [tenant_slug],
                )
                rows = cur.fetchall()
            out: list[ComplianceAuditEvent] = []
            for row in rows:
                loaded_meta = json.loads(str(row[10]))
                meta_obj = loaded_meta if isinstance(loaded_meta, dict) else {}
                out.append(
                    ComplianceAuditEvent(
                        sequence=int(row[0]),
                        event_id=str(row[1]),
                        occurred_at=str(row[2]),
                        tenant_slug=str(row[3]),
                        actor_type=str(row[4]),
                        actor_id=str(row[5]),
                        actor_label=str(row[6]),
                        action=str(row[7]),
                        target_urn=str(row[8]),
                        source_ip=str(row[9]),
                        metadata=meta_obj,
                        prev_hash=str(row[11]),
                        entry_hash=str(row[12]),
                    )
                )
            return tuple(out)

        with self._lock:
            return tuple(self._streams.get(tenant_slug, ()))

    def head_hash(self, tenant_slug: str) -> str:
        require_enterprise_edition()
        if can_use_postgres():
            ensure_ee_tables()
            with connection.cursor() as cur:
                cur.execute(
                    "SELECT entry_hash FROM ee_audit_events "
                    "WHERE tenant_slug = %s ORDER BY sequence DESC LIMIT 1",
                    [tenant_slug],
                )
                row = cur.fetchone()
            return str(row[0]) if row is not None else GENESIS_PREV_HASH

        with self._lock:
            chain = self._streams.get(tenant_slug, [])
            return chain[-1].entry_hash if chain else GENESIS_PREV_HASH

    def verify_vault_integrity(self, tenant_slug: str) -> tuple[bool, list[str]]:
        """Verify hash-chain integrity across every event stored in the tenant's vault."""
        require_enterprise_edition()
        events = self.snapshot_events(tenant_slug)
        return verify_ledger_sequence(events)

    def sync_from_django_audit(
        self,
        *,
        organisation_id: UUID,
        tenant_slug: str,
    ) -> int:
        """Import any unchained `apps.audit.models.AuditEvent` rows for `organisation_id`."""
        require_enterprise_edition()
        from apps.audit.models import AuditEvent

        existing_ids = {evt.event_id for evt in self.snapshot_events(tenant_slug)}
        rows = AuditEvent.objects.filter(organisation_id=organisation_id).order_by(
            "occurred_at", "id"
        )
        added = 0
        for row in rows:
            rid = str(row.id)
            if rid in existing_ids:
                continue
            self.append_event(
                tenant_slug=tenant_slug,
                event_id=rid,
                occurred_at=row.occurred_at,
                actor_type=row.actor_type,
                actor_id=str(row.actor_id) if row.actor_id else "system",
                actor_label=row.actor_label or "",
                action=row.action,
                target_urn=row.target_urn,
                source_ip=str(row.source_ip_trunc or ""),
                metadata=row.metadata if isinstance(row.metadata, dict) else {},
            )
            added += 1
        return added


def verify_ledger_sequence(events: Sequence[ComplianceAuditEvent]) -> tuple[bool, list[str]]:
    errors: list[str] = []
    expected_prev = GENESIS_PREV_HASH
    for idx, evt in enumerate(events, start=1):
        if evt.sequence != idx:
            errors.append(f"row {idx}: expected sequence {idx}, got {evt.sequence}")
        if evt.prev_hash != expected_prev:
            errors.append(f"row {idx}: prev_hash mismatch")
        recomputed = compute_domain_sha256(LEDGER_HASH_DOMAIN, evt.ledger_payload())
        if evt.entry_hash != recomputed:
            errors.append(f"row {idx}: entry_hash mismatch")
        expected_prev = evt.entry_hash
    return (len(errors) == 0), errors


default_audit_ledger = ComplianceAuditLedger()
