"""Tests for Tamper-Evident Signed Compliance Audit Exports (`ee/audit_export/`).

Covers:
- SHA-256 hash-chained append-only audit stream (`prev_hash -> entry_hash`) + PostgreSQL bridge
- Detached Ed25519 (primary) and HMAC-SHA256 (fallback) signed NDJSON and CSV compliance bundles
  across `SOC2`, `ISO27001`, and `SECNUMCLOUD`
- Date-range & actor filters, PII redaction policy (`redact_pii=True`), and chunked streaming export
- HTTP `/api/v1/ee/compliance/audit-exports/verify` AND standalone subprocess CLI
  (`python3 -m ee.audit_export.verify`)
- Tamper-detection mutation tests: single-byte edit, deleted middle row, swapped/reordered rows,
  forged manifest hash recomputation, and wrong signing key all fail verification!
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
from django.http import StreamingHttpResponse
from django.test import Client, override_settings

from ee.audit_export.crypto import GENESIS_PREV_HASH
from ee.audit_export.ledger import default_audit_ledger
from ee.audit_export.verify import verify_compliance_bundle

MONOREPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def enterprise_client(monkeypatch: pytest.MonkeyPatch) -> Client:
    monkeypatch.setenv("KODERA_EDITION", "enterprise")
    return Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")


def _seed_sample_events(client: Client, tenant_slug: str = "acme-corp") -> list[dict[str, object]]:
    samples = [
        {
            "tenant_slug": tenant_slug,
            "actor_type": "customer_user",
            "actor_id": "u-alice",
            "actor_label": "alice.martin@acme.fr",
            "action": "sso.saml.authenticated",
            "target_urn": "urn:kodera:org:acme-corp",
            "source_ip": "203.0.113.42",
            "occurred_at": "2026-05-01T08:00:00Z",
            "metadata": {"email": "alice.martin@acme.fr", "idp": "okta-primary"},
        },
        {
            "tenant_slug": tenant_slug,
            "actor_type": "scim_token",
            "actor_id": "tok-okta",
            "actor_label": "Okta Provisioner",
            "action": "scim.user.provisioned",
            "target_urn": "urn:kodera:user:u-bob",
            "source_ip": "198.51.100.17",
            "occurred_at": "2026-05-01T09:00:00Z",
            "metadata": {"email": "bob.dupont@acme.fr", "role": "org_member"},
        },
        {
            "tenant_slug": tenant_slug,
            "actor_type": "customer_user",
            "actor_id": "u-alice",
            "actor_label": "alice.martin@acme.fr",
            "action": "org.policy.updated",
            "target_urn": "urn:kodera:org:acme-corp:policy",
            "source_ip": "203.0.113.42",
            "occurred_at": "2026-05-01T10:00:00Z",
            "metadata": {"mfa_required": True},
        },
        {
            "tenant_slug": tenant_slug,
            "actor_type": "scim_token",
            "actor_id": "tok-okta",
            "actor_label": "Okta Provisioner",
            "action": "scim.user.deprovisioned",
            "target_urn": "urn:kodera:user:u-bob",
            "source_ip": "198.51.100.17",
            "occurred_at": "2026-05-01T11:00:00Z",
            "metadata": {"revoked_sessions": 2},
        },
    ]
    created: list[dict[str, object]] = []
    for item in samples:
        resp = client.post(
            "/api/v1/ee/compliance/audit-exports/events",
            data=json.dumps(item),
            content_type="application/json",
        )
        assert resp.status_code == 201, resp.content
        created.append(resp.json())
    return created


@pytest.mark.parametrize("export_format", ["ndjson", "csv"])
@pytest.mark.parametrize("framework", ["SOC2", "ISO27001", "SECNUMCLOUD"])
def test_signed_ed25519_and_hmac_compliance_exports_verify_cleanly(
    enterprise_client: Client,
    export_format: str,
    framework: str,
) -> None:
    with override_settings(KODERA_EDITION="enterprise"):
        appended = _seed_sample_events(enterprise_client)
        assert appended[0]["prev_hash"] == GENESIS_PREV_HASH
        assert appended[1]["prev_hash"] == appended[0]["entry_hash"]
        assert appended[2]["prev_hash"] == appended[1]["entry_hash"]
        assert appended[3]["prev_hash"] == appended[2]["entry_hash"]

        ok, errs = default_audit_ledger.verify_vault_integrity("acme-corp")
        assert ok is True and errs == []

        # Ed25519 signed export
        exp_resp = enterprise_client.post(
            "/api/v1/ee/compliance/audit-exports",
            data=json.dumps(
                {
                    "tenant_slug": "acme-corp",
                    "format": export_format,
                    "framework": framework,
                    "signing_algorithm": "ed25519",
                }
            ),
            content_type="application/json",
        )
        assert exp_resp.status_code == 200, exp_resp.content
        bundle = exp_resp.json()
        assert bundle["manifest"]["record_count"] == 4
        assert bundle["manifest"]["signing_algorithm"] == "ed25519"
        assert bundle["manifest"]["framework"] == framework

        ver_resp = enterprise_client.post(
            "/api/v1/ee/compliance/audit-exports/verify",
            data=json.dumps(
                {
                    "payload": bundle["payload"],
                    "manifest": bundle["manifest"],
                    "public_key_pem": bundle["manifest"]["public_key_pem"],
                }
            ),
            content_type="application/json",
        )
        assert ver_resp.status_code == 200
        assert ver_resp.json()["verified"] is True
        assert ver_resp.json()["errors"] == []

        # HMAC-SHA256 fallback signed export
        hmac_resp = enterprise_client.post(
            "/api/v1/ee/compliance/audit-exports",
            data=json.dumps(
                {
                    "tenant_slug": "acme-corp",
                    "format": export_format,
                    "framework": framework,
                    "signing_algorithm": "hmac-sha256",
                }
            ),
            content_type="application/json",
        )
        assert hmac_resp.status_code == 200
        hmac_bundle = hmac_resp.json()
        assert hmac_bundle["manifest"]["signing_algorithm"] == "hmac-sha256"
        assert hmac_bundle["manifest"]["public_key_pem"] is None

        hmac_ver = enterprise_client.post(
            "/api/v1/ee/compliance/audit-exports/verify",
            data=json.dumps(
                {
                    "payload": hmac_bundle["payload"],
                    "manifest": hmac_bundle["manifest"],
                }
            ),
            content_type="application/json",
        )
        assert hmac_ver.status_code == 200
        assert hmac_ver.json()["verified"] is True


def test_filters_pii_redaction_and_streaming_export(enterprise_client: Client) -> None:
    with override_settings(KODERA_EDITION="enterprise"):
        _seed_sample_events(enterprise_client)

        # Date-range + actor filter + PII redaction (`redact_pii=True`)
        filtered_resp = enterprise_client.post(
            "/api/v1/ee/compliance/audit-exports",
            data=json.dumps(
                {
                    "tenant_slug": "acme-corp",
                    "format": "ndjson",
                    "framework": "SECNUMCLOUD",
                    "from_timestamp": "2026-05-01T08:00:00Z",
                    "to_timestamp": "2026-05-01T10:30:00Z",
                    "actor_id": "u-alice",
                    "redact_pii": True,
                }
            ),
            content_type="application/json",
        )
        assert filtered_resp.status_code == 200
        filtered = filtered_resp.json()
        assert filtered["manifest"]["record_count"] == 2
        assert filtered["manifest"]["pii_redacted"] is True

        # Ensure zero raw PII (`alice.martin@acme.fr`, `203.0.113.42`) leaks into payload!
        payload_text = filtered["payload"]
        assert "alice.martin@acme.fr" not in payload_text
        assert "203.0.113.42" not in payload_text
        assert "203.0.113.0/24" in payload_text
        assert "@redacted.invalid" in payload_text

        # Redacted bundle still cryptographically verifies end-to-end!
        ver = verify_compliance_bundle(payload_text, filtered["manifest"])
        assert ver.verified is True

        # Streaming export (`GET /api/v1/ee/compliance/audit-exports/stream`)
        stream_resp = enterprise_client.get(
            "/api/v1/ee/compliance/audit-exports/stream",
            {"tenant_slug": "acme-corp", "format": "csv", "framework": "ISO27001"},
        )
        assert stream_resp.status_code == 200
        assert isinstance(stream_resp, StreamingHttpResponse)
        assert stream_resp.streaming is True
        assert "text/csv" in stream_resp["Content-Type"]
        streamed_bytes = b"".join(stream_resp.streaming_content)
        manifest_json = base64.urlsafe_b64decode(
            stream_resp["X-Kodera-Audit-Manifest"].encode("ascii")
        )
        manifest = json.loads(manifest_json.decode("utf-8"))
        stream_ver = verify_compliance_bundle(streamed_bytes, manifest)
        assert stream_ver.verified is True and stream_ver.record_count == 4


@pytest.mark.parametrize("export_format", ["ndjson", "csv"])
def test_tamper_detection_mutations_and_standalone_cli_verifier(
    enterprise_client: Client,
    tmp_path: Path,
    export_format: str,
) -> None:
    with override_settings(KODERA_EDITION="enterprise"):
        _seed_sample_events(enterprise_client)
        bundle = enterprise_client.post(
            "/api/v1/ee/compliance/audit-exports",
            data=json.dumps(
                {
                    "tenant_slug": "acme-corp",
                    "format": export_format,
                    "framework": "SOC2",
                }
            ),
            content_type="application/json",
        ).json()

        valid_payload: str = bundle["payload"]
        valid_manifest: dict[str, object] = bundle["manifest"]

        # Write valid detached bundle + manifest + pinned public key to disk and run standalone CLI
        bundle_file = tmp_path / f"export.{export_format}"
        manifest_file = tmp_path / "manifest.json"
        pubkey_file = tmp_path / "pubkey.pem"
        bundle_file.write_text(valid_payload, encoding="utf-8")
        manifest_file.write_text(json.dumps(valid_manifest), encoding="utf-8")
        pubkey_file.write_text(str(valid_manifest["public_key_pem"]), encoding="utf-8")

        env = {
            "PATH": os.environ.get("PATH", ""),
            "PYTHONPATH": str(MONOREPO_ROOT),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        cli_ok = subprocess.run(  # noqa: S603
            [
                sys.executable,
                "-m",
                "ee.audit_export.verify",
                "--bundle",
                str(bundle_file),
                "--manifest",
                str(manifest_file),
                "--public-key",
                str(pubkey_file),
            ],
            capture_output=True,
            text=True,
            env=env,
            timeout=15,
            check=False,
        )
        assert cli_ok.returncode == 0, cli_ok.stderr
        assert json.loads(cli_ok.stdout)["verified"] is True

        # --- MUTATION 1: Single-byte modification in event payload ---
        mutated_single_byte = valid_payload.replace("org.policy.updated", "org.policy.ubdated", 1)
        assert mutated_single_byte != valid_payload
        res_m1 = enterprise_client.post(
            "/api/v1/ee/compliance/audit-exports/verify",
            data=json.dumps({"payload": mutated_single_byte, "manifest": valid_manifest}),
            content_type="application/json",
        )
        assert res_m1.status_code == 422
        m1_errors = res_m1.json()["errors"]
        assert "payload_sha256_mismatch" in m1_errors
        assert any(e.startswith("entry_hash_mismatch:row_3") for e in m1_errors)

        # CLI must also exit 1 on single-byte tamper!
        tampered_file = tmp_path / f"tampered_byte.{export_format}"
        tampered_file.write_text(mutated_single_byte, encoding="utf-8")
        cli_m1 = subprocess.run(  # noqa: S603
            [
                sys.executable,
                "-m",
                "ee.audit_export.verify",
                "--bundle",
                str(tampered_file),
                "--manifest",
                str(manifest_file),
            ],
            capture_output=True,
            text=True,
            env=env,
            timeout=15,
            check=False,
        )
        assert cli_m1.returncode == 1
        assert json.loads(cli_m1.stdout)["verified"] is False

        # --- MUTATION 1b: Attacker ALSO recomputes payload_sha256 in manifest -> Ed25519 signature fails! ---
        forged_manifest = {
            **valid_manifest,
            "payload_sha256": hashlib.sha256(mutated_single_byte.encode("utf-8")).hexdigest(),
        }
        res_forged = verify_compliance_bundle(mutated_single_byte, forged_manifest)
        assert res_forged.verified is False
        assert "invalid_manifest_signature" in res_forged.errors

        # --- MUTATION 2: Deleted middle row (remove event row 2 of 4) ---
        lines = valid_payload.splitlines(keepends=True)
        if export_format == "ndjson":
            # lines: [row1, row2, row3, row4] -> drop row2 (index 1)
            deleted_middle = "".join([lines[0], lines[2], lines[3]])
            swapped_rows = "".join([lines[0], lines[2], lines[1], lines[3]])
        else:
            # lines: [header, row1, row2, row3, row4] -> drop row2 (index 2)
            deleted_middle = "".join([lines[0], lines[1], lines[3], lines[4]])
            swapped_rows = "".join([lines[0], lines[1], lines[3], lines[2], lines[4]])

        res_deleted = verify_compliance_bundle(deleted_middle, valid_manifest)
        assert res_deleted.verified is False
        assert any(e.startswith("record_count_mismatch") for e in res_deleted.errors)
        assert any(e.startswith("sequence_gap_or_reorder") for e in res_deleted.errors)
        assert any(e.startswith("broken_hash_chain") for e in res_deleted.errors)

        # --- MUTATION 3: Swapped / reordered rows (swap row 2 and row 3) ---
        res_swapped = verify_compliance_bundle(swapped_rows, valid_manifest)
        assert res_swapped.verified is False
        assert any(e.startswith("sequence_gap_or_reorder") for e in res_swapped.errors)
        assert any(e.startswith("non_monotonic_ledger_sequence") for e in res_swapped.errors)
        assert any(e.startswith("broken_hash_chain") for e in res_swapped.errors)

        # --- MUTATION 4: Pinned against a different Ed25519 public key -> signature rejected ---
        wrong_key = ed25519.Ed25519PrivateKey.generate().public_key()
        wrong_pem = wrong_key.public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("ascii")
        res_wrong_key = verify_compliance_bundle(
            valid_payload,
            valid_manifest,
            trusted_public_key_pem=wrong_pem,
        )
        assert res_wrong_key.verified is False
        assert "invalid_manifest_signature" in res_wrong_key.errors


@pytest.mark.django_db
def test_ledger_syncs_from_django_audit_events(enterprise_client: Client) -> None:
    from apps.audit.models import AuditEvent
    from apps.orgs.models import Organisation, SlugReservation
    from django.db import transaction

    with transaction.atomic():
        org = Organisation.objects.create(
            slug="acme-audit-org",
            name="Acme Audit SAS",
            realm="acme-audit-org",
            issuer="https://sso.kodera.test/realms/acme-audit-org",
        )
        SlugReservation.objects.create(organisation=org, slug=org.slug, state="provisional")
    AuditEvent.objects.create(
        actor_type="system",
        actor_id=None,
        actor_label="system",
        organisation_id=org.id,
        action="org.created",
        target_urn=f"urn:kodera:org:{org.id}",
        retention_class="standard",
        metadata={"source": "test"},
    )

    with override_settings(KODERA_EDITION="enterprise"):
        imported = default_audit_ledger.sync_from_django_audit(
            organisation_id=org.id,
            tenant_slug="acme-audit-org",
        )
        assert imported == 1
        ok, errs = default_audit_ledger.verify_vault_integrity("acme-audit-org")
        assert ok is True and errs == []


def test_audit_export_linear_redaction_and_sanitized_http_errors(
    enterprise_client: Client,
) -> None:
    """Pathological @-strings redact in O(n) time and malformed inputs return static error details."""
    with override_settings(KODERA_EDITION="enterprise"):
        # Invalid occurred_at timestamp must NOT expose raw Python ValueError (`fromisoformat` text)
        bad_evt = enterprise_client.post(
            "/api/v1/ee/compliance/audit-exports/events",
            data=json.dumps(
                {
                    "tenant_slug": "acme-corp",
                    "actor_type": "customer_user",
                    "actor_id": "u-1",
                    "action": "org.updated",
                    "target_urn": "urn:kodera:org:acme-corp",
                    "occurred_at": "not-an-iso-timestamp-secret-marker",
                }
            ),
            content_type="application/json",
        )
        assert bad_evt.status_code == 400
        assert bad_evt.json()["code"] == "invalid_event"
        assert "not-an-iso-timestamp-secret-marker" not in bad_evt.json()["detail"]
        assert "isoformat" not in bad_evt.json()["detail"].lower()

        # Linear-time redaction on pathological long non-email `@` text
        adversarial_note = ("a" * 20_000) + "@" + ("b." * 5_000) + "!"
        ok_evt = enterprise_client.post(
            "/api/v1/ee/compliance/audit-exports/events",
            data=json.dumps(
                {
                    "tenant_slug": "acme-corp",
                    "actor_type": "customer_user",
                    "actor_id": "u-1",
                    "action": "org.note",
                    "target_urn": "urn:kodera:org:acme-corp",
                    "metadata": {"note": adversarial_note, "contact": "secops@acme.fr."},
                }
            ),
            content_type="application/json",
        )
        assert ok_evt.status_code == 201

        started = time.perf_counter()
        exp = enterprise_client.post(
            "/api/v1/ee/compliance/audit-exports",
            data=json.dumps({"tenant_slug": "acme-corp", "redact_pii": True}),
            content_type="application/json",
        )
        assert (time.perf_counter() - started) < 0.25
        assert exp.status_code == 200
        assert "secops@acme.fr" not in exp.json()["payload"]
        assert "@redacted.invalid." in exp.json()["payload"]
