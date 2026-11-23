"""Views for zero-mutation workspace import preview, execution, and coexistence bridges."""

from __future__ import annotations

import base64
import binascii
import hashlib
import urllib.error
import urllib.request
from http.client import HTTPException
from typing import Any
from uuid import UUID

from django.core.exceptions import RequestDataTooBig
from django.http import HttpRequest, HttpResponse

from apps.media import services as media_services
from apps.media.context import RefusalError as MediaRefusalError
from core.api.scopes import declares
from services.identity.access_tokens import VerifiedAccessToken

from .. import coexistence, imports
from ..import_parsers import MAX_ARCHIVE
from ..wire import ExtensionRefusedError
from . import http
from .permissions import (
    CREATE_COEXISTENCE_BRIDGE,
    EXECUTE_WORKSPACE_IMPORT,
    LIST_COEXISTENCE_BRIDGES,
    PREVIEW_WORKSPACE_IMPORT,
    RECEIVE_COEXISTENCE_EVENT,
    REVOKE_COEXISTENCE_BRIDGE,
)

MAX_INLINE_ARCHIVE_BYTES = 512 * 1024  # Strictly < 512 KiB inline preview cap.


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


_STORAGE_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def fetch_attachment_bytes(*, download_url: str, max_bytes: int = MAX_ARCHIVE) -> bytes:
    req = urllib.request.Request(  # noqa: S310 - presigned object-storage ticket from media Gateway
        download_url,
        headers={"Connection": "close"},
        method="GET",
    )
    try:
        with _STORAGE_OPENER.open(req, timeout=10.0) as resp:
            if resp.status != 200:
                raise ExtensionRefusedError("import_attachment_unavailable", 503)
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise ExtensionRefusedError("import_archive_bound", 413)
                chunks.append(chunk)
            return b"".join(chunks)
    except ExtensionRefusedError:
        raise
    except (urllib.error.HTTPError, urllib.error.URLError, OSError, HTTPException):
        raise ExtensionRefusedError("import_attachment_unavailable", 503) from None


def _resolve_archive_bytes(
    *, verified: VerifiedAccessToken, organisation_id: UUID, body: dict[str, Any]
) -> bytes:
    inline_b64 = body.get("inlineArchiveBase64")
    attachment_raw = body.get("attachmentId")
    if (inline_b64 is None) == (attachment_raw is None):
        raise ExtensionRefusedError("import_archive_source_ambiguous", 422)
    if inline_b64 is not None:
        if not isinstance(inline_b64, str) or not inline_b64 or len(inline_b64) > 700_000:
            raise ExtensionRefusedError(
                "import_inline_archive_bound"
                if isinstance(inline_b64, str) and len(inline_b64) > 700_000
                else "import_inline_archive_invalid",
                413 if isinstance(inline_b64, str) and len(inline_b64) > 700_000 else 422,
            )
        try:
            raw = base64.b64decode(inline_b64, validate=True)
        except (ValueError, binascii.Error):
            raise ExtensionRefusedError("import_inline_archive_invalid", 400) from None
        if not 0 < len(raw) < MAX_INLINE_ARCHIVE_BYTES:
            raise ExtensionRefusedError(
                "import_inline_archive_bound"
                if len(raw) >= MAX_INLINE_ARCHIVE_BYTES
                else "import_inline_archive_invalid",
                413 if len(raw) >= MAX_INLINE_ARCHIVE_BYTES else 422,
            )
        return raw

    attachment_id = http.parse_uuid(attachment_raw)
    try:
        ticket = media_services.get_attachment(
            verified=verified,
            organisation_id=organisation_id,
            attachment_id=attachment_id,
        )
    except MediaRefusalError as refused:
        raise ExtensionRefusedError("import_attachment_refused", refused.status) from None
    size_bytes = ticket.get("sizeBytes")
    if type(size_bytes) is not int or not 0 < size_bytes <= MAX_ARCHIVE:
        raise ExtensionRefusedError("import_archive_bound", 413)
    raw = fetch_attachment_bytes(download_url=str(ticket["downloadUrl"]), max_bytes=MAX_ARCHIVE)
    if len(raw) != size_bytes or hashlib.sha256(raw).hexdigest() != ticket.get("sha256"):
        raise ExtensionRefusedError("import_attachment_digest_mismatch", 409)
    return raw


def _parse_channel_map(raw_map: Any) -> dict[str, UUID] | None:
    if raw_map is None:
        return None
    if not isinstance(raw_map, dict) or len(raw_map) > 100:
        raise ExtensionRefusedError("import_channel_map_invalid", 422)
    out: dict[str, UUID] = {}
    for key, val in raw_map.items():
        if not isinstance(key, str) or not 1 <= len(key) <= 160:
            raise ExtensionRefusedError("import_channel_map_invalid", 422)
        out[key] = http.parse_uuid(val)
    return out


@declares(PREVIEW_WORKSPACE_IMPORT)
def import_preview(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def post(verified: VerifiedAccessToken, _req_id: str) -> HttpResponse:
        body = http.parse_json_body(
            request,
            fields={"source", "inlineArchiveBase64", "attachmentId", "channelMap"},
            required={"source"},
        )
        source = body["source"]
        if not isinstance(source, str):
            raise ExtensionRefusedError("import_source_or_size_invalid", 422)
        channel_map = _parse_channel_map(body.get("channelMap"))
        raw = _resolve_archive_bytes(verified=verified, organisation_id=organisation_id, body=body)
        report = imports.preview(
            verified=verified,
            organisation_id=organisation_id,
            source=source,
            raw=raw,
            channel_map=channel_map,
        )
        return http.json_response(report, 200)

    # Zero-mutation dry-run: never persist an idempotency record.
    return http.serve_authenticated(
        request,
        organisation_id=organisation_id,
        handlers={"POST": post},
        operations=(PREVIEW_WORKSPACE_IMPORT,),
        idempotent_post=False,
    )


@declares(EXECUTE_WORKSPACE_IMPORT)
def import_execute(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    is_dry_run = False
    if request.method == "POST":
        try:
            peek = http.parse_json_body(
                request,
                fields={
                    "source",
                    "inlineArchiveBase64",
                    "attachmentId",
                    "dryRun",
                    "limit",
                    "channelMap",
                },
                required={"source"},
            )
            is_dry_run = peek.get("dryRun") is True
        except ExtensionRefusedError:
            is_dry_run = False

    def post(verified: VerifiedAccessToken, _req_id: str) -> HttpResponse:
        body = http.parse_json_body(
            request,
            fields={
                "source",
                "inlineArchiveBase64",
                "attachmentId",
                "dryRun",
                "limit",
                "channelMap",
            },
            required={"source"},
        )
        source = body["source"]
        if not isinstance(source, str):
            raise ExtensionRefusedError("import_source_or_size_invalid", 422)
        dry_run = body.get("dryRun", False)
        if type(dry_run) is not bool:
            raise ExtensionRefusedError("import_dry_run_invalid", 422)
        limit = body.get("limit", 25)
        if type(limit) is not int or not 1 <= limit <= 25:
            raise ExtensionRefusedError("import_batch_limit", 422)
        channel_map = _parse_channel_map(body.get("channelMap"))
        raw = _resolve_archive_bytes(verified=verified, organisation_id=organisation_id, body=body)
        report = imports.execute(
            verified=verified,
            organisation_id=organisation_id,
            source=source,
            raw=raw,
            limit=limit,
            dry_run=dry_run,
            channel_map=channel_map,
        )
        return http.json_response(report, 200)

    return http.serve_authenticated(
        request,
        organisation_id=organisation_id,
        handlers={"POST": post},
        operations=(EXECUTE_WORKSPACE_IMPORT,),
        idempotent_post=not is_dry_run,
    )


@declares(LIST_COEXISTENCE_BRIDGES, CREATE_COEXISTENCE_BRIDGE)
def coexistence_bridges(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def get(verified: VerifiedAccessToken, _req_id: str) -> HttpResponse:
        bridges = coexistence.list_bridges(verified=verified, organisation_id=organisation_id)
        return http.json_response({"bridges": bridges}, 200)

    def post(verified: VerifiedAccessToken, _req_id: str) -> HttpResponse:
        body = http.parse_json_body(
            request,
            fields={
                "channelId",
                "source",
                "externalWorkspaceId",
                "externalChannelId",
                "outboundEndpoint",
                "signingSecret",
            },
            required={
                "channelId",
                "source",
                "externalWorkspaceId",
                "externalChannelId",
                "outboundEndpoint",
                "signingSecret",
            },
        )
        row = coexistence.create_bridge(
            verified=verified,
            organisation_id=organisation_id,
            channel_id=http.parse_uuid(body["channelId"]),
            source=str(body["source"]) if isinstance(body["source"], str) else "",
            external_workspace_id=(
                body["externalWorkspaceId"] if isinstance(body["externalWorkspaceId"], str) else ""
            ),
            external_channel_id=(
                body["externalChannelId"] if isinstance(body["externalChannelId"], str) else ""
            ),
            outbound_endpoint=(
                body["outboundEndpoint"] if isinstance(body["outboundEndpoint"], str) else ""
            ),
            signing_secret=(
                body["signingSecret"] if isinstance(body["signingSecret"], str) else ""
            ),
        )
        return http.json_response(coexistence.serialize_bridge(row), 201)

    return http.serve_authenticated(
        request,
        organisation_id=organisation_id,
        handlers={"GET": get, "POST": post},
        operations=(LIST_COEXISTENCE_BRIDGES, CREATE_COEXISTENCE_BRIDGE),
        idempotent_post=True,
    )


@declares(REVOKE_COEXISTENCE_BRIDGE)
def coexistence_bridge(
    request: HttpRequest, organisation_id: UUID, bridge_id: UUID
) -> HttpResponse:
    def delete(verified: VerifiedAccessToken, _req_id: str) -> HttpResponse:
        coexistence.revoke_bridge(
            verified=verified, organisation_id=organisation_id, bridge_id=bridge_id
        )
        return HttpResponse(status=204)

    return http.serve_authenticated(
        request,
        organisation_id=organisation_id,
        handlers={"DELETE": delete},
        operations=(REVOKE_COEXISTENCE_BRIDGE,),
        idempotent_post=False,
    )


@declares(RECEIVE_COEXISTENCE_EVENT)
def coexistence_webhook(request: HttpRequest, bridge_id: UUID) -> HttpResponse:
    req_id = http.request_id(request)
    try:
        if request.method != "POST":
            return http.finish(http.problem(405, req_id, allowed=["POST"]), req_id)
        content_length = request.META.get("CONTENT_LENGTH", "")
        if isinstance(content_length, str) and content_length.isdigit():
            if int(content_length) > coexistence.MAX_COEXISTENCE_BODY:
                raise ExtensionRefusedError("coexistence_payload_bound", 413)
        raw_body = bytes(request.body[: coexistence.MAX_COEXISTENCE_BODY + 1])
        receipt = coexistence.receive_webhook(
            bridge_id=bridge_id,
            raw_body=raw_body,
            headers=dict(request.headers),
        )
        status_code = 202 if receipt.get("queued") is True else 200
        response = http.json_response(receipt, status_code)
    except RequestDataTooBig:
        response = http.problem(413, req_id, reason="coexistence_payload_bound")
    except ExtensionRefusedError as refused:
        response = http.problem(
            refused.status,
            req_id,
            reason=refused.reason,
            www_authenticate="Kodera-Coexistence-Signature",
        )
    return http.finish(response, req_id)
