"""Signed NDJSON & CSV compliance bundle exporter with PII redaction and streaming.

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import csv
import hashlib
import io
import ipaddress
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final
from uuid import uuid4

from ee.audit_export.crypto import (
    EXPORT_ROW_HASH_DOMAIN,
    GENESIS_PREV_HASH,
    AuditSigner,
    canonical_json_bytes,
    compute_domain_sha256,
)
from ee.audit_export.ledger import (
    FRAMEWORK_CONTROL_CATALOG,
    SUPPORTED_FRAMEWORKS,
    ComplianceAuditEvent,
    ComplianceAuditLedger,
    format_utc_iso,
    parse_utc_iso,
)
from ee.edition import require_enterprise_edition

EXPORT_SCHEMA_VERSION = "kodera.compliance.audit-export.v1"
SUPPORTED_EXPORT_FORMATS = frozenset({"ndjson", "csv"})

CSV_COLUMNS = (
    "export_seq",
    "ledger_seq",
    "event_id",
    "occurred_at",
    "tenant_slug",
    "framework",
    "framework_controls",
    "actor_type",
    "actor_id",
    "actor_label",
    "action",
    "target_urn",
    "source_ip",
    "metadata_json",
    "prev_hash",
    "entry_hash",
)

_EMAIL_LOCAL_CHARS: Final[frozenset[str]] = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._%+-"
)
_EMAIL_DOMAIN_CHARS: Final[frozenset[str]] = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-"
)
_SENSITIVE_META_KEYS = frozenset(
    {"email", "mail", "full_name", "display_name", "phone", "ip", "source_ip", "user_agent"}
)


class AuditExportError(ValueError):
    """Raised when compliance audit export parameters are invalid."""

    def __init__(self, code: str, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True, slots=True)
class AuditExportFilters:
    from_timestamp: datetime | None = None
    to_timestamp: datetime | None = None
    actor_id: str | None = None
    actor_type: str | None = None
    action: str | None = None

    def to_manifest_dict(self) -> dict[str, str | None]:
        return {
            "from_timestamp": format_utc_iso(self.from_timestamp)
            if self.from_timestamp is not None
            else None,
            "to_timestamp": format_utc_iso(self.to_timestamp)
            if self.to_timestamp is not None
            else None,
            "actor_id": self.actor_id,
            "actor_type": self.actor_type,
            "action": self.action,
        }


@dataclass(frozen=True, slots=True)
class ExportedComplianceBundle:
    bundle_id: str
    tenant_slug: str
    framework: str
    export_format: str
    payload_bytes: bytes
    manifest: dict[str, object]

    @property
    def payload_text(self) -> str:
        return self.payload_bytes.decode("utf-8")


def _pseudonymize_email_str(raw_email: str, tenant_slug: str) -> str:
    raw = raw_email.lower().encode("utf-8")
    digest = hashlib.sha256(
        b"kodera-pii-redact-v1\x00" + tenant_slug.encode("utf-8") + b"\x00" + raw
    ).hexdigest()[:12]
    return f"redacted-{digest}@redacted.invalid"


def _looks_like_redactable_domain(domain: str) -> bool:
    if not (3 <= len(domain) <= 253) or "." not in domain:
        return False
    parts = domain.split(".")
    if any(not part for part in parts):
        return False
    tld = parts[-1]
    return 2 <= len(tld) <= 24 and tld.isalpha()


def _redact_ip(raw_ip: str) -> str:
    cleaned = raw_ip.strip()
    if not cleaned:
        return ""
    if "/" in cleaned:
        cleaned = cleaned.split("/", 1)[0]
    try:
        addr = ipaddress.ip_address(cleaned)
    except ValueError:
        return "[REDACTED_IP]"
    if isinstance(addr, ipaddress.IPv4Address):
        net4 = ipaddress.IPv4Network(f"{addr}/24", strict=False)
        return str(net4)
    net6 = ipaddress.IPv6Network(f"{addr}/48", strict=False)
    return str(net6)


def _redact_string(value: str, tenant_slug: str) -> str:
    """Scan and pseudonymize email addresses in O(n) linear time without regular expressions."""
    if "@" not in value:
        return value
    out: list[str] = []
    cursor = 0
    total = len(value)
    at_idx = value.find("@", cursor)
    while at_idx != -1:
        left_limit = max(cursor, at_idx - 64)
        l_pos = at_idx
        while l_pos > left_limit and value[l_pos - 1] in _EMAIL_LOCAL_CHARS:
            l_pos -= 1
        local_part = value[l_pos:at_idx]

        right_limit = min(total, at_idx + 1 + 278)
        r_pos = at_idx + 1
        while r_pos < right_limit and value[r_pos] in _EMAIL_DOMAIN_CHARS:
            r_pos += 1
        while r_pos > at_idx + 1 and value[r_pos - 1] in ".-":
            r_pos -= 1
        domain_part = value[at_idx + 1 : r_pos]

        if local_part and _looks_like_redactable_domain(domain_part):
            out.append(value[cursor:l_pos])
            out.append(_pseudonymize_email_str(f"{local_part}@{domain_part}", tenant_slug))
            cursor = r_pos
        else:
            out.append(value[cursor : at_idx + 1])
            cursor = at_idx + 1
        at_idx = value.find("@", cursor)

    out.append(value[cursor:])
    return "".join(out)


def _redact_metadata(value: object, tenant_slug: str) -> object:
    if isinstance(value, str):
        return _redact_string(value, tenant_slug)
    if isinstance(value, list):
        return [_redact_metadata(item, tenant_slug) for item in value]
    if isinstance(value, dict):
        redacted_dict: dict[str, object] = {}
        for k, v in value.items():
            key_str = str(k)
            low_k = key_str.lower()
            if low_k in {"ip", "source_ip"} and isinstance(v, str):
                redacted_dict[key_str] = _redact_ip(v)
            elif low_k in _SENSITIVE_META_KEYS:
                if isinstance(v, str) and "@" in v:
                    redacted_dict[key_str] = _redact_string(v, tenant_slug)
                else:
                    digest = hashlib.sha256(
                        b"kodera-pii-field-v1\x00"
                        + tenant_slug.encode("utf-8")
                        + b"\x00"
                        + str(v).encode("utf-8")
                    ).hexdigest()[:12]
                    redacted_dict[key_str] = f"[REDACTED:{digest}]"
            else:
                redacted_dict[key_str] = _redact_metadata(v, tenant_slug)
        return redacted_dict
    return value


def canonical_export_row_input(row: Mapping[str, object]) -> dict[str, object]:
    """Return the exact canonical field dict hashed into `entry_hash` for NDJSON & CSV parity."""
    return {
        "export_seq": row["export_seq"],
        "ledger_seq": row["ledger_seq"],
        "event_id": row["event_id"],
        "occurred_at": row["occurred_at"],
        "tenant_slug": row["tenant_slug"],
        "framework": row["framework"],
        "framework_controls": list(row["framework_controls"])  # type: ignore[call-overload]
        if isinstance(row.get("framework_controls"), list | tuple)
        else [],
        "actor_type": row["actor_type"],
        "actor_id": row["actor_id"],
        "actor_label": row["actor_label"],
        "action": row["action"],
        "target_urn": row["target_urn"],
        "source_ip": row["source_ip"],
        "metadata": row["metadata"],
        "prev_hash": row["prev_hash"],
    }


def _filter_events(
    events: Sequence[ComplianceAuditEvent],
    filters: AuditExportFilters,
) -> list[ComplianceAuditEvent]:
    if (
        filters.from_timestamp is not None
        and filters.to_timestamp is not None
        and filters.from_timestamp > filters.to_timestamp
    ):
        raise AuditExportError(
            "invalid_time_range",
            "from_timestamp must not be after to_timestamp",
        )
    matched: list[ComplianceAuditEvent] = []
    for evt in events:
        evt_dt = parse_utc_iso(evt.occurred_at)
        if filters.from_timestamp is not None and evt_dt < filters.from_timestamp:
            continue
        if filters.to_timestamp is not None and evt_dt > filters.to_timestamp:
            continue
        if filters.actor_id is not None and evt.actor_id != filters.actor_id:
            continue
        if filters.actor_type is not None and evt.actor_type != filters.actor_type:
            continue
        if filters.action is not None and evt.action != filters.action:
            continue
        matched.append(evt)
    return matched


def _build_chained_export_rows(
    events: Sequence[ComplianceAuditEvent],
    *,
    tenant_slug: str,
    framework: str,
    redact_pii: bool,
) -> list[dict[str, object]]:
    controls = list(FRAMEWORK_CONTROL_CATALOG[framework])
    rows: list[dict[str, object]] = []
    prev_hash = GENESIS_PREV_HASH

    for export_seq, evt in enumerate(events, start=1):
        actor_label = (
            _redact_string(evt.actor_label, tenant_slug)
            if redact_pii and evt.actor_label
            else evt.actor_label
        )
        if redact_pii and actor_label and "@" not in evt.actor_label:
            digest = hashlib.sha256(
                b"kodera-pii-actor-v1\x00"
                + tenant_slug.encode("utf-8")
                + b"\x00"
                + evt.actor_label.encode("utf-8")
            ).hexdigest()[:12]
            actor_label = f"redacted-actor-{digest}"

        source_ip = _redact_ip(evt.source_ip) if redact_pii else evt.source_ip
        meta = (
            _redact_metadata(dict(evt.metadata), tenant_slug) if redact_pii else dict(evt.metadata)
        )

        draft: dict[str, object] = {
            "export_seq": export_seq,
            "ledger_seq": evt.sequence,
            "event_id": evt.event_id,
            "occurred_at": evt.occurred_at,
            "tenant_slug": evt.tenant_slug,
            "framework": framework,
            "framework_controls": controls,
            "actor_type": evt.actor_type,
            "actor_id": evt.actor_id,
            "actor_label": actor_label,
            "action": evt.action,
            "target_urn": evt.target_urn,
            "source_ip": source_ip,
            "metadata": meta,
            "prev_hash": prev_hash,
        }
        entry_hash = compute_domain_sha256(
            EXPORT_ROW_HASH_DOMAIN,
            canonical_export_row_input(draft),
        )
        draft["entry_hash"] = entry_hash
        rows.append(draft)
        prev_hash = entry_hash

    return rows


def _render_ndjson_chunks(rows: Sequence[dict[str, object]]) -> Iterator[bytes]:
    for row in rows:
        yield canonical_json_bytes(row) + b"\n"


def _render_csv_chunks(rows: Sequence[dict[str, object]]) -> Iterator[bytes]:
    header_buf = io.StringIO()
    writer = csv.writer(header_buf, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    yield header_buf.getvalue().encode("utf-8")

    for row in rows:
        row_buf = io.StringIO()
        row_writer = csv.writer(row_buf, lineterminator="\n")
        controls = row["framework_controls"]
        control_items = controls if isinstance(controls, list) else []
        row_writer.writerow(
            [
                str(row["export_seq"]),
                str(row["ledger_seq"]),
                str(row["event_id"]),
                str(row["occurred_at"]),
                str(row["tenant_slug"]),
                str(row["framework"]),
                ",".join(str(c) for c in control_items),
                str(row["actor_type"]),
                str(row["actor_id"]),
                str(row["actor_label"]),
                str(row["action"]),
                str(row["target_urn"]),
                str(row["source_ip"]),
                canonical_json_bytes(row["metadata"]).decode("utf-8"),
                str(row["prev_hash"]),
                str(row["entry_hash"]),
            ]
        )
        yield row_buf.getvalue().encode("utf-8")


def export_compliance_bundle(
    *,
    ledger: ComplianceAuditLedger,
    tenant_slug: str,
    signer: AuditSigner,
    export_format: str = "ndjson",
    framework: str = "SOC2",
    filters: AuditExportFilters | None = None,
    redact_pii: bool = False,
    exported_at: datetime | None = None,
) -> ExportedComplianceBundle:
    """Export and cryptographically sign a tamper-evident NDJSON or CSV compliance bundle."""
    require_enterprise_edition()
    fmt = export_format.strip().lower()
    if fmt not in SUPPORTED_EXPORT_FORMATS:
        raise AuditExportError(
            "unsupported_format", f"Format must be one of {sorted(SUPPORTED_EXPORT_FORMATS)}"
        )
    fw = framework.strip().upper()
    if fw not in SUPPORTED_FRAMEWORKS:
        raise AuditExportError(
            "unsupported_framework",
            f"Compliance framework must be one of {sorted(SUPPORTED_FRAMEWORKS)}",
        )

    effective_filters = filters or AuditExportFilters()
    vault_events = ledger.snapshot_events(tenant_slug)
    ledger_head = vault_events[-1].entry_hash if vault_events else GENESIS_PREV_HASH
    filtered = _filter_events(vault_events, effective_filters)
    rows = _build_chained_export_rows(
        filtered,
        tenant_slug=tenant_slug,
        framework=fw,
        redact_pii=redact_pii,
    )

    chunks = list(_render_ndjson_chunks(rows) if fmt == "ndjson" else _render_csv_chunks(rows))
    payload_bytes = b"".join(chunks)
    payload_sha256 = hashlib.sha256(payload_bytes).hexdigest()
    head_entry_hash = str(rows[-1]["entry_hash"]) if rows else GENESIS_PREV_HASH
    first_ledger_seq = filtered[0].sequence if filtered else None
    last_ledger_seq = filtered[-1].sequence if filtered else None

    bundle_id = str(uuid4())
    created_ts = format_utc_iso(exported_at or datetime.now(UTC))

    unsigned_manifest: dict[str, object] = {
        "schema_version": EXPORT_SCHEMA_VERSION,
        "bundle_id": bundle_id,
        "tenant_slug": tenant_slug,
        "framework": fw,
        "framework_controls": list(FRAMEWORK_CONTROL_CATALOG[fw]),
        "format": fmt,
        "exported_at": created_ts,
        "filters": effective_filters.to_manifest_dict(),
        "pii_redacted": redact_pii,
        "record_count": len(rows),
        "first_ledger_sequence": first_ledger_seq,
        "last_ledger_sequence": last_ledger_seq,
        "genesis_prev_hash": GENESIS_PREV_HASH,
        "head_entry_hash": head_entry_hash,
        "vault_head_hash": ledger_head,
        "payload_sha256": payload_sha256,
        "signing_algorithm": signer.algorithm,
        "key_id": signer.key_id,
        "public_key_pem": signer.public_key_pem,
    }
    signature = signer.sign_manifest(unsigned_manifest)
    manifest: dict[str, object] = {**unsigned_manifest, "signature": signature}

    return ExportedComplianceBundle(
        bundle_id=bundle_id,
        tenant_slug=tenant_slug,
        framework=fw,
        export_format=fmt,
        payload_bytes=payload_bytes,
        manifest=manifest,
    )


def stream_compliance_bundle(
    bundle: ExportedComplianceBundle,
    *,
    chunk_size: int = 16_384,
) -> Iterator[bytes]:
    """Yield exported compliance payload in bounded byte chunks for `StreamingHttpResponse`."""
    data = bundle.payload_bytes
    if not data:
        return
    for offset in range(0, len(data), chunk_size):
        yield data[offset : offset + chunk_size]
