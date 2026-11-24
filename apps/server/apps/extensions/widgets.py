"""Sandboxed `kodera.widget.v1` validation and pinned-IP SSRF action dispatch."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import math
import re
import time
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from apps.e2ee.selectors import channel_has_e2ee_room
from apps.media import outbound
from apps.orgs.selectors import organisation_authority_revision
from apps.workspaces import selectors as workspaces
from apps.workspaces.channel_access import permits_channel_post
from core import sealing

from . import services
from .models import Installation, MarketplaceEntitlement, WidgetActionReceipt
from .wire import ExtensionRefusedError, canonical, event_payload, signed_delivery

WIDGET_SCHEMA_VERSION = "kodera.widget.v1"
MAX_WIDGET_CARD_BYTES = 16 * 1024
MAX_WIDGET_AST_DEPTH = 4
MAX_WIDGET_BLOCKS = 20
MAX_WIDGET_KV_ITEMS = 12
MAX_WIDGET_ACTIONS = 5
MAX_ACTION_PAYLOAD_BYTES = 4 * 1024
MAX_WIDGET_RESPONSE_WIRE = 32 * 1024
WIDGET_DISPATCH_TIMEOUT_SECONDS = 5.0

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]\Z")
ACTION_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}\Z")
IDEMPOTENCY_KEY_RE = re.compile(r"^[\x21-\x7e]{1,128}\Z")
FORBIDDEN_OBJECT_KEYS = frozenset({"__proto__", "constructor", "prototype"})
ALLOWED_TEXT_TONES = frozenset({"default", "muted", "mono"})
ALLOWED_STATUS_STATES = frozenset({"success", "info", "warning", "danger", "neutral", "planned"})
ALLOWED_PROGRESS_TONES = frozenset({"default", "warning", "danger", "success"})
ALLOWED_BUTTON_VARIANTS = frozenset({"primary", "secondary", "tertiary", "destructive"})
ALLOWED_LINK_VARIANTS = frozenset({"secondary", "tertiary"})
ALLOWED_BLOCK_TYPES = frozenset(
    {
        "header",
        "text",
        "kv_list",
        "status_pill",
        "progress_bar",
        "button_row",
        "link_button",
    }
)

MARKETPLACE_SEAL_AAD_PREFIX = b"kodera-marketplace-install-v1:"


def marketplace_install_aad(organisation_id: UUID, installation_id: UUID) -> bytes:
    return MARKETPLACE_SEAL_AAD_PREFIX + organisation_id.bytes + installation_id.bytes


def marketplace_seal_key() -> bytes:
    key = getattr(settings, "KODERA_CONTACT_SEAL_KEY", None)
    if not isinstance(key, bytes) or len(key) != sealing.KEY_BYTES:
        raise ExtensionRefusedError("extension_signing_key_unavailable", 503)
    return key


def _assert_widget_text(value: Any, *, max_len: int, reason: str) -> str:
    if not isinstance(value, str):
        raise ExtensionRefusedError(reason, 422)
    if any(
        (0 <= ord(ch) <= 8) or ord(ch) in {11, 12, 127} or (14 <= ord(ch) <= 31) for ch in value
    ):
        raise ExtensionRefusedError(reason, 422)
    trimmed = value.strip()
    if not (1 <= len(trimmed) <= max_len):
        raise ExtensionRefusedError(reason, 422)
    return trimmed


def _assert_safe_tree(node: Any, depth: int = 0) -> None:
    if node is None or isinstance(node, (str, bool)):
        return
    if isinstance(node, (int, float)):
        if not math.isfinite(node):
            raise ExtensionRefusedError("widget_number_invalid", 422)
        return
    if depth > MAX_WIDGET_AST_DEPTH:
        raise ExtensionRefusedError("widget_ast_depth_exceeded", 422)
    if isinstance(node, list):
        for item in node:
            _assert_safe_tree(item, depth + 1)
        return
    if isinstance(node, dict):
        for key, val in node.items():
            if not isinstance(key, str) or key in FORBIDDEN_OBJECT_KEYS:
                raise ExtensionRefusedError("widget_forbidden_key", 422)
            _assert_safe_tree(val, depth + 1)
        return
    raise ExtensionRefusedError("widget_value_invalid", 422)


def _validate_public_https_link(href: Any) -> str:
    if not isinstance(href, str) or not href.strip():
        raise ExtensionRefusedError("widget_link_href_invalid", 422)
    try:
        parsed = outbound.target(href.strip(), https_only=True)
    except outbound.BlockedTargetError:
        raise ExtensionRefusedError("widget_link_href_blocked", 422) from None
    host = parsed.host
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise ExtensionRefusedError("widget_link_href_blocked", 422)
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        try:
            outbound.public_address(host)
        except outbound.BlockedTargetError:
            raise ExtensionRefusedError("widget_link_href_blocked", 422) from None
    return parsed.url


def _validate_block(raw_block: Any) -> dict[str, Any]:
    if not isinstance(raw_block, dict):
        raise ExtensionRefusedError("widget_block_invalid", 422)
    block_type = raw_block.get("type")
    if not isinstance(block_type, str) or block_type not in ALLOWED_BLOCK_TYPES:
        raise ExtensionRefusedError("widget_block_type_invalid", 422)

    if block_type == "header":
        if set(raw_block) - {"type", "title", "subtitle"} or "title" not in raw_block:
            raise ExtensionRefusedError("widget_header_invalid", 422)
        out: dict[str, Any] = {
            "type": "header",
            "title": _assert_widget_text(
                raw_block["title"], max_len=160, reason="widget_header_invalid"
            ),
        }
        if raw_block.get("subtitle") is not None:
            out["subtitle"] = _assert_widget_text(
                raw_block["subtitle"], max_len=240, reason="widget_header_invalid"
            )
        return out

    if block_type == "text":
        if set(raw_block) - {"type", "body", "tone"} or "body" not in raw_block:
            raise ExtensionRefusedError("widget_text_invalid", 422)
        body = _assert_widget_text(raw_block["body"], max_len=2000, reason="widget_text_invalid")
        tone = raw_block.get("tone", "default")
        if not isinstance(tone, str) or tone not in ALLOWED_TEXT_TONES:
            raise ExtensionRefusedError("widget_text_invalid", 422)
        return {"type": "text", "body": body, "tone": tone}

    if block_type == "kv_list":
        items = raw_block.get("items")
        if (
            set(raw_block) != {"type", "items"}
            or not isinstance(items, list)
            or not (1 <= len(items) <= MAX_WIDGET_KV_ITEMS)
        ):
            raise ExtensionRefusedError("widget_kv_list_invalid", 422)
        normalized_items: list[dict[str, Any]] = []
        for entry in items:
            if not isinstance(entry, dict) or set(entry) - {"label", "value", "mono"}:
                raise ExtensionRefusedError("widget_kv_list_invalid", 422)
            item_out: dict[str, Any] = {
                "label": _assert_widget_text(
                    entry.get("label"), max_len=80, reason="widget_kv_list_invalid"
                ),
                "value": _assert_widget_text(
                    entry.get("value"), max_len=240, reason="widget_kv_list_invalid"
                ),
            }
            if "mono" in entry and entry["mono"] is not None:
                if type(entry["mono"]) is not bool:
                    raise ExtensionRefusedError("widget_kv_list_invalid", 422)
                item_out["mono"] = entry["mono"]
            normalized_items.append(item_out)
        return {"type": "kv_list", "items": normalized_items}

    if block_type == "status_pill":
        if set(raw_block) != {"type", "label", "state"}:
            raise ExtensionRefusedError("widget_status_pill_invalid", 422)
        label = _assert_widget_text(
            raw_block.get("label"), max_len=80, reason="widget_status_pill_invalid"
        )
        state = raw_block.get("state")
        if not isinstance(state, str) or state not in ALLOWED_STATUS_STATES:
            raise ExtensionRefusedError("widget_status_pill_invalid", 422)
        return {"type": "status_pill", "label": label, "state": state}

    if block_type == "progress_bar":
        if set(raw_block) - {"type", "label", "value", "valueText", "tone"}:
            raise ExtensionRefusedError("widget_progress_bar_invalid", 422)
        label = _assert_widget_text(
            raw_block.get("label"), max_len=120, reason="widget_progress_bar_invalid"
        )
        val = raw_block.get("value")
        if (
            not isinstance(val, (int, float))
            or isinstance(val, bool)
            or not math.isfinite(val)
            or not (0 <= float(val) <= 100)
        ):
            raise ExtensionRefusedError("widget_progress_bar_invalid", 422)
        tone = raw_block.get("tone", "default")
        if not isinstance(tone, str) or tone not in ALLOWED_PROGRESS_TONES:
            raise ExtensionRefusedError("widget_progress_bar_invalid", 422)
        prog_out: dict[str, Any] = {
            "type": "progress_bar",
            "label": label,
            "value": 0 if val == 0 else (round(float(val), 2) if isinstance(val, float) else val),
            "tone": tone,
        }
        if raw_block.get("valueText") is not None:
            prog_out["valueText"] = _assert_widget_text(
                raw_block["valueText"], max_len=40, reason="widget_progress_bar_invalid"
            )
        return prog_out

    if block_type == "button_row":
        actions = raw_block.get("actions")
        if (
            set(raw_block) != {"type", "actions"}
            or not isinstance(actions, list)
            or not (1 <= len(actions) <= MAX_WIDGET_ACTIONS)
        ):
            raise ExtensionRefusedError("widget_button_row_invalid", 422)
        seen_ids: set[str] = set()
        normalized_actions: list[dict[str, Any]] = []
        for action in actions:
            if not isinstance(action, dict) or set(action) - {
                "actionId",
                "label",
                "variant",
                "value",
            }:
                raise ExtensionRefusedError("widget_button_row_invalid", 422)
            act_id = action.get("actionId")
            variant = action.get("variant", "secondary")
            if (
                not isinstance(act_id, str)
                or not ACTION_ID_RE.fullmatch(act_id)
                or act_id in seen_ids
                or not isinstance(variant, str)
                or variant not in ALLOWED_BUTTON_VARIANTS
            ):
                raise ExtensionRefusedError("widget_button_row_invalid", 422)
            seen_ids.add(act_id)
            act_out: dict[str, Any] = {
                "actionId": act_id,
                "label": _assert_widget_text(
                    action.get("label"), max_len=64, reason="widget_button_row_invalid"
                ),
                "variant": variant,
            }
            if action.get("value") is not None:
                raw_val = action["value"]
                if (
                    not isinstance(raw_val, str)
                    or len(raw_val) > 256
                    or any(ord(ch) < 32 or ord(ch) == 127 for ch in raw_val)
                ):
                    raise ExtensionRefusedError("widget_button_row_invalid", 422)
                act_out["value"] = raw_val
            normalized_actions.append(act_out)
        return {"type": "button_row", "actions": normalized_actions}

    # link_button
    if set(raw_block) - {"type", "label", "href", "variant"}:
        raise ExtensionRefusedError("widget_link_button_invalid", 422)
    label = _assert_widget_text(
        raw_block.get("label"), max_len=80, reason="widget_link_button_invalid"
    )
    href = _validate_public_https_link(raw_block.get("href"))
    variant = raw_block.get("variant", "secondary")
    if not isinstance(variant, str) or variant not in ALLOWED_LINK_VARIANTS:
        raise ExtensionRefusedError("widget_link_button_invalid", 422)
    return {"type": "link_button", "label": label, "href": href, "variant": variant}


def validate_widget_card(raw_card: Any) -> dict[str, Any]:
    """Validate and canonicalize a declarative `kodera.widget.v1` card (matching `@kodera/extension-sdk`)."""
    if not isinstance(raw_card, dict):
        raise ExtensionRefusedError("widget_card_invalid", 422)
    _assert_safe_tree(raw_card, 0)

    raw_bytes = json.dumps(raw_card, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(raw_bytes) > MAX_WIDGET_CARD_BYTES:
        raise ExtensionRefusedError("widget_card_too_large", 413)

    if set(raw_card) - {"schemaVersion", "widgetId", "title", "blocks"}:
        raise ExtensionRefusedError("widget_card_invalid", 422)
    if raw_card.get("schemaVersion") != WIDGET_SCHEMA_VERSION:
        raise ExtensionRefusedError("widget_schema_invalid", 422)
    widget_id = raw_card.get("widgetId")
    if not isinstance(widget_id, str) or not SLUG_RE.fullmatch(widget_id) or "--" in widget_id:
        raise ExtensionRefusedError("widget_id_invalid", 422)
    blocks = raw_card.get("blocks")
    if not isinstance(blocks, list) or not (1 <= len(blocks) <= MAX_WIDGET_BLOCKS):
        raise ExtensionRefusedError("widget_blocks_invalid", 422)

    normalized: dict[str, Any] = {
        "schemaVersion": WIDGET_SCHEMA_VERSION,
        "widgetId": widget_id,
    }
    if raw_card.get("title") is not None:
        normalized["title"] = _assert_widget_text(
            raw_card["title"], max_len=120, reason="widget_title_invalid"
        )
    normalized["blocks"] = [_validate_block(block) for block in blocks]

    serialized = json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(serialized) > MAX_WIDGET_CARD_BYTES:
        raise ExtensionRefusedError("widget_card_too_large", 413)
    return normalized


def _normalize_action_payload(payload: dict[str, Any] | None) -> dict[str, Any]:
    if payload is None:
        return {}
    if not isinstance(payload, dict):
        raise ExtensionRefusedError("widget_action_payload_invalid", 422)
    _assert_safe_tree(payload, 1)
    encoded = canonical(payload)
    if len(encoded) > MAX_ACTION_PAYLOAD_BYTES:
        raise ExtensionRefusedError("widget_action_payload_bound", 413)
    return payload


def _resolve_installation_secret(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    installation: Installation,
    secrets: Any | None = None,
) -> str:
    entitlement = MarketplaceEntitlement.objects.filter(
        workspace_id=workspace_id,
        installation=installation,
        state="active",
        revoked_at__isnull=True,
    ).first()
    if entitlement is not None and bytes(entitlement.sealed_signing_secret):
        try:
            unsealed = sealing.unseal(
                marketplace_seal_key(),
                marketplace_install_aad(organisation_id, installation.id),
                bytes(entitlement.sealed_signing_secret),
            )
            return unsealed.decode("ascii")
        except (ValueError, UnicodeDecodeError):
            raise ExtensionRefusedError("extension_signing_key_unavailable", 503) from None

    provider = secrets
    if provider is None:
        factory = getattr(settings, "KODERA_EXTENSION_SECRET_PROVIDER_FACTORY", None)
        if callable(factory):
            provider = factory()
    if provider is not None and hasattr(provider, "get"):
        return str(
            provider.get(installation_id=installation.id, generation=installation.generation)
        )
    raise ExtensionRefusedError("extension_signing_key_unavailable", 503)


def _serialize_receipt(receipt: WidgetActionReceipt, *, replayed: bool) -> dict[str, Any]:
    return {
        "receiptId": str(receipt.id),
        "installationId": str(receipt.installation_id),
        "channelId": str(receipt.channel_id),
        "widgetId": receipt.widget_id,
        "actionId": receipt.action_id,
        "state": receipt.state,
        "responseStatus": receipt.response_status,
        "card": receipt.response_card,
        "replayed": replayed,
    }


def dispatch_widget_action(
    *,
    verified: Any,
    organisation_id: UUID,
    channel_id: UUID,
    widget_id: str,
    installation_id: UUID,
    action_id: str,
    idempotency_key: str,
    payload: dict[str, Any] | None = None,
    secrets: Any | None = None,
) -> dict[str, Any]:
    """Verify membership, channel policy & non-confidentiality, then dispatch `widget.action` outside `transaction.atomic()`."""
    if connection.in_atomic_block:
        raise RuntimeError("dispatch_widget_action must execute outside transaction.atomic()")

    if not isinstance(widget_id, str) or not SLUG_RE.fullmatch(widget_id) or "--" in widget_id:
        raise ExtensionRefusedError("widget_id_invalid", 422)
    if not isinstance(action_id, str) or not ACTION_ID_RE.fullmatch(action_id):
        raise ExtensionRefusedError("widget_action_id_invalid", 422)
    if not isinstance(idempotency_key, str) or not IDEMPOTENCY_KEY_RE.fullmatch(idempotency_key):
        raise ExtensionRefusedError("idempotency_key_invalid", 400)
    normalized_payload = _normalize_action_payload(payload)

    request_digest = hashlib.sha256(
        canonical(
            {
                "installation_id": str(installation_id),
                "channel_id": str(channel_id),
                "widget_id": widget_id,
                "action_id": action_id,
                "payload": normalized_payload,
            }
        )
    ).hexdigest()

    # Stage 1: Authorize caller, verify non-confidential/non-E2EE channel & post permission,
    # claim idempotency receipt, and build the HMAC-signed `kodera.extension.delivery.v2` envelope.
    with transaction.atomic():
        workspace_id, principal = services.member(verified, organisation_id)
        snap = workspaces.channel_snapshot(
            workspace_id=workspace_id, channel_id=channel_id, for_update=False
        )
        if snap is None or snap.kind != "text" or snap.lifecycle != "active":
            raise ExtensionRefusedError("widget_channel_absent", 404)
        if snap.is_confidential or channel_has_e2ee_room(
            channel_id=channel_id, organisation_id=organisation_id
        ):
            raise ExtensionRefusedError("widget_confidential_channel_refused", 403)
        if not permits_channel_post(
            channel_id=channel_id,
            membership_id=principal.membership_id,
            organisation_id=organisation_id,
            member_org_role=principal.role,
            authority_revision=organisation_authority_revision(organisation_id=organisation_id),
        ):
            raise ExtensionRefusedError("extension_channel_access_refused", 403)

        installation = Installation.objects.filter(
            id=installation_id,
            workspace_id=workspace_id,
            revoked_at__isnull=True,
        ).first()
        if installation is None:
            raise ExtensionRefusedError("extension_installation_absent", 404)
        if "widget.action" not in installation.events:
            raise ExtensionRefusedError("extension_event_not_granted", 403)

        existing = (
            WidgetActionReceipt.objects.select_for_update()
            .filter(
                workspace_id=workspace_id,
                channel_id=channel_id,
                widget_id=widget_id,
                idempotency_key=idempotency_key,
            )
            .first()
        )
        if existing is not None:
            if existing.request_sha256 != request_digest:
                raise ExtensionRefusedError("idempotency_key_reused", 409)
            if existing.state == "in_flight":
                raise ExtensionRefusedError("idempotency_key_in_flight", 409)
            if existing.state == "delivered":
                return _serialize_receipt(existing, replayed=True)
            raise ExtensionRefusedError("widget_action_previously_failed", 502)

        try:
            receipt = WidgetActionReceipt.objects.create(
                organisation_id=organisation_id,
                workspace_id=workspace_id,
                channel_id=channel_id,
                installation=installation,
                actor_membership_id=principal.membership_id,
                widget_id=widget_id,
                action_id=action_id,
                idempotency_key=idempotency_key,
                request_sha256=request_digest,
                state="in_flight",
            )
        except IntegrityError:
            raise ExtensionRefusedError("idempotency_key_in_flight", 409) from None

        signing_secret = _resolve_installation_secret(
            organisation_id=organisation_id,
            workspace_id=workspace_id,
            installation=installation,
            secrets=secrets,
        )
        now = timezone.now()
        event_bytes = event_payload(
            "widget.action",
            {
                "workspace_id": str(workspace_id),
                "channel_id": str(channel_id),
                "actor_membership_id": str(principal.membership_id),
                "widget_id": widget_id,
                "action_id": action_id,
                "payload": normalized_payload,
            },
        )
        signed = signed_delivery(
            organisation_id=organisation_id,
            installation_id=installation.id,
            delivery_id=receipt.id,
            generation=installation.generation,
            event=event_bytes,
            secret=signing_secret,
            now=now,
        )
        endpoint_url = installation.endpoint
        receipt_id = receipt.id

    # Stage 2: Execute pinned-IP HTTPS webhook request strictly outside any DB transaction.
    response_status: int | None = None
    response_card: dict[str, Any] | None = None
    final_state = "failed"
    refusal_error: ExtensionRefusedError | None = None

    try:
        destination = outbound.target(endpoint_url, https_only=True)
        conn, http_resp = outbound.request(
            destination,
            deadline=time.monotonic() + WIDGET_DISPATCH_TIMEOUT_SECONDS,
            method="POST",
            body=signed.body,
            headers=signed.headers,
            pool="webhook",
            scope_key=str(organisation_id),
            max_wire=MAX_WIDGET_RESPONSE_WIRE,
        )
        try:
            response_status = int(http_resp.status)
            if 300 <= response_status < 400:
                final_state = "refused"
                refusal_error = ExtensionRefusedError("widget_redirect_refused", 502)
            elif 200 <= response_status < 300:
                raw_resp = http_resp.read(MAX_WIDGET_RESPONSE_WIRE + 1)
                if len(raw_resp) > MAX_WIDGET_RESPONSE_WIRE:
                    final_state = "refused"
                    refusal_error = ExtensionRefusedError("widget_response_too_large", 502)
                elif raw_resp.strip():
                    content_type = (http_resp.getheader("Content-Type") or "").lower()
                    if "application/json" in content_type:
                        try:
                            decoded = json.loads(raw_resp.decode("utf-8"))
                        except (UnicodeDecodeError, ValueError, RecursionError):
                            final_state = "refused"
                            refusal_error = ExtensionRefusedError(
                                "widget_response_json_invalid", 502
                            )
                        else:
                            candidate_card = None
                            if isinstance(decoded, dict):
                                if decoded.get("schemaVersion") == WIDGET_SCHEMA_VERSION:
                                    candidate_card = decoded
                                elif "card" in decoded and decoded["card"] is not None:
                                    candidate_card = decoded["card"]
                            if candidate_card is not None:
                                try:
                                    response_card = validate_widget_card(candidate_card)
                                except ExtensionRefusedError:
                                    final_state = "refused"
                                    refusal_error = ExtensionRefusedError(
                                        "widget_response_card_invalid", 502
                                    )
                            if refusal_error is None:
                                final_state = "delivered"
                    else:
                        final_state = "delivered"
                else:
                    final_state = "delivered"
            else:
                final_state = "refused"
                refusal_error = ExtensionRefusedError("widget_endpoint_refused", 502)
        finally:
            conn.close()
    except outbound.BlockedTargetError:
        final_state = "refused"
        refusal_error = ExtensionRefusedError("widget_endpoint_blocked", 422)
    except outbound.FetchError:
        final_state = "failed"
        refusal_error = ExtensionRefusedError("widget_endpoint_unavailable", 502)

    # Stage 3: Persist outcome and audit evidence.
    with transaction.atomic():
        receipt = WidgetActionReceipt.objects.select_for_update().get(id=receipt_id)
        receipt.state = final_state
        receipt.response_status = response_status
        receipt.response_card = response_card
        receipt.save(update_fields=["state", "response_status", "response_card", "updated_at"])
        services.audit(
            "widget_action_dispatched",
            principal,
            organisation_id,
            installation_id,
            {
                "channel_id": str(channel_id),
                "widget_id": widget_id,
                "action_id": action_id,
                "state": final_state,
            },
        )

    if refusal_error is not None:
        raise refusal_error
    return _serialize_receipt(receipt, replayed=False)
