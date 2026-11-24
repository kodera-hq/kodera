"""Workspace custom WebP emojis, Send Later scheduled messages, reminders, and Kodera Labs."""

from __future__ import annotations

import hashlib
import json
import re
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.audit.services import record_workspace_resource_event
from apps.e2ee.services import has_confidential_room
from apps.notifications import services as notification_services
from apps.orgs.actor_selectors import (
    TenantCaller,
    TenantCallerNotFoundError,
    TenantCallerUnknownError,
    read_tenant_caller,
)
from apps.orgs.selectors import lock_erasure_cutoff_fences
from apps.orgs.workspace_members import for_workspace
from services.identity.access_tokens import VerifiedAccessToken

from .channel_access import may_view, permits_channel_post, resolve
from .custom_emojis import (
    CustomEmojiValidationError,
    decode_base64_webp,
    sanitize_custom_emoji_webp,
    validate_shortcode,
    verify_custom_emoji_webp_clean,
)
from .models import (
    LABS_FLAG_KEYS,
    Channel,
    MemberWorkspacePreference,
    ScheduledMessage,
    Workspace,
    WorkspaceCustomEmoji,
)
from .moderation import ADMINS, RefusalError, member_restrictions
from .selectors import (
    is_designated_confidential_channel,
    lock_workspace,
    resolve_partner_channel_for_room,
    verify_channel_room_binding,
)
from .structure import WorkspaceUnavailableError

MAX_CUSTOM_EMOJIS_PER_WORKSPACE = 200
MAX_PENDING_SCHEDULED_PER_MEMBER = 100
MAX_ACTIVE_REMINDERS_PER_MEMBER = 200
MAX_MENTIONS_PER_SCHEDULED = 50
MAX_HORIZON_DAYS = 366
MIN_SCHEDULE_LEAD_SECONDS = 5
MIN_REMINDER_LEAD_SECONDS = 5

ROOM_ID_RE = re.compile(r"^![^\s\x00-\x1f]{1,254}\Z")
EVENT_ID_RE = re.compile(r"^\$[^\s\x00-\x1f]{1,254}\Z")

DEFAULT_LABS_FLAGS: dict[str, bool] = {
    "send_later": True,
    "custom_emojis": True,
    "personal_reminders": True,
    "waiting_room_ambience": True,
}


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def etag_for(body: Any) -> str:
    digest = hashlib.sha256(
        json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return f'"{digest}"'


def _verify_if_match(if_match: str | None, current_wire: dict[str, Any]) -> None:
    if if_match is None:
        raise RefusalError(428, "precondition-required")
    current_tag = etag_for(current_wire)
    if if_match != "*" and if_match != current_tag:
        raise RefusalError(412, "precondition-failed", current_etag=current_tag)


@transaction.atomic
def authorize_experience(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    admin: bool = False,
) -> None:
    _caller_context(verified, organisation_id, admin=admin, lock=False, require_active_org=True)


def _parse_uuid(value: Any) -> UUID:
    if isinstance(value, UUID):
        return value
    if not isinstance(value, str):
        raise RefusalError(422)
    try:
        return UUID(value)
    except ValueError:
        raise RefusalError(422) from None


def _parse_optional_uuid(value: Any) -> UUID | None:
    if value is None or value == "":
        return None
    return _parse_uuid(value)


def _parse_aware_datetime(value: Any) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise RefusalError(422)
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise RefusalError(422) from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise RefusalError(422)
    return parsed.astimezone(UTC)


def _audit(
    workspace: Workspace,
    actor_id: UUID,
    action: str,
    target: UUID,
    request_id: str,
    *,
    metadata: dict[str, object] | None = None,
) -> None:
    record_workspace_resource_event(
        action=action,
        actor_id=actor_id,
        organisation_id=workspace.organisation_id,
        target_id=target,
        request_id=request_id,
        metadata=metadata,
    )


def _caller_context(
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    *,
    admin: bool = False,
    lock: bool = False,
    require_active_org: bool = True,
) -> tuple[Workspace, TenantCaller]:
    if lock:
        initial_ws, _ = _caller_context(
            verified,
            organisation_id,
            admin=admin,
            lock=False,
            require_active_org=require_active_org,
        )
        lock_workspace(workspace_id=initial_ws.id)
        return _caller_context(
            verified,
            organisation_id,
            admin=admin,
            lock=False,
            require_active_org=require_active_org,
        )

    workspace = Workspace.objects.filter(organisation_id=organisation_id).order_by("id").first()
    if workspace is None:
        raise RefusalError(404)
    try:
        caller = read_tenant_caller(
            verified=verified, organisation_id=organisation_id, allow_community=True
        )
    except TenantCallerUnknownError:
        raise RefusalError(403, "identity-unknown") from None
    except TenantCallerNotFoundError:
        raise RefusalError(404) from None
    if require_active_org and caller.organisation_state != "active":
        raise RefusalError(403)
    denied, _ = member_restrictions(workspace.id, caller.membership_id)
    if denied:
        raise RefusalError(403)
    if admin and caller.role not in ADMINS:
        raise RefusalError(403)
    return workspace, caller


def _lock_caller_erasure_fences(organisation_id: UUID, membership_id: UUID) -> None:
    member = for_workspace(organisation_id=organisation_id, membership_id=membership_id, lock=False)
    if member is None:
        raise RefusalError(403)
    lock_erasure_cutoff_fences(organisation_id=organisation_id, user_id=member.user_id)
    if (
        for_workspace(organisation_id=organisation_id, membership_id=membership_id, lock=False)
        is None
    ):
        raise RefusalError(403)


def _assert_plaintext_target(
    *,
    workspace: Workspace,
    caller: TenantCaller,
    channel_id: UUID | None,
    room_id: str,
    require_post: bool,
    confidential_hint: bool = False,
    resolved_synapse_room_id: str | None = None,
) -> tuple[Channel, str]:
    if confidential_hint:
        raise RefusalError(403, "confidential_channel_refused")
    if channel_id is None and not room_id:
        raise RefusalError(422, "channel_binding_required")
    if room_id and not ROOM_ID_RE.fullmatch(room_id):
        raise RefusalError(422)

    if require_post:
        denied, muted = member_restrictions(workspace.id, caller.membership_id)
        if denied:
            raise RefusalError(403)
        if muted:
            raise RefusalError(403, "member_muted")

    resolved_channel_id = channel_id
    if resolved_channel_id is None:
        resolved_channel_id = resolve_partner_channel_for_room(
            workspace_id=workspace.id, room_id=room_id
        )
        if resolved_channel_id is None:
            raise RefusalError(422, "channel_binding_required")

    channel = (
        Channel.objects.filter(id=resolved_channel_id, workspace_id=workspace.id)
        .exclude(lifecycle__in=("deletion_pending", "deleted"))
        .first()
    )
    if channel is None:
        raise RefusalError(404)

    try:
        access = resolve(channel.id)
    except (Channel.DoesNotExist, WorkspaceUnavailableError):
        raise RefusalError(404) from None

    if not may_view(
        access,
        organisation_id=workspace.organisation_id,
        membership_id=caller.membership_id,
        authority_revision=caller.authority_revision,
    ):
        raise RefusalError(404)

    if (
        bool(channel.is_confidential)
        or is_designated_confidential_channel(workspace_id=workspace.id, channel_id=channel.id)
        or has_confidential_room(channel_id=channel.id, organisation_id=workspace.organisation_id)
    ):
        raise RefusalError(403, "confidential_channel_refused")

    if channel.kind != "text":
        raise RefusalError(422, "invalid_channel_kind")

    binding_ok, bound_room_id = verify_channel_room_binding(
        workspace_id=workspace.id,
        channel_id=channel.id,
        room_id=room_id,
        resolved_synapse_room_id=resolved_synapse_room_id,
    )
    if not binding_ok:
        raise RefusalError(422, "channel_room_mismatch")

    if require_post:
        if channel.lifecycle != "active":
            raise RefusalError(409, "channel_archived")
        if not permits_channel_post(
            channel_id=channel.id,
            membership_id=caller.membership_id,
            organisation_id=workspace.organisation_id,
            member_org_role=caller.role,
            authority_revision=caller.authority_revision,
        ):
            raise RefusalError(403)

    return channel, bound_room_id


# --------------------------------------------------------------------------- Custom Emojis ---


def _emoji_wire(row: WorkspaceCustomEmoji) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "shortcode": row.shortcode,
        "sha256": row.sha256,
        "width": row.width,
        "height": row.height,
        "animated": row.animated,
        "creatorMembershipId": str(row.creator_id),
        "createdAt": _iso(row.created_at),
        "blobPath": (f"/api/v1/organisations/{row.organisation_id}/workspace/emojis/{row.id}/blob"),
    }


@transaction.atomic
def list_emojis(*, verified: VerifiedAccessToken, organisation_id: UUID) -> dict[str, Any]:
    workspace, _ = _caller_context(
        verified, organisation_id, admin=False, lock=False, require_active_org=False
    )
    rows = WorkspaceCustomEmoji.objects.filter(
        organisation_id=organisation_id,
        workspace_id=workspace.id,
        revoked_at__isnull=True,
    ).order_by("shortcode", "id")
    return {"items": [_emoji_wire(row) for row in rows]}


@transaction.atomic
def create_emoji(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    data: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    raw_shortcode = data.get("shortcode")
    raw_b64 = data.get("webp_base64") if "webp_base64" in data else data.get("webpBase64")
    try:
        shortcode = validate_shortcode(raw_shortcode)
        raw_webp = decode_base64_webp(raw_b64)
        sanitized = sanitize_custom_emoji_webp(raw_webp)
    except CustomEmojiValidationError as exc:
        raise RefusalError(422, exc.code) from None

    initial_ws, initial_caller = _caller_context(
        verified, organisation_id, admin=True, lock=False, require_active_org=True
    )
    _lock_caller_erasure_fences(organisation_id, initial_caller.membership_id)
    lock_workspace(workspace_id=initial_ws.id)
    workspace, caller = _caller_context(
        verified, organisation_id, admin=True, lock=False, require_active_org=True
    )

    active_count = WorkspaceCustomEmoji.objects.filter(
        organisation_id=organisation_id,
        workspace_id=workspace.id,
        revoked_at__isnull=True,
    ).count()
    if active_count >= MAX_CUSTOM_EMOJIS_PER_WORKSPACE:
        raise RefusalError(409, "quota-exceeded")

    try:
        with transaction.atomic():
            row = WorkspaceCustomEmoji.objects.create(
                organisation_id=organisation_id,
                workspace_id=workspace.id,
                creator_id=caller.membership_id,
                shortcode=shortcode,
                webp_bytes=sanitized.webp_bytes,
                sha256=sanitized.sha256,
                width=sanitized.width,
                height=sanitized.height,
                animated=sanitized.animated,
            )
    except IntegrityError:
        raise RefusalError(409, "shortcode_conflict") from None

    _audit(
        workspace,
        caller.membership_id,
        "workspace.custom_emoji.created",
        row.id,
        request_id,
        metadata={"shortcode": shortcode, "sha256": sanitized.sha256},
    )
    return _emoji_wire(row)


@transaction.atomic
def delete_emoji(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    emoji_id: UUID,
    request_id: str,
) -> None:
    initial_ws, initial_caller = _caller_context(
        verified, organisation_id, admin=True, lock=False, require_active_org=True
    )
    _lock_caller_erasure_fences(organisation_id, initial_caller.membership_id)
    lock_workspace(workspace_id=initial_ws.id)
    workspace, caller = _caller_context(
        verified, organisation_id, admin=True, lock=False, require_active_org=True
    )

    row = (
        WorkspaceCustomEmoji.objects.select_for_update()
        .filter(
            id=emoji_id,
            organisation_id=organisation_id,
            workspace_id=workspace.id,
        )
        .first()
    )
    if row is None:
        raise RefusalError(404)
    if row.revoked_at is not None:
        return
    now = timezone.now()
    row.revoked_at = now
    row.save(update_fields=["revoked_at", "updated_at"])
    _audit(
        workspace,
        caller.membership_id,
        "workspace.custom_emoji.revoked",
        row.id,
        request_id,
        metadata={"shortcode": row.shortcode},
    )


@transaction.atomic
def get_emoji_blob(
    *, verified: VerifiedAccessToken, organisation_id: UUID, emoji_id: UUID
) -> tuple[bytes, str]:
    workspace, _ = _caller_context(
        verified, organisation_id, admin=False, lock=False, require_active_org=False
    )
    row = WorkspaceCustomEmoji.objects.filter(
        id=emoji_id,
        organisation_id=organisation_id,
        workspace_id=workspace.id,
        revoked_at__isnull=True,
    ).first()
    if row is None:
        raise RefusalError(404)
    blob = bytes(row.webp_bytes)
    try:
        verify_custom_emoji_webp_clean(blob)
    except CustomEmojiValidationError:
        raise RefusalError(404) from None
    return blob, row.sha256


# ---------------------------------------------------------------------- Scheduled Messages ---


def _scheduled_wire(row: ScheduledMessage) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "channelId": str(row.channel_id) if row.channel_id is not None else None,
        "roomId": row.room_id,
        "body": row.body,
        "mentions": list(row.mentions_json) if isinstance(row.mentions_json, list) else [],
        "threadRootEventId": row.thread_root_event_id or None,
        "deliverAt": _iso(row.deliver_at),
        "matrixTxnId": row.matrix_txn_id,
        "matrixEventId": row.matrix_event_id or None,
        "state": row.state,
        "failureReason": row.failure_reason or None,
        "createdAt": _iso(row.created_at),
        "updatedAt": _iso(row.updated_at),
    }


def _validate_mentions(raw: Any) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_MENTIONS_PER_SCHEDULED:
        raise RefusalError(422)
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        uid_str = str(_parse_uuid(item))
        if uid_str not in seen:
            seen.add(uid_str)
            out.append(uid_str)
    return out


def _validate_scheduled_body(raw: Any) -> str:
    if not isinstance(raw, str):
        raise RefusalError(422)
    if "\x00" in raw or not raw.strip() or len(raw) > 4000:
        raise RefusalError(422)
    return raw


def _validate_deliver_at(deliver_at: datetime, *, now: datetime) -> None:
    if deliver_at < now + timedelta(seconds=MIN_SCHEDULE_LEAD_SECONDS):
        raise RefusalError(422, "deliver_at_in_past")
    if deliver_at > now + timedelta(days=MAX_HORIZON_DAYS):
        raise RefusalError(422, "deliver_at_too_far")


@transaction.atomic
def list_scheduled_messages(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    channel_id: UUID | None = None,
    include_terminal: bool = False,
) -> dict[str, Any]:
    workspace, caller = _caller_context(
        verified, organisation_id, admin=False, lock=False, require_active_org=False
    )
    qs = ScheduledMessage.objects.filter(
        organisation_id=organisation_id,
        workspace_id=workspace.id,
        author_id=caller.membership_id,
    )
    if channel_id is not None:
        qs = qs.filter(channel_id=channel_id)
    if not include_terminal:
        qs = qs.filter(state__in=("pending", "in_flight", "refused_policy"))
    rows = qs.order_by("deliver_at", "id")[:200]
    return {"items": [_scheduled_wire(row) for row in rows]}


@transaction.atomic
def create_scheduled_message(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    data: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    raw_channel = data.get("channel_id") if "channel_id" in data else data.get("channelId")
    raw_room = data.get("room_id") if "room_id" in data else data.get("roomId", "")
    raw_deliver = data.get("deliver_at") if "deliver_at" in data else data.get("deliverAt")
    raw_thread = (
        data.get("thread_root_event_id")
        if "thread_root_event_id" in data
        else data.get("threadRootEventId", "")
    )
    confidential_hint = bool(data.get("confidential") or data.get("encrypted"))

    channel_id = _parse_optional_uuid(raw_channel)
    if raw_room is None:
        room_id = ""
    elif isinstance(raw_room, str):
        room_id = raw_room.strip()
    else:
        raise RefusalError(422)

    if raw_thread is None:
        thread_root_event_id = ""
    elif isinstance(raw_thread, str):
        thread_root_event_id = raw_thread.strip()
    else:
        raise RefusalError(422)
    if thread_root_event_id and not EVENT_ID_RE.fullmatch(thread_root_event_id):
        raise RefusalError(422)

    body = _validate_scheduled_body(data.get("body"))
    mentions = _validate_mentions(data.get("mentions"))
    deliver_at = _parse_aware_datetime(raw_deliver)

    workspace, caller = _caller_context(
        verified, organisation_id, admin=False, lock=False, require_active_org=True
    )
    _lock_caller_erasure_fences(organisation_id, caller.membership_id)
    workspace, caller = _caller_context(
        verified, organisation_id, admin=False, lock=False, require_active_org=True
    )

    now = timezone.now()
    _validate_deliver_at(deliver_at, now=now)
    channel, bound_room_id = _assert_plaintext_target(
        workspace=workspace,
        caller=caller,
        channel_id=channel_id,
        room_id=room_id,
        require_post=True,
        confidential_hint=confidential_hint,
    )

    pending_count = ScheduledMessage.objects.filter(
        organisation_id=organisation_id,
        workspace_id=workspace.id,
        author_id=caller.membership_id,
        state__in=("pending", "in_flight"),
    ).count()
    if pending_count >= MAX_PENDING_SCHEDULED_PER_MEMBER:
        raise RefusalError(409, "quota-exceeded")

    txn_id = f"kodera-sched-{secrets.token_hex(16)}"
    try:
        with transaction.atomic():
            row = ScheduledMessage.objects.create(
                organisation_id=organisation_id,
                workspace_id=workspace.id,
                channel_id=channel.id,
                room_id=bound_room_id,
                author_id=caller.membership_id,
                body=body,
                mentions_json=mentions,
                thread_root_event_id=thread_root_event_id,
                deliver_at=deliver_at,
                matrix_txn_id=txn_id,
                state=ScheduledMessage.State.PENDING,
            )
    except IntegrityError:
        raise RefusalError(409) from None

    _audit(
        workspace,
        caller.membership_id,
        "workspace.scheduled_message.created",
        row.id,
        request_id,
        metadata={
            "channel_id": str(channel.id),
            "deliver_at": _iso(deliver_at),
        },
    )
    return _scheduled_wire(row)


@transaction.atomic
def update_scheduled_message(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    scheduled_message_id: UUID,
    data: dict[str, Any],
    request_id: str,
    if_match: str | None = "*",
) -> dict[str, Any]:
    if not data:
        raise RefusalError(422)
    workspace, caller = _caller_context(
        verified, organisation_id, admin=False, lock=False, require_active_org=True
    )
    _lock_caller_erasure_fences(organisation_id, caller.membership_id)
    workspace, caller = _caller_context(
        verified, organisation_id, admin=False, lock=False, require_active_org=True
    )

    row = (
        ScheduledMessage.objects.select_for_update()
        .filter(
            id=scheduled_message_id,
            organisation_id=organisation_id,
            workspace_id=workspace.id,
            author_id=caller.membership_id,
        )
        .first()
    )
    if row is None:
        raise RefusalError(404)
    _verify_if_match(if_match, _scheduled_wire(row))
    if row.state != ScheduledMessage.State.PENDING:
        raise RefusalError(409, "scheduled_message_not_editable")

    _assert_plaintext_target(
        workspace=workspace,
        caller=caller,
        channel_id=row.channel_id,
        room_id=row.room_id,
        require_post=True,
    )

    now = timezone.now()
    update_fields = ["updated_at"]
    if "body" in data:
        row.body = _validate_scheduled_body(data["body"])
        update_fields.append("body")
    if "mentions" in data:
        row.mentions_json = _validate_mentions(data["mentions"])
        update_fields.append("mentions_json")
    if "deliver_at" in data or "deliverAt" in data:
        raw_deliver = data.get("deliver_at") if "deliver_at" in data else data.get("deliverAt")
        deliver_at = _parse_aware_datetime(raw_deliver)
        _validate_deliver_at(deliver_at, now=now)
        row.deliver_at = deliver_at
        update_fields.append("deliver_at")

    if len(update_fields) == 1:
        raise RefusalError(422)

    row.save(update_fields=update_fields)
    _audit(
        workspace,
        caller.membership_id,
        "workspace.scheduled_message.updated",
        row.id,
        request_id,
        metadata={"deliver_at": _iso(row.deliver_at)},
    )
    return _scheduled_wire(row)


@transaction.atomic
def cancel_scheduled_message(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    scheduled_message_id: UUID,
    request_id: str,
) -> None:
    workspace, caller = _caller_context(
        verified, organisation_id, admin=False, lock=False, require_active_org=True
    )
    _lock_caller_erasure_fences(organisation_id, caller.membership_id)

    row = (
        ScheduledMessage.objects.select_for_update()
        .filter(
            id=scheduled_message_id,
            organisation_id=organisation_id,
            workspace_id=workspace.id,
            author_id=caller.membership_id,
        )
        .first()
    )
    if row is None:
        raise RefusalError(404)
    if row.state == ScheduledMessage.State.CANCELLED:
        return
    if row.state != ScheduledMessage.State.PENDING:
        raise RefusalError(409, "scheduled_message_not_cancellable")

    row.state = ScheduledMessage.State.CANCELLED
    row.save(update_fields=["state", "updated_at"])
    _audit(
        workspace,
        caller.membership_id,
        "workspace.scheduled_message.cancelled",
        row.id,
        request_id,
    )


# ---------------------------------------------------------------------- Personal Reminders ---


def _reminder_wire(row: notification_services.PersonalReminderRecord) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "channelId": str(row.channel_id) if row.channel_id is not None else None,
        "roomId": row.room_id,
        "targetEventId": row.target_event_id,
        "note": row.note,
        "remindAt": _iso(row.remind_at),
        "state": row.state,
        "notificationId": str(row.notification_id) if row.notification_id is not None else None,
        "createdAt": _iso(row.created_at),
        "updatedAt": _iso(row.updated_at),
    }


def _validate_note(raw: Any) -> str:
    if raw is None:
        return ""
    if not isinstance(raw, str) or "\x00" in raw or len(raw) > 500:
        raise RefusalError(422)
    return raw.strip()


def _validate_remind_at(remind_at: datetime, *, now: datetime) -> None:
    if remind_at < now + timedelta(seconds=MIN_REMINDER_LEAD_SECONDS):
        raise RefusalError(422, "remind_at_in_past")
    if remind_at > now + timedelta(days=MAX_HORIZON_DAYS):
        raise RefusalError(422, "remind_at_too_far")


@transaction.atomic
def list_reminders(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    include_completed: bool = False,
) -> dict[str, Any]:
    _, caller = _caller_context(
        verified, organisation_id, admin=False, lock=False, require_active_org=False
    )
    rows = notification_services.list_member_reminders(
        organisation_id=organisation_id,
        membership_id=caller.membership_id,
        include_completed=include_completed,
        limit=200,
    )
    return {"items": [_reminder_wire(row) for row in rows]}


@transaction.atomic
def create_reminder(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    data: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    raw_channel = data.get("channel_id") if "channel_id" in data else data.get("channelId")
    raw_room = data.get("room_id") if "room_id" in data else data.get("roomId", "")
    raw_event = (
        data.get("target_event_id") if "target_event_id" in data else data.get("targetEventId")
    )
    raw_remind = data.get("remind_at") if "remind_at" in data else data.get("remindAt")
    confidential_hint = bool(data.get("confidential") or data.get("encrypted"))

    channel_id = _parse_optional_uuid(raw_channel)
    if raw_room is None:
        room_id = ""
    elif isinstance(raw_room, str):
        room_id = raw_room.strip()
    else:
        raise RefusalError(422)

    if not isinstance(raw_event, str):
        raise RefusalError(422)
    target_event_id = raw_event.strip()
    if not EVENT_ID_RE.fullmatch(target_event_id):
        raise RefusalError(422)

    note = _validate_note(data.get("note"))
    remind_at = _parse_aware_datetime(raw_remind)

    workspace, caller = _caller_context(
        verified, organisation_id, admin=False, lock=False, require_active_org=True
    )
    _lock_caller_erasure_fences(organisation_id, caller.membership_id)
    workspace, caller = _caller_context(
        verified, organisation_id, admin=False, lock=False, require_active_org=True
    )

    now = timezone.now()
    _validate_remind_at(remind_at, now=now)
    channel, bound_room_id = _assert_plaintext_target(
        workspace=workspace,
        caller=caller,
        channel_id=channel_id,
        room_id=room_id,
        require_post=False,
        confidential_hint=confidential_hint,
    )

    active_count = notification_services.count_active_member_reminders(
        organisation_id=organisation_id,
        membership_id=caller.membership_id,
    )
    if active_count >= MAX_ACTIVE_REMINDERS_PER_MEMBER:
        raise RefusalError(409, "quota-exceeded")

    try:
        with transaction.atomic():
            row = notification_services.create_member_reminder(
                organisation_id=organisation_id,
                membership_id=caller.membership_id,
                channel_id=channel.id,
                room_id=bound_room_id,
                target_event_id=target_event_id,
                note=note,
                remind_at=remind_at,
            )
    except IntegrityError:
        raise RefusalError(409) from None

    _audit(
        workspace,
        caller.membership_id,
        "workspace.personal_reminder.created",
        row.id,
        request_id,
        metadata={
            "channel_id": str(channel.id),
            "remind_at": _iso(remind_at),
        },
    )
    return _reminder_wire(row)


@transaction.atomic
def update_reminder(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    reminder_id: UUID,
    data: dict[str, Any],
    request_id: str,
    if_match: str | None = "*",
) -> dict[str, Any]:
    if not data:
        raise RefusalError(422)
    workspace, caller = _caller_context(
        verified, organisation_id, admin=False, lock=False, require_active_org=True
    )
    _lock_caller_erasure_fences(organisation_id, caller.membership_id)
    workspace, caller = _caller_context(
        verified, organisation_id, admin=False, lock=False, require_active_org=True
    )

    row = notification_services.lock_member_reminder(
        reminder_id=reminder_id,
        organisation_id=organisation_id,
        membership_id=caller.membership_id,
    )
    if row is None:
        raise RefusalError(404)
    _verify_if_match(if_match, _reminder_wire(row))
    if row.state in ("in_flight", "cancelled", "obsolete"):
        raise RefusalError(409, "reminder_not_editable")

    now = timezone.now()
    next_note: str | None = None
    next_remind_at: datetime | None = None
    next_state: str | None = None

    if "note" in data:
        next_note = _validate_note(data["note"])

    has_remind_at = "remind_at" in data or "remindAt" in data
    if has_remind_at:
        _assert_plaintext_target(
            workspace=workspace,
            caller=caller,
            channel_id=row.channel_id,
            room_id=row.room_id,
            require_post=False,
        )
        raw_remind = data.get("remind_at") if "remind_at" in data else data.get("remindAt")
        remind_at = _parse_aware_datetime(raw_remind)
        _validate_remind_at(remind_at, now=now)
        next_remind_at = remind_at
        if "state" not in data:
            candidate_state = "snoozed" if row.state in ("fired", "snoozed") else "pending"
            if row.state != candidate_state:
                next_state = candidate_state

    if "state" in data:
        req_state = data["state"]
        if req_state not in ("completed", "cancelled", "snoozed", "pending"):
            raise RefusalError(422)
        if req_state in ("snoozed", "pending") and not has_remind_at:
            _validate_remind_at(row.remind_at, now=now)
        if row.state != req_state:
            next_state = req_state

    if next_note is None and next_remind_at is None and next_state is None:
        raise RefusalError(422)

    updated = notification_services.update_member_reminder(
        reminder_id=row.id,
        organisation_id=organisation_id,
        membership_id=caller.membership_id,
        note=next_note,
        remind_at=next_remind_at,
        state=next_state,
    )
    _audit(
        workspace,
        caller.membership_id,
        "workspace.personal_reminder.updated",
        updated.id,
        request_id,
        metadata={"state": updated.state},
    )
    return _reminder_wire(updated)


@transaction.atomic
def delete_reminder(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    reminder_id: UUID,
    request_id: str,
) -> None:
    workspace, caller = _caller_context(
        verified, organisation_id, admin=False, lock=False, require_active_org=True
    )
    _lock_caller_erasure_fences(organisation_id, caller.membership_id)

    row = notification_services.lock_member_reminder(
        reminder_id=reminder_id,
        organisation_id=organisation_id,
        membership_id=caller.membership_id,
    )
    if row is None:
        raise RefusalError(404)
    if row.state == "cancelled":
        return
    if row.state == "in_flight":
        raise RefusalError(409, "reminder_in_flight")

    notification_services.update_member_reminder(
        reminder_id=row.id,
        organisation_id=organisation_id,
        membership_id=caller.membership_id,
        state="cancelled",
    )
    _audit(
        workspace,
        caller.membership_id,
        "workspace.personal_reminder.cancelled",
        row.id,
        request_id,
    )


# ------------------------------------------------------------ Member Workspace Preferences ---


def _normalize_labs_flags(stored: Any) -> dict[str, bool]:
    merged = dict(DEFAULT_LABS_FLAGS)
    if isinstance(stored, dict):
        for key in LABS_FLAG_KEYS:
            val = stored.get(key)
            if isinstance(val, bool):
                merged[key] = val
    return merged


def _preferences_wire(row: MemberWorkspacePreference | None) -> dict[str, Any]:
    if row is None:
        return {
            "labsFlags": dict(DEFAULT_LABS_FLAGS),
            "waitingRoomAmbience": False,
            "updatedAt": None,
        }
    return {
        "labsFlags": _normalize_labs_flags(row.labs_flags),
        "waitingRoomAmbience": bool(row.waiting_room_ambience),
        "updatedAt": _iso(row.updated_at),
    }


@transaction.atomic
def get_my_preferences(*, verified: VerifiedAccessToken, organisation_id: UUID) -> dict[str, Any]:
    workspace, caller = _caller_context(
        verified, organisation_id, admin=False, lock=False, require_active_org=False
    )
    row = MemberWorkspacePreference.objects.filter(
        organisation_id=organisation_id,
        workspace_id=workspace.id,
        membership_id=caller.membership_id,
    ).first()
    return _preferences_wire(row)


@transaction.atomic
def update_my_preferences(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    data: dict[str, Any],
    request_id: str,
    if_match: str | None = "*",
) -> dict[str, Any]:
    if not data:
        raise RefusalError(422)

    has_labs = "labs_flags" in data or "labsFlags" in data
    has_ambience = "waiting_room_ambience" in data or "waitingRoomAmbience" in data
    if not has_labs and not has_ambience:
        raise RefusalError(422)

    labs_patch: dict[str, bool] = {}
    if has_labs:
        raw_labs = data.get("labs_flags") if "labs_flags" in data else data.get("labsFlags")
        if not isinstance(raw_labs, dict) or not raw_labs:
            raise RefusalError(422)
        for key, val in raw_labs.items():
            if key not in LABS_FLAG_KEYS or not isinstance(val, bool):
                raise RefusalError(422)
            labs_patch[key] = val

    ambience_patch: bool | None = None
    if has_ambience:
        raw_amb = (
            data.get("waiting_room_ambience")
            if "waiting_room_ambience" in data
            else data.get("waitingRoomAmbience")
        )
        if not isinstance(raw_amb, bool):
            raise RefusalError(422)
        ambience_patch = raw_amb

    workspace, caller = _caller_context(
        verified, organisation_id, admin=False, lock=False, require_active_org=True
    )
    _lock_caller_erasure_fences(organisation_id, caller.membership_id)
    workspace, caller = _caller_context(
        verified, organisation_id, admin=False, lock=False, require_active_org=True
    )

    row = (
        MemberWorkspacePreference.objects.select_for_update()
        .filter(
            organisation_id=organisation_id,
            workspace_id=workspace.id,
            membership_id=caller.membership_id,
        )
        .first()
    )
    _verify_if_match(if_match, _preferences_wire(row))

    current_labs = (
        dict(row.labs_flags) if row is not None and isinstance(row.labs_flags, dict) else {}
    )
    for key, val in labs_patch.items():
        current_labs[key] = val
    cleaned_labs = {
        k: v for k, v in current_labs.items() if k in LABS_FLAG_KEYS and isinstance(v, bool)
    }

    current_ambience = bool(row.waiting_room_ambience) if row is not None else False
    if ambience_patch is not None:
        current_ambience = ambience_patch
    elif labs_patch.get("waiting_room_ambience") is False:
        current_ambience = False

    try:
        with transaction.atomic():
            if row is None:
                row = MemberWorkspacePreference.objects.create(
                    organisation_id=organisation_id,
                    workspace_id=workspace.id,
                    membership_id=caller.membership_id,
                    labs_flags=cleaned_labs,
                    waiting_room_ambience=current_ambience,
                )
            else:
                row.labs_flags = cleaned_labs
                row.waiting_room_ambience = current_ambience
                row.save(update_fields=["labs_flags", "waiting_room_ambience", "updated_at"])
    except IntegrityError:
        raise RefusalError(409) from None

    _audit(
        workspace,
        caller.membership_id,
        "workspace.preferences.updated",
        row.id,
        request_id,
        metadata={"waiting_room_ambience": current_ambience},
    )
    return _preferences_wire(row)
