"""HTTP views for Enterprise Signed Compliance Audit Exports (`/api/v1/ee/compliance/audit-exports/*`).

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import base64
import json

from django.http import HttpRequest, HttpResponse, StreamingHttpResponse

from ee.audit_export.crypto import AuditSigner, canonical_json_bytes
from ee.audit_export.exporter import (
    AuditExportError,
    AuditExportFilters,
    export_compliance_bundle,
    stream_compliance_bundle,
)
from ee.audit_export.ledger import default_audit_ledger, parse_utc_iso
from ee.audit_export.verify import verify_compliance_bundle


def _json_response(payload: dict[str, object], *, status: int = 200) -> HttpResponse:
    resp = HttpResponse(
        json.dumps(payload).encode("utf-8"),
        status=status,
        content_type="application/json",
    )
    resp["Cache-Control"] = "no-store"
    return resp


def _parse_json_body(request: HttpRequest) -> dict[str, object]:
    if not request.body or len(request.body) > 2_097_152:
        raise AuditExportError("invalid_json", "Missing or oversized JSON request body")
    try:
        parsed = json.loads(request.body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise AuditExportError("invalid_json", "Malformed JSON request body") from exc
    if not isinstance(parsed, dict):
        raise AuditExportError("invalid_json", "JSON object expected")
    return parsed


def _build_filters_from_mapping(source: dict[str, object]) -> AuditExportFilters:
    raw_from = source.get("from_timestamp")
    raw_to = source.get("to_timestamp")
    try:
        from_dt = (
            parse_utc_iso(raw_from) if isinstance(raw_from, str) and raw_from.strip() else None
        )
        to_dt = parse_utc_iso(raw_to) if isinstance(raw_to, str) and raw_to.strip() else None
    except ValueError as exc:
        raise AuditExportError("invalid_timestamp", "Invalid ISO-8601 timestamp filter") from exc

    actor_id = source.get("actor_id")
    actor_type = source.get("actor_type")
    action = source.get("action")
    return AuditExportFilters(
        from_timestamp=from_dt,
        to_timestamp=to_dt,
        actor_id=actor_id.strip() if isinstance(actor_id, str) and actor_id.strip() else None,
        actor_type=actor_type.strip()
        if isinstance(actor_type, str) and actor_type.strip()
        else None,
        action=action.strip() if isinstance(action, str) and action.strip() else None,
    )


def _select_signer(tenant_slug: str, signing_algorithm: str) -> AuditSigner:
    alg = signing_algorithm.strip().lower()
    if alg == "ed25519":
        return default_audit_ledger.ed25519_signer_for_tenant(tenant_slug)
    if alg == "hmac-sha256":
        return default_audit_ledger.hmac_signer_for_tenant(tenant_slug)
    raise AuditExportError(
        "unsupported_signing_algorithm",
        "signing_algorithm must be 'ed25519' or 'hmac-sha256'",
    )


def append_audit_event_view(request: HttpRequest) -> HttpResponse:
    """Append an audit event into a tenant's hash-chained compliance vault."""
    if request.method != "POST":
        resp = _json_response(
            {"detail": "Method not allowed", "code": "method_not_allowed"},
            status=405,
        )
        resp["Allow"] = "POST"
        return resp
    try:
        body = _parse_json_body(request)
        tenant_slug = body.get("tenant_slug")
        actor_type = body.get("actor_type")
        actor_id = body.get("actor_id")
        action = body.get("action")
        target_urn = body.get("target_urn")
        if (
            not isinstance(tenant_slug, str)
            or not isinstance(actor_type, str)
            or not isinstance(actor_id, str)
            or not isinstance(action, str)
            or not isinstance(target_urn, str)
        ):
            raise AuditExportError(
                "missing_fields",
                "tenant_slug, actor_type, actor_id, action, and target_urn are required",
            )
        actor_label = body.get("actor_label")
        source_ip = body.get("source_ip")
        metadata = body.get("metadata")
        occurred_at = body.get("occurred_at")
        if metadata is not None and not isinstance(metadata, dict):
            raise AuditExportError("invalid_metadata", "metadata must be a JSON object")

        evt = default_audit_ledger.append_event(
            tenant_slug=tenant_slug.strip(),
            actor_type=actor_type,
            actor_id=actor_id,
            actor_label=actor_label if isinstance(actor_label, str) else "",
            action=action,
            target_urn=target_urn,
            source_ip=source_ip if isinstance(source_ip, str) else "",
            metadata=metadata,
            occurred_at=occurred_at if isinstance(occurred_at, str) else None,
        )
    except AuditExportError as exc:
        return _json_response({"detail": str(exc), "code": exc.code}, status=exc.status)
    except ValueError as exc:
        return _json_response({"detail": str(exc), "code": "invalid_event"}, status=400)

    return _json_response(
        {
            "sequence": evt.sequence,
            "event_id": evt.event_id,
            "occurred_at": evt.occurred_at,
            "tenant_slug": evt.tenant_slug,
            "prev_hash": evt.prev_hash,
            "entry_hash": evt.entry_hash,
        },
        status=201,
    )


def create_audit_export_view(request: HttpRequest) -> HttpResponse | StreamingHttpResponse:
    """Export a signed NDJSON or CSV compliance bundle (JSON envelope or chunked stream)."""
    if request.method not in {"POST", "GET"}:
        resp = _json_response(
            {"detail": "Method not allowed", "code": "method_not_allowed"},
            status=405,
        )
        resp["Allow"] = "GET, POST"
        return resp

    try:
        if request.method == "POST":
            params = _parse_json_body(request)
        else:
            params = {k: v for k, v in request.GET.items()}

        tenant_raw = params.get("tenant_slug")
        if not isinstance(tenant_raw, str) or not tenant_raw.strip():
            raise AuditExportError("missing_tenant_slug", "tenant_slug is required")
        tenant_slug = tenant_raw.strip()

        fmt_raw = params.get("format", "ndjson")
        export_format = fmt_raw if isinstance(fmt_raw, str) else "ndjson"

        fw_raw = params.get("framework", "SOC2")
        framework = fw_raw if isinstance(fw_raw, str) else "SOC2"

        alg_raw = params.get("signing_algorithm", "ed25519")
        signing_alg = alg_raw if isinstance(alg_raw, str) else "ed25519"

        raw_redact = params.get("redact_pii", False)
        redact_pii = raw_redact is True or (
            isinstance(raw_redact, str) and raw_redact.strip().lower() in {"1", "true"}
        )
        raw_stream = params.get("stream", request.path_info.endswith("/stream"))
        use_stream = raw_stream is True or (
            isinstance(raw_stream, str) and raw_stream.strip().lower() in {"1", "true"}
        )

        filters = _build_filters_from_mapping(params)
        signer = _select_signer(tenant_slug, signing_alg)

        bundle = export_compliance_bundle(
            ledger=default_audit_ledger,
            tenant_slug=tenant_slug,
            signer=signer,
            export_format=export_format,
            framework=framework,
            filters=filters,
            redact_pii=redact_pii,
        )
    except AuditExportError as exc:
        return _json_response({"detail": str(exc), "code": exc.code}, status=exc.status)
    except ValueError as exc:
        return _json_response({"detail": str(exc), "code": "invalid_export_request"}, status=400)

    if use_stream:
        media_type = (
            "application/x-ndjson; charset=utf-8"
            if bundle.export_format == "ndjson"
            else "text/csv; charset=utf-8"
        )
        stream_resp = StreamingHttpResponse(
            stream_compliance_bundle(bundle),
            status=200,
            content_type=media_type,
        )
        stream_resp["Cache-Control"] = "no-store"
        stream_resp["X-Kodera-Audit-Bundle-Id"] = bundle.bundle_id
        stream_resp["X-Kodera-Audit-Head-Hash"] = str(bundle.manifest["head_entry_hash"])
        stream_resp["X-Kodera-Audit-Signature"] = str(bundle.manifest["signature"])
        manifest_b64 = base64.urlsafe_b64encode(canonical_json_bytes(bundle.manifest)).decode(
            "ascii"
        )
        stream_resp["X-Kodera-Audit-Manifest"] = manifest_b64
        return stream_resp

    return _json_response(
        {
            "bundle_id": bundle.bundle_id,
            "tenant_slug": bundle.tenant_slug,
            "framework": bundle.framework,
            "format": bundle.export_format,
            "payload": bundle.payload_text,
            "manifest": bundle.manifest,
        },
        status=200,
    )


def verify_audit_export_view(request: HttpRequest) -> HttpResponse:
    """Verify hash-chain and detached Ed25519 / HMAC-SHA256 signature on an exported bundle."""
    if request.method != "POST":
        resp = _json_response(
            {"detail": "Method not allowed", "code": "method_not_allowed"},
            status=405,
        )
        resp["Allow"] = "POST"
        return resp

    try:
        body = _parse_json_body(request)
    except AuditExportError as exc:
        return _json_response({"detail": str(exc), "code": exc.code}, status=exc.status)

    payload = body.get("payload")
    manifest = body.get("manifest")
    if not isinstance(payload, str) or not isinstance(manifest, dict):
        return _json_response(
            {
                "detail": "payload (string) and manifest (object) are required",
                "code": "invalid_verification_request",
            },
            status=400,
        )

    pub_pem_raw = body.get("public_key_pem")
    trusted_pub_pem = pub_pem_raw if isinstance(pub_pem_raw, str) and pub_pem_raw.strip() else None

    hmac_secret: bytes | None = None
    if manifest.get("signing_algorithm") == "hmac-sha256":
        hmac_hex = body.get("hmac_key_hex")
        if isinstance(hmac_hex, str) and hmac_hex.strip():
            try:
                hmac_secret = bytes.fromhex(hmac_hex.strip())
            except ValueError:
                return _json_response(
                    {"detail": "Invalid hmac_key_hex", "code": "invalid_hmac_key_hex"},
                    status=400,
                )
        else:
            t_slug = manifest.get("tenant_slug")
            if isinstance(t_slug, str) and t_slug.strip():
                hmac_secret = default_audit_ledger.hmac_signer_for_tenant(t_slug).secret_key

    result = verify_compliance_bundle(
        payload,
        manifest,
        trusted_public_key_pem=trusted_pub_pem,
        hmac_secret=hmac_secret,
    )
    return _json_response(result.to_dict(), status=200 if result.verified else 422)
