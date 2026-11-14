"""Append-only SHA-256 hash-chained compliance audit ledger (`ee/audit_export/ledger.py`).

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from uuid6 import uuid7

from ee.audit_export.crypto import (
    GENESIS_PREV_HASH,
    LEDGER_HASH_DOMAIN,
    Ed25519AuditSigner,
    HmacAuditSigner,
    compute_domain_sha256,
)
from ee.edition import require_enterprise_edition

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
    """Thread-safe append-only SHA-256 hash-chained audit stream per tenant."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._streams: dict[str, list[ComplianceAuditEvent]] = {}
        self._ed25519_signers: dict[str, Ed25519AuditSigner] = {}
        self._hmac_signers: dict[str, HmacAuditSigner] = {}

    def reset(self) -> None:
        with self._lock:
            self._streams.clear()
            self._ed25519_signers.clear()
            self._hmac_signers.clear()

    def ed25519_signer_for_tenant(self, tenant_slug: str) -> Ed25519AuditSigner:
        require_enterprise_edition()
        with self._lock:
            signer = self._ed25519_signers.get(tenant_slug)
            if signer is None:
                signer = Ed25519AuditSigner()
                self._ed25519_signers[tenant_slug] = signer
            return signer

    def hmac_signer_for_tenant(
        self,
        tenant_slug: str,
        *,
        secret_key: bytes | None = None,
    ) -> HmacAuditSigner:
        require_enterprise_edition()
        with self._lock:
            if secret_key is not None:
                signer = HmacAuditSigner(secret_key)
                self._hmac_signers[tenant_slug] = signer
                return signer
            existing = self._hmac_signers.get(tenant_slug)
            if existing is None:
                existing = HmacAuditSigner()
                self._hmac_signers[tenant_slug] = existing
            return existing

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

        with self._lock:
            chain = self._streams.setdefault(tenant_slug, [])
            seq = len(chain) + 1
            prev = GENESIS_PREV_HASH if seq == 1 else chain[-1].entry_hash
            unsigned_fields: dict[str, object] = {
                "sequence": seq,
                "event_id": eid,
                "occurred_at": ts_str,
                "tenant_slug": tenant_slug,
                "actor_type": actor_type.strip(),
                "actor_id": actor_id.strip(),
                "actor_label": actor_label.strip(),
                "action": action.strip(),
                "target_urn": target_urn.strip(),
                "source_ip": source_ip.strip(),
                "metadata": clean_meta,
                "prev_hash": prev,
            }
            digest = compute_domain_sha256(LEDGER_HASH_DOMAIN, unsigned_fields)
            event = ComplianceAuditEvent(
                sequence=seq,
                event_id=eid,
                occurred_at=ts_str,
                tenant_slug=tenant_slug,
                actor_type=actor_type.strip(),
                actor_id=actor_id.strip(),
                actor_label=actor_label.strip(),
                action=action.strip(),
                target_urn=target_urn.strip(),
                source_ip=source_ip.strip(),
                metadata=clean_meta,
                prev_hash=prev,
                entry_hash=digest,
            )
            chain.append(event)
            return event

    def snapshot_events(self, tenant_slug: str) -> tuple[ComplianceAuditEvent, ...]:
        require_enterprise_edition()
        with self._lock:
            return tuple(self._streams.get(tenant_slug, ()))

    def head_hash(self, tenant_slug: str) -> str:
        require_enterprise_edition()
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
