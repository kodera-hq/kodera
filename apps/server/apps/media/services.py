"""Membership-authorized attachment tickets, verified completion and bounded previews."""

from __future__ import annotations

import hashlib
import http.client
import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from django.conf import settings
from django.core.cache import cache
from django.core.exceptions import ObjectDoesNotExist
from django.db import connection, transaction
from django.utils import timezone

from apps.orgs.actor_selectors import TenantCaller
from apps.workspaces.channel_access import may_view, resolve
from apps.workspaces.selectors import (
    active_text_channel_id,
    undeleted_channel_id,
    workspace_id_for,
)
from apps.workspaces.structure import WorkspaceUnavailableError
from core.db.ids import new_uuid7
from services.identity.access_tokens import VerifiedAccessToken

from . import outbound, unfurl
from .context import RefusalError as RefusalError, audit, caller, read_caller
from .models import ROOM_ID_REGEX, Attachment
from .storage import ObjectDescriptor, ObjectMismatchError, StorageRefusedError
from .storage_gateway import Gateway
from .storage_protocol import unique_object

_DEFAULT_UNFURL = unfurl.unfurl
ROOM_ID_PATTERN = re.compile(ROOM_ID_REGEX + r"\Z")
DEFAULT_MAX_PENDING_PER_MEMBER = 10
DEFAULT_MAX_PENDING_PER_WORKSPACE = 100
PREVIEW_TTL = 300
ROOM_VERIFIER_TIMEOUT_S = 3.0
MAX_ROOM_VERIFIER_BYTES = 4096


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


_INTERNAL_VERIFIER_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}), _NoRedirect()
)


@dataclass(frozen=True)
class PreparedUpload:
    row_id: UUID
    channel_id: UUID | None
    room_id: str | None
    filename: str
    content_type: str
    size_bytes: int
    sha256: str
    ticket: dict[str, Any]


@dataclass(frozen=True)
class PreparedCompletion:
    attachment_id: UUID
    verified_storage: bool
    download_ticket: dict[str, Any]
    organisation_id: UUID | None = None
    room_id: str | None = None
    uploader_id: UUID | None = None
    dm_verified_membership_id: UUID | None = None


def _descriptor(row: Attachment) -> ObjectDescriptor:
    return ObjectDescriptor(
        row.organisation_id, row.id, row.filename, row.content_type, row.size_bytes, row.sha256
    )


def _gateway() -> Gateway:
    return Gateway(getattr(settings, "KODERA_MEDIA_GATEWAY_SOCKET", None))


def _format_download(row: Attachment, result: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "filename": row.filename,
        "contentType": row.content_type,
        "sizeBytes": row.size_bytes,
        "sha256": row.sha256,
        "downloadUrl": result["url"],
        "expiresAt": result["expiresAt"],
        "disposition": "attachment",
    }


def _parse_scope(body: dict[str, Any]) -> tuple[UUID | None, str | None]:
    raw_channel = body.get("channelId")
    raw_room = body.get("roomId")
    if (raw_channel is None and raw_room is None) or (
        raw_channel is not None and raw_room is not None
    ):
        raise RefusalError(422)
    channel_id: UUID | None = None
    room_id: str | None = None
    if raw_channel is not None:
        if isinstance(raw_channel, UUID):
            channel_id = raw_channel
        elif isinstance(raw_channel, str):
            try:
                channel_id = UUID(raw_channel)
            except ValueError:
                raise RefusalError(422) from None
        else:
            raise RefusalError(422)
    if raw_room is not None:
        if (
            not isinstance(raw_room, str)
            or len(raw_room) > 255
            or ROOM_ID_PATTERN.fullmatch(raw_room) is None
        ):
            raise RefusalError(422)
        room_id = raw_room
    return channel_id, room_id


def _query_room_verifier_http(verifier_url: str, *, room_id: str, subject: str) -> bool:
    payload = json.dumps({"room_id": room_id, "subject": subject}, separators=(",", ":")).encode()
    req = urllib.request.Request(  # noqa: S310 - reviewed internal room-access URL from settings
        verifier_url,
        data=payload,
        headers={"Content-Type": "application/json", "Connection": "close"},
        method="POST",
    )
    try:
        with _INTERNAL_VERIFIER_OPENER.open(req, timeout=ROOM_VERIFIER_TIMEOUT_S) as resp:
            if resp.status != 200:
                raise RefusalError(503, "service-unavailable")
            raw = resp.read(MAX_ROOM_VERIFIER_BYTES + 1)
    except urllib.error.HTTPError as exc:
        exc.close()
        raise RefusalError(503, "service-unavailable") from None
    except (urllib.error.URLError, OSError, http.client.HTTPException):
        raise RefusalError(503, "service-unavailable") from None

    if not raw or len(raw) > MAX_ROOM_VERIFIER_BYTES:
        raise RefusalError(503, "service-unavailable")
    try:
        parsed = json.loads(raw, object_pairs_hook=unique_object)
    except ValueError:
        raise RefusalError(503, "service-unavailable") from None
    if (
        not isinstance(parsed, dict)
        or set(parsed) != {"allowed"}
        or not isinstance(parsed["allowed"], bool)
    ):
        raise RefusalError(503, "service-unavailable")
    return parsed["allowed"]


def _verify_dm_room_authority(
    *,
    organisation_id: UUID,
    membership_id: UUID,
    verified: VerifiedAccessToken,
    room_id: str,
    uploader_id: UUID | None,
    for_upload: bool,
) -> None:
    """Verify caller authority on a Matrix DM `room_id` through serving configuration."""
    verifier_url = getattr(settings, "KODERA_MEDIA_ROOM_VERIFIER_URL", None)
    if isinstance(verifier_url, str) and verifier_url:
        if not _query_room_verifier_http(verifier_url, room_id=room_id, subject=verified.subject):
            raise RefusalError(403)
        return

    socket_configured = bool(getattr(settings, "KODERA_MEDIA_GATEWAY_SOCKET", None))
    if socket_configured or _gateway is not _DEFAULT_GATEWAY:
        try:
            gw = _gateway()
        except StorageRefusedError:
            if socket_configured:
                raise RefusalError(503, "service-unavailable") from None
            gw = None
        verify_fn = getattr(gw, "verify_room_member", None) if gw is not None else None
        if callable(verify_fn):
            try:
                verdict = verify_fn(
                    organisation_id=organisation_id,
                    room_id=room_id,
                    subject=verified.subject,
                )
            except StorageRefusedError:
                raise RefusalError(503, "service-unavailable") from None
            if verdict is not None:
                if not verdict:
                    raise RefusalError(403)
                return

    # When no external Matrix room verifier is configured, an admitted member may upload to their
    # own DM session, while read/completion fails closed for everyone except the uploader.
    if for_upload:
        return
    if uploader_id != membership_id:
        raise RefusalError(403)


_DEFAULT_GATEWAY = _gateway


def _verify_channel_upload_authority(principal: TenantCaller, channel_id: UUID) -> None:
    ws_id = workspace_id_for(organisation_id=principal.organisation_id)
    if ws_id is None or active_text_channel_id(workspace_id=ws_id, channel_id=channel_id) is None:
        raise RefusalError(403)
    try:
        access = resolve(channel_id)
    except (ObjectDoesNotExist, WorkspaceUnavailableError):
        raise RefusalError(403) from None
    if not may_view(
        access,
        organisation_id=principal.organisation_id,
        membership_id=principal.membership_id,
        authority_revision=principal.authority_revision,
    ):
        raise RefusalError(403)
    if "file.upload" in access.denied and principal.role not in {"org_owner", "org_admin"}:
        raise RefusalError(403)


def _verify_db_read_authority(principal: TenantCaller, row: Attachment) -> None:
    """Verify PostgreSQL-backed attachment scope authority without performing network I/O."""
    if row.channel_id is not None:
        ws_id = workspace_id_for(organisation_id=principal.organisation_id)
        if (
            ws_id is None
            or undeleted_channel_id(workspace_id=ws_id, channel_id=row.channel_id) is None
        ):
            raise RefusalError(403)
        try:
            access = resolve(row.channel_id)
        except (ObjectDoesNotExist, WorkspaceUnavailableError):
            raise RefusalError(403) from None
        if not may_view(
            access,
            organisation_id=principal.organisation_id,
            membership_id=principal.membership_id,
            authority_revision=principal.authority_revision,
        ):
            raise RefusalError(403)
        if "file.read" in access.denied and principal.role not in {"org_owner", "org_admin"}:
            raise RefusalError(403)
        return

    if row.room_id is not None:
        return

    # Legacy unscoped rows have no verified channel or DM participant list; restrict strictly to
    # the original uploader (administrator status never grants private unscoped attachment reads).
    if row.uploader_id != principal.membership_id:
        raise RefusalError(403)


def _check_pending_limits(principal: TenantCaller, now: datetime) -> None:
    max_member = int(
        getattr(settings, "KODERA_MAX_PENDING_UPLOADS_PER_MEMBER", DEFAULT_MAX_PENDING_PER_MEMBER)
    )
    max_workspace = int(
        getattr(
            settings,
            "KODERA_MAX_PENDING_UPLOADS_PER_WORKSPACE",
            DEFAULT_MAX_PENDING_PER_WORKSPACE,
        )
    )
    active_pending = Attachment.objects.filter(
        organisation_id=principal.organisation_id,
        completed_at__isnull=True,
        upload_expires_at__gt=now,
    )
    if active_pending.filter(uploader_id=principal.membership_id).count() >= max_member:
        raise RefusalError(429, "rate-limited", "pending_upload_limit_exceeded")
    if active_pending.count() >= max_workspace:
        raise RefusalError(429, "rate-limited", "workspace_pending_upload_limit_exceeded")


def prepare_upload(
    *, verified: VerifiedAccessToken, organisation_id: UUID, body: dict[str, Any]
) -> PreparedUpload:
    """Validate authority, scope and pending caps, then presign PUT outside Workspace locks."""
    with transaction.atomic():
        principal = read_caller(verified, organisation_id)
        channel_id, room_id = _parse_scope(body)
        if channel_id is not None:
            _verify_channel_upload_authority(principal, channel_id)
        _check_pending_limits(principal, timezone.now())
        raw_filename = body.get("filename")
        raw_content_type = body.get("contentType")
        raw_size_bytes = body.get("sizeBytes")
        raw_sha256 = body.get("sha256")
        if (
            not isinstance(raw_filename, str)
            or not isinstance(raw_content_type, str)
            or type(raw_size_bytes) is not int
            or not isinstance(raw_sha256, str)
        ):
            raise RefusalError(422)
        row_id = new_uuid7()
        try:
            obj = ObjectDescriptor(
                principal.organisation_id,
                row_id,
                raw_filename,
                raw_content_type,
                raw_size_bytes,
                raw_sha256,
            )
        except (ValueError, TypeError, AttributeError):
            raise RefusalError(422) from None
        org_id = principal.organisation_id
        membership_id = principal.membership_id

    if room_id is not None:
        _verify_dm_room_authority(
            organisation_id=org_id,
            membership_id=membership_id,
            verified=verified,
            room_id=room_id,
            uploader_id=membership_id,
            for_upload=True,
        )

    try:
        ticket = _gateway().call("upload", obj)
    except StorageRefusedError:
        raise RefusalError(503, "service-unavailable") from None

    return PreparedUpload(
        row_id=row_id,
        channel_id=channel_id,
        room_id=room_id,
        filename=obj.filename,
        content_type=obj.content_type,
        size_bytes=obj.size_bytes,
        sha256=obj.sha256,
        ticket=ticket,
    )


@transaction.atomic
def commit_upload(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    prepared: PreparedUpload,
    request_id: str,
) -> dict[str, Any]:
    principal = caller(verified, organisation_id)
    if (prepared.channel_id is None and prepared.room_id is None) or (
        prepared.channel_id is not None and prepared.room_id is not None
    ):
        raise RefusalError(422)
    if prepared.channel_id is not None:
        _verify_channel_upload_authority(principal, prepared.channel_id)
    now = timezone.now()
    _check_pending_limits(principal, now)
    row = Attachment(
        id=prepared.row_id,
        organisation_id=principal.organisation_id,
        uploader_id=principal.membership_id,
        channel_id=prepared.channel_id,
        room_id=prepared.room_id,
        filename=prepared.filename,
        content_type=prepared.content_type,
        size_bytes=prepared.size_bytes,
        sha256=prepared.sha256,
        upload_expires_at=datetime.fromisoformat(prepared.ticket["expiresAt"]),
    )
    row.save(force_insert=True)
    audit(principal, "workspace.attachment.upload_created", row.id, request_id)
    return {
        "attachmentId": str(row.id),
        "uploadUrl": prepared.ticket["uploadUrl"]
        if "uploadUrl" in prepared.ticket
        else prepared.ticket["url"],
        "method": "PUT",
        "headers": prepared.ticket["headers"],
        "expiresAt": prepared.ticket["expiresAt"],
    }


def create_upload(
    *, verified: VerifiedAccessToken, organisation_id: UUID, body: dict[str, Any], request_id: str
) -> dict[str, Any]:
    prepared = prepare_upload(verified=verified, organisation_id=organisation_id, body=body)
    return commit_upload(
        verified=verified,
        organisation_id=organisation_id,
        prepared=prepared,
        request_id=request_id,
    )


def prepare_complete(
    *, verified: VerifiedAccessToken, organisation_id: UUID, attachment_id: UUID
) -> PreparedCompletion:
    """Verify scope and S3 object metadata via StorageWorker HEAD outside Workspace locks."""
    with transaction.atomic():
        principal = read_caller(verified, organisation_id)
        row = Attachment.objects.filter(
            id=attachment_id, organisation_id=principal.organisation_id
        ).first()
        if row is None:
            raise RefusalError(404)
        if row.uploader_id != principal.membership_id and principal.role not in {
            "org_owner",
            "org_admin",
        }:
            raise RefusalError(403)
        _verify_db_read_authority(principal, row)
        if row.cancelled_at is not None:
            raise RefusalError(409)
        needs_verify = row.completed_at is None
        if needs_verify and row.upload_expires_at <= timezone.now():
            raise RefusalError(409)
        obj = _descriptor(row)
        org_id = principal.organisation_id
        membership_id = principal.membership_id
        room_id = row.room_id
        uploader_id = row.uploader_id

    if room_id is not None:
        _verify_dm_room_authority(
            organisation_id=org_id,
            membership_id=membership_id,
            verified=verified,
            room_id=room_id,
            uploader_id=uploader_id,
            for_upload=False,
        )

    gateway = _gateway()
    if needs_verify:
        try:
            gateway.call("verify", obj)
        except ObjectMismatchError:
            raise RefusalError(409) from None
        except StorageRefusedError:
            raise RefusalError(503, "service-unavailable") from None
    try:
        download_ticket = gateway.call("download", obj)
    except StorageRefusedError:
        raise RefusalError(503, "service-unavailable") from None

    if room_id is not None:
        _verify_dm_room_authority(
            organisation_id=org_id,
            membership_id=membership_id,
            verified=verified,
            room_id=room_id,
            uploader_id=uploader_id,
            for_upload=False,
        )

    return PreparedCompletion(
        attachment_id=attachment_id,
        verified_storage=needs_verify,
        download_ticket=download_ticket,
        organisation_id=org_id,
        room_id=room_id,
        uploader_id=uploader_id,
        dm_verified_membership_id=membership_id if room_id is not None else None,
    )


def commit_complete(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    prepared: PreparedCompletion,
    request_id: str,
) -> dict[str, Any]:
    if (
        prepared.room_id is not None
        and prepared.organisation_id is not None
        and prepared.dm_verified_membership_id is not None
    ):
        _verify_dm_room_authority(
            organisation_id=prepared.organisation_id,
            membership_id=prepared.dm_verified_membership_id,
            verified=verified,
            room_id=prepared.room_id,
            uploader_id=prepared.uploader_id,
            for_upload=False,
        )
    with transaction.atomic():
        principal = caller(verified, organisation_id)
        row = (
            Attachment.objects.select_for_update()
            .filter(id=prepared.attachment_id, organisation_id=principal.organisation_id)
            .first()
        )
        if row is None:
            raise RefusalError(404)
        if row.uploader_id != principal.membership_id and principal.role not in {
            "org_owner",
            "org_admin",
        }:
            raise RefusalError(403)
        _verify_db_read_authority(principal, row)
        if row.room_id is not None and (
            prepared.room_id != row.room_id
            or prepared.dm_verified_membership_id != principal.membership_id
        ):
            raise RefusalError(403)
        if row.cancelled_at is not None:
            raise RefusalError(409)
        if row.completed_at is None:
            if row.upload_expires_at <= timezone.now():
                raise RefusalError(409)
            if not prepared.verified_storage:
                raise RefusalError(409)
            row.completed_at = timezone.now()
            row.save(update_fields=["completed_at", "updated_at"])
            audit(principal, "workspace.attachment.completed", row.id, request_id)
        org_id = principal.organisation_id
        membership_id = principal.membership_id
        room_id = row.room_id
        uploader_id = row.uploader_id

    if room_id is not None:
        _verify_dm_room_authority(
            organisation_id=org_id,
            membership_id=membership_id,
            verified=verified,
            room_id=room_id,
            uploader_id=uploader_id,
            for_upload=False,
        )
    return _format_download(row, prepared.download_ticket)


def authorize_complete(
    *, verified: VerifiedAccessToken, organisation_id: UUID, attachment_id: UUID
) -> None:
    """Verify current channel/DM completion & download authority before replaying cached URLs."""
    with transaction.atomic():
        principal = read_caller(verified, organisation_id)
        row = Attachment.objects.filter(
            id=attachment_id, organisation_id=principal.organisation_id
        ).first()
        if row is None:
            raise RefusalError(404)
        if row.uploader_id != principal.membership_id and principal.role not in {
            "org_owner",
            "org_admin",
        }:
            raise RefusalError(403)
        _verify_db_read_authority(principal, row)
        if row.cancelled_at is not None:
            raise RefusalError(409)
        org_id = principal.organisation_id
        membership_id = principal.membership_id
        room_id = row.room_id
        uploader_id = row.uploader_id

    if room_id is not None:
        _verify_dm_room_authority(
            organisation_id=org_id,
            membership_id=membership_id,
            verified=verified,
            room_id=room_id,
            uploader_id=uploader_id,
            for_upload=False,
        )


def authorize_upload_replay(
    *, verified: VerifiedAccessToken, organisation_id: UUID, body: dict[str, Any]
) -> None:
    """Verify current channel/DM upload authority before replaying a cached upload ticket."""
    with transaction.atomic():
        principal = read_caller(verified, organisation_id)
        channel_id, room_id = _parse_scope(body)
        if channel_id is not None:
            _verify_channel_upload_authority(principal, channel_id)
        org_id = principal.organisation_id
        membership_id = principal.membership_id

    if room_id is not None:
        _verify_dm_room_authority(
            organisation_id=org_id,
            membership_id=membership_id,
            verified=verified,
            room_id=room_id,
            uploader_id=membership_id,
            for_upload=True,
        )


def complete_upload(
    *, verified: VerifiedAccessToken, organisation_id: UUID, attachment_id: UUID, request_id: str
) -> dict[str, Any]:
    prepared = prepare_complete(
        verified=verified, organisation_id=organisation_id, attachment_id=attachment_id
    )
    if (
        prepared.room_id is not None
        and prepared.organisation_id is not None
        and prepared.dm_verified_membership_id is not None
    ):
        _verify_dm_room_authority(
            organisation_id=prepared.organisation_id,
            membership_id=prepared.dm_verified_membership_id,
            verified=verified,
            room_id=prepared.room_id,
            uploader_id=prepared.uploader_id,
            for_upload=False,
        )
    return commit_complete(
        verified=verified,
        organisation_id=organisation_id,
        prepared=prepared,
        request_id=request_id,
    )


def cancel_upload(
    *, verified: VerifiedAccessToken, organisation_id: UUID, attachment_id: UUID, request_id: str
) -> None:
    """Atomically claim cancellation before S3 DELETE, keeping unexpired PUT tombstones for reaper."""
    with transaction.atomic():
        principal = caller(verified, organisation_id)
        locked = (
            Attachment.objects.select_for_update()
            .filter(id=attachment_id, organisation_id=principal.organisation_id)
            .first()
        )
        if locked is None:
            raise RefusalError(404)
        if locked.uploader_id != principal.membership_id and principal.role not in {
            "org_owner",
            "org_admin",
        }:
            raise RefusalError(403)
        if locked.completed_at is not None:
            raise RefusalError(409)
        if locked.cancelled_at is None:
            locked.cancelled_at = timezone.now()
            locked.save(update_fields=["cancelled_at", "updated_at"])
            audit(principal, "workspace.attachment.upload_cancelled", locked.id, request_id)
        obj = _descriptor(locked)
        expires_at = locked.upload_expires_at

    try:
        _gateway().call("delete", obj)
    except StorageRefusedError:
        raise RefusalError(503, "service-unavailable") from None

    if expires_at <= timezone.now():
        with transaction.atomic():
            principal = caller(verified, organisation_id)
            Attachment.objects.select_for_update().filter(
                id=attachment_id,
                organisation_id=principal.organisation_id,
                completed_at__isnull=True,
                cancelled_at__isnull=False,
                upload_expires_at__lte=timezone.now(),
            ).delete()


def reap_expired_uploads(*, limit: int = 100) -> int:
    """Bounded reaper purging expired uncompleted/cancelled tickets after S3 DELETE + HEAD 404."""
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise ValueError("expired upload reaper limit must be between 1 and 1000")
    now = timezone.now()
    candidates = list(
        Attachment.objects.filter(completed_at__isnull=True, upload_expires_at__lte=now).order_by(
            "upload_expires_at", "id"
        )[:limit]
    )
    if not candidates:
        return 0
    gateway = _gateway()
    purged = 0
    for row in candidates:
        with transaction.atomic():
            claimed = (
                Attachment.objects.select_for_update(skip_locked=True)
                .filter(
                    id=row.id,
                    completed_at__isnull=True,
                    upload_expires_at__lte=timezone.now(),
                )
                .first()
            )
            if claimed is None:
                continue
            if claimed.cancelled_at is None:
                claimed.cancelled_at = timezone.now()
                claimed.save(update_fields=["cancelled_at", "updated_at"])
            obj = _descriptor(claimed)
        try:
            gateway.call("delete", obj)
        except StorageRefusedError:
            # Fail closed: keep the fenced tombstone row until storage absence is confirmed.
            continue
        with transaction.atomic():
            deleted_count, _ = (
                Attachment.objects.select_for_update(skip_locked=True)
                .filter(
                    id=row.id,
                    completed_at__isnull=True,
                    cancelled_at__isnull=False,
                    upload_expires_at__lte=timezone.now(),
                )
                .delete()
            )
            if deleted_count:
                purged += 1
    return purged


def get_attachment(
    *, verified: VerifiedAccessToken, organisation_id: UUID, attachment_id: UUID
) -> dict[str, Any]:
    with transaction.atomic():
        principal = read_caller(verified, organisation_id)
        row = Attachment.objects.filter(
            id=attachment_id, organisation_id=principal.organisation_id, completed_at__isnull=False
        ).first()
        if row is None:
            raise RefusalError(404)
        _verify_db_read_authority(principal, row)
        obj = _descriptor(row)
        org_id = principal.organisation_id
        membership_id = principal.membership_id
        room_id = row.room_id
        uploader_id = row.uploader_id

    if room_id is not None:
        _verify_dm_room_authority(
            organisation_id=org_id,
            membership_id=membership_id,
            verified=verified,
            room_id=room_id,
            uploader_id=uploader_id,
            for_upload=False,
        )

    try:
        result = _gateway().call("download", obj)
    except StorageRefusedError:
        raise RefusalError(503, "service-unavailable") from None

    if room_id is not None:
        _verify_dm_room_authority(
            organisation_id=org_id,
            membership_id=membership_id,
            verified=verified,
            room_id=room_id,
            uploader_id=uploader_id,
            for_upload=False,
        )

    with transaction.atomic():
        principal = read_caller(verified, organisation_id)
        refreshed = Attachment.objects.filter(
            id=attachment_id, organisation_id=principal.organisation_id, completed_at__isnull=False
        ).first()
        if refreshed is None:
            raise RefusalError(404)
        _verify_db_read_authority(principal, refreshed)
        return _format_download(refreshed, result)


def prepare_preview(
    *, verified: VerifiedAccessToken, organisation_id: UUID, url: str
) -> dict[str, str]:
    """Authorize and check the bounded cache before doing network I/O in autocommit."""
    if connection.in_atomic_block:
        raise RuntimeError("URL preview fetch requires no enclosing transaction")
    with transaction.atomic():
        read_caller(verified, organisation_id)
        if not isinstance(url, str) or len(url) > 8192:
            raise RefusalError(422)
        try:
            digest = hashlib.sha256(url.encode()).hexdigest()
        except UnicodeError:
            raise RefusalError(422) from None
        key = "media-preview:" + str(organisation_id) + ":" + digest
        cached = cache.get(key)
    if cached is not None:
        return cached
    try:
        if unfurl.unfurl is _DEFAULT_UNFURL:
            result = unfurl.unfurl(url, scope_key=str(organisation_id))
        else:
            result = unfurl.unfurl(url)
    except outbound.BlockedTargetError as failure:
        raise RefusalError(403, "forbidden", failure.reason) from None
    except outbound.FetchError as failure:
        if failure.reason in {"timeout", "unavailable", "resolver-busy"}:
            raise RefusalError(503, "service-unavailable") from None
        raise RefusalError(422) from None
    with transaction.atomic():
        read_caller(verified, organisation_id)
        cache.set(key, result, timeout=PREVIEW_TTL)
    return result


@transaction.atomic
def record_preview(
    *, verified: VerifiedAccessToken, organisation_id: UUID, result: dict[str, str], request_id: str
) -> dict[str, str]:
    principal = caller(verified, organisation_id)
    # The URL, its query and extracted content never enter the append-only audit record.
    audit(principal, "workspace.url.previewed", principal.membership_id, request_id)
    return result


def preview(
    *, verified: VerifiedAccessToken, organisation_id: UUID, url: str, request_id: str
) -> dict[str, str]:
    result = prepare_preview(verified=verified, organisation_id=organisation_id, url=url)
    return record_preview(
        verified=verified, organisation_id=organisation_id, result=result, request_id=request_id
    )


@transaction.atomic
def authorize(verified: VerifiedAccessToken, organisation_id: UUID | None = None) -> None:
    read_caller(verified, organisation_id)


def quota_replay_policy():
    """Supply the workspace effect policy through this application service boundary."""
    from apps.workspaces.services import quota_replay_policy as workspace_policy

    return workspace_policy()
