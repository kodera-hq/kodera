"""Signed NDJSON & CSV compliance bundle exporter with PII redaction and streaming.

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import csv
import hashlib
import hmac
import io
import ipaddress
import tempfile
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Final
from uuid import UUID, uuid4

from ee.audit_export.crypto import (
    EXPORT_ROW_HASH_DOMAIN,
    GENESIS_PREV_HASH,
    AuditSigner,
    canonical_json_bytes,
    compute_domain_sha256,
)
from ee.audit_export.ledger import (
    FRAMEWORK_CONTROL_CATALOG,
    MAX_EXPORT_QUERY_ROWS,
    SUPPORTED_FRAMEWORKS,
    ComplianceAuditEvent,
    ComplianceAuditLedger,
    format_utc_iso,
)
from ee.edition import require_enterprise_edition
from ee.store import derive_ee_hkdf_bytes

EXPORT_SCHEMA_VERSION = "kodera.compliance.audit-export.v1"
SUPPORTED_EXPORT_FORMATS = frozenset({"ndjson", "csv"})
MAX_EXPORT_ROWS = MAX_EXPORT_QUERY_ROWS
MAX_EXPORT_BYTES = 16 * 1024 * 1024
_PII_REDACT_KDF_INFO = b"kodera-ee-audit-pii-pepper-v1"

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
    {
        "email",
        "mail",
        "contact_email",
        "reply_to_email",
        "full_name",
        "display_name",
        "given_name",
        "family_name",
        "first_name",
        "last_name",
        "name",
        "user_name",
        "username",
        "subject_name_id",
        "signatory",
        "phone",
        "ip",
        "source_ip",
        "user_agent",
    }
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
    after_seq: int | None = None
    limit: int | None = None

    def to_manifest_dict(self) -> dict[str, str | int | None]:
        out: dict[str, str | int | None] = {
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
        if self.after_seq is not None:
            out["after_seq"] = self.after_seq
        if self.limit is not None:
            out["limit"] = self.limit
        return out


@dataclass(slots=True)
class ExportedComplianceBundle:
    bundle_id: str
    tenant_slug: str
    framework: str
    export_format: str
    manifest: dict[str, object]
    _payload_bytes: bytes | None = None
    _spool: tempfile.SpooledTemporaryFile[bytes] | None = field(
        default=None, repr=False, compare=False
    )

    @property
    def payload_bytes(self) -> bytes:
        if self._payload_bytes is not None:
            return self._payload_bytes
        spool = self._spool
        if spool is None:
            return b""
        try:
            spool.seek(0)
            data = spool.read()
        finally:
            spool.close()
            self._spool = None
        self._payload_bytes = data
        return data

    @property
    def payload_text(self) -> str:
        return self.payload_bytes.decode("utf-8")

    def close(self) -> None:
        if self._spool is not None:
            self._spool.close()
            self._spool = None

    def __del__(self) -> None:
        self.close()


def _derive_pii_pepper(tenant_slug: str, organisation_id: UUID | None = None) -> bytes:
    scope = str(organisation_id) if organisation_id is not None else tenant_slug
    return derive_ee_hkdf_bytes(domain_info=_PII_REDACT_KDF_INFO + b"\x00" + scope.encode("utf-8"))


def _hmac_pii_token(pepper: bytes, context_label: bytes, raw_value: str) -> str:
    return hmac.new(
        pepper,
        context_label + b"\x00" + raw_value.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()[:16]


def _pseudonymize_email_str(raw_email: str, pepper: bytes) -> str:
    digest = _hmac_pii_token(pepper, b"email", raw_email.strip().lower())
    return f"redacted-{digest}@redacted.invalid"


def _looks_like_redactable_domain(domain: str) -> bool:
    if not (3 <= len(domain) <= 253) or "." not in domain:
        return False
    parts = domain.split(".")
    if any(not part for part in parts):
        return False
    tld = parts[-1]
    return 2 <= len(tld) <= 24 and tld.isalpha()


def _is_exact_email_address(candidate: str) -> bool:
    cleaned = candidate.strip()
    local, sep, domain = cleaned.partition("@")
    if not sep or "@" in domain or not (1 <= len(local) <= 64):
        return False
    if any(ch not in _EMAIL_LOCAL_CHARS for ch in local):
        return False
    if any(ch not in _EMAIL_DOMAIN_CHARS for ch in domain):
        return False
    return _looks_like_redactable_domain(domain)


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


def _redact_string(value: str, pepper: bytes) -> str:
    """Scan and pseudonymize email addresses using keyed HMAC-SHA256 in O(n) linear time."""
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
            out.append(_pseudonymize_email_str(f"{local_part}@{domain_part}", pepper))
            cursor = r_pos
        else:
            out.append(value[cursor : at_idx + 1])
            cursor = at_idx + 1
        at_idx = value.find("@", cursor)

    out.append(value[cursor:])
    return "".join(out)


def _redact_target_urn(target_urn: str, pepper: bytes) -> str:
    redacted = _redact_string(target_urn, pepper)
    stripped_valid_redactions = redacted.replace("@redacted.invalid", "")
    if "@" in stripped_valid_redactions or any(ch.isspace() for ch in redacted):
        digest = _hmac_pii_token(pepper, b"target_urn", target_urn)
        return f"urn:kodera:redacted:{digest}"
    return redacted


def _redact_metadata(value: object, pepper: bytes) -> object:
    if isinstance(value, str):
        return _redact_string(value, pepper)
    if isinstance(value, list):
        return [_redact_metadata(item, pepper) for item in value]
    if isinstance(value, dict):
        redacted_dict: dict[str, object] = {}
        for k, v in value.items():
            key_str = str(k)
            low_k = key_str.lower()
            if low_k in {"ip", "source_ip"} and isinstance(v, str):
                redacted_dict[key_str] = _redact_ip(v)
            elif low_k in _SENSITIVE_META_KEYS:
                if isinstance(v, str) and _is_exact_email_address(v):
                    redacted_dict[key_str] = _pseudonymize_email_str(v, pepper)
                else:
                    digest = _hmac_pii_token(
                        pepper,
                        b"field:" + low_k.encode("utf-8"),
                        str(v),
                    )
                    redacted_dict[key_str] = f"[REDACTED:{digest}]"
            else:
                redacted_dict[key_str] = _redact_metadata(v, pepper)
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


def _iter_chained_export_rows(
    events: Iterable[ComplianceAuditEvent],
    *,
    tenant_slug: str,
    organisation_id: UUID | None,
    framework: str,
    redact_pii: bool,
) -> Iterator[dict[str, object]]:
    controls = list(FRAMEWORK_CONTROL_CATALOG[framework])
    prev_hash = GENESIS_PREV_HASH
    pepper = _derive_pii_pepper(tenant_slug, organisation_id) if redact_pii else b""

    for export_seq, evt in enumerate(events, start=1):
        if redact_pii:
            raw_label = evt.actor_label
            if not raw_label or raw_label == "erased" or raw_label.startswith("erased:"):
                actor_label = raw_label
            elif _is_exact_email_address(raw_label):
                actor_label = _pseudonymize_email_str(raw_label, pepper)
            else:
                email_scrubbed = _redact_string(raw_label, pepper)
                if email_scrubbed != raw_label:
                    actor_label = email_scrubbed
                else:
                    digest = _hmac_pii_token(pepper, b"actor_label", raw_label)
                    actor_label = f"redacted-actor-{digest}"

            actor_id = (
                f"redacted-actor-id-{_hmac_pii_token(pepper, b'actor_id', evt.actor_id)}"
                if "@" in evt.actor_id
                else evt.actor_id
            )
            target_urn = _redact_target_urn(evt.target_urn, pepper)
            source_ip = _redact_ip(evt.source_ip)
            meta = _redact_metadata(dict(evt.metadata), pepper)
        else:
            actor_label = evt.actor_label
            actor_id = evt.actor_id
            target_urn = evt.target_urn
            source_ip = evt.source_ip
            meta = dict(evt.metadata)

        draft: dict[str, object] = {
            "export_seq": export_seq,
            "ledger_seq": evt.sequence,
            "event_id": evt.event_id,
            "occurred_at": evt.occurred_at,
            "tenant_slug": evt.tenant_slug,
            "framework": framework,
            "framework_controls": controls,
            "actor_type": evt.actor_type,
            "actor_id": actor_id,
            "actor_label": actor_label,
            "action": evt.action,
            "target_urn": target_urn,
            "source_ip": source_ip,
            "metadata": meta,
            "prev_hash": prev_hash,
        }
        entry_hash = compute_domain_sha256(
            EXPORT_ROW_HASH_DOMAIN,
            canonical_export_row_input(draft),
        )
        draft["entry_hash"] = entry_hash
        prev_hash = entry_hash
        yield draft


def _render_ndjson_chunks(rows: Iterable[dict[str, object]]) -> Iterator[bytes]:
    for row in rows:
        yield canonical_json_bytes(row) + b"\n"


def _render_csv_chunks(rows: Iterable[dict[str, object]]) -> Iterator[bytes]:
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
    organisation_id: UUID | None = None,
    max_rows: int | None = None,
    max_bytes: int | None = None,
    stream_mode: bool = False,
) -> ExportedComplianceBundle:
    """Export and cryptographically sign a tamper-evident NDJSON or CSV compliance bundle."""
    require_enterprise_edition()
    effective_max_rows = MAX_EXPORT_ROWS if max_rows is None else max_rows
    effective_max_bytes = MAX_EXPORT_BYTES if max_bytes is None else max_bytes
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
    if (
        effective_filters.from_timestamp is not None
        and effective_filters.to_timestamp is not None
        and effective_filters.from_timestamp > effective_filters.to_timestamp
    ):
        raise AuditExportError(
            "invalid_time_range",
            "from_timestamp must not be after to_timestamp",
        )
    if effective_filters.after_seq is not None and effective_filters.after_seq < 0:
        raise AuditExportError("invalid_export_request", "after_seq must be >= 0")
    if effective_filters.limit is not None and (
        effective_filters.limit < 1 or effective_filters.limit > effective_max_rows
    ):
        raise AuditExportError(
            "invalid_export_request", f"limit must be between 1 and {effective_max_rows}"
        )

    cursor_stream = ledger.stream_events(
        tenant_slug,
        organisation_id=organisation_id,
        from_timestamp=effective_filters.from_timestamp,
        to_timestamp=effective_filters.to_timestamp,
        actor_id=effective_filters.actor_id,
        actor_type=effective_filters.actor_type,
        action=effective_filters.action,
        after_seq=effective_filters.after_seq,
        limit=effective_filters.limit,
        max_rows=effective_max_rows,
    )

    ledger_head = ledger.head_hash(tenant_slug, organisation_id=organisation_id)
    head_entry_hash = GENESIS_PREV_HASH
    record_count = 0
    first_ledger_seq: int | None = None
    last_ledger_seq: int | None = None

    def _bounded_events() -> Iterator[ComplianceAuditEvent]:
        nonlocal first_ledger_seq, last_ledger_seq
        for evt in cursor_stream.events:
            if first_ledger_seq is None:
                first_ledger_seq = evt.sequence
            last_ledger_seq = evt.sequence
            yield evt
        if cursor_stream.has_more and effective_filters.limit is None:
            raise AuditExportError(
                "export_limit_exceeded",
                f"Export exceeds {effective_max_rows}-row ceiling; pass limit and after_seq for cursor pagination",
                status=413,
            )

    def _tracked_rows() -> Iterator[dict[str, object]]:
        nonlocal head_entry_hash, record_count
        for row in _iter_chained_export_rows(
            _bounded_events(),
            tenant_slug=tenant_slug,
            organisation_id=organisation_id,
            framework=fw,
            redact_pii=redact_pii,
        ):
            record_count += 1
            head_entry_hash = str(row["entry_hash"])
            yield row

    spool = tempfile.SpooledTemporaryFile(max_size=262_144)  # noqa: SIM115
    hasher = hashlib.sha256()
    written_bytes = 0
    try:
        chunk_iter = (
            _render_ndjson_chunks(_tracked_rows())
            if fmt == "ndjson"
            else _render_csv_chunks(_tracked_rows())
        )
        for chunk in chunk_iter:
            written_bytes += len(chunk)
            if written_bytes > effective_max_bytes:
                raise AuditExportError(
                    "export_limit_exceeded",
                    f"Export exceeds {effective_max_bytes}-byte ceiling; narrow filters or pass limit/after_seq",
                    status=413,
                )
            hasher.update(chunk)
            spool.write(chunk)
        if cursor_stream.has_more and effective_filters.limit is None:
            raise AuditExportError(
                "export_limit_exceeded",
                f"Export exceeds {effective_max_rows}-row ceiling; pass limit and after_seq for cursor pagination",
                status=413,
            )
        spool.seek(0)
    except Exception:
        spool.close()
        raise

    has_more = cursor_stream.has_more
    payload_sha256 = hasher.hexdigest()
    next_after_seq = last_ledger_seq if (has_more and last_ledger_seq is not None) else None

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
        "record_count": record_count,
        "first_ledger_sequence": first_ledger_seq,
        "last_ledger_sequence": last_ledger_seq,
        "has_more": has_more,
        "next_after_seq": next_after_seq,
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

    if (
        signer.algorithm == "ed25519"
        and signer.public_key_pem is not None
        and signer.public_key_pem == ledger.ed25519_signer_for_tenant(tenant_slug).public_key_pem
    ):
        ledger.register_signing_key(
            tenant_slug=tenant_slug,
            signer=signer,
            organisation_id=organisation_id,
        )

    if not stream_mode:
        try:
            spool.seek(0)
            eager_bytes = spool.read()
        finally:
            spool.close()
        return ExportedComplianceBundle(
            bundle_id=bundle_id,
            tenant_slug=tenant_slug,
            framework=fw,
            export_format=fmt,
            manifest=manifest,
            _payload_bytes=eager_bytes,
        )

    return ExportedComplianceBundle(
        bundle_id=bundle_id,
        tenant_slug=tenant_slug,
        framework=fw,
        export_format=fmt,
        manifest=manifest,
        _spool=spool,
    )


def stream_compliance_bundle(
    bundle: ExportedComplianceBundle,
    *,
    chunk_size: int = 16_384,
) -> Iterator[bytes]:
    """Yield exported compliance payload from temporary spool in bounded byte chunks."""
    spool = bundle._spool
    if spool is not None:
        try:
            spool.seek(0)
            while True:
                chunk = spool.read(chunk_size)
                if not chunk:
                    break
                yield chunk
        finally:
            spool.close()
            bundle._spool = None
        return

    data = bundle.payload_bytes
    if not data:
        return
    for offset in range(0, len(data), chunk_size):
        yield data[offset : offset + chunk_size]
