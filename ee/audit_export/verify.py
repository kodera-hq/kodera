"""Cryptographic verifier & standalone CLI (`python3 -m ee.audit_export.verify`) for audit exports.

Detects any single-byte modification, row deletion, row insertion, row reordering, or forged
manifest signature across both NDJSON and CSV compliance bundles.

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import hmac
import io
import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from ee.audit_export.crypto import (
    EXPORT_ROW_HASH_DOMAIN,
    GENESIS_PREV_HASH,
    compute_domain_sha256,
    verify_manifest_signature,
)
from ee.audit_export.exporter import (
    CSV_COLUMNS,
    EXPORT_SCHEMA_VERSION,
    SUPPORTED_EXPORT_FORMATS,
    canonical_export_row_input,
)

_REQUIRED_EXPORT_ROW_FIELDS = (
    "export_seq",
    "ledger_seq",
    "event_id",
    "occurred_at",
    "tenant_slug",
    "framework",
    "actor_type",
    "actor_id",
    "actor_label",
    "action",
    "target_urn",
    "source_ip",
    "metadata",
    "prev_hash",
)


@dataclass(frozen=True, slots=True)
class VerificationResult:
    verified: bool
    bundle_id: str | None
    tenant_slug: str | None
    framework: str | None
    export_format: str | None
    record_count: int
    head_entry_hash: str
    signing_algorithm: str | None
    errors: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "verified": self.verified,
            "bundle_id": self.bundle_id,
            "tenant_slug": self.tenant_slug,
            "framework": self.framework,
            "format": self.export_format,
            "record_count": self.record_count,
            "head_entry_hash": self.head_entry_hash,
            "signing_algorithm": self.signing_algorithm,
            "errors": list(self.errors),
        }


def _parse_ndjson_rows(payload_text: str, errors: list[str]) -> list[dict[str, object]]:
    if payload_text == "":
        return []
    if not payload_text.endswith("\n"):
        errors.append("malformed_ndjson:missing_trailing_newline")
    lines = payload_text.splitlines()
    rows: list[dict[str, object]] = []
    for idx, line in enumerate(lines, start=1):
        if not line.strip():
            errors.append(f"malformed_ndjson:empty_line_at_{idx}")
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            errors.append(f"malformed_ndjson:invalid_json_at_line_{idx}")
            continue
        if not isinstance(obj, dict):
            errors.append(f"malformed_ndjson:non_object_at_line_{idx}")
            continue
        rows.append(obj)
    return rows


def _parse_csv_rows(payload_text: str, errors: list[str]) -> list[dict[str, object]]:
    if payload_text == "":
        errors.append("malformed_csv:missing_header")
        return []
    reader = csv.reader(io.StringIO(payload_text))
    raw_rows = list(reader)
    if not raw_rows:
        errors.append("malformed_csv:missing_header")
        return []
    header = tuple(raw_rows[0])
    if header != CSV_COLUMNS:
        errors.append("malformed_csv:header_mismatch")
        return []

    parsed: list[dict[str, object]] = []
    for row_idx, cols in enumerate(raw_rows[1:], start=1):
        if len(cols) != len(CSV_COLUMNS):
            errors.append(f"malformed_csv:column_count_mismatch_at_row_{row_idx}")
            continue
        mapped = dict(zip(CSV_COLUMNS, cols, strict=True))
        try:
            export_seq = int(mapped["export_seq"])
            ledger_seq = int(mapped["ledger_seq"])
        except ValueError:
            errors.append(f"malformed_csv:invalid_sequence_int_at_row_{row_idx}")
            continue
        try:
            metadata = json.loads(mapped["metadata_json"])
        except ValueError:
            errors.append(f"malformed_csv:invalid_metadata_json_at_row_{row_idx}")
            continue
        controls_raw = mapped["framework_controls"]
        controls = [c for c in controls_raw.split(",") if c] if controls_raw else []
        parsed.append(
            {
                "export_seq": export_seq,
                "ledger_seq": ledger_seq,
                "event_id": mapped["event_id"],
                "occurred_at": mapped["occurred_at"],
                "tenant_slug": mapped["tenant_slug"],
                "framework": mapped["framework"],
                "framework_controls": controls,
                "actor_type": mapped["actor_type"],
                "actor_id": mapped["actor_id"],
                "actor_label": mapped["actor_label"],
                "action": mapped["action"],
                "target_urn": mapped["target_urn"],
                "source_ip": mapped["source_ip"],
                "metadata": metadata,
                "prev_hash": mapped["prev_hash"],
                "entry_hash": mapped["entry_hash"],
            }
        )
    return parsed


def verify_compliance_bundle(
    payload: bytes | str,
    manifest: dict[str, object],
    *,
    trusted_public_key_pem: str | None = None,
    hmac_secret: bytes | None = None,
) -> VerificationResult:
    """Verify detached signature, payload digest, sequence contiguity, and row SHA-256 hash chain."""
    errors: list[str] = []
    payload_bytes = payload.encode("utf-8") if isinstance(payload, str) else payload

    if manifest.get("schema_version") != EXPORT_SCHEMA_VERSION:
        errors.append("unsupported_manifest_schema_version")

    sig_ok, sig_err = verify_manifest_signature(
        manifest,
        trusted_public_key_pem=trusted_public_key_pem,
        hmac_secret=hmac_secret,
    )
    if not sig_ok and sig_err is not None:
        errors.append(sig_err)

    expected_payload_sha = manifest.get("payload_sha256")
    actual_payload_sha = hashlib.sha256(payload_bytes).hexdigest()
    if not isinstance(expected_payload_sha, str) or not hmac.compare_digest(
        actual_payload_sha, expected_payload_sha
    ):
        errors.append("payload_sha256_mismatch")

    fmt = manifest.get("format")
    if not isinstance(fmt, str) or fmt not in SUPPORTED_EXPORT_FORMATS:
        errors.append("unsupported_export_format")
        fmt_str: str | None = None
    else:
        fmt_str = fmt

    try:
        payload_text = payload_bytes.decode("utf-8")
    except UnicodeDecodeError:
        errors.append("invalid_payload_utf8")
        payload_text = ""

    rows: list[dict[str, object]] = []
    if fmt_str == "ndjson":
        rows = _parse_ndjson_rows(payload_text, errors)
    elif fmt_str == "csv":
        rows = _parse_csv_rows(payload_text, errors)

    declared_count = manifest.get("record_count")
    if not isinstance(declared_count, int) or isinstance(declared_count, bool):
        errors.append("invalid_manifest_record_count")
    elif len(rows) != declared_count:
        errors.append(f"record_count_mismatch:expected_{declared_count}_got_{len(rows)}")

    if manifest.get("genesis_prev_hash") != GENESIS_PREV_HASH:
        errors.append("invalid_genesis_prev_hash")

    expected_tenant = manifest.get("tenant_slug")
    expected_framework = manifest.get("framework")
    expected_prev = GENESIS_PREV_HASH
    prev_ledger_seq = 0

    for idx, row in enumerate(rows, start=1):
        exp_seq = row.get("export_seq")
        led_seq = row.get("ledger_seq")
        if exp_seq != idx:
            errors.append(f"sequence_gap_or_reorder:row_{idx}")
        if not isinstance(led_seq, int) or led_seq <= prev_ledger_seq:
            errors.append(f"non_monotonic_ledger_sequence:row_{idx}")
        else:
            prev_ledger_seq = led_seq

        if row.get("tenant_slug") != expected_tenant:
            errors.append(f"tenant_mismatch:row_{idx}")
        if row.get("framework") != expected_framework:
            errors.append(f"framework_mismatch:row_{idx}")

        row_prev = row.get("prev_hash")
        if not isinstance(row_prev, str) or not hmac.compare_digest(row_prev, expected_prev):
            errors.append(f"broken_hash_chain:row_{idx}")

        row_entry = row.get("entry_hash")
        missing_field = next((fld for fld in _REQUIRED_EXPORT_ROW_FIELDS if fld not in row), None)
        if missing_field is not None:
            errors.append(f"missing_required_field:row_{idx}:{missing_field}")
            continue

        recomputed_entry = compute_domain_sha256(
            EXPORT_ROW_HASH_DOMAIN,
            canonical_export_row_input(row),
        )

        if not isinstance(row_entry, str) or not hmac.compare_digest(row_entry, recomputed_entry):
            errors.append(f"entry_hash_mismatch:row_{idx}")
            expected_prev = recomputed_entry
        else:
            expected_prev = row_entry

    declared_head = manifest.get("head_entry_hash")
    if not isinstance(declared_head, str) or not hmac.compare_digest(expected_prev, declared_head):
        errors.append("head_entry_hash_mismatch")

    if rows:
        if manifest.get("first_ledger_sequence") != rows[0].get("ledger_seq"):
            errors.append("first_ledger_sequence_mismatch")
        if manifest.get("last_ledger_sequence") != rows[-1].get("ledger_seq"):
            errors.append("last_ledger_sequence_mismatch")

    bundle_id = manifest.get("bundle_id")
    alg = manifest.get("signing_algorithm")
    return VerificationResult(
        verified=(len(errors) == 0),
        bundle_id=bundle_id if isinstance(bundle_id, str) else None,
        tenant_slug=expected_tenant if isinstance(expected_tenant, str) else None,
        framework=expected_framework if isinstance(expected_framework, str) else None,
        export_format=fmt_str,
        record_count=len(rows),
        head_entry_hash=expected_prev,
        signing_algorithm=alg if isinstance(alg, str) else None,
        errors=tuple(errors),
    )


def main(argv: Sequence[str] | None = None) -> int:
    """Standalone CLI entry point (`python3 -m ee.audit_export.verify`)."""
    parser = argparse.ArgumentParser(
        prog="python3 -m ee.audit_export.verify",
        description="Verify hash-chain & Ed25519/HMAC manifest signature on a Kodera audit bundle.",
    )
    parser.add_argument(
        "--bundle",
        required=True,
        type=Path,
        help="Path to exported NDJSON, CSV, or combined JSON bundle file.",
    )
    parser.add_argument(
        "--manifest",
        required=False,
        type=Path,
        default=None,
        help="Path to detached JSON manifest (optional if --bundle is a combined JSON export).",
    )
    parser.add_argument(
        "--public-key",
        required=False,
        type=Path,
        default=None,
        help="Optional trusted Ed25519 public key PEM file to pin against.",
    )
    parser.add_argument(
        "--hmac-key-hex",
        required=False,
        type=str,
        default=None,
        help="Hex-encoded HMAC-SHA256 secret when verifying an hmac-sha256 bundle.",
    )

    args = parser.parse_args(argv)
    try:
        raw_bundle = args.bundle.read_bytes()
    except OSError:
        print(json.dumps({"verified": False, "errors": ["bundle_read_error"]}))
        return 1

    manifest_obj: dict[str, object]
    payload_input: bytes | str
    if args.manifest is not None:
        try:
            loaded_manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            print(json.dumps({"verified": False, "errors": ["manifest_read_error"]}))
            return 1
        if not isinstance(loaded_manifest, dict):
            print(json.dumps({"verified": False, "errors": ["manifest_not_json_object"]}))
            return 1
        manifest_obj = loaded_manifest
        payload_input = raw_bundle
    else:
        try:
            combined = json.loads(raw_bundle.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            print(json.dumps({"verified": False, "errors": ["combined_json_error"]}))
            return 1
        if (
            not isinstance(combined, dict)
            or not isinstance(combined.get("manifest"), dict)
            or not isinstance(combined.get("payload"), str)
        ):
            print(
                json.dumps(
                    {
                        "verified": False,
                        "errors": [
                            "combined_bundle_requires_payload_and_manifest_or_pass_--manifest"
                        ],
                    }
                )
            )
            return 1
        manifest_obj = combined["manifest"]
        payload_input = combined["payload"]

    trusted_pem: str | None = None
    if args.public_key is not None:
        try:
            trusted_pem = args.public_key.read_text(encoding="utf-8")
        except OSError:
            print(json.dumps({"verified": False, "errors": ["public_key_read_error"]}))
            return 1

    hmac_bytes: bytes | None = None
    if args.hmac_key_hex is not None:
        try:
            hmac_bytes = bytes.fromhex(args.hmac_key_hex.strip())
        except ValueError:
            print(json.dumps({"verified": False, "errors": ["invalid_hmac_key_hex"]}))
            return 1

    result = verify_compliance_bundle(
        payload_input,
        manifest_obj,
        trusted_public_key_pem=trusted_pem,
        hmac_secret=hmac_bytes,
    )
    print(json.dumps(result.to_dict(), indent=2))
    return 0 if result.verified else 1


if __name__ == "__main__":
    sys.exit(main())
