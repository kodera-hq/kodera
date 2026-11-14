"""HTTP views for Enterprise Signed Compliance Audit Exports (`/api/v1/ee/compliance/audit-exports/*`).

Security invariants (`W2-1` & `W2-2`):
- Every endpoint requires a verified Kodera customer Bearer token with active `Organisation` and
  accepted `org_owner` or `org_admin` `Membership`.
- `tenant_slug` and `actor_id` are bound strictly to the authenticated principal; cross-tenant
  requests and spoofed `actor_id` / `actor_type` fields are rejected with `403`.
- Compliance exports default `redact_pii=True`; unredacted exports (`redact_pii=False`) require
  `org_owner` membership.
- Bundle verification (`POST .../verify`) ignores caller-supplied trust keys and pins strictly to
  the server-governed deterministic tenant signing key registry.

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import base64
import json
from typing import Final

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
from ee.auth import ADMIN_ROLES, OWNER_ROLES, EeAuthError, authenticate_tenant_request

_AUDIT_PUBLIC_ERRORS: Final[tuple[tuple[str, int, str], ...]] = (
    # Authentication & tenant authorization rejections (401 / 403)
    ("unauthenticated", 401, "Authentication required"),
    ("forbidden_lane", 403, "Customer authentication lane required"),
    ("identity_unknown", 403, "Authenticated identity is not provisioned"),
    ("tenant_membership_required", 403, "Active tenant membership is required"),
    ("cross_tenant_forbidden", 403, "Cross-tenant compliance operation is forbidden"),
    ("insufficient_role", 403, "Organisation owner or admin role is required"),
    (
        "actor_spoofing_forbidden",
        403,
        "Audit event actor fields must match the authenticated principal",
    ),
    (
        "owner_required_for_unredacted_export",
        403,
        "Organisation owner role is required for unredacted PII export",
    ),
    # Input validation rejections (400)
    ("invalid_json", 400, "Malformed or oversized JSON request body"),
    ("invalid_timestamp", 400, "Invalid ISO-8601 timestamp parameter"),
    ("invalid_time_range", 400, "from_timestamp must not be after to_timestamp"),
    ("unsupported_format", 400, "Unsupported compliance export format"),
    ("unsupported_framework", 400, "Unsupported compliance framework"),
    ("unsupported_signing_algorithm", 400, "Unsupported audit manifest signing algorithm"),
    ("missing_fields", 400, "Required audit event fields are missing"),
    ("invalid_metadata", 400, "Audit event metadata must be a JSON object"),
    ("missing_tenant_slug", 400, "tenant_slug is invalid"),
    ("invalid_event", 400, "Invalid compliance audit event parameters"),
    ("invalid_export_request", 400, "Invalid compliance audit export parameters"),
)


def _json_response(payload: dict[str, object], *, status: int = 200) -> HttpResponse:
    resp = HttpResponse(
        json.dumps(payload).encode("utf-8"),
        status=status,
        content_type="application/json",
    )
    resp["Cache-Control"] = "no-store"
    if status == 401:
        resp["WWW-Authenticate"] = "Bearer"
    return resp


def _audit_error_response(error_code: str) -> HttpResponse:
    """Resolve compliance audit error response solely from static literals."""
    for code_lit, status_lit, detail_lit in _AUDIT_PUBLIC_ERRORS:
        if error_code == code_lit:
            return _json_response({"detail": detail_lit, "code": code_lit}, status=status_lit)
    return _json_response(
        {"detail": "Compliance audit request rejected", "code": "invalid_export_request"},
        status=400,
    )


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


def _resolve_redact_pii(raw_redact: object, *, caller_role: str) -> bool:
    """Default `redact_pii` to `True`; allow `False` solely for verified `org_owner` callers."""
    if raw_redact is None:
        return True
    if raw_redact is True or (
        isinstance(raw_redact, str) and raw_redact.strip().lower() in {"1", "true"}
    ):
        return True
    if raw_redact is False or (
        isinstance(raw_redact, str) and raw_redact.strip().lower() in {"0", "false"}
    ):
        if caller_role not in OWNER_ROLES:
            raise EeAuthError("owner_required_for_unredacted_export", status=403)
        return False
    raise AuditExportError("invalid_export_request", "Invalid redact_pii boolean value")


def append_audit_event_view(request: HttpRequest) -> HttpResponse:
    """Append an administrative audit event bound strictly to the authenticated tenant admin."""
    if request.method != "POST":
        resp = _json_response(
            {"detail": "Method not allowed", "code": "method_not_allowed"},
            status=405,
        )
        resp["Allow"] = "POST"
        return resp
    try:
        auth = authenticate_tenant_request(request, required_roles=ADMIN_ROLES)
        body = _parse_json_body(request)

        if "tenant_slug" in body and body["tenant_slug"] is not None:
            raw_tenant = body["tenant_slug"]
            if not isinstance(raw_tenant, str) or raw_tenant.strip() != auth.tenant_slug:
                raise EeAuthError("cross_tenant_forbidden", status=403)

        expected_actor_id = str(auth.user_id)
        if "actor_id" in body and body["actor_id"] is not None:
            raw_actor_id = body["actor_id"]
            if not isinstance(raw_actor_id, str) or raw_actor_id.strip() != expected_actor_id:
                raise EeAuthError("actor_spoofing_forbidden", status=403)

        if "actor_type" in body and body["actor_type"] is not None:
            raw_actor_type = body["actor_type"]
            if not isinstance(raw_actor_type, str) or raw_actor_type.strip() != "customer_user":
                raise EeAuthError("actor_spoofing_forbidden", status=403)

        action = body.get("action")
        target_urn = body.get("target_urn")
        if (
            not isinstance(action, str)
            or not action.strip()
            or not isinstance(target_urn, str)
            or not target_urn.strip()
        ):
            raise AuditExportError("missing_fields", "action and target_urn are required")

        metadata = body.get("metadata")
        occurred_at = body.get("occurred_at")
        if metadata is not None and not isinstance(metadata, dict):
            raise AuditExportError("invalid_metadata", "metadata must be a JSON object")

        remote_addr = request.META.get("REMOTE_ADDR")
        client_ip = remote_addr if isinstance(remote_addr, str) else ""

        evt = default_audit_ledger.append_event(
            tenant_slug=auth.tenant_slug,
            actor_type="customer_user",
            actor_id=expected_actor_id,
            actor_label=auth.email,
            action=action,
            target_urn=target_urn,
            source_ip=client_ip,
            metadata=metadata,
            occurred_at=occurred_at if isinstance(occurred_at, str) else None,
        )
    except EeAuthError as exc:
        return _audit_error_response(exc.code)
    except AuditExportError as exc:
        return _audit_error_response(exc.code)
    except ValueError:
        return _audit_error_response("invalid_event")

    return _json_response(
        {
            "sequence": evt.sequence,
            "event_id": evt.event_id,
            "occurred_at": evt.occurred_at,
            "tenant_slug": evt.tenant_slug,
            "actor_type": evt.actor_type,
            "actor_id": evt.actor_id,
            "prev_hash": evt.prev_hash,
            "entry_hash": evt.entry_hash,
        },
        status=201,
    )


def create_audit_export_view(request: HttpRequest) -> HttpResponse | StreamingHttpResponse:
    """Export a signed NDJSON or CSV compliance bundle for the authenticated tenant."""
    if request.method not in {"POST", "GET"}:
        resp = _json_response(
            {"detail": "Method not allowed", "code": "method_not_allowed"},
            status=405,
        )
        resp["Allow"] = "GET, POST"
        return resp

    try:
        auth = authenticate_tenant_request(request, required_roles=ADMIN_ROLES)
        if request.method == "POST" and request.body:
            params = _parse_json_body(request)
        elif request.method == "POST":
            params = {}
        else:
            params = {k: v for k, v in request.GET.items()}

        if "tenant_slug" in params and params["tenant_slug"] is not None:
            tenant_raw = params["tenant_slug"]
            if not isinstance(tenant_raw, str) or not tenant_raw.strip():
                raise AuditExportError("missing_tenant_slug", "Invalid tenant_slug")
            if tenant_raw.strip() != auth.tenant_slug:
                raise EeAuthError("cross_tenant_forbidden", status=403)

        tenant_slug = auth.tenant_slug

        fmt_raw = params.get("format", "ndjson")
        export_format = fmt_raw if isinstance(fmt_raw, str) else "ndjson"

        fw_raw = params.get("framework", "SOC2")
        framework = fw_raw if isinstance(fw_raw, str) else "SOC2"

        alg_raw = params.get("signing_algorithm", "ed25519")
        signing_alg = alg_raw if isinstance(alg_raw, str) else "ed25519"

        redact_pii = _resolve_redact_pii(params.get("redact_pii"), caller_role=auth.role)

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
    except EeAuthError as exc:
        return _audit_error_response(exc.code)
    except AuditExportError as exc:
        return _audit_error_response(exc.code)
    except ValueError:
        return _audit_error_response("invalid_export_request")

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
    """Verify hash-chain and detached signature pinned strictly to the server-governed tenant key."""
    if request.method != "POST":
        resp = _json_response(
            {"detail": "Method not allowed", "code": "method_not_allowed"},
            status=405,
        )
        resp["Allow"] = "POST"
        return resp

    try:
        auth = authenticate_tenant_request(request, required_roles=ADMIN_ROLES)
        body = _parse_json_body(request)
    except EeAuthError as exc:
        return _audit_error_response(exc.code)
    except AuditExportError as exc:
        return _audit_error_response(exc.code)

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

    manifest_tenant = manifest.get("tenant_slug")
    if not isinstance(manifest_tenant, str) or manifest_tenant.strip() != auth.tenant_slug:
        return _audit_error_response("cross_tenant_forbidden")

    # Security invariant (`W2-2`): ignore any caller-supplied `public_key_pem` / `hmac_key_hex` and
    # pin strictly to the server-governed deterministic signing keys for `auth.tenant_slug`.
    server_pub_pem = default_audit_ledger.ed25519_signer_for_tenant(auth.tenant_slug).public_key_pem
    server_hmac_secret = default_audit_ledger.hmac_signer_for_tenant(auth.tenant_slug).secret_key

    result = verify_compliance_bundle(
        payload,
        manifest,
        trusted_public_key_pem=server_pub_pem,
        hmac_secret=server_hmac_secret,
    )
    return _json_response(result.to_dict(), status=200 if result.verified else 422)
