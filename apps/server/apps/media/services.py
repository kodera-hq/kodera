"""Membership-authorized attachment tickets, verified completion and bounded previews."""

from __future__ import annotations

import hashlib
import http.client
import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from django.conf import settings
from django.core.cache import cache
from django.core.exceptions import ObjectDoesNotExist
from django.db import connection, transaction
from django.utils import timezone

from apps.orgs.actor_selectors import TenantCaller
from apps.orgs.claim_readiness import database_now
from apps.orgs.selectors import attachment_sweep_organisation_ids, previous_sweep_organisation_id
from apps.workspaces.channel_access import may_perform, resolve
from apps.workspaces.selectors import (
    active_channel_id,
    undeleted_channel_id,
    workspace_id_for,
)
from apps.workspaces.structure import WorkspaceUnavailableError
from config.upload_limits import UPLOAD_STREAM_DRAIN_SECONDS
from core.db.ids import new_uuid7
from services.identity.access_tokens import VerifiedAccessToken

from . import outbound, preview_guard, unfurl
from .context import RefusalError as RefusalError, audit, caller, read_caller
from .models import ROOM_ID_REGEX, Attachment
from .storage import (
    EXPIRY_SECONDS,
    ObjectDescriptor,
    ObjectMismatchError,
    StorageRefusedError,
    parse_object_key,
)
from .storage_gateway import Gateway, attachment_prefix_objects, delete_object
from .storage_protocol import unique_object

_DEFAULT_UNFURL = unfurl.unfurl
ROOM_ID_PATTERN = re.compile(ROOM_ID_REGEX + r"\Z")
DEFAULT_MAX_PENDING_PER_MEMBER = 10
DEFAULT_MAX_PENDING_PER_WORKSPACE = 100
PREVIEW_TTL = 300
PREVIEW_TIMEOUT_TTL = 10
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
    if ws_id is None or active_channel_id(workspace_id=ws_id, channel_id=channel_id) is None:
        raise RefusalError(403)
    try:
        access = resolve(channel_id)
    except (ObjectDoesNotExist, WorkspaceUnavailableError):
        raise RefusalError(403) from None
    if not may_perform(
        access,
        action="file.upload",
        organisation_id=principal.organisation_id,
        membership_id=principal.membership_id,
        member_org_role=principal.role,
        authority_revision=principal.authority_revision,
    ):
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
        if not may_perform(
            access,
            action="file.read",
            organisation_id=principal.organisation_id,
            membership_id=principal.membership_id,
            member_org_role=principal.role,
            authority_revision=principal.authority_revision,
        ):
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
    return _format_download(row, prepared.download_ticket)


def authorize_complete(
    *, verified: VerifiedAccessToken, organisation_id: UUID, attachment_id: UUID
) -> None:
    """Verify current database channel/attachment authority inside replay transactions."""
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


def authorize_complete_dm(
    *, verified: VerifiedAccessToken, organisation_id: UUID, attachment_id: UUID
) -> None:
    """Verify live DM membership AFTER `respond_once` commits so zero DB locks are held."""
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
    """Verify current database channel upload authority inside replay transactions."""
    with transaction.atomic():
        principal = read_caller(verified, organisation_id)
        channel_id, _ = _parse_scope(body)
        if channel_id is not None:
            _verify_channel_upload_authority(principal, channel_id)


def authorize_upload_dm(
    *, verified: VerifiedAccessToken, organisation_id: UUID, body: dict[str, Any]
) -> None:
    """Verify live DM membership AFTER `respond_once` commits so zero DB locks are held."""
    with transaction.atomic():
        principal = read_caller(verified, organisation_id)
        _, room_id = _parse_scope(body)
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
    result = commit_complete(
        verified=verified,
        organisation_id=organisation_id,
        prepared=prepared,
        request_id=request_id,
    )
    authorize_complete_dm(
        verified=verified,
        organisation_id=organisation_id,
        attachment_id=attachment_id,
    )
    return result


def cancel_upload(
    *, verified: VerifiedAccessToken, organisation_id: UUID, attachment_id: UUID, request_id: str
) -> None:
    """Atomically claim cancellation before S3 DELETE, keeping PUT tombstones until the upload stream window drains."""
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

    # The drain window must close before DELETE starts, not merely before row removal.
    # An early DELETE may be followed by a late PUT; its tombstone always needs another pass.
    purge_allowed = expires_at <= _upload_purge_before()
    try:
        _gateway().call("delete", obj)
    except StorageRefusedError:
        raise RefusalError(503, "service-unavailable") from None

    if purge_allowed:
        with transaction.atomic():
            principal = caller(verified, organisation_id)
            Attachment.objects.select_for_update().filter(
                id=attachment_id,
                organisation_id=principal.organisation_id,
                completed_at__isnull=True,
                cancelled_at__isnull=False,
                upload_expires_at__lte=_upload_purge_before(),
            ).delete()


def _upload_purge_before() -> datetime:
    # Quota SQL uses the same fixed fence; S3 does not enforce stream duration.
    if settings.KODERA_MEDIA_MAX_UPLOAD_STREAM_S != UPLOAD_STREAM_DRAIN_SECONDS:
        raise RuntimeError("media upload drain window must be 300 seconds")
    return timezone.now() - timedelta(seconds=UPLOAD_STREAM_DRAIN_SECONDS)


def reap_expired_uploads(*, limit: int = 100) -> int:
    """Purge uncompleted tickets after the PUT stream window and S3 DELETE + HEAD 404."""
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise ValueError("expired upload reaper limit must be between 1 and 1000")
    now = _upload_purge_before()
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
                    upload_expires_at__lte=_upload_purge_before(),
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
                    upload_expires_at__lte=_upload_purge_before(),
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
        principal = read_caller(verified, organisation_id)
        if not isinstance(url, str) or len(url) > 8192:
            raise RefusalError(422)
        try:
            digest = hashlib.sha256(url.encode()).hexdigest()
        except UnicodeError:
            raise RefusalError(422) from None
        key = "media-preview:" + str(organisation_id) + ":" + digest
        cached = cache.get(key)
    # Commit the charge outside the authorization transaction, including refused fetches.
    principal_key = "principal:" + hashlib.sha256(str(principal.identity_id).encode()).hexdigest()
    if not preview_guard.charge(principal_key):
        raise RefusalError(429, "rate-limited", "unfurl-rate-limited")
    try:
        origin = outbound.target(url)
    except outbound.BlockedTargetError as failure:
        raise RefusalError(403, "forbidden", failure.reason) from None
    host_key = (
        "host:"
        + hashlib.sha256(json.dumps([origin.scheme, origin.host, origin.port]).encode()).hexdigest()
    )
    if cached is not None:
        return cached
    if preview_guard.timed_out(host_key):
        raise RefusalError(503, "service-unavailable", "timeout")
    try:
        if unfurl.unfurl is _DEFAULT_UNFURL:
            result = unfurl.unfurl(url, scope_key=str(organisation_id))
        else:
            result = unfurl.unfurl(url)
    except outbound.BlockedTargetError as failure:
        raise RefusalError(403, "forbidden", failure.reason) from None
    except outbound.FetchError as failure:
        if failure.reason == "timeout":
            preview_guard.remember_timeout(host_key, PREVIEW_TIMEOUT_TTL)
        if failure.reason in {"timeout", "unavailable", "resolver-busy"}:
            raise RefusalError(503, "service-unavailable", failure.reason) from None
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


def has_in_flight_attachment_uploads(*, attachment_ids: list[UUID], cutoff: datetime) -> bool:
    """Whether any listed attachment still has an upload window open after `cutoff`."""
    if not attachment_ids:
        return False
    return Attachment.objects.filter(id__in=attachment_ids, upload_expires_at__gt=cutoff).exists()


def _orphan_sweep_cutoff() -> datetime:
    if settings.KODERA_MEDIA_MAX_UPLOAD_STREAM_S != UPLOAD_STREAM_DRAIN_SECONDS:
        raise RuntimeError("media upload drain window must be 300 seconds")
    return database_now() - timedelta(seconds=EXPIRY_SECONDS + UPLOAD_STREAM_DRAIN_SECONDS)


def sweep_orphan_attachments(
    *,
    max_orgs: int = 50,
    max_pages: int = 100,
    max_deletes: int = 100,
    after_org: UUID | str | None = None,
    continuation: str | None = None,
    socket_path: str | None = None,
) -> dict[str, Any]:
    """Bounded, resumable S3 sweep deleting only rowless objects older than the 600s drain fence."""
    for label, bound in (
        ("max_orgs", max_orgs),
        ("max_pages", max_pages),
        ("max_deletes", max_deletes),
    ):
        if type(bound) is not int or not 1 <= bound <= 1000:
            raise ValueError(f"orphan attachment sweep {label} must be between 1 and 1000")

    resolved_after_org: UUID | None = None
    if after_org is not None:
        if isinstance(after_org, UUID):
            resolved_after_org = after_org
        elif isinstance(after_org, str) and after_org:
            try:
                resolved_after_org = UUID(after_org)
            except ValueError:
                raise ValueError("after_org must be a valid UUID") from None
        else:
            raise ValueError("after_org must be a valid UUID")

    if continuation is not None:
        if (
            not isinstance(continuation, str)
            or not continuation
            or len(continuation) > 4096
            or not continuation.isascii()
        ):
            raise ValueError("continuation must be a non-empty ASCII token up to 4096 bytes")
        if resolved_after_org is None:
            raise ValueError("continuation requires after_org")

    cutoff = _orphan_sweep_cutoff()
    resuming_current_org = continuation is not None
    fetched_orgs = attachment_sweep_organisation_ids(
        after_org=resolved_after_org,
        include_after_org=resuming_current_org,
        limit=max_orgs + 1,
    )
    has_extra_orgs = len(fetched_orgs) > max_orgs
    org_ids = fetched_orgs[:max_orgs]

    orgs_scanned = 0
    pages_scanned = 0
    objects_inspected = 0
    deleted = 0
    skipped_recent = 0
    skipped_tracked = 0
    last_completed_org: UUID | None = (
        previous_sweep_organisation_id(before_org=resolved_after_org)
        if resuming_current_org and resolved_after_org is not None
        else resolved_after_org
    )

    for index, org_id in enumerate(org_ids):
        if pages_scanned >= max_pages or deleted >= max_deletes:
            return {
                "organisationsScanned": orgs_scanned,
                "pagesScanned": pages_scanned,
                "objectsInspected": objects_inspected,
                "deleted": deleted,
                "skippedRecent": skipped_recent,
                "skippedTracked": skipped_tracked,
                "hasMore": True,
                "nextAfterOrg": str(last_completed_org) if last_completed_org is not None else None,
                "nextContinuation": None,
            }

        orgs_scanned += 1
        page_token: str | None = (
            continuation
            if resuming_current_org
            and resolved_after_org is not None
            and org_id == resolved_after_org
            else None
        )

        while True:
            page = attachment_prefix_objects(
                org_id,
                continuation=page_token,
                socket_path=socket_path,
            )
            pages_scanned += 1
            raw_objects: list[dict[str, str]] = page["objects"]
            next_token: str | None = page["continuation"]

            for item_idx, entry in enumerate(raw_objects):
                objects_inspected += 1
                parsed = parse_object_key(entry["key"])
                if parsed.organisation_id != org_id:
                    raise StorageRefusedError()

                last_modified = datetime.fromisoformat(entry["last_modified"])
                if last_modified.tzinfo is None:
                    raise StorageRefusedError()
                if last_modified > cutoff:
                    skipped_recent += 1
                    continue

                if Attachment.objects.filter(id=parsed.attachment_id).exists():
                    skipped_tracked += 1
                    continue

                delete_object(parsed, socket_path=socket_path)
                deleted += 1

                if deleted >= max_deletes:
                    remaining_on_page = item_idx + 1 < len(raw_objects)
                    if remaining_on_page:
                        if page_token is not None:
                            return {
                                "organisationsScanned": orgs_scanned,
                                "pagesScanned": pages_scanned,
                                "objectsInspected": objects_inspected,
                                "deleted": deleted,
                                "skippedRecent": skipped_recent,
                                "skippedTracked": skipped_tracked,
                                "hasMore": True,
                                "nextAfterOrg": str(org_id),
                                "nextContinuation": page_token,
                            }
                        return {
                            "organisationsScanned": orgs_scanned,
                            "pagesScanned": pages_scanned,
                            "objectsInspected": objects_inspected,
                            "deleted": deleted,
                            "skippedRecent": skipped_recent,
                            "skippedTracked": skipped_tracked,
                            "hasMore": True,
                            "nextAfterOrg": (
                                str(last_completed_org) if last_completed_org is not None else None
                            ),
                            "nextContinuation": None,
                        }
                    if next_token is not None:
                        return {
                            "organisationsScanned": orgs_scanned,
                            "pagesScanned": pages_scanned,
                            "objectsInspected": objects_inspected,
                            "deleted": deleted,
                            "skippedRecent": skipped_recent,
                            "skippedTracked": skipped_tracked,
                            "hasMore": True,
                            "nextAfterOrg": str(org_id),
                            "nextContinuation": next_token,
                        }
                    last_completed_org = org_id
                    more_orgs = (index + 1 < len(org_ids)) or has_extra_orgs
                    return {
                        "organisationsScanned": orgs_scanned,
                        "pagesScanned": pages_scanned,
                        "objectsInspected": objects_inspected,
                        "deleted": deleted,
                        "skippedRecent": skipped_recent,
                        "skippedTracked": skipped_tracked,
                        "hasMore": more_orgs,
                        "nextAfterOrg": str(org_id) if more_orgs else None,
                        "nextContinuation": None,
                    }

            if next_token is None:
                last_completed_org = org_id
                break

            page_token = next_token
            if pages_scanned >= max_pages:
                return {
                    "organisationsScanned": orgs_scanned,
                    "pagesScanned": pages_scanned,
                    "objectsInspected": objects_inspected,
                    "deleted": deleted,
                    "skippedRecent": skipped_recent,
                    "skippedTracked": skipped_tracked,
                    "hasMore": True,
                    "nextAfterOrg": str(org_id),
                    "nextContinuation": page_token,
                }

    return {
        "organisationsScanned": orgs_scanned,
        "pagesScanned": pages_scanned,
        "objectsInspected": objects_inspected,
        "deleted": deleted,
        "skippedRecent": skipped_recent,
        "skippedTracked": skipped_tracked,
        "hasMore": has_extra_orgs,
        "nextAfterOrg": (
            str(last_completed_org) if has_extra_orgs and last_completed_org is not None else None
        ),
        "nextContinuation": None,
    }


@dataclass(frozen=True)
class CompletedAttachmentSnapshot:
    id: UUID
    organisation_id: UUID
    uploader_id: UUID
    channel_id: UUID | None
    room_id: str | None
    filename: str
    content_type: str
    size_bytes: int
    sha256: str


def get_completed_attachment(
    *, attachment_id: UUID, organisation_id: UUID
) -> CompletedAttachmentSnapshot | None:
    """Return a completed, non-cancelled attachment snapshot for `organisation_id`."""
    row = Attachment.objects.filter(
        id=attachment_id,
        organisation_id=organisation_id,
        completed_at__isnull=False,
        cancelled_at__isnull=True,
    ).first()
    if row is None:
        return None
    return CompletedAttachmentSnapshot(
        id=row.id,
        organisation_id=row.organisation_id,
        uploader_id=row.uploader_id,
        channel_id=row.channel_id,
        room_id=row.room_id,
        filename=row.filename,
        content_type=row.content_type,
        size_bytes=row.size_bytes,
        sha256=row.sha256,
    )
