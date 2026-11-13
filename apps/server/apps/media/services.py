"""Membership-authorized attachment tickets, verified completion and bounded previews."""

from datetime import datetime
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from services.identity.access_tokens import VerifiedAccessToken

from . import outbound, unfurl
from .context import RefusalError as RefusalError, audit, caller
from .models import Attachment
from .storage import ObjectDescriptor, ObjectMismatchError, StorageRefusedError
from .storage_gateway import Gateway


def _descriptor(row: Attachment) -> ObjectDescriptor:
    return ObjectDescriptor(
        row.organisation_id, row.id, row.filename, row.content_type, row.size_bytes, row.sha256
    )


def _gateway() -> Gateway:
    return Gateway(getattr(settings, "KODERA_MEDIA_GATEWAY_SOCKET", None))


def _download(row: Attachment) -> dict[str, Any]:
    result = _gateway().call("download", _descriptor(row))
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


@transaction.atomic
def create_upload(
    *, verified: VerifiedAccessToken, organisation_id: UUID, body: dict[str, Any], request_id: str
) -> dict[str, Any]:
    principal = caller(verified, organisation_id)
    row = Attachment(
        organisation_id=principal.organisation_id,
        uploader_id=principal.membership_id,
        filename=body["filename"],
        content_type=body["contentType"],
        size_bytes=body["sizeBytes"],
        sha256=body["sha256"],
    )
    try:
        obj = _descriptor(row)
    except (ValueError, TypeError, AttributeError):
        raise RefusalError(422) from None
    try:
        result = _gateway().call("upload", obj)
    except StorageRefusedError:
        raise RefusalError(503, "service-unavailable") from None
    row.upload_expires_at = datetime.fromisoformat(result["expiresAt"])
    row.save(force_insert=True)
    audit(principal, "workspace.attachment.upload_created", row.id, request_id)
    return {
        "attachmentId": str(row.id),
        "uploadUrl": result["url"],
        "method": "PUT",
        "headers": result["headers"],
        "expiresAt": result["expiresAt"],
    }


@transaction.atomic
def complete_upload(
    *, verified: VerifiedAccessToken, organisation_id: UUID, attachment_id: UUID, request_id: str
) -> dict[str, Any]:
    principal = caller(verified, organisation_id)
    row = (
        Attachment.objects.select_for_update()
        .filter(id=attachment_id, organisation_id=principal.organisation_id)
        .first()
    )
    if row is None:
        raise RefusalError(404)
    if row.uploader_id != principal.membership_id and principal.role not in {
        "org_owner",
        "org_admin",
    }:
        raise RefusalError(403)
    if row.completed_at is None:
        if row.upload_expires_at <= timezone.now():
            raise RefusalError(409)
        try:
            _gateway().call("verify", _descriptor(row))
        except ObjectMismatchError:
            raise RefusalError(409) from None
        except StorageRefusedError:
            raise RefusalError(503, "service-unavailable") from None
        row.completed_at = timezone.now()
        row.save(update_fields=["completed_at", "updated_at"])
        audit(principal, "workspace.attachment.completed", row.id, request_id)
    try:
        return _download(row)
    except StorageRefusedError:
        raise RefusalError(503, "service-unavailable") from None


@transaction.atomic
def get_attachment(
    *, verified: VerifiedAccessToken, organisation_id: UUID, attachment_id: UUID
) -> dict[str, Any]:
    principal = caller(verified, organisation_id)
    row = Attachment.objects.filter(
        id=attachment_id, organisation_id=principal.organisation_id, completed_at__isnull=False
    ).first()
    if row is None:
        raise RefusalError(404)
    try:
        return _download(row)
    except StorageRefusedError:
        raise RefusalError(503, "service-unavailable") from None


@transaction.atomic
def preview(
    *, verified: VerifiedAccessToken, organisation_id: UUID, url: str, request_id: str
) -> dict[str, str]:
    principal = caller(verified, organisation_id)
    try:
        result = unfurl.unfurl(url)
    except outbound.BlockedTargetError as failure:
        raise RefusalError(403, "forbidden", failure.reason) from None
    except outbound.FetchError as failure:
        if failure.reason in {"timeout", "unavailable", "resolver-busy"}:
            raise RefusalError(503, "service-unavailable") from None
        raise RefusalError(422) from None
    # The URL, its query and extracted content never enter the append-only audit record.
    audit(principal, "workspace.url.previewed", principal.membership_id, request_id)
    return result


@transaction.atomic
def authorize(verified: VerifiedAccessToken, organisation_id: UUID | None = None) -> None:
    caller(verified, organisation_id)
