"""Bounded `(tenant, external_workspace, channel_pair)` live coexistence bridge."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import http.client
import json
import ssl
import time
from collections.abc import Mapping
from contextlib import suppress
from datetime import timedelta
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from apps.identity import selectors as identities
from apps.identity.selectors import lock_delivery_identity, lock_user_fence
from apps.media import outbound
from apps.orgs import selectors as organisations
from apps.orgs.selectors import (
    lock_erasure_cutoff_fences,
    lock_membership_fence,
    lock_organisation,
    organisation_exists,
)
from apps.workspaces import selectors as workspaces
from apps.workspaces.channel_sets import lock_workspace
from core import sealing
from core.db.ids import new_uuid7

from .import_parsers import MAX_FILE, clean, identifier, verify_asset_magic
from .imports import MatrixReplayTransport, try_compensating_redact
from .member_matching import inert_author_attribution
from .models import CoexistenceBridge, CoexistenceReplayGuard, WorkspaceCutoff
from .services import admin, audit, read_admin, require_channel_post
from .wire import ExtensionRefusedError, canonical, signature as sign_v1

SEAL_AAD_PREFIX = b"kodera-coexistence-v1:"
MAX_COEXISTENCE_BODY = 256 * 1024
MAX_BRIDGES_PER_WORKSPACE = 50
FRESHNESS_WINDOW_SECONDS = 300
REPLAY_TTL_DAYS = 7

_DEFAULT_OUTBOUND_ADDRESSES = outbound.addresses
_DEFAULT_OUTBOUND_REQUEST = outbound.request


def coexistence_aad(organisation_id: UUID, bridge_id: UUID) -> bytes:
    return SEAL_AAD_PREFIX + organisation_id.bytes + bridge_id.bytes


def coexistence_seal_key() -> bytes:
    explicit = getattr(settings, "KODERA_COEXISTENCE_SEAL_KEY", None)
    key = explicit if explicit is not None else getattr(settings, "KODERA_CONTACT_SEAL_KEY", None)
    if not isinstance(key, bytes) or len(key) != sealing.KEY_BYTES:
        raise ExtensionRefusedError("coexistence_seal_key_unavailable", 503)
    return key


def _validate_signing_secret(secret: str) -> bytes:
    if (
        not isinstance(secret, str)
        or not 32 <= len(secret.encode("utf-8")) <= 512
        or not secret.isascii()
        or not secret.isprintable()
    ):
        raise ExtensionRefusedError("coexistence_signing_secret_invalid", 422)
    return secret.encode("ascii")


def content_echo_sha256(bridge_id: UUID, cleaned_text: str) -> str:
    payload = canonical({"bridge_id": str(bridge_id), "text": cleaned_text})
    return hashlib.sha256(payload).hexdigest()


def serialize_bridge(row: CoexistenceBridge) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "workspaceId": str(row.workspace_id),
        "channelId": str(row.channel_id),
        "creatorMembershipId": str(row.creator_id),
        "source": row.source,
        "externalWorkspaceId": row.external_workspace_id,
        "externalChannelId": row.external_channel_id,
        "outboundEndpoint": row.outbound_endpoint,
        "active": row.revoked_at is None,
        "createdAt": row.created_at.isoformat(),
        "updatedAt": row.updated_at.isoformat(),
        "revokedAt": row.revoked_at.isoformat() if row.revoked_at is not None else None,
    }


def _unique_json_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, val in pairs:
        if key in out:
            raise ValueError("duplicate JSON key")
        out[key] = val
    return out


def sign_inbound_webhook(secret: str, timestamp: int, raw_body: bytes) -> str:
    return sign_v1(secret, timestamp, raw_body)


def _header(headers: Mapping[str, str], name: str) -> str | None:
    target = name.lower()
    for key, val in headers.items():
        if key.lower() == target:
            return val
    return None


def _parse_and_check_freshness(headers: Mapping[str, str], now_ts: int) -> int:
    raw_ts = (
        _header(headers, "X-Kodera-Coexistence-Timestamp")
        or _header(headers, "X-Slack-Request-Timestamp")
        or _header(headers, "X-Signature-Timestamp")
    )
    if (
        not isinstance(raw_ts, str)
        or not raw_ts
        or len(raw_ts) > 20
        or not raw_ts.isascii()
        or not raw_ts.isdigit()
    ):
        raise ExtensionRefusedError("coexistence_timestamp_invalid", 401)
    ts = int(raw_ts)
    if abs(now_ts - ts) > FRESHNESS_WINDOW_SECONDS:
        raise ExtensionRefusedError("coexistence_timestamp_stale", 401)
    return ts


def _extract_signature_header(headers: Mapping[str, str]) -> tuple[str, str]:
    kodera_sig = _header(headers, "X-Kodera-Coexistence-Signature")
    if isinstance(kodera_sig, str) and kodera_sig.startswith("v1="):
        digest_hex = kodera_sig[3:]
        if len(digest_hex) == 64 and all(c in "0123456789abcdef" for c in digest_hex):
            return ("v1", kodera_sig)
        raise ExtensionRefusedError("coexistence_signature_invalid", 401)
    slack_sig = _header(headers, "X-Slack-Signature")
    if isinstance(slack_sig, str) and slack_sig.startswith("v0="):
        digest_hex = slack_sig[3:]
        if len(digest_hex) == 64 and all(c in "0123456789abcdef" for c in digest_hex):
            return ("v0", slack_sig)
        raise ExtensionRefusedError("coexistence_signature_invalid", 401)
    raise ExtensionRefusedError("coexistence_signature_invalid", 401)


def _verify_hmac_constant_time(
    *, scheme: str, provided_sig: str, secret: str, ts: int, raw_body: bytes
) -> None:
    if scheme == "v1":
        expected = (
            "v1="
            + hmac.digest(
                secret.encode("ascii"), f"{ts}.".encode("ascii") + raw_body, "sha256"
            ).hex()
        )
    else:
        expected = (
            "v0="
            + hmac.digest(
                secret.encode("ascii"), f"v0:{ts}:".encode("ascii") + raw_body, "sha256"
            ).hex()
        )
    if not hmac.compare_digest(expected.encode("ascii"), provided_sig.encode("ascii")):
        raise ExtensionRefusedError("coexistence_signature_invalid", 401)


def create_bridge(
    *,
    verified: Any,
    organisation_id: UUID,
    channel_id: UUID,
    source: str,
    external_workspace_id: str,
    external_channel_id: str,
    outbound_endpoint: str,
    signing_secret: str,
) -> CoexistenceBridge:
    if source not in {"slack", "discord"}:
        raise ExtensionRefusedError("coexistence_source_invalid", 422)
    ext_ws = identifier(external_workspace_id)
    ext_ch = identifier(external_channel_id)
    try:
        canonical_endpoint = outbound.target(outbound_endpoint, https_only=True).url
    except outbound.BlockedTargetError:
        raise ExtensionRefusedError("coexistence_outbound_endpoint_refused", 422) from None
    secret_bytes = _validate_signing_secret(signing_secret)
    key = coexistence_seal_key()

    with transaction.atomic():
        workspace_id, principal = admin(verified, organisation_id)
        channel = workspaces.channel_snapshot(
            channel_id=channel_id, workspace_id=workspace_id, for_update=True
        )
        if channel is None or channel.kind != "text":
            raise ExtensionRefusedError("coexistence_channel_absent", 404)
        if channel.is_confidential:
            raise ExtensionRefusedError("coexistence_confidential_channel_refused", 403)
        if channel.lifecycle != "active":
            raise ExtensionRefusedError("coexistence_channel_inactive", 409)
        require_channel_post(
            channel_id=channel.id,
            membership_id=principal.membership_id,
            organisation_id=organisation_id,
            confidential_reason="coexistence_confidential_channel_refused",
        )
        active_count = CoexistenceBridge.objects.filter(
            workspace_id=workspace_id, revoked_at__isnull=True
        ).count()
        if active_count >= MAX_BRIDGES_PER_WORKSPACE:
            raise ExtensionRefusedError("coexistence_bridge_limit_exceeded", 409)
        bridge_id = new_uuid7()
        sealed = sealing.seal(key, coexistence_aad(organisation_id, bridge_id), secret_bytes)
        try:
            row = CoexistenceBridge.objects.create(
                id=bridge_id,
                workspace_id=workspace_id,
                channel_id=channel.id,
                creator_id=principal.membership_id,
                source=source,
                external_workspace_id=ext_ws,
                external_channel_id=ext_ch,
                outbound_endpoint=canonical_endpoint,
                sealed_signing_secret=sealed,
            )
        except IntegrityError:
            raise ExtensionRefusedError("coexistence_bridge_already_exists", 409) from None
        audit(
            "coexistence_bridge_created",
            principal,
            organisation_id,
            row.id,
            {"source": source, "channel_id": str(channel.id)},
        )
        return row


@transaction.atomic
def list_bridges(*, verified: Any, organisation_id: UUID) -> list[dict[str, Any]]:
    workspace_id, _ = read_admin(verified, organisation_id)
    rows = CoexistenceBridge.objects.filter(workspace_id=workspace_id).order_by(
        "-created_at", "-id"
    )[:100]
    return [serialize_bridge(row) for row in rows]


@transaction.atomic
def revoke_bridge(*, verified: Any, organisation_id: UUID, bridge_id: UUID) -> CoexistenceBridge:
    workspace_id, principal = admin(verified, organisation_id)
    row = (
        CoexistenceBridge.objects.select_for_update()
        .filter(id=bridge_id, workspace_id=workspace_id)
        .first()
    )
    if row is None:
        raise ExtensionRefusedError("coexistence_bridge_absent", 404)
    if row.revoked_at is None:
        row.revoked_at = timezone.now()
        row.sealed_signing_secret = b""
        row.save(update_fields=["revoked_at", "sealed_signing_secret", "updated_at"])
        audit(
            "coexistence_bridge_revoked",
            principal,
            organisation_id,
            row.id,
            {"source": row.source, "channel_id": str(row.channel_id)},
        )
    return row


def _lock_and_verify_bridge_authority(
    *,
    bridge_id: UUID,
    hmac_check: tuple[str, str, int, bytes] | None = None,
) -> tuple[UUID, CoexistenceBridge, workspaces.ChannelSnapshot, str]:
    """Acquire canonical `advisories -> m -> i -> u -> o -> w` locks and verify live bridge invariants."""
    initial = CoexistenceBridge.objects.filter(id=bridge_id).first()
    if initial is None:
        if hmac_check is not None:
            raise ExtensionRefusedError("coexistence_signature_invalid", 401)
        raise ExtensionRefusedError("coexistence_bridge_absent", 404)

    org_id: UUID = workspaces.workspace_organisation(workspace_id=initial.workspace_id)
    if not organisation_exists(organisation_id=org_id):
        raise ExtensionRefusedError("extension_workspace_absent", 404)
    if WorkspaceCutoff.objects.filter(organisation_id=org_id).exists():
        raise ExtensionRefusedError("extension_workspace_cut_off", 410)

    creator_membership_id: UUID = initial.creator_id
    creator_user_id: UUID = organisations.membership_user_id(membership_id=initial.creator_id)
    initial_identity = identities.first_organisation_identity_id(
        organisation_id=org_id, user_id=creator_user_id
    )

    # Canonical lock order: advisories -> m -> i -> u -> o -> w
    lock_erasure_cutoff_fences(organisation_id=org_id, user_id=creator_user_id)
    locked_user_id = lock_membership_fence(membership_id=creator_membership_id)
    if initial_identity is not None:
        lock_delivery_identity(identity_id=initial_identity)
    lock_user_fence(user_id=locked_user_id)
    if not lock_organisation(organisation_id=org_id):
        raise ExtensionRefusedError("extension_workspace_absent", 404)
    if lock_workspace(organisation_id=org_id) is None:
        raise ExtensionRefusedError("extension_workspace_absent", 404)

    if WorkspaceCutoff.objects.filter(organisation_id=org_id).exists():
        raise ExtensionRefusedError("extension_workspace_cut_off", 410)

    bridge = (
        CoexistenceBridge.objects.select_for_update()
        .filter(id=bridge_id, workspace__organisation_id=org_id)
        .first()
    )
    if bridge is None:
        raise ExtensionRefusedError("coexistence_bridge_absent", 404)
    if bridge.revoked_at is not None or not bytes(bridge.sealed_signing_secret):
        raise ExtensionRefusedError("coexistence_bridge_revoked", 403)

    key = coexistence_seal_key()
    try:
        secret = sealing.unseal(
            key, coexistence_aad(org_id, bridge.id), bytes(bridge.sealed_signing_secret)
        ).decode("ascii")
    except (UnicodeError, sealing.SealError):
        raise ExtensionRefusedError("coexistence_seal_corrupted", 503) from None

    # Authenticate inbound HMAC before revealing organisation/creator/channel refusal states.
    if hmac_check is not None:
        scheme, provided_sig, ts, raw_body = hmac_check
        _verify_hmac_constant_time(
            scheme=scheme, provided_sig=provided_sig, secret=secret, ts=ts, raw_body=raw_body
        )

    if not organisations.active_organisation(organisation_id=org_id):
        raise ExtensionRefusedError("coexistence_organisation_inactive", 403)

    creator_active = (
        organisations.current_admin_role(membership_id=bridge.creator_id, organisation_id=org_id)
        is not None
        and identities.enabled_user(user_id=locked_user_id)
        and identities.delivery_identity_exists(organisation_id=org_id, user_id=locked_user_id)
    )
    if not creator_active:
        raise ExtensionRefusedError("coexistence_creator_authority_revoked", 403)

    channel = workspaces.channel_snapshot(
        channel_id=bridge.channel_id, workspace_id=bridge.workspace_id, for_update=True
    )
    if channel is None or channel.kind != "text" or channel.lifecycle != "active":
        raise ExtensionRefusedError("coexistence_channel_inactive", 403)
    if channel.is_confidential:
        raise ExtensionRefusedError("coexistence_confidential_channel_refused", 403)

    require_channel_post(
        channel_id=channel.id,
        membership_id=bridge.creator_id,
        organisation_id=org_id,
        confidential_reason="coexistence_confidential_channel_refused",
    )
    return org_id, bridge, channel, secret


def _has_echo_markers(payload: dict[str, Any]) -> bool:
    if "kodera_bridge_id" in payload and payload["kodera_bridge_id"] is not None:
        return True
    if payload.get("bot_id"):
        return True
    if payload.get("subtype") == "bot_message":
        return True
    author = payload.get("author")
    if isinstance(author, dict) and bool(author.get("bot") or author.get("is_bot")):
        return True
    metadata = payload.get("metadata")
    if isinstance(metadata, dict) and metadata.get("kodera_bridge_id") is not None:
        return True
    event = payload.get("event")
    if isinstance(event, dict) and _has_echo_markers(event):
        return True
    return False


def _fetch_pinned_attachment(
    *, organisation_id: UUID, url: str, filename: str, declared_mime: str | None
) -> str:
    try:
        destination = outbound.target(url, https_only=True)
    except outbound.BlockedTargetError:
        raise ExtensionRefusedError("coexistence_attachment_target_refused", 422) from None
    deadline = time.monotonic() + 5.0
    try:
        conn, resp = outbound.request(
            destination,
            method="GET",
            pool="webhook",
            scope_key=str(organisation_id),
            deadline=deadline,
        )
    except outbound.BlockedTargetError:
        raise ExtensionRefusedError("coexistence_attachment_target_refused", 422) from None
    except outbound.FetchError:
        raise ExtensionRefusedError("coexistence_attachment_unavailable", 502) from None
    try:
        if resp.status != 200:
            raise ExtensionRefusedError("coexistence_attachment_unavailable", 502)
        raw = resp.read(MAX_FILE + 1)
    finally:
        resp.close()
        conn.close()
    if not raw or len(raw) > MAX_FILE:
        raise ExtensionRefusedError("import_asset_bound", 413)
    return verify_asset_magic(filename, raw, declared_mime)


def _verify_inbound_hmac_prelock(
    *, bridge_id: UUID, scheme: str, provided_sig: str, ts: int, raw_body: bytes
) -> tuple[UUID, CoexistenceBridge]:
    """Authenticate HMAC-SHA256 before acquiring any advisory or row locks."""
    initial = CoexistenceBridge.objects.filter(id=bridge_id).first()
    dummy_digest = hmac.new(
        b"0" * 32, f"v1:{ts}:".encode("ascii") + raw_body, hashlib.sha256
    ).hexdigest()
    if initial is None:
        hmac.compare_digest(dummy_digest, provided_sig)
        raise ExtensionRefusedError("coexistence_signature_invalid", 401)
    org_id: UUID = workspaces.workspace_organisation(workspace_id=initial.workspace_id)
    if WorkspaceCutoff.objects.filter(organisation_id=org_id).exists():
        hmac.compare_digest(dummy_digest, provided_sig)
        raise ExtensionRefusedError("extension_workspace_cut_off", 410)
    if initial.revoked_at is not None or not bytes(initial.sealed_signing_secret):
        hmac.compare_digest(dummy_digest, provided_sig)
        raise ExtensionRefusedError("coexistence_bridge_revoked", 403)
    key = coexistence_seal_key()
    try:
        secret = sealing.unseal(
            key, coexistence_aad(org_id, initial.id), bytes(initial.sealed_signing_secret)
        ).decode("ascii")
    except (UnicodeError, sealing.SealError):
        raise ExtensionRefusedError("coexistence_seal_corrupted", 503) from None
    _verify_hmac_constant_time(
        scheme=scheme, provided_sig=provided_sig, secret=secret, ts=ts, raw_body=raw_body
    )
    return org_id, initial


def _claim_coexistence_guard_locked(
    *,
    bridge: CoexistenceBridge,
    external_event_id: str,
    event_sha256: str,
    direction: str,
    now: Any,
    allow_queued_existing: bool = False,
    matrix_txn_id: str | None = None,
    matrix_event_id: str | None = None,
    sanitized_payload: dict[str, Any] | None = None,
) -> tuple[CoexistenceReplayGuard, UUID]:
    """Under bridge lock, claim an `in_flight` lease or refuse non-retryable duplicates."""
    existing = (
        CoexistenceReplayGuard.objects.select_for_update()
        .filter(bridge=bridge, external_event_id=external_event_id)
        .first()
    )
    lease_id = new_uuid7()
    lease_until = now + timedelta(seconds=60)
    if existing is not None:
        active_lease = (
            existing.state == "in_flight"
            and existing.lease_expires_at is not None
            and existing.lease_expires_at > now
        )
        retryable = (
            existing.state == "retryable_failed"
            or (allow_queued_existing and existing.state == "queued")
            or (
                existing.state == "in_flight"
                and existing.lease_expires_at is not None
                and existing.lease_expires_at <= now
            )
        )
        if existing.state in {"delivered", "obsolete"} or active_lease or not retryable:
            raise ExtensionRefusedError("coexistence_event_replayed", 409)
        if existing.attempts >= 8:
            existing.state = "obsolete"
            existing.lease_id = None
            existing.lease_expires_at = None
            existing.sanitized_payload = None
            existing.save(
                update_fields=[
                    "state",
                    "lease_id",
                    "lease_expires_at",
                    "sanitized_payload",
                    "updated_at",
                ]
            )
            raise ExtensionRefusedError("coexistence_delivery_attempts_exhausted", 409)
        existing.state = "in_flight"
        existing.lease_id = lease_id
        existing.lease_expires_at = lease_until
        existing.attempts = existing.attempts + 1
        if matrix_txn_id is not None and existing.matrix_txn_id is None:
            existing.matrix_txn_id = matrix_txn_id
        if sanitized_payload is not None and existing.sanitized_payload is None:
            existing.sanitized_payload = sanitized_payload
        existing.save(
            update_fields=[
                "state",
                "lease_id",
                "lease_expires_at",
                "attempts",
                "matrix_txn_id",
                "sanitized_payload",
                "updated_at",
            ]
        )
        return existing, lease_id

    try:
        guard = CoexistenceReplayGuard.objects.create(
            bridge=bridge,
            external_event_id=external_event_id,
            event_sha256=event_sha256,
            direction=direction,
            state="in_flight",
            lease_id=lease_id,
            lease_expires_at=lease_until,
            attempts=1,
            matrix_txn_id=matrix_txn_id,
            matrix_event_id=matrix_event_id,
            sanitized_payload=sanitized_payload,
            expires_at=now + timedelta(days=REPLAY_TTL_DAYS),
        )
    except IntegrityError:
        raise ExtensionRefusedError("coexistence_event_replayed", 409) from None
    return guard, lease_id


def _release_guard_retryable(guard_id: UUID, lease_id: UUID) -> None:
    with transaction.atomic():
        CoexistenceReplayGuard.objects.filter(
            id=guard_id, state="in_flight", lease_id=lease_id
        ).update(state="retryable_failed", lease_id=None, lease_expires_at=None)


def _mark_guard_obsolete(guard_id: UUID, lease_id: UUID | None = None) -> None:
    with transaction.atomic():
        qs = CoexistenceReplayGuard.objects.filter(id=guard_id).exclude(
            state__in=("delivered", "obsolete")
        )
        if lease_id is not None:
            qs = qs.filter(lease_id=lease_id)
        qs.update(state="obsolete", lease_id=None, lease_expires_at=None, sanitized_payload=None)


def receive_webhook(
    *,
    bridge_id: UUID,
    raw_body: bytes,
    headers: Mapping[str, str],
    now_ts: int | None = None,
    matrix_transport: MatrixReplayTransport | None = None,
    room_id: str | None = None,
) -> dict[str, Any]:
    """Authenticate before locking, anti-echo filter, replay-fence, and queue or relay inbound events."""
    if not isinstance(raw_body, bytes) or not 0 < len(raw_body) <= MAX_COEXISTENCE_BODY:
        raise ExtensionRefusedError(
            "coexistence_payload_bound"
            if isinstance(raw_body, bytes) and len(raw_body) > MAX_COEXISTENCE_BODY
            else "coexistence_payload_invalid",
            413 if isinstance(raw_body, bytes) and len(raw_body) > MAX_COEXISTENCE_BODY else 400,
        )
    if _header(headers, "X-Kodera-Bridge-Origin") is not None:
        raise ExtensionRefusedError("coexistence_echo_origin_refused", 409)

    effective_now_ts = int(time.time()) if now_ts is None else now_ts
    ts = _parse_and_check_freshness(headers, effective_now_ts)
    scheme, provided_sig = _extract_signature_header(headers)

    # 1. Verify HMAC-SHA256 BEFORE acquiring any org/workspace/membership locks.
    org_id, initial_bridge = _verify_inbound_hmac_prelock(
        bridge_id=bridge_id,
        scheme=scheme,
        provided_sig=provided_sig,
        ts=ts,
        raw_body=raw_body,
    )

    try:
        payload = json.loads(
            raw_body.decode("utf-8"),
            object_pairs_hook=_unique_json_pairs,
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError()),
        )
    except (UnicodeError, ValueError, RecursionError):
        raise ExtensionRefusedError("coexistence_payload_invalid", 400) from None
    if not isinstance(payload, dict):
        raise ExtensionRefusedError("coexistence_payload_invalid", 400)

    if _has_echo_markers(payload):
        raise ExtensionRefusedError("coexistence_echo_loop_refused", 409)

    raw_event = payload.get("event")
    inner: dict[str, Any] = raw_event if isinstance(raw_event, dict) else payload
    ext_ws = (
        payload.get("external_workspace_id") or payload.get("team_id") or payload.get("guild_id")
    )
    ext_ch = inner.get("external_channel_id") or inner.get("channel") or inner.get("channel_id")
    if (
        ext_ws != initial_bridge.external_workspace_id
        or ext_ch != initial_bridge.external_channel_id
    ):
        raise ExtensionRefusedError("coexistence_scope_mismatch", 403)

    raw_event_id = (
        payload.get("event_id") or inner.get("event_id") or inner.get("id") or inner.get("ts")
    )
    external_event_id = identifier(raw_event_id)
    raw_author = inner.get("author")
    author_dict: dict[str, Any] = raw_author if isinstance(raw_author, dict) else {}
    raw_author_id = inner.get("user") or author_dict.get("id") or "external"
    author_id = identifier(raw_author_id)
    raw_author_name = (
        inner.get("author_name")
        or author_dict.get("name")
        or author_dict.get("username")
        or author_id
    )
    author_name = clean(str(raw_author_name), 200) or author_id
    cleaned_text = clean(inner.get("text") if "text" in inner else inner.get("content", ""))

    raw_attachments = inner.get("attachments")
    pending_remote_attachments: list[tuple[str, str, str | None]] = []
    if raw_attachments is not None:
        if not isinstance(raw_attachments, list) or len(raw_attachments) > 10:
            raise ExtensionRefusedError("coexistence_attachments_bound", 422)
        for att in raw_attachments:
            if not isinstance(att, dict):
                raise ExtensionRefusedError("coexistence_payload_invalid", 422)
            filename = att.get("filename")
            declared_mime = (
                att.get("content_type") if isinstance(att.get("content_type"), str) else None
            )
            if not isinstance(filename, str) or not filename.strip():
                raise ExtensionRefusedError("import_asset_mime_refused", 422)
            if "content_base64" in att:
                b64_val = att["content_base64"]
                if not isinstance(b64_val, str) or len(b64_val) > (MAX_FILE * 4 // 3 + 16):
                    raise ExtensionRefusedError("import_asset_bound", 413)
                try:
                    att_bytes = base64.b64decode(b64_val, validate=True)
                except (ValueError, binascii.Error):
                    raise ExtensionRefusedError("coexistence_payload_invalid", 400) from None
                verify_asset_magic(filename, att_bytes, declared_mime)
            elif "url" in att:
                if not isinstance(att["url"], str):
                    raise ExtensionRefusedError("coexistence_payload_invalid", 422)
                pending_remote_attachments.append((att["url"], filename, declared_mime))
            else:
                raise ExtensionRefusedError("coexistence_payload_invalid", 422)

    pre_now = timezone.now()
    echo_digest = content_echo_sha256(initial_bridge.id, cleaned_text)
    raw_digest = hashlib.sha256(raw_body).hexdigest()

    existing_pre = CoexistenceReplayGuard.objects.filter(
        bridge_id=bridge_id, external_event_id=external_event_id
    ).first()
    if existing_pre is not None:
        active_pre = (
            existing_pre.state == "in_flight"
            and existing_pre.lease_expires_at is not None
            and existing_pre.lease_expires_at > pre_now
        )
        if existing_pre.state in {"delivered", "queued", "obsolete"} or active_pre:
            raise ExtensionRefusedError("coexistence_event_replayed", 409)

    if (
        CoexistenceReplayGuard.objects.filter(
            bridge_id=bridge_id,
            direction="outbound",
            expires_at__gt=pre_now,
            event_sha256__in=(echo_digest, raw_digest),
        )
        .exclude(state="obsolete")
        .exists()
    ):
        raise ExtensionRefusedError("coexistence_echo_loop_refused", 409)

    # 2. Fetch external attachments & resolve room_id BEFORE acquiring the delivery authority fence!
    validated_mimes: list[str] = []
    for att_url, filename, declared_mime in pending_remote_attachments:
        validated_mimes.append(
            _fetch_pinned_attachment(
                organisation_id=org_id,
                url=att_url,
                filename=filename,
                declared_mime=declared_mime,
            )
        )

    matrix_txn_id = (
        "kodera-coex-"
        + hashlib.sha256(f"{bridge_id}:{external_event_id}".encode()).hexdigest()[:32]
    )
    attribution = inert_author_attribution(initial_bridge.source, author_id, author_name)
    formatted_body = f"{attribution}\n\n{cleaned_text}"
    sanitized_doc = {"body": formatted_body, "validated_mimes": validated_mimes}

    # 3A. API container path (`ADR-0003`: `matrix_transport is None`): verify authority + non-confidential
    # + unfailed Matrix room projection under canonical lock and durably queue for the operator worker.
    if matrix_transport is None:
        with transaction.atomic():
            _, locked_bridge, locked_channel, _ = _lock_and_verify_bridge_authority(
                bridge_id=bridge_id
            )
            if locked_channel.room_state == "failed":
                raise ExtensionRefusedError("coexistence_matrix_room_unavailable", 503)
            now = timezone.now()
            if (
                CoexistenceReplayGuard.objects.filter(
                    bridge=locked_bridge,
                    direction="outbound",
                    expires_at__gt=now,
                    event_sha256__in=(echo_digest, raw_digest),
                )
                .exclude(state="obsolete")
                .exists()
            ):
                raise ExtensionRefusedError("coexistence_echo_loop_refused", 409)
            existing_q = (
                CoexistenceReplayGuard.objects.select_for_update()
                .filter(bridge=locked_bridge, external_event_id=external_event_id)
                .first()
            )
            if existing_q is not None:
                if existing_q.state != "retryable_failed":
                    raise ExtensionRefusedError("coexistence_event_replayed", 409)
                existing_q.state = "queued"
                existing_q.lease_id = None
                existing_q.lease_expires_at = None
                existing_q.matrix_txn_id = matrix_txn_id
                existing_q.sanitized_payload = sanitized_doc
                existing_q.save(
                    update_fields=[
                        "state",
                        "lease_id",
                        "lease_expires_at",
                        "matrix_txn_id",
                        "sanitized_payload",
                        "updated_at",
                    ]
                )
            else:
                try:
                    CoexistenceReplayGuard.objects.create(
                        bridge=locked_bridge,
                        external_event_id=external_event_id,
                        event_sha256=echo_digest,
                        direction="inbound",
                        state="queued",
                        matrix_txn_id=matrix_txn_id,
                        sanitized_payload=sanitized_doc,
                        expires_at=now + timedelta(days=REPLAY_TTL_DAYS),
                    )
                except IntegrityError:
                    raise ExtensionRefusedError("coexistence_event_replayed", 409) from None
        return {
            "accepted": True,
            "queued": True,
            "status": "queued",
            "bridgeId": str(bridge_id),
            "channelId": str(locked_channel.id),
            "externalEventId": external_event_id,
            "matrixTxnId": matrix_txn_id,
            "matrixEventId": None,
            "validatedAttachmentMimes": validated_mimes,
        }

    # 3B. Direct / worker Matrix transport path: resolve room_id BEFORE pre-send authority lock.
    resolved_room = room_id
    if resolved_room is None and hasattr(matrix_transport, "resolve_channel_room"):
        resolved_room = matrix_transport.resolve_channel_room(initial_bridge.channel_id)
    if not resolved_room:
        raise ExtensionRefusedError("coexistence_matrix_room_unavailable", 503)

    # Pre-send authority fence + lease claim immediately before idempotent Matrix PUT.
    with transaction.atomic():
        _, locked_bridge, locked_channel, _ = _lock_and_verify_bridge_authority(bridge_id=bridge_id)
        now = timezone.now()
        if (
            CoexistenceReplayGuard.objects.filter(
                bridge=locked_bridge,
                direction="outbound",
                expires_at__gt=now,
                event_sha256__in=(echo_digest, raw_digest),
            )
            .exclude(state="obsolete")
            .exists()
        ):
            raise ExtensionRefusedError("coexistence_echo_loop_refused", 409)
        guard, lease_id = _claim_coexistence_guard_locked(
            bridge=locked_bridge,
            external_event_id=external_event_id,
            event_sha256=echo_digest,
            direction="inbound",
            now=now,
            allow_queued_existing=True,
            matrix_txn_id=matrix_txn_id,
            sanitized_payload=sanitized_doc,
        )

    try:
        matrix_event_id = matrix_transport.send_message(
            room_id=resolved_room,
            txn_id=matrix_txn_id,
            content={"msgtype": "m.text", "body": formatted_body},
        )
    except ExtensionRefusedError:
        _release_guard_retryable(guard.id, lease_id)
        raise
    except Exception as exc:  # noqa: BLE001
        _release_guard_retryable(guard.id, lease_id)
        raise ExtensionRefusedError("import_matrix_unavailable", 503) from exc

    # Post-send authority fence on commit; compensating redact if revoked concurrently!
    try:
        with transaction.atomic():
            _, _, locked_channel, _ = _lock_and_verify_bridge_authority(bridge_id=bridge_id)
            locked_guard = (
                CoexistenceReplayGuard.objects.select_for_update()
                .filter(id=guard.id, lease_id=lease_id)
                .first()
            )
            if locked_guard is not None:
                locked_guard.state = "delivered"
                locked_guard.lease_id = None
                locked_guard.lease_expires_at = None
                locked_guard.matrix_event_id = matrix_event_id
                locked_guard.sanitized_payload = None
                locked_guard.save(
                    update_fields=[
                        "state",
                        "lease_id",
                        "lease_expires_at",
                        "matrix_event_id",
                        "sanitized_payload",
                        "updated_at",
                    ]
                )
    except ExtensionRefusedError as commit_err:
        if commit_err.status in {401, 403, 404, 410}:
            _mark_guard_obsolete(guard.id, lease_id)
            try_compensating_redact(
                matrix_transport,
                room_id=resolved_room,
                event_id=matrix_event_id,
                txn_id=f"{matrix_txn_id}-redact",
                reason="coexistence_authority_revoked",
            )
        else:
            _release_guard_retryable(guard.id, lease_id)
        raise

    return {
        "accepted": True,
        "queued": False,
        "status": "delivered",
        "bridgeId": str(bridge_id),
        "channelId": str(locked_channel.id),
        "externalEventId": external_event_id,
        "matrixTxnId": matrix_txn_id,
        "matrixEventId": matrix_event_id,
        "validatedAttachmentMimes": validated_mimes,
    }


def _is_agent_or_echo_sender(sender: str, msgtype: str, metadata: Mapping[str, Any] | None) -> bool:
    localpart = sender.split(":", 1)[0]
    return (
        localpart == "@kodera-agent"
        or sender == "@kodera-agent"
        or msgtype == "m.notice"
        or (metadata is not None and metadata.get("kodera_bridge_id") is not None)
    )


@transaction.atomic
def enqueue_outbound_coexistence(
    *,
    workspace_id: UUID,
    channel_id: UUID,
    matrix_event_id: str,
    sender: str,
    sender_display_name: str,
    text: str,
    msgtype: str = "m.text",
    metadata: Mapping[str, Any] | None = None,
) -> list[CoexistenceReplayGuard]:
    """Durably enqueue outbound coexistence deliveries for active non-confidential channel bridges."""
    if not isinstance(sender, str) or not sender:
        raise ExtensionRefusedError("coexistence_sender_invalid", 422)
    if _is_agent_or_echo_sender(sender, msgtype, metadata):
        return []
    channel = workspaces.channel_snapshot(channel_id=channel_id, workspace_id=workspace_id)
    if channel is None or channel.kind != "text" or channel.lifecycle != "active":
        return []
    if channel.is_confidential:
        return []
    event_id = identifier(
        matrix_event_id.lstrip("$") if matrix_event_id.startswith("$") else matrix_event_id
    )
    cleaned_text = clean(text)
    safe_sender_name = clean(sender_display_name, 200) or "Kodera Member"
    now = timezone.now()
    queued: list[CoexistenceReplayGuard] = []
    bridges = CoexistenceBridge.objects.filter(
        workspace_id=workspace_id,
        channel_id=channel_id,
        revoked_at__isnull=True,
    ).order_by("id")
    for bridge in bridges:
        try:
            require_channel_post(
                channel_id=channel.id,
                membership_id=bridge.creator_id,
                organisation_id=workspaces.workspace_organisation(workspace_id=workspace_id),
                confidential_reason="coexistence_confidential_channel_refused",
            )
        except ExtensionRefusedError:
            continue
        echo_digest = content_echo_sha256(bridge.id, cleaned_text)
        guard, created = CoexistenceReplayGuard.objects.get_or_create(
            bridge=bridge,
            external_event_id="out:" + event_id,
            defaults={
                "event_sha256": echo_digest,
                "direction": "outbound",
                "state": "queued",
                "matrix_event_id": matrix_event_id,
                "sanitized_payload": {
                    "sender": sender,
                    "sender_display_name": safe_sender_name,
                    "text": cleaned_text,
                    "matrix_event_id": matrix_event_id,
                },
                "expires_at": now + timedelta(days=REPLAY_TTL_DAYS),
            },
        )
        if created:
            queued.append(guard)
    return queued


def _mark_existing_outbound_retryable(bridge_id: UUID, external_event_id: str) -> None:
    now = timezone.now()
    with transaction.atomic():
        CoexistenceReplayGuard.objects.filter(
            Q(bridge_id=bridge_id, external_event_id=external_event_id),
            Q(state="queued") | Q(state="in_flight", lease_expires_at__lte=now),
        ).update(state="retryable_failed", lease_id=None, lease_expires_at=None)


def _send_pinned_request(
    destination: outbound.Target,
    resolved: list[tuple[Any, ...]],
    *,
    deadline: float,
    method: str,
    body: bytes,
    headers: dict[str, str],
) -> tuple[outbound.PinnedConnection, http.client.HTTPResponse]:
    """Transmit over pre-resolved pinned numeric sockaddrs with zero post-lock DNS lookup."""
    connection = outbound.PinnedConnection(destination, resolved, deadline)
    try:
        connection.request(
            method,
            destination.path,
            body=body,
            headers={
                "Host": destination.authority,
                "Connection": "close",
                "Accept-Encoding": "identity",
                **headers,
            },
        )
        return connection, connection.getresponse()
    except (outbound.PreSendFetchError, outbound.FetchError):
        connection.close()
        raise
    except TimeoutError:
        connection.close()
        if not connection.transmitted:
            raise outbound.PreSendFetchError("timeout") from None
        raise outbound.FetchError("timeout") from None
    except (OSError, ssl.SSLError, http.client.HTTPException):
        connection.close()
        if not connection.transmitted:
            raise outbound.PreSendFetchError() from None
        raise outbound.FetchError() from None
    except BaseException:
        connection.close()
        raise


def forward_outbound(
    *,
    bridge_id: UUID,
    matrix_event_id: str,
    sender: str,
    sender_display_name: str,
    text: str,
    msgtype: str = "m.text",
    metadata: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Forward a local non-confidential room message outbound with pinned-IP egress and retryable lease."""
    if not isinstance(sender, str) or not sender:
        raise ExtensionRefusedError("coexistence_sender_invalid", 422)
    if _is_agent_or_echo_sender(sender, msgtype, metadata):
        raise ExtensionRefusedError("coexistence_agent_event_refused", 409)

    event_id = identifier(
        matrix_event_id.lstrip("$") if matrix_event_id.startswith("$") else matrix_event_id
    )
    cleaned_text = clean(text)
    safe_sender_name = clean(sender_display_name, 200) or "Kodera Member"

    # 1. Read endpoint and pre-resolve pinned DNS addresses BEFORE acquiring the pre-send
    # authority lock so revocation during DNS aborts before any HTTP byte is transmitted.
    initial = CoexistenceBridge.objects.filter(id=bridge_id).first()
    if initial is None:
        raise ExtensionRefusedError("coexistence_bridge_absent", 404)
    if initial.revoked_at is not None or not bytes(initial.sealed_signing_secret):
        raise ExtensionRefusedError("coexistence_bridge_revoked", 403)
    initial_org_id: UUID = workspaces.workspace_organisation(workspace_id=initial.workspace_id)
    deadline = time.monotonic() + 5.0
    resolved_addrs: list[tuple[Any, ...]] | None = None
    try:
        destination = outbound.target(initial.outbound_endpoint, https_only=True)
        if (
            outbound.request is _DEFAULT_OUTBOUND_REQUEST
            or outbound.addresses is not _DEFAULT_OUTBOUND_ADDRESSES
        ):
            resolved_addrs = outbound.addresses(
                destination,
                deadline,
                pool="webhook",
                scope_key=str(initial_org_id),
            )
    except outbound.BlockedTargetError:
        _mark_existing_outbound_retryable(bridge_id, "out:" + event_id)
        raise ExtensionRefusedError("coexistence_outbound_endpoint_refused", 422) from None
    except outbound.FetchError:
        _mark_existing_outbound_retryable(bridge_id, "out:" + event_id)
        raise ExtensionRefusedError("coexistence_outbound_unavailable", 502) from None

    # 2. Re-acquire canonical authority + non-confidential lock & claim lease right before POST.
    with transaction.atomic():
        org_id, bridge, channel, secret = _lock_and_verify_bridge_authority(bridge_id=bridge_id)
        if bridge.outbound_endpoint != initial.outbound_endpoint:
            raise ExtensionRefusedError("coexistence_outbound_endpoint_refused", 422)
        now = timezone.now()
        echo_digest = content_echo_sha256(bridge.id, cleaned_text)
        guard, lease_id = _claim_coexistence_guard_locked(
            bridge=bridge,
            external_event_id="out:" + event_id,
            event_sha256=echo_digest,
            direction="outbound",
            now=now,
            allow_queued_existing=True,
            matrix_event_id=matrix_event_id,
            sanitized_payload={
                "sender": sender,
                "sender_display_name": safe_sender_name,
                "text": cleaned_text,
                "matrix_event_id": matrix_event_id,
            },
        )
        ext_ws = bridge.external_workspace_id
        ext_ch = bridge.external_channel_id
        source = bridge.source

    now_ts = int(time.time())
    body_bytes = canonical(
        {
            "schema": "kodera.coexistence.outbound.v1",
            "kodera_bridge_id": str(bridge_id),
            "organisation_id": str(org_id),
            "channel_id": str(channel.id),
            "source": source,
            "external_workspace_id": ext_ws,
            "external_channel_id": ext_ch,
            "event_id": matrix_event_id,
            "sender_display_name": safe_sender_name,
            "text": cleaned_text,
        }
    )
    sig = sign_v1(secret, now_ts, body_bytes)
    req_headers = {
        "Content-Type": "application/json",
        "X-Kodera-Coexistence-Timestamp": str(now_ts),
        "X-Kodera-Coexistence-Signature": sig,
        "X-Kodera-Bridge-Origin": str(bridge_id),
        "Idempotency-Key": f"kodera-coex-out-{bridge_id}-{event_id}",
    }
    conn: Any = None
    resp: Any = None
    try:
        if outbound.request is _DEFAULT_OUTBOUND_REQUEST and resolved_addrs is not None:
            conn, resp = _send_pinned_request(
                destination,
                resolved_addrs,
                deadline=deadline,
                method="POST",
                body=body_bytes,
                headers=req_headers,
            )
        else:
            conn, resp = outbound.request(
                destination,
                method="POST",
                body=body_bytes,
                headers=req_headers,
                pool="webhook",
                scope_key=str(org_id),
                deadline=deadline,
            )
        _ = resp.read(32768)
        status = resp.status
    except outbound.BlockedTargetError:
        _release_guard_retryable(guard.id, lease_id)
        raise ExtensionRefusedError("coexistence_outbound_endpoint_refused", 422) from None
    except (outbound.FetchError, TimeoutError, OSError, ssl.SSLError, http.client.HTTPException):
        _release_guard_retryable(guard.id, lease_id)
        raise ExtensionRefusedError("coexistence_outbound_unavailable", 502) from None
    finally:
        if resp is not None:
            with suppress(OSError):
                resp.close()
        if conn is not None:
            with suppress(OSError):
                conn.close()
    if status not in {200, 201, 202, 204}:
        _release_guard_retryable(guard.id, lease_id)
        raise ExtensionRefusedError("coexistence_outbound_refused", 502)

    try:
        with transaction.atomic():
            _lock_and_verify_bridge_authority(bridge_id=bridge_id)
            locked_guard = (
                CoexistenceReplayGuard.objects.select_for_update()
                .filter(id=guard.id, lease_id=lease_id)
                .first()
            )
            if locked_guard is not None:
                locked_guard.state = "delivered"
                locked_guard.lease_id = None
                locked_guard.lease_expires_at = None
                locked_guard.sanitized_payload = None
                locked_guard.save(
                    update_fields=[
                        "state",
                        "lease_id",
                        "lease_expires_at",
                        "sanitized_payload",
                        "updated_at",
                    ]
                )
    except ExtensionRefusedError as post_err:
        if post_err.status in {401, 403, 404, 410}:
            _mark_guard_obsolete(guard.id, lease_id)
        else:
            _release_guard_retryable(guard.id, lease_id)
        raise

    return {
        "delivered": True,
        "bridgeId": str(bridge_id),
        "status": status,
    }


def drain_coexistence_inbound(
    *,
    matrix_transport: MatrixReplayTransport,
    organisation_id: UUID | None = None,
    room_map: Mapping[UUID, str] | None = None,
    limit: int = 25,
) -> dict[str, int]:
    """Drain queued/retryable inbound coexistence events into Synapse rooms."""
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ExtensionRefusedError("coexistence_batch_limit")
    now = timezone.now()
    qs = (
        CoexistenceReplayGuard.objects.select_related("bridge")
        .filter(
            Q(direction="inbound", expires_at__gt=now),
            Q(state__in=("queued", "retryable_failed"))
            | Q(state="in_flight", lease_expires_at__lte=now),
        )
        .order_by("created_at", "id")
    )
    if organisation_id is not None:
        qs = qs.filter(bridge__workspace__organisation_id=organisation_id)
    candidates = list(qs[:limit])
    resolved_rooms: dict[UUID, str] = dict(room_map) if room_map is not None else {}

    delivered = 0
    retryable = 0
    obsoleted = 0

    for row in candidates:
        ch_id = row.bridge.channel_id
        resolved_room = resolved_rooms.get(ch_id)
        if resolved_room is None and hasattr(matrix_transport, "resolve_channel_room"):
            resolved_room = matrix_transport.resolve_channel_room(ch_id)
            if resolved_room is not None:
                resolved_rooms[ch_id] = resolved_room
        if not resolved_room:
            CoexistenceReplayGuard.objects.filter(
                Q(id=row.id),
                Q(state="queued") | Q(state="in_flight", lease_expires_at__lte=now),
            ).update(state="retryable_failed", lease_id=None, lease_expires_at=None)
            retryable += 1
            continue

        try:
            with transaction.atomic():
                _, locked_bridge, _, _ = _lock_and_verify_bridge_authority(bridge_id=row.bridge_id)
                claim_now = timezone.now()
                guard, lease_id = _claim_coexistence_guard_locked(
                    bridge=locked_bridge,
                    external_event_id=row.external_event_id,
                    event_sha256=row.event_sha256,
                    direction="inbound",
                    now=claim_now,
                    allow_queued_existing=True,
                )
                payload_doc = (
                    guard.sanitized_payload if isinstance(guard.sanitized_payload, dict) else {}
                )
                body_text = str(payload_doc.get("body", ""))
                txn_id = guard.matrix_txn_id or (
                    "kodera-coex-"
                    + hashlib.sha256(
                        f"{row.bridge_id}:{row.external_event_id}".encode()
                    ).hexdigest()[:32]
                )
        except ExtensionRefusedError as pre_err:
            if (
                pre_err.status in {401, 403, 404, 410}
                or pre_err.reason == "coexistence_delivery_attempts_exhausted"
            ):
                _mark_guard_obsolete(row.id)
                obsoleted += 1
            continue

        try:
            sent_event_id = matrix_transport.send_message(
                room_id=resolved_room,
                txn_id=txn_id,
                content={"msgtype": "m.text", "body": body_text},
            )
        except Exception:  # noqa: BLE001
            _release_guard_retryable(guard.id, lease_id)
            retryable += 1
            continue

        try:
            with transaction.atomic():
                _lock_and_verify_bridge_authority(bridge_id=row.bridge_id)
                locked_guard = (
                    CoexistenceReplayGuard.objects.select_for_update()
                    .filter(id=guard.id, lease_id=lease_id)
                    .first()
                )
                if locked_guard is not None:
                    locked_guard.state = "delivered"
                    locked_guard.lease_id = None
                    locked_guard.lease_expires_at = None
                    locked_guard.matrix_event_id = sent_event_id
                    locked_guard.sanitized_payload = None
                    locked_guard.save(
                        update_fields=[
                            "state",
                            "lease_id",
                            "lease_expires_at",
                            "matrix_event_id",
                            "sanitized_payload",
                            "updated_at",
                        ]
                    )
                    delivered += 1
        except ExtensionRefusedError as post_err:
            if post_err.status in {401, 403, 404, 410}:
                _mark_guard_obsolete(guard.id, lease_id)
                try_compensating_redact(
                    matrix_transport,
                    room_id=resolved_room,
                    event_id=sent_event_id,
                    txn_id=f"{txn_id}-redact",
                    reason="coexistence_authority_revoked",
                )
                obsoleted += 1
            else:
                _release_guard_retryable(guard.id, lease_id)
                retryable += 1

    return {"delivered": delivered, "retryable": retryable, "obsoleted": obsoleted}


def drain_coexistence_outbound(
    *,
    organisation_id: UUID | None = None,
    limit: int = 25,
) -> dict[str, int]:
    """Drain queued/retryable outbound coexistence deliveries over IP-pinned HTTPS webhooks."""
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ExtensionRefusedError("coexistence_batch_limit")
    now = timezone.now()
    qs = CoexistenceReplayGuard.objects.filter(
        Q(direction="outbound", expires_at__gt=now),
        Q(state__in=("queued", "retryable_failed"))
        | Q(state="in_flight", lease_expires_at__lte=now),
    ).order_by("created_at", "id")
    if organisation_id is not None:
        qs = qs.filter(bridge__workspace__organisation_id=organisation_id)
    candidates = list(qs[:limit])

    delivered = 0
    retryable = 0
    obsoleted = 0

    for row in candidates:
        payload_doc = row.sanitized_payload if isinstance(row.sanitized_payload, dict) else None
        if payload_doc is None:
            _mark_guard_obsolete(row.id)
            obsoleted += 1
            continue
        try:
            forward_outbound(
                bridge_id=row.bridge_id,
                matrix_event_id=str(
                    payload_doc.get("matrix_event_id")
                    or row.matrix_event_id
                    or row.external_event_id.removeprefix("out:")
                ),
                sender=str(payload_doc.get("sender") or "@member:kodera.local"),
                sender_display_name=str(payload_doc.get("sender_display_name") or "Kodera Member"),
                text=str(payload_doc.get("text") or ""),
            )
            delivered += 1
        except ExtensionRefusedError as err:
            if err.status in {401, 403, 404, 410} or err.reason in {
                "coexistence_agent_event_refused",
                "coexistence_delivery_attempts_exhausted",
            }:
                _mark_guard_obsolete(row.id)
                obsoleted += 1
            else:
                retryable += 1

    return {"delivered": delivered, "retryable": retryable, "obsoleted": obsoleted}
