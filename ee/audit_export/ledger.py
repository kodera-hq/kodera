"""Append-only SHA-256 hash-chained compliance audit ledger (`ee/audit_export/ledger.py`).

Persists hash-chained audit events in PostgreSQL (`public.ee_audit_ledger`) with `UUID` primary keys
and sequence-free `seq` (`BIGINT`, computed inside a per-organisation transaction advisory lock) so
all Gunicorn workers share a contiguous, tamper-evident chain under `kodera_api`'s narrow
append-only (`SELECT`, `INSERT`) grants.

Also persists server-governed Ed25519 verification public keys in `public.ee_audit_signing_key` so
previously exported compliance bundles remain verifiable across `KODERA_EE_AUDIT_SIGNING_SEED` /
`SECRET_KEY` rotations without ever trusting bundle-embedded attacker keys.

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from django.db import DatabaseError, IntegrityError, connection, transaction
from uuid6 import uuid7

from ee.audit_export.crypto import (
    GENESIS_PREV_HASH,
    LEDGER_HASH_DOMAIN,
    AuditSigner,
    Ed25519AuditSigner,
    HmacAuditSigner,
    compute_domain_sha256,
    derive_tenant_ed25519_signer,
    derive_tenant_hmac_signer,
)
from ee.edition import require_enterprise_edition
from ee.store import (
    TenantCutoffError,
    acquire_active_tenant_fence,
    can_use_postgres,
    is_retriable_lock_contention,
    reset_ee_tables,
)

SUPPORTED_FRAMEWORKS = frozenset({"SOC2", "ISO27001", "SECNUMCLOUD"})
MAX_EVENT_METADATA_BYTES = 32_768
MAX_EXPORT_QUERY_ROWS = 10_000
_URN_SEGMENT_CHARS = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-"
)

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


def _ledger_hash_fields(
    *,
    sequence: int,
    event_id: str,
    occurred_at: str,
    tenant_slug: str,
    actor_type: str,
    actor_id: str,
    action: str,
    target_urn: str,
    prev_hash: str,
) -> dict[str, object]:
    """Statutory immutable structural fields hashed into `ee_audit_ledger.entry_hash`.

    Scrubbable personal-data columns (`actor_label`, `source_ip`, `metadata_json`) are excluded from
    the persistent vault chain so statutory GDPR erasure scrubbing preserves vault hash continuity,
    while every exported bundle (`EXPORT_ROW_HASH_DOMAIN` + `payload_sha256` + detached signature)
    still binds all exported fields end-to-end.
    """
    return {
        "sequence": sequence,
        "event_id": event_id,
        "occurred_at": occurred_at,
        "tenant_slug": tenant_slug,
        "actor_type": actor_type,
        "actor_id": actor_id,
        "action": action,
        "target_urn": target_urn,
        "prev_hash": prev_hash,
    }


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
        return _ledger_hash_fields(
            sequence=self.sequence,
            event_id=self.event_id,
            occurred_at=self.occurred_at,
            tenant_slug=self.tenant_slug,
            actor_type=self.actor_type,
            actor_id=self.actor_id,
            action=self.action,
            target_urn=self.target_urn,
            prev_hash=self.prev_hash,
        )


def _try_parse_uuid(raw: str) -> UUID | None:
    try:
        return UUID(raw)
    except ValueError:
        return None


def truncate_audit_source_ip(raw_ip: str) -> str:
    """Truncate source IP (`/24` IPv4, `/48` IPv6) before persistence (`BUG-0055`)."""
    cleaned = raw_ip.strip()
    if not cleaned:
        return ""
    if "/" in cleaned:
        cleaned = cleaned.split("/", 1)[0].strip()
    try:
        addr = ipaddress.ip_address(cleaned)
    except ValueError:
        return ""
    if isinstance(addr, ipaddress.IPv4Address):
        return str(ipaddress.IPv4Network(f"{addr}/24", strict=False))
    return str(ipaddress.IPv6Network(f"{addr}/48", strict=False))


def validate_opaque_target_urn(raw_urn: str) -> str:
    """Require canonical opaque `urn:kodera:<type>:<id>[:...]` with zero `@` or PII (`BUG-0055`)."""
    cleaned = raw_urn.strip()
    if not (14 <= len(cleaned) <= 255):
        raise ValueError("target_urn must be 14..255 characters")
    if "@" in cleaned or any(ch.isspace() or ord(ch) < 0x21 or ord(ch) > 0x7E for ch in cleaned):
        raise ValueError("target_urn must not contain email addresses or whitespace")
    parts = cleaned.split(":")
    if len(parts) < 4 or parts[0] != "urn" or parts[1] != "kodera":
        raise ValueError("target_urn must match urn:kodera:<type>:<opaque_id>")
    for seg in parts[2:]:
        if not (1 <= len(seg) <= 128) or any(ch not in _URN_SEGMENT_CHARS for ch in seg):
            raise ValueError("target_urn contains non-opaque characters")
    return cleaned


def _sanitize_historical_target_urn(raw_urn: str) -> str:
    try:
        return validate_opaque_target_urn(raw_urn)
    except ValueError:
        digest = hashlib.sha256(raw_urn.encode("utf-8")).hexdigest()[:16]
        return f"urn:kodera:redacted:{digest}"


class ComplianceAuditLedger:
    """Multi-worker PostgreSQL-backed append-only SHA-256 hash-chained audit stream per tenant."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._streams: dict[str, list[ComplianceAuditEvent]] = {}
        self._signing_keys: dict[tuple[str, str], str] = {}
        self._ed25519_overrides: dict[str, Ed25519AuditSigner] = {}
        self._hmac_overrides: dict[str, HmacAuditSigner] = {}
        self._export_rate_windows: dict[str, list[float]] = {}

    def reset(self) -> None:
        with self._lock:
            self._streams.clear()
            self._signing_keys.clear()
            self._ed25519_overrides.clear()
            self._hmac_overrides.clear()
            self._export_rate_windows.clear()
        reset_ee_tables("audit")

    def check_export_rate_limit(
        self,
        tenant_slug: str,
        *,
        limit_per_minute: int = 30,
        now_monotonic: float | None = None,
    ) -> bool:
        """Enforce a per-tenant rolling 60s compliance export rate limit (`BUG-0056`)."""
        import time

        now_ts = time.monotonic() if now_monotonic is None else now_monotonic
        cutoff = now_ts - 60.0
        with self._lock:
            bucket = [t for t in self._export_rate_windows.get(tenant_slug, []) if t > cutoff]
            if len(bucket) >= limit_per_minute:
                self._export_rate_windows[tenant_slug] = bucket
                return False
            bucket.append(now_ts)
            self._export_rate_windows[tenant_slug] = bucket
            return True

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

    def register_signing_key(
        self,
        *,
        tenant_slug: str,
        signer: AuditSigner,
        organisation_id: UUID | None = None,
    ) -> None:
        """Persist a server-governed Ed25519 public verification key for historical verification."""
        require_enterprise_edition()
        if signer.algorithm != "ed25519":
            return
        pub_pem = signer.public_key_pem
        pub_b64 = signer.public_key_b64
        if not pub_pem or not pub_b64:
            return

        if can_use_postgres():
            try:
                with transaction.atomic(), connection.cursor() as cur:
                    org_id, resolved_slug = acquire_active_tenant_fence(
                        cur,
                        tenant_slug=tenant_slug,
                        organisation_id=organisation_id,
                    )
                    cur.execute(
                        """
                        SELECT 1
                        FROM public.ee_audit_signing_key
                        WHERE organisation_id = %s AND key_id = %s
                        LIMIT 1
                        """,
                        [org_id, signer.key_id],
                    )
                    if cur.fetchone() is None:
                        cur.execute(
                            """
                            INSERT INTO public.ee_audit_signing_key (
                                id, organisation_id, tenant_slug, algorithm,
                                key_id, public_key_b64, public_key_pem, created_at
                            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                            ON CONFLICT (organisation_id, key_id) DO NOTHING
                            """,
                            [
                                uuid7(),
                                org_id,
                                resolved_slug,
                                signer.algorithm,
                                signer.key_id,
                                pub_b64,
                                pub_pem,
                                datetime.now(UTC),
                            ],
                        )
            except IntegrityError as exc:
                raise TenantCutoffError("tenant_cutoff_fenced", status=403) from exc
            except DatabaseError as exc:
                if is_retriable_lock_contention(exc):
                    raise TenantCutoffError("authority_fenced", status=409) from exc
                raise
            return

        with self._lock:
            self._signing_keys[(tenant_slug, signer.key_id)] = pub_pem

    def resolve_trusted_ed25519_public_key(
        self,
        *,
        tenant_slug: str,
        key_id: str | None,
        organisation_id: UUID | None = None,
    ) -> str | None:
        """Resolve a server-governed Ed25519 public key by `(tenant_slug, key_id)`."""
        require_enterprise_edition()
        clean_kid = key_id.strip() if isinstance(key_id, str) and key_id.strip() else None

        if clean_kid is not None:
            if can_use_postgres():
                with connection.cursor() as cur:
                    if organisation_id is not None:
                        cur.execute(
                            """
                            SELECT public_key_pem
                            FROM public.ee_audit_signing_key
                            WHERE organisation_id = %s AND tenant_slug = %s AND key_id = %s
                            LIMIT 1
                            """,
                            [organisation_id, tenant_slug, clean_kid],
                        )
                    else:
                        cur.execute(
                            """
                            SELECT public_key_pem
                            FROM public.ee_audit_signing_key
                            WHERE tenant_slug = %s AND key_id = %s
                            LIMIT 1
                            """,
                            [tenant_slug, clean_kid],
                        )
                    row = cur.fetchone()
                if row is not None:
                    return str(row[0])
            else:
                with self._lock:
                    found_pem = self._signing_keys.get((tenant_slug, clean_kid))
                if found_pem is not None:
                    return found_pem

        active_signer = self.ed25519_signer_for_tenant(tenant_slug)
        if clean_kid is None or clean_kid == active_signer.key_id:
            return active_signer.public_key_pem
        return None

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
        organisation_id: UUID | None = None,
        user_id: UUID | None = None,
        allow_historical_erased: bool = False,
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
        meta_json = json.dumps(clean_meta, sort_keys=True, separators=(",", ":"))
        if len(meta_json.encode("utf-8")) > MAX_EVENT_METADATA_BYTES:
            raise ValueError(
                f"Audit event metadata exceeds {MAX_EVENT_METADATA_BYTES}-byte limit"
            )
        clean_actor_type = actor_type.strip()
        clean_actor_id = actor_id.strip()
        clean_actor_label = actor_label.strip()
        clean_action = action.strip()
        clean_target = validate_opaque_target_urn(target_urn)
        clean_ip = truncate_audit_source_ip(source_ip)

        if can_use_postgres():
            try:
                with transaction.atomic(), connection.cursor() as cur:
                    resolved_user_id: UUID | None = user_id
                    prescrubbed_at: datetime | None = None
                    if resolved_user_id is None:
                        candidate_uuid = _try_parse_uuid(clean_actor_id)
                        if candidate_uuid is not None:
                            if clean_actor_type == "customer_user":
                                cur.execute(
                                    """
                                    SELECT u.id, u.deleted_at, u.email,
                                           EXISTS(
                                               SELECT 1 FROM public.orgs_accounterasure ae
                                               WHERE ae.user_reference = u.id
                                           )
                                    FROM public.identity_user u
                                    WHERE u.id = %s
                                    LIMIT 1
                                    """,
                                    [candidate_uuid],
                                )
                                u_row = cur.fetchone()
                                if u_row is not None:
                                    u_erased = (
                                        u_row[1] is not None
                                        or str(u_row[2]).startswith("erased:")
                                        or bool(u_row[3])
                                    )
                                    if u_erased and allow_historical_erased:
                                        resolved_user_id = None
                                        clean_actor_label = f"erased:{candidate_uuid}"
                                        clean_ip = ""
                                        clean_meta = {}
                                        meta_json = "{}"
                                        prescrubbed_at = datetime.now(UTC)
                                    else:
                                        resolved_user_id = candidate_uuid
                            elif clean_actor_type == "tenant":
                                cur.execute(
                                    """
                                    SELECT i.user_id, i.deleted_at, i.email, u.deleted_at, u.email,
                                           EXISTS(
                                               SELECT 1 FROM public.orgs_accounterasure ae
                                               WHERE ae.user_reference = i.user_id
                                           )
                                    FROM public.identity_identity i
                                    JOIN public.identity_user u ON u.id = i.user_id
                                    WHERE i.id = %s
                                    LIMIT 1
                                    """,
                                    [candidate_uuid],
                                )
                                i_row = cur.fetchone()
                                if i_row is not None and i_row[0] is not None:
                                    uid_val = (
                                        i_row[0]
                                        if isinstance(i_row[0], UUID)
                                        else UUID(str(i_row[0]))
                                    )
                                    is_erased = (
                                        i_row[1] is not None
                                        or str(i_row[2]).startswith("erased:")
                                        or i_row[3] is not None
                                        or str(i_row[4]).startswith("erased:")
                                        or bool(i_row[5])
                                    )
                                    if is_erased and allow_historical_erased:
                                        resolved_user_id = None
                                        clean_actor_label = f"erased:{uid_val}"
                                        clean_ip = ""
                                        clean_meta = {}
                                        meta_json = "{}"
                                        prescrubbed_at = datetime.now(UTC)
                                    else:
                                        resolved_user_id = uid_val

                    org_id, resolved_slug = acquire_active_tenant_fence(
                        cur,
                        tenant_slug=tenant_slug,
                        organisation_id=organisation_id,
                        user_id=resolved_user_id,
                    )
                    if allow_historical_erased and prescrubbed_at is None and clean_meta:
                        cur.execute(
                            """
                            SELECT ae.user_reference,
                                   COALESCE(ae.inventory->'ee_audit_subject_sha256s', '[]'::jsonb)
                            FROM public.orgs_accounterasure ae
                            WHERE COALESCE(ae.inventory->'ee_audit_target_org_ids', '[]'::jsonb) ? %s
                            """,
                            [str(org_id)],
                        )
                        erasure_rows = cur.fetchall()
                        if erasure_rows and _metadata_matches_erased_digests(
                            clean_meta, erasure_rows
                        ):
                            clean_ip = ""
                            clean_meta = {}
                            meta_json = "{}"
                            prescrubbed_at = datetime.now(UTC)
                    cur.execute(
                        "SELECT pg_advisory_xact_lock(hashtext('kodera_ee_audit:' || %s))",
                        [str(org_id)],
                    )
                    cur.execute(
                        """
                        SELECT seq, entry_hash
                        FROM public.ee_audit_ledger
                        WHERE organisation_id = %s
                        ORDER BY seq DESC
                        LIMIT 1
                        """,
                        [org_id],
                    )
                    last_row = cur.fetchone()
                    if last_row is None:
                        seq = 1
                        prev = GENESIS_PREV_HASH
                    else:
                        seq = int(last_row[0]) + 1
                        prev = str(last_row[1])

                    unsigned_fields = _ledger_hash_fields(
                        sequence=seq,
                        event_id=eid,
                        occurred_at=ts_str,
                        tenant_slug=resolved_slug,
                        actor_type=clean_actor_type,
                        actor_id=clean_actor_id,
                        action=clean_action,
                        target_urn=clean_target,
                        prev_hash=prev,
                    )
                    digest = compute_domain_sha256(LEDGER_HASH_DOMAIN, unsigned_fields)
                    cur.execute(
                        """
                        INSERT INTO public.ee_audit_ledger (
                            id, organisation_id, user_id, tenant_slug, seq, event_id,
                            occurred_at, actor_type, actor_id, actor_label, action,
                            target_urn, source_ip, metadata_json, prev_hash, entry_hash,
                            pii_scrubbed_at
                        ) VALUES (
                            %s, %s, %s, %s, %s, %s,
                            %s, %s, %s, %s, %s,
                            %s, %s, %s, %s, %s,
                            %s
                        )
                        """,
                        [
                            uuid7(),
                            org_id,
                            resolved_user_id,
                            resolved_slug,
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
                            prescrubbed_at,
                        ],
                    )
            except IntegrityError as exc:
                msg = str(exc)
                if "account cutoff refuses write" in msg:
                    raise TenantCutoffError("account_cutoff_fenced", status=403) from exc
                if "erasure cutoff refuses write" in msg:
                    raise TenantCutoffError("tenant_cutoff_fenced", status=403) from exc
                raise
            except DatabaseError as exc:
                if is_retriable_lock_contention(exc):
                    raise TenantCutoffError("authority_fenced", status=409) from exc
                raise

            return ComplianceAuditEvent(
                sequence=seq,
                event_id=eid,
                occurred_at=ts_str,
                tenant_slug=resolved_slug,
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
            unsigned_fields_mem = _ledger_hash_fields(
                sequence=seq,
                event_id=eid,
                occurred_at=ts_str,
                tenant_slug=tenant_slug,
                actor_type=clean_actor_type,
                actor_id=clean_actor_id,
                action=clean_action,
                target_urn=clean_target,
                prev_hash=prev,
            )
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

    def snapshot_events(
        self,
        tenant_slug: str,
        *,
        organisation_id: UUID | None = None,
    ) -> tuple[ComplianceAuditEvent, ...]:
        require_enterprise_edition()
        if can_use_postgres():
            with connection.cursor() as cur:
                if organisation_id is not None:
                    cur.execute(
                        """
                        SELECT seq, event_id, occurred_at, tenant_slug, actor_type, actor_id,
                               actor_label, action, target_urn, source_ip, metadata_json,
                               prev_hash, entry_hash
                        FROM public.ee_audit_ledger
                        WHERE organisation_id = %s AND tenant_slug = %s
                        ORDER BY seq ASC
                        """,
                        [organisation_id, tenant_slug],
                    )
                else:
                    cur.execute(
                        """
                        SELECT seq, event_id, occurred_at, tenant_slug, actor_type, actor_id,
                               actor_label, action, target_urn, source_ip, metadata_json,
                               prev_hash, entry_hash
                        FROM public.ee_audit_ledger
                        WHERE tenant_slug = %s
                        ORDER BY seq ASC
                        """,
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

    def query_events(
        self,
        tenant_slug: str,
        *,
        organisation_id: UUID | None = None,
        from_timestamp: datetime | None = None,
        to_timestamp: datetime | None = None,
        actor_id: str | None = None,
        actor_type: str | None = None,
        action: str | None = None,
        after_seq: int | None = None,
        limit: int | None = None,
        max_rows: int = MAX_EXPORT_QUERY_ROWS,
    ) -> tuple[tuple[ComplianceAuditEvent, ...], bool]:
        """Query filtered audit events via SQL predicates + keyset cursor (`seq > after_seq`, `LIMIT`)."""
        require_enterprise_edition()
        fetch_cap = limit if limit is not None else max_rows
        if fetch_cap < 1 or fetch_cap > max_rows:
            raise ValueError(f"limit must be in 1..{max_rows}")

        if can_use_postgres():
            from_iso = format_utc_iso(from_timestamp) if from_timestamp is not None else None
            to_iso = format_utc_iso(to_timestamp) if to_timestamp is not None else None
            with connection.cursor() as cur:
                cur.execute(
                    """
                    SELECT seq, event_id, occurred_at, tenant_slug, actor_type, actor_id,
                           actor_label, action, target_urn, source_ip, metadata_json,
                           prev_hash, entry_hash
                    FROM public.ee_audit_ledger
                    WHERE (%s::uuid IS NULL OR organisation_id = %s)
                      AND tenant_slug = %s
                      AND (%s::bigint IS NULL OR seq > %s)
                      AND (%s::text IS NULL OR occurred_at >= %s)
                      AND (%s::text IS NULL OR occurred_at <= %s)
                      AND (%s::text IS NULL OR actor_id = %s)
                      AND (%s::text IS NULL OR actor_type = %s)
                      AND (%s::text IS NULL OR action = %s)
                    ORDER BY seq ASC
                    LIMIT %s
                    """,
                    [
                        organisation_id,
                        organisation_id,
                        tenant_slug,
                        after_seq,
                        after_seq,
                        from_iso,
                        from_iso,
                        to_iso,
                        to_iso,
                        actor_id,
                        actor_id,
                        actor_type,
                        actor_type,
                        action,
                        action,
                        fetch_cap + 1,
                    ],
                )
                rows = cur.fetchall()
            has_more = len(rows) > fetch_cap
            selected_rows = rows[:fetch_cap] if has_more else rows
            out: list[ComplianceAuditEvent] = []
            for row in selected_rows:
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
            return tuple(out), has_more

        with self._lock:
            mem_events = list(self._streams.get(tenant_slug, ()))
        matched: list[ComplianceAuditEvent] = []
        for evt in mem_events:
            if after_seq is not None and evt.sequence <= after_seq:
                continue
            evt_dt = parse_utc_iso(evt.occurred_at)
            if from_timestamp is not None and evt_dt < from_timestamp:
                continue
            if to_timestamp is not None and evt_dt > to_timestamp:
                continue
            if actor_id is not None and evt.actor_id != actor_id:
                continue
            if actor_type is not None and evt.actor_type != actor_type:
                continue
            if action is not None and evt.action != action:
                continue
            matched.append(evt)
            if len(matched) > fetch_cap:
                break
        has_more = len(matched) > fetch_cap
        return tuple(matched[:fetch_cap] if has_more else matched), has_more

    def head_hash(self, tenant_slug: str, *, organisation_id: UUID | None = None) -> str:
        require_enterprise_edition()
        if can_use_postgres():
            with connection.cursor() as cur:
                if organisation_id is not None:
                    cur.execute(
                        """
                        SELECT entry_hash
                        FROM public.ee_audit_ledger
                        WHERE organisation_id = %s AND tenant_slug = %s
                        ORDER BY seq DESC
                        LIMIT 1
                        """,
                        [organisation_id, tenant_slug],
                    )
                else:
                    cur.execute(
                        """
                        SELECT entry_hash
                        FROM public.ee_audit_ledger
                        WHERE tenant_slug = %s
                        ORDER BY seq DESC
                        LIMIT 1
                        """,
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
        """Import unchained `AuditEvent` rows, populating `user_id` & scrubbing erased historical actors."""
        require_enterprise_edition()
        from apps.audit.models import AuditEvent

        if can_use_postgres():
            with connection.cursor() as cur:
                cur.execute(
                    "SELECT event_id FROM public.ee_audit_ledger WHERE organisation_id = %s",
                    [organisation_id],
                )
                existing_ids = {str(r[0]) for r in cur.fetchall()}
        else:
            existing_ids = {
                evt.event_id
                for evt in self.snapshot_events(tenant_slug, organisation_id=organisation_id)
            }

        rows = AuditEvent.objects.filter(organisation_id=organisation_id).order_by(
            "occurred_at", "id"
        )
        added = 0
        for row in rows:
            rid = str(row.id)
            if rid in existing_ids:
                continue
            raw_meta = row.metadata if isinstance(row.metadata, dict) else {}
            serialized_meta = json.dumps(raw_meta, sort_keys=True, separators=(",", ":"))
            if len(serialized_meta.encode("utf-8")) > MAX_EVENT_METADATA_BYTES:
                raw_meta = {"truncated": True}
            self.append_event(
                tenant_slug=tenant_slug,
                organisation_id=organisation_id,
                event_id=rid,
                occurred_at=row.occurred_at,
                actor_type=row.actor_type,
                actor_id=str(row.actor_id) if row.actor_id else "system",
                actor_label=row.actor_label or "",
                action=row.action,
                target_urn=_sanitize_historical_target_urn(row.target_urn),
                source_ip=str(row.source_ip_trunc or ""),
                metadata=raw_meta,
                allow_historical_erased=True,
            )
            added += 1
        return added


def _collect_metadata_strings(value: object, out: list[str]) -> None:
    if isinstance(value, str):
        stripped = value.strip().lower()
        if stripped:
            out.append(stripped)
            for token in stripped.replace(",", " ").replace(";", " ").split():
                tok = token.strip("<>\"'()[]{}")
                if tok and tok != stripped:
                    out.append(tok)
    elif isinstance(value, Mapping):
        for v in value.values():
            _collect_metadata_strings(v, out)
    elif isinstance(value, list | tuple):
        for item in value:
            _collect_metadata_strings(item, out)


def _metadata_matches_erased_digests(
    metadata: Mapping[str, object],
    erasure_rows: Sequence[Sequence[object]],
) -> bool:
    digest_set: set[str] = set()
    for row in erasure_rows:
        user_ref = str(row[0] or "").strip().lower()
        if user_ref:
            digest_set.add(hashlib.sha256(user_ref.encode("utf-8")).hexdigest())
        raw_digests = row[1]
        if isinstance(raw_digests, str):
            try:
                parsed = json.loads(raw_digests)
            except ValueError:
                parsed = []
        elif isinstance(raw_digests, list | tuple):
            parsed = list(raw_digests)
        else:
            parsed = []
        for item in parsed:
            if isinstance(item, str) and len(item) == 64:
                digest_set.add(item)
    if not digest_set:
        return False
    strings: list[str] = []
    _collect_metadata_strings(metadata, strings)
    for item in strings:
        if hashlib.sha256(item.encode("utf-8")).hexdigest() in digest_set:
            return True
    return False


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


EE_AUDIT_ERASURE_MIGRATION_0035_FORWARD_SQL = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE FUNCTION public.ee_audit_row_matches_erasure(
    p_org uuid,
    p_row_id uuid,
    p_row_user uuid,
    p_actor_id text,
    p_actor_label text,
    p_metadata_json text,
    p_person uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    ae_inv jsonb;
    digests jsonb;
    meta_doc jsonb;
BEGIN
    IF p_person IS NULL THEN
        RETURN false;
    END IF;
    IF p_row_user IS NOT NULL AND p_row_user = p_person THEN
        RETURN true;
    END IF;

    SELECT ae.inventory
    INTO ae_inv
    FROM public.orgs_accounterasure ae
    WHERE ae.user_reference = p_person
    LIMIT 1;

    IF NOT FOUND OR ae_inv IS NULL THEN
        RETURN false;
    END IF;

    IF COALESCE(ae_inv->'ee_audit_scrub_ids', '[]'::jsonb) ? (p_row_id::text) THEN
        RETURN true;
    END IF;

    IF NOT (COALESCE(ae_inv->'ee_audit_target_org_ids', '[]'::jsonb) ? (p_org::text)) THEN
        RETURN false;
    END IF;

    digests := COALESCE(ae_inv->'ee_audit_subject_sha256s', '[]'::jsonb);
    IF jsonb_typeof(digests) IS DISTINCT FROM 'array' OR jsonb_array_length(digests) = 0 THEN
        RETURN false;
    END IF;

    IF p_actor_id IS NOT NULL AND p_actor_id <> ''
       AND digests ? encode(sha256(convert_to(lower(btrim(p_actor_id)), 'UTF8')), 'hex') THEN
        RETURN true;
    END IF;

    IF p_actor_label IS NOT NULL AND p_actor_label <> ''
       AND digests ? encode(sha256(convert_to(lower(btrim(p_actor_label)), 'UTF8')), 'hex') THEN
        RETURN true;
    END IF;

    IF p_metadata_json IS NOT NULL AND p_metadata_json <> '' AND p_metadata_json <> '{}' THEN
        BEGIN
            meta_doc := p_metadata_json::jsonb;
        EXCEPTION WHEN others THEN
            meta_doc := NULL;
        END;

        IF meta_doc IS NOT NULL THEN
            IF EXISTS (
                WITH RECURSIVE nodes(val) AS (
                    SELECT meta_doc
                    UNION ALL
                    SELECT CASE
                        WHEN jsonb_typeof(n.val) = 'object' THEN e.value
                        WHEN jsonb_typeof(n.val) = 'array' THEN a.value
                    END
                    FROM nodes n
                    LEFT JOIN LATERAL jsonb_each(
                        CASE WHEN jsonb_typeof(n.val) = 'object' THEN n.val ELSE '{}'::jsonb END
                    ) e ON jsonb_typeof(n.val) = 'object'
                    LEFT JOIN LATERAL jsonb_array_elements(
                        CASE WHEN jsonb_typeof(n.val) = 'array' THEN n.val ELSE '[]'::jsonb END
                    ) a ON jsonb_typeof(n.val) = 'array'
                    WHERE jsonb_typeof(n.val) IN ('object', 'array')
                )
                SELECT 1
                FROM nodes
                WHERE jsonb_typeof(val) = 'string'
                  AND digests ? encode(
                      sha256(convert_to(lower(btrim(val #>> '{}')), 'UTF8')),
                      'hex'
                  )
            ) THEN
                RETURN true;
            END IF;
        END IF;
    END IF;

    RETURN false;
END
$$;
REVOKE ALL ON FUNCTION public.ee_audit_row_matches_erasure(uuid, uuid, uuid, text, text, text, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.ee_privacy_cutoff_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    item jsonb := to_jsonb(NEW);
    org uuid;
    person uuid;
BEGIN
    org := NEW.organisation_id;
    IF NOT EXISTS (SELECT 1 FROM public.orgs_organisation WHERE id = org) THEN
        RAISE EXCEPTION 'ee organisation reference missing' USING ERRCODE = '23503';
    END IF;

    IF TG_TABLE_NAME = 'ee_audit_ledger' AND TG_OP = 'UPDATE' THEN
        IF NEW.source_ip = ''
           AND NEW.metadata_json = '{}'
           AND NEW.pii_scrubbed_at IS NOT NULL
           AND (to_jsonb(NEW) - ARRAY['actor_label', 'source_ip', 'metadata_json', 'pii_scrubbed_at'])
               IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['actor_label', 'source_ip', 'metadata_json', 'pii_scrubbed_at'])
           AND (
               (public.privacy_erasure_context(OLD.organisation_id) AND NEW.actor_label = 'erased')
               OR EXISTS (
                   SELECT 1
                   FROM public.retention_worker_context rwc
                   WHERE rwc.backend = pg_backend_pid()
                     AND rwc.transaction = txid_current()
                     AND rwc.purpose = 'account'
                     AND rwc.source_table = 'identity_user'
                     AND public.ee_audit_row_matches_erasure(
                         OLD.organisation_id,
                         OLD.id,
                         OLD.user_id,
                         OLD.actor_id,
                         OLD.actor_label,
                         OLD.metadata_json,
                         rwc.source_id
                     )
                     AND (
                         (OLD.user_id = rwc.source_id AND NEW.actor_label = 'erased:' || rwc.source_id::text)
                         OR (
                             OLD.user_id IS DISTINCT FROM rwc.source_id
                             AND NEW.actor_label IN (OLD.actor_label, 'erased:' || rwc.source_id::text)
                         )
                     )
               )
           )
        THEN
            RETURN NEW;
        END IF;
    END IF;

    PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy_erasure_cutoff:' || org::text, 0));
    IF (
        EXISTS (SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference = org)
        OR EXISTS (
            SELECT 1 FROM public.orgs_organisation
            WHERE id = org AND (state = 'closed' OR deleted_at IS NOT NULL)
        )
    ) AND NOT public.privacy_erasure_context(org) THEN
        RAISE EXCEPTION 'durable erasure cutoff refuses write' USING ERRCODE = '23514';
    END IF;

    IF (item ? 'user_id') AND (item->>'user_id') IS NOT NULL THEN
        person := (item->>'user_id')::uuid;
        IF NOT EXISTS (SELECT 1 FROM public.identity_user WHERE id = person) THEN
            RAISE EXCEPTION 'ee user reference missing' USING ERRCODE = '23503';
        END IF;
        PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy_account_cutoff:' || person::text, 0));
        IF EXISTS (SELECT 1 FROM public.orgs_accounterasure WHERE user_reference = person)
           AND NOT public.privacy_account_context(person)
           AND NOT public.privacy_erasure_context(org) THEN
            RAISE EXCEPTION 'durable account cutoff refuses write' USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.ee_privacy_cutoff_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.ee_audit_ledger_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'ee audit ledger is append-only' USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.source_ip = ''
           AND NEW.metadata_json = '{}'
           AND NEW.pii_scrubbed_at IS NOT NULL
           AND (to_jsonb(NEW) - ARRAY['actor_label', 'source_ip', 'metadata_json', 'pii_scrubbed_at'])
               IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['actor_label', 'source_ip', 'metadata_json', 'pii_scrubbed_at'])
           AND (
               (public.privacy_erasure_context(OLD.organisation_id) AND NEW.actor_label = 'erased')
               OR EXISTS (
                   SELECT 1
                   FROM public.retention_worker_context rwc
                   WHERE rwc.backend = pg_backend_pid()
                     AND rwc.transaction = txid_current()
                     AND rwc.purpose = 'account'
                     AND rwc.source_table = 'identity_user'
                     AND public.ee_audit_row_matches_erasure(
                         OLD.organisation_id,
                         OLD.id,
                         OLD.user_id,
                         OLD.actor_id,
                         OLD.actor_label,
                         OLD.metadata_json,
                         rwc.source_id
                     )
                     AND (
                         (OLD.user_id = rwc.source_id AND NEW.actor_label = 'erased:' || rwc.source_id::text)
                         OR (
                             OLD.user_id IS DISTINCT FROM rwc.source_id
                             AND NEW.actor_label IN (OLD.actor_label, 'erased:' || rwc.source_id::text)
                         )
                     )
               )
           )
        THEN
            RETURN NEW;
        END IF;

        RAISE EXCEPTION 'ee audit ledger is immutable' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.ee_audit_ledger_immutable_guard() FROM PUBLIC;

CREATE FUNCTION public.ee_audit_erasure_journal_hook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    person uuid;
    target_orgs uuid[] := ARRAY[]::uuid[];
    target_org_texts text[] := ARRAY[]::text[];
    subject_sha256s jsonb := '[]'::jsonb;
    scrub_ids jsonb := '[]'::jsonb;
    scrubbed_count bigint := 0;
BEGIN
    IF TG_TABLE_NAME <> 'orgs_accounterasure' THEN
        RETURN NEW;
    END IF;

    person := NEW.user_reference;

    IF TG_OP = 'INSERT' THEN
        SELECT COALESCE(array_agg(org_id ORDER BY org_id), ARRAY[]::uuid[]),
               COALESCE(array_agg(org_id::text ORDER BY org_id::text), ARRAY[]::text[])
        INTO target_orgs, target_org_texts
        FROM (
            SELECT DISTINCT m.organisation_id AS org_id
            FROM public.orgs_membership m
            WHERE m.user_id = person
            UNION
            SELECT DISTINCT i.organisation_id AS org_id
            FROM public.identity_identity i
            WHERE i.user_id = person AND i.organisation_id IS NOT NULL
        ) orgs;

        SELECT COALESCE(jsonb_agg(sha ORDER BY sha), '[]'::jsonb)
        INTO subject_sha256s
        FROM (
            SELECT DISTINCT encode(sha256(convert_to(tok, 'UTF8')), 'hex') AS sha
            FROM (
                SELECT lower(btrim(u.email)) AS tok
                FROM public.identity_user u WHERE u.id = person
                UNION
                SELECT lower(btrim(u.display_name)) AS tok
                FROM public.identity_user u WHERE u.id = person AND u.display_name IS NOT NULL
                UNION
                SELECT lower(btrim(i.email)) AS tok
                FROM public.identity_identity i WHERE i.user_id = person
                UNION
                SELECT lower(person::text) AS tok
                UNION
                SELECT lower(i.id::text) AS tok
                FROM public.identity_identity i WHERE i.user_id = person
                UNION
                SELECT lower(btrim(i.subject)) AS tok
                FROM public.identity_identity i WHERE i.user_id = person
            ) tokens
            WHERE tok IS NOT NULL AND tok <> '' AND tok NOT LIKE 'erased:%'
        ) digests;

        IF to_regclass('public.ee_audit_ledger') IS NOT NULL THEN
            SELECT COALESCE(jsonb_agg(l.id::text ORDER BY l.id::text), '[]'::jsonb)
            INTO scrub_ids
            FROM public.ee_audit_ledger l
            WHERE l.user_id = person
               OR (
                   l.organisation_id = ANY(target_orgs)
                   AND (
                       subject_sha256s ? encode(sha256(convert_to(lower(btrim(l.actor_id)), 'UTF8')), 'hex')
                       OR subject_sha256s ? encode(sha256(convert_to(lower(btrim(l.actor_label)), 'UTF8')), 'hex')
                       OR EXISTS (
                           SELECT 1
                           FROM (
                               SELECT lower(btrim(u.email)) AS needle
                               FROM public.identity_user u WHERE u.id = person
                               UNION
                               SELECT lower(btrim(i.email)) AS needle
                               FROM public.identity_identity i WHERE i.user_id = person
                               UNION
                               SELECT lower(person::text) AS needle
                               UNION
                               SELECT lower(i.id::text) AS needle
                               FROM public.identity_identity i WHERE i.user_id = person
                           ) needles
                           WHERE needles.needle IS NOT NULL
                             AND needles.needle <> ''
                             AND needles.needle NOT LIKE 'erased:%'
                             AND (
                                 strpos(lower(l.metadata_json), needles.needle) > 0
                                 OR strpos(lower(l.actor_label), needles.needle) > 0
                                 OR strpos(lower(l.actor_id), needles.needle) > 0
                             )
                       )
                   )
               );
        END IF;

        NEW.inventory := NEW.inventory || jsonb_build_object(
            'ee_audit_target_org_ids', to_jsonb(target_org_texts),
            'ee_audit_subject_sha256s', subject_sha256s,
            'ee_audit_scrub_ids', scrub_ids
        );
        NEW.inventory_sha256 := public.retention_inventory_digest(NEW.inventory);
        RETURN NEW;

    ELSIF TG_OP = 'UPDATE' THEN
        subject_sha256s := COALESCE(NEW.inventory->'ee_audit_subject_sha256s', '[]'::jsonb);

        IF OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
            IF to_regclass('public.ee_audit_ledger') IS NOT NULL THEN
                UPDATE public.ee_audit_ledger l
                SET actor_label = CASE
                        WHEN l.user_id = person
                             OR subject_sha256s ? encode(sha256(convert_to(lower(btrim(l.actor_id)), 'UTF8')), 'hex')
                             OR subject_sha256s ? encode(sha256(convert_to(lower(btrim(l.actor_label)), 'UTF8')), 'hex')
                        THEN 'erased:' || person::text
                        ELSE l.actor_label
                    END,
                    source_ip = '',
                    metadata_json = '{}',
                    pii_scrubbed_at = COALESCE(l.pii_scrubbed_at, clock_timestamp())
                WHERE public.ee_audit_row_matches_erasure(
                    l.organisation_id,
                    l.id,
                    l.user_id,
                    l.actor_id,
                    l.actor_label,
                    l.metadata_json,
                    person
                )
                AND (
                    l.pii_scrubbed_at IS NULL
                    OR l.metadata_json <> '{}'
                    OR l.source_ip <> ''
                    OR (
                        (
                            l.user_id = person
                            OR subject_sha256s ? encode(sha256(convert_to(lower(btrim(l.actor_id)), 'UTF8')), 'hex')
                            OR subject_sha256s ? encode(sha256(convert_to(lower(btrim(l.actor_label)), 'UTF8')), 'hex')
                        )
                        AND l.actor_label IS DISTINCT FROM ('erased:' || person::text)
                    )
                );
                GET DIAGNOSTICS scrubbed_count = ROW_COUNT;

                NEW.counts := COALESCE(NEW.counts, '{}'::jsonb) || jsonb_build_object(
                    'ee_audit_subject_scrubbed', scrubbed_count
                );
            END IF;
        END IF;

        IF OLD.status <> 'complete' AND NEW.status = 'complete' THEN
            IF to_regclass('public.ee_audit_ledger') IS NOT NULL THEN
                IF EXISTS (
                    SELECT 1
                    FROM public.ee_audit_ledger l
                    WHERE public.ee_audit_row_matches_erasure(
                        l.organisation_id,
                        l.id,
                        l.user_id,
                        l.actor_id,
                        l.actor_label,
                        l.metadata_json,
                        person
                    )
                    AND (
                        l.pii_scrubbed_at IS NULL
                        OR l.metadata_json <> '{}'
                        OR l.source_ip <> ''
                        OR (
                            (
                                l.user_id = person
                                OR subject_sha256s ? encode(sha256(convert_to(lower(btrim(l.actor_id)), 'UTF8')), 'hex')
                                OR subject_sha256s ? encode(sha256(convert_to(lower(btrim(l.actor_label)), 'UTF8')), 'hex')
                            )
                            AND l.actor_label IS DISTINCT FROM ('erased:' || person::text)
                            AND l.actor_label IS DISTINCT FROM 'erased'
                        )
                    )
                ) THEN
                    RAISE EXCEPTION 'enterprise audit ledger subject personal data still present'
                        USING ERRCODE = '23514';
                END IF;
            END IF;
        END IF;

        RETURN NEW;
    END IF;

    RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.ee_audit_erasure_journal_hook() FROM PUBLIC;

CREATE TRIGGER aa_03_ee_audit_erasure
    BEFORE INSERT OR UPDATE ON public.orgs_accounterasure
    FOR EACH ROW EXECUTE FUNCTION public.ee_audit_erasure_journal_hook();
"""

EE_AUDIT_ERASURE_RESTORE_0032_GUARDS_SQL = r"""
DROP TRIGGER IF EXISTS aa_03_ee_audit_erasure ON public.orgs_accounterasure;
DROP FUNCTION IF EXISTS public.ee_audit_erasure_journal_hook();

CREATE OR REPLACE FUNCTION public.ee_privacy_cutoff_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE item jsonb := to_jsonb(NEW); org uuid; person uuid;
BEGIN
 org := NEW.organisation_id;
 IF NOT EXISTS(SELECT 1 FROM public.orgs_organisation WHERE id = org) THEN
  RAISE EXCEPTION 'ee organisation reference missing' USING ERRCODE='23503';
 END IF;
 IF TG_TABLE_NAME = 'ee_audit_ledger' AND TG_OP = 'UPDATE' THEN
  IF OLD.user_id IS NOT NULL AND public.privacy_account_context(OLD.user_id)
  AND NEW.actor_label = 'erased:' || OLD.user_id::text
  AND NEW.source_ip = '' AND NEW.metadata_json = '{}' AND NEW.pii_scrubbed_at IS NOT NULL
  AND (to_jsonb(NEW) - ARRAY['actor_label','source_ip','metadata_json','pii_scrubbed_at'])
   IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['actor_label','source_ip','metadata_json','pii_scrubbed_at'])
  THEN RETURN NEW; END IF;
 END IF;

 PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy_erasure_cutoff:' || org::text, 0));
 IF (EXISTS(SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference = org)
  OR EXISTS(SELECT 1 FROM public.orgs_organisation WHERE id = org AND (state = 'closed' OR deleted_at IS NOT NULL)))
  AND NOT public.privacy_erasure_context(org) THEN
  RAISE EXCEPTION 'durable erasure cutoff refuses write' USING ERRCODE='23514';
 END IF;

 IF (item ? 'user_id') AND (item->>'user_id') IS NOT NULL THEN
  person := (item->>'user_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.identity_user WHERE id = person) THEN
   RAISE EXCEPTION 'ee user reference missing' USING ERRCODE='23503';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy_account_cutoff:' || person::text, 0));
  IF EXISTS(SELECT 1 FROM public.orgs_accounterasure WHERE user_reference = person)
   AND NOT public.privacy_account_context(person)
   AND NOT public.privacy_erasure_context(org) THEN
   RAISE EXCEPTION 'durable account cutoff refuses write' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ee_privacy_cutoff_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.ee_audit_ledger_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'ee audit ledger is append-only' USING ERRCODE='23514';
 END IF;
 IF TG_OP = 'UPDATE' THEN
  IF (public.privacy_erasure_context(OLD.organisation_id)
   OR (OLD.user_id IS NOT NULL AND public.privacy_account_context(OLD.user_id)))
   AND NEW.source_ip = '' AND NEW.metadata_json = '{}' AND NEW.pii_scrubbed_at IS NOT NULL
   AND (NEW.actor_label = 'erased' OR (OLD.user_id IS NOT NULL AND NEW.actor_label = 'erased:' || OLD.user_id::text))
   AND (to_jsonb(NEW) - ARRAY['actor_label','source_ip','metadata_json','pii_scrubbed_at'])
    IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['actor_label','source_ip','metadata_json','pii_scrubbed_at'])
  THEN
   RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ee audit ledger is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ee_audit_ledger_immutable_guard() FROM PUBLIC;

DROP FUNCTION IF EXISTS public.ee_audit_row_matches_erasure(uuid, uuid, uuid, text, text, text, uuid);
"""

EE_AUDIT_ERASURE_MIGRATION_0035_REVERSE_SQL = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $$
BEGIN
    LOCK TABLE public.orgs_accounterasure IN SHARE MODE;
    IF EXISTS (
        SELECT 1 FROM public.orgs_accounterasure
        WHERE inventory ? 'ee_audit_scrub_ids'
           OR inventory ? 'ee_audit_subject_sha256s'
           OR counts ? 'ee_audit_subject_scrubbed'
    ) THEN
        RAISE EXCEPTION 'cannot downgrade enterprise audit erasure migration while admitted obligations exist'
            USING ERRCODE = '23514';
    END IF;
END
$$;

DROP TRIGGER IF EXISTS aa_03_ee_audit_erasure ON public.orgs_accounterasure;
DROP FUNCTION IF EXISTS public.ee_audit_erasure_journal_hook();

CREATE OR REPLACE FUNCTION public.ee_privacy_cutoff_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE item jsonb := to_jsonb(NEW); org uuid; person uuid;
BEGIN
 org := NEW.organisation_id;
 IF NOT EXISTS(SELECT 1 FROM public.orgs_organisation WHERE id = org) THEN
  RAISE EXCEPTION 'ee organisation reference missing' USING ERRCODE='23503';
 END IF;
 IF TG_TABLE_NAME = 'ee_audit_ledger' AND TG_OP = 'UPDATE' THEN
  IF OLD.user_id IS NOT NULL AND public.privacy_account_context(OLD.user_id)
  AND NEW.actor_label = 'erased:' || OLD.user_id::text
  AND NEW.source_ip = '' AND NEW.metadata_json = '{}' AND NEW.pii_scrubbed_at IS NOT NULL
  AND (to_jsonb(NEW) - ARRAY['actor_label','source_ip','metadata_json','pii_scrubbed_at'])
   IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['actor_label','source_ip','metadata_json','pii_scrubbed_at'])
  THEN RETURN NEW; END IF;
 END IF;

 PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy_erasure_cutoff:' || org::text, 0));
 IF (EXISTS(SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference = org)
  OR EXISTS(SELECT 1 FROM public.orgs_organisation WHERE id = org AND (state = 'closed' OR deleted_at IS NOT NULL)))
  AND NOT public.privacy_erasure_context(org) THEN
  RAISE EXCEPTION 'durable erasure cutoff refuses write' USING ERRCODE='23514';
 END IF;

 IF (item ? 'user_id') AND (item->>'user_id') IS NOT NULL THEN
  person := (item->>'user_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.identity_user WHERE id = person) THEN
   RAISE EXCEPTION 'ee user reference missing' USING ERRCODE='23503';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy_account_cutoff:' || person::text, 0));
  IF EXISTS(SELECT 1 FROM public.orgs_accounterasure WHERE user_reference = person)
   AND NOT public.privacy_account_context(person)
   AND NOT public.privacy_erasure_context(org) THEN
   RAISE EXCEPTION 'durable account cutoff refuses write' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ee_privacy_cutoff_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.ee_audit_ledger_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'ee audit ledger is append-only' USING ERRCODE='23514';
 END IF;
 IF TG_OP = 'UPDATE' THEN
  IF (public.privacy_erasure_context(OLD.organisation_id)
   OR (OLD.user_id IS NOT NULL AND public.privacy_account_context(OLD.user_id)))
   AND NEW.source_ip = '' AND NEW.metadata_json = '{}' AND NEW.pii_scrubbed_at IS NOT NULL
   AND (NEW.actor_label = 'erased' OR (OLD.user_id IS NOT NULL AND NEW.actor_label = 'erased:' || OLD.user_id::text))
   AND (to_jsonb(NEW) - ARRAY['actor_label','source_ip','metadata_json','pii_scrubbed_at'])
    IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['actor_label','source_ip','metadata_json','pii_scrubbed_at'])
  THEN
   RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ee audit ledger is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ee_audit_ledger_immutable_guard() FROM PUBLIC;

DROP FUNCTION IF EXISTS public.ee_audit_row_matches_erasure(uuid, uuid, uuid, text, text, text, uuid);
"""


default_audit_ledger = ComplianceAuditLedger()
