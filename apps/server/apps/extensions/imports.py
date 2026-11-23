"""Resumable native document imports & idempotent Matrix channel replay; zero privilege escalation."""

from __future__ import annotations

import hashlib
import http.client
import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from typing import Any, Protocol
from uuid import UUID

from django.db import IntegrityError, connection, transaction

from apps.docs import collections, services as documents
from apps.docs.errors import RefusalError
from apps.identity import selectors as identities
from apps.identity.selectors import lock_delivery_identity, lock_user_fence
from apps.orgs import selectors as organisations
from apps.orgs.selectors import (
    lock_erasure_cutoff_fences,
    lock_membership_fence,
    lock_organisation,
    organisation_exists,
)
from apps.workspaces import selectors as workspaces
from apps.workspaces.channel_sets import lock_workspace
from apps.workspaces.quotas import violation

from .import_parsers import MAX_ARCHIVE, ImportedMessage, Item, Parsed, parse
from .member_matching import MemberMatchResult, inert_author_attribution, match_external_users
from .models import ImportBatch, ImportedObject, WorkspaceCutoff
from .services import admin, audit, read_admin, require_channel_post
from .wire import ExtensionRefusedError

MAX_RESPONSE_MEMBER_MAPPINGS = 250


def response_member_mappings(
    member_match: MemberMatchResult, warnings: list[str]
) -> list[dict[str, Any]]:
    """Bound wire reports while retaining the complete match result for attribution.

    OpenAPI 0.55.0 has a closed warning enum: use its omission warning rather than
    introducing an incompatible truncation code. Archive order is deterministic.
    """
    if (
        len(member_match.mappings) > MAX_RESPONSE_MEMBER_MAPPINGS
        and "unsupported_assets_omitted" not in warnings
    ):
        warnings.append("unsupported_assets_omitted")
    return [mapping.to_dict() for mapping in member_match.mappings[:MAX_RESPONSE_MEMBER_MAPPINGS]]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow HTTP redirects when carrying a homeserver bearer token."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


class MatrixReplayTransport(Protocol):
    def send_message(self, *, room_id: str, txn_id: str, content: dict[str, Any]) -> str: ...


class SynapseReplayTransport:
    """Idempotent Synapse room/thread message sender matching `tenant_agent/synapse.py`."""

    def __init__(
        self,
        url: str,
        token: str,
        server_name: str = "",
        *,
        timeout: float = 10.0,
    ) -> None:
        self._url = url.rstrip("/")
        self._token = token
        self.server_name = server_name
        self._timeout = timeout
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    @staticmethod
    def _q(value: str) -> str:
        return urllib.parse.quote(value, safe="")

    def _call(
        self, method: str, path: str, body: Any = None, *, ok: tuple[int, ...] = (200,)
    ) -> tuple[int, Any]:
        req = urllib.request.Request(  # noqa: S310 - tenant homeserver configured by operator
            self._url + path,
            data=None if body is None else json.dumps(body, separators=(",", ":")).encode(),
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
            },
            method=method,
        )
        try:
            with self._opener.open(req, timeout=self._timeout) as response:
                raw = response.read(65536)
                status = response.status
        except urllib.error.HTTPError as exc:
            exc.close()
            if exc.code in ok:
                return exc.code, {}
            raise ExtensionRefusedError("import_matrix_transport_refused", 502) from None
        except (urllib.error.URLError, OSError, http.client.HTTPException):
            raise ExtensionRefusedError("import_matrix_unavailable", 503) from None
        try:
            return status, json.loads(raw) if raw else {}
        except ValueError:
            raise ExtensionRefusedError("import_matrix_transport_refused", 502) from None

    def resolve_channel_room(self, channel_id: UUID) -> str | None:
        if not self.server_name:
            return None
        alias = f"#kodera-ch-{channel_id}:{self.server_name}"
        status, answer = self._call(
            "GET",
            f"/_matrix/client/v3/directory/room/{self._q(alias)}",
            ok=(200, 404),
        )
        if status == 200 and isinstance(answer, dict) and isinstance(answer.get("room_id"), str):
            return answer["room_id"]
        return None

    def send_message(self, *, room_id: str, txn_id: str, content: dict[str, Any]) -> str:
        _, answer = self._call(
            "PUT",
            f"/_matrix/client/v3/rooms/{self._q(room_id)}/send/m.room.message/{self._q(txn_id)}",
            content,
        )
        event_id = answer.get("event_id") if isinstance(answer, dict) else None
        if not isinstance(event_id, str) or not event_id.startswith("$"):
            raise ExtensionRefusedError("import_matrix_transport_refused", 502)
        return event_id

    def redact_message(
        self, *, room_id: str, event_id: str, txn_id: str, reason: str = "authority_revoked"
    ) -> str | None:
        _, answer = self._call(
            "PUT",
            f"/_matrix/client/v3/rooms/{self._q(room_id)}/redact/{self._q(event_id)}/{self._q(txn_id)}",
            {"reason": reason[:200]},
            ok=(200, 404),
        )
        if isinstance(answer, dict) and isinstance(answer.get("event_id"), str):
            return answer["event_id"]
        return None


def try_compensating_redact(
    matrix_transport: Any, *, room_id: str, event_id: str, txn_id: str, reason: str
) -> None:
    redact_fn = getattr(matrix_transport, "redact_message", None)
    if callable(redact_fn):
        try:
            redact_fn(room_id=room_id, event_id=event_id, txn_id=txn_id, reason=reason)
        except Exception:  # noqa: BLE001 - best-effort compensating redaction before surfacing 403/410
            logging.getLogger(__name__).warning(
                "compensating_matrix_redaction_failed room_id=%s event_id=%s", room_id, event_id
            )


def deterministic_matrix_txn_id(workspace_id: UUID, source: str, external_key: str) -> str:
    digest = hashlib.sha256(f"{workspace_id}:{source}:{external_key}".encode()).hexdigest()[:32]
    return f"kodera-imp-{digest}"


def _validate_source_and_raw(source: str, raw: bytes) -> None:
    if (
        source not in {"slack", "discord", "notion"}
        or not isinstance(raw, bytes)
        or not 0 < len(raw) <= MAX_ARCHIVE
    ):
        raise ExtensionRefusedError("import_source_or_size_invalid")


def preview(
    *,
    verified: Any,
    organisation_id: UUID,
    source: str,
    raw: bytes,
    channel_map: Mapping[str, UUID] | None = None,
) -> dict[str, Any]:
    """Zero-mutation dry-run simulation; runs inside a PostgreSQL read-only transaction."""
    _validate_source_and_raw(source, raw)
    parsed = parse(source, raw)
    archive_sha256 = hashlib.sha256(raw).hexdigest()

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL transaction_read_only = on")
        workspace_id, principal = read_admin(verified, organisation_id)
        member_match = match_external_users(
            organisation_id=organisation_id, external_users=parsed.external_users
        )

        workspace_channels = workspaces.importable_channel_snapshots(workspace_id=workspace_id)
        channels_by_id = {ch.id: ch for ch in workspace_channels}
        channels_by_name: dict[str, list[workspaces.ChannelSnapshot]] = {}
        for ch in workspace_channels:
            channels_by_name.setdefault(ch.name.casefold(), []).append(ch)

        channels_existing = 0
        channels_to_create = 0
        confidential_skipped = False

        if channel_map:
            for mapped_id in channel_map.values():
                target_ch = channels_by_id.get(mapped_id)
                if target_ch is not None:
                    require_channel_post(
                        channel_id=target_ch.id,
                        membership_id=principal.membership_id,
                        organisation_id=organisation_id,
                        allow_confidential_preview=True,
                    )
                if target_ch is not None and target_ch.is_confidential:
                    confidential_skipped = True

        for imp_ch in parsed.channels:
            mapped_uuid = (
                (channel_map.get(imp_ch.external_id) or channel_map.get(imp_ch.external_key))
                if channel_map
                else None
            )
            if mapped_uuid is not None:
                target_ch = channels_by_id.get(mapped_uuid)
                if target_ch is None:
                    channels_to_create += 1
                elif target_ch.is_confidential:
                    confidential_skipped = True
                else:
                    channels_existing += 1
            else:
                candidates = channels_by_name.get(imp_ch.name.casefold(), [])
                non_conf = [c for c in candidates if not c.is_confidential]
                if non_conf:
                    for candidate in non_conf:
                        require_channel_post(
                            channel_id=candidate.id,
                            membership_id=principal.membership_id,
                            organisation_id=organisation_id,
                            allow_confidential_preview=True,
                        )
                    channels_existing += 1
                elif candidates:
                    confidential_skipped = True
                else:
                    channels_to_create += 1

        matrix_mode = source in {"slack", "discord"} and channel_map is not None
        if matrix_mode:
            candidate_hashes = {msg.external_key: msg.sha256 for msg in parsed.messages}
        else:
            candidate_hashes = {item.external_key: item.sha256 for item in parsed.items}

        existing_objects = (
            {
                row.external_key: row.source_sha256
                for row in ImportedObject.objects.filter(
                    workspace_id=workspace_id,
                    source=source,
                    external_key__in=list(candidate_hashes.keys()),
                ).only("external_key", "source_sha256")
            }
            if candidate_hashes
            else {}
        )
        already_imported_reused = sum(
            1
            for ext_key, digest in candidate_hashes.items()
            if existing_objects.get(ext_key) == digest
        )

        collections_total = sum(1 for item in parsed.items if bool(item.properties))
        collection_rows_total = sum(1 for item in parsed.items if item.collection_key is not None)
        docs_pages_total = (
            sum(1 for item in parsed.items if item.collection_key is None)
            if source == "notion"
            else 0
        )

        doc_items_needed = 0 if matrix_mode else (len(parsed.items) - already_imported_reused)
        quota_exceeded = False
        page_limit = workspaces.workspace_page_limit(workspace_id=workspace_id)
        if page_limit is not None and doc_items_needed > 0:
            used_pages = workspaces.workspace_pages_used(workspace_id=workspace_id)
            if used_pages + doc_items_needed > page_limit:
                quota_exceeded = True

        warnings: list[str] = []
        if member_match.external_admin_privilege_ignored:
            warnings.append("external_admin_privilege_ignored")
        if confidential_skipped:
            warnings.append("confidential_target_channel_skipped")
        if parsed.omitted_assets > 0:
            warnings.append("unsupported_assets_omitted")
        if quota_exceeded:
            warnings.append("quota_headroom_exceeded")

        return {
            "source": source,
            "archive_sha256": archive_sha256,
            "dry_run": True,
            "counts": {
                "channels_total": len(parsed.channels),
                "channels_existing": channels_existing,
                "channels_to_create": channels_to_create,
                "messages_total": len(parsed.messages),
                "thread_replies_total": sum(
                    1 for msg in parsed.messages if msg.thread_parent_key is not None
                ),
                "docs_pages_total": docs_pages_total,
                "collections_total": collections_total,
                "collection_rows_total": collection_rows_total,
                "members_matched": member_match.matched_count,
                "members_unmatched": member_match.unmatched_count,
                "already_imported_reused": already_imported_reused,
                "omitted_assets": parsed.omitted_assets,
            },
            "member_mappings": response_member_mappings(member_match, warnings),
            "warnings": warnings,
        }


@transaction.atomic
def start(*, verified, organisation_id: UUID, source: str, raw: bytes) -> ImportBatch:
    workspace_id, principal = admin(verified, organisation_id)
    _validate_source_and_raw(source, raw)
    batch, created = ImportBatch.objects.get_or_create(
        workspace_id=workspace_id,
        source=source,
        archive_sha256=hashlib.sha256(raw).hexdigest(),
        defaults={"creator_id": principal.membership_id},
    )
    if created:
        audit(
            "import_started",
            principal,
            organisation_id,
            batch.id,
            {"source": source, "archive_sha256": batch.archive_sha256},
        )
    return batch


def source_object(workspace_id, source, external_key):
    row = (
        ImportedObject.objects.select_for_update()
        .filter(workspace_id=workspace_id, source=source, external_key=external_key)
        .first()
    )
    if row is None:
        raise ExtensionRefusedError("import_parent_not_ready", 409)
    return row


def _schema_compatible(
    frozen_properties: tuple[dict[str, Any], ...], actual_properties: Any
) -> bool:
    expected = {prop["id"]: prop for prop in frozen_properties}
    actual = {prop["id"]: prop for prop in actual_properties}
    for key, frozen_prop in expected.items():
        current_prop = actual.get(key)
        if current_prop is None or current_prop.get("type") != frozen_prop["type"]:
            return False
        if frozen_prop["type"] == "select":
            expected_opts = {opt["id"] for opt in frozen_prop.get("options", ())}
            actual_opts = {opt["id"] for opt in current_prop.get("options", ())}
            if not expected_opts <= actual_opts:
                return False
    return True


@transaction.atomic
def apply_item(
    *,
    verified,
    organisation_id: UUID,
    batch_id: UUID,
    item: Item,
    frozen_collection: Item | None = None,
) -> tuple[UUID, bool]:
    workspace_id, principal = admin(verified, organisation_id)
    batch = ImportBatch.objects.select_for_update().get(id=batch_id, workspace_id=workspace_id)
    old = (
        ImportedObject.objects.select_for_update()
        .filter(workspace_id=workspace_id, source=batch.source, external_key=item.external_key)
        .first()
    )
    if old is not None:
        if old.source_sha256 != item.sha256 or old.document_id is None:
            raise ExtensionRefusedError("import_source_changed", 409)
        documents.resource(
            workspace_id=workspace_id,
            principal=principal,
            verified=verified,
            document_id=old.document_id,
            edit=True,
        )
        if old.collection_id is not None:
            collections.get(workspace_id, old.collection_id, principal, True)
        return old.document_id, False
    typed = None
    row_collection_id = None
    if item.collection_key is not None:
        table = source_object(workspace_id, batch.source, item.collection_key)
        if (
            table.collection_id is None
            or item.values is None
            or frozen_collection is None
            or frozen_collection.external_key != item.collection_key
            or not frozen_collection.properties
        ):
            raise ExtensionRefusedError("import_collection_binding_invalid", 409)
        model = collections.get(workspace_id, table.collection_id, principal, True)
        expected = {prop["id"]: prop["type"] for prop in frozen_collection.properties}
        # The archive's inferred CSV types are frozen source data. User schema edits never
        # reinterpret them; refuse before any native row document is created or transformed.
        if (
            table.source_sha256 != frozen_collection.sha256
            or item.values.keys() != expected.keys()
            or not _schema_compatible(frozen_collection.properties, model.properties)
        ):
            raise ExtensionRefusedError("import_collection_schema_changed", 409)
        typed = {key: {"type": expected[key], "value": value} for key, value in item.values.items()}
        row_collection_id = table.collection_id
    parent_id = None
    if item.parent_key is not None:
        parent_row = source_object(workspace_id, batch.source, item.parent_key)
        if parent_row.document_id is None:
            raise ExtensionRefusedError("import_parent_not_ready", 409)
        parent_id = parent_row.document_id
    created = documents.create(
        verified=verified,
        organisation_id=organisation_id,
        name=item.title,
        parent_id=parent_id,
        template_key=None,
        request_id=str(batch.id),
    )
    document_id = UUID(created["id"])
    if item.markdown:
        documents.patch(
            verified=verified,
            organisation_id=organisation_id,
            document_id=document_id,
            changes={"markdown": item.markdown},
            if_match=documents.tag(created),
            request_id=str(batch.id),
        )
    collection_id = None
    if item.properties:
        collection = collections.create(
            verified=verified,
            organisation_id=organisation_id,
            body={"title": item.title, "properties": list(item.properties), "views": []},
            request_id=str(batch.id),
        )
        collection_id = UUID(collection["id"])
    if typed is not None:
        collections.put_row(
            verified=verified,
            organisation_id=organisation_id,
            collection_id=row_collection_id,
            document_id=document_id,
            body={"values": typed},
            if_match="",
            if_none_match="*",
            request_id=str(batch.id),
        )
    ImportedObject.objects.create(
        workspace_id=workspace_id,
        source=batch.source,
        external_key=item.external_key,
        source_sha256=item.sha256,
        document_id=document_id,
        collection_id=collection_id,
        batch=batch,
    )
    audit(
        "object_imported",
        principal,
        organisation_id,
        batch.id,
        {"source": batch.source, "document_id": str(document_id), "source_sha256": item.sha256},
    )
    return document_id, True


def _validate_target_channel_locked(
    channel: workspaces.ChannelSnapshot | None,
) -> workspaces.ChannelSnapshot:
    if (
        channel is None
        or channel.kind != "text"
        or channel.lifecycle in {"deletion_pending", "deleted"}
    ):
        raise ExtensionRefusedError("import_target_channel_unavailable", 404)
    if channel.is_confidential:
        raise ExtensionRefusedError("import_confidential_channel_refused", 403)
    if channel.room_state == "failed":
        raise ExtensionRefusedError("import_matrix_unavailable", 503)
    return channel


def _prepare_or_queue_matrix_step(
    *,
    verified: Any,
    organisation_id: UUID,
    batch_id: UUID,
    message: ImportedMessage,
    target_channel_id: UUID,
    queue_only: bool = False,
) -> tuple[UUID, str | None, str, dict[str, Any] | None, str]:
    """Under canonical lock, validate channel/authority and either queue or prepare Matrix replay."""
    with transaction.atomic():
        workspace_id, principal = admin(verified, organisation_id)
        batch = ImportBatch.objects.select_for_update().get(id=batch_id, workspace_id=workspace_id)
        channel = _validate_target_channel_locked(
            workspaces.channel_snapshot(
                channel_id=target_channel_id, workspace_id=workspace_id, for_update=True
            )
        )
        require_channel_post(
            channel_id=channel.id,
            membership_id=principal.membership_id,
            organisation_id=organisation_id,
            confidential_reason="import_confidential_channel_refused",
        )
        old = (
            ImportedObject.objects.select_for_update()
            .filter(
                workspace_id=workspace_id, source=batch.source, external_key=message.external_key
            )
            .first()
        )
        txn_id = deterministic_matrix_txn_id(workspace_id, batch.source, message.external_key)
        if old is not None:
            if old.source_sha256 != message.sha256 or old.document_id is not None:
                raise ExtensionRefusedError("import_source_changed", 409)
            if old.replay_state == "replayed" and old.matrix_event_id is not None:
                return (
                    workspace_id,
                    old.matrix_event_id,
                    old.matrix_txn_id or txn_id,
                    None,
                    "reused",
                )
            if old.replay_state == "queued_matrix":
                if queue_only:
                    return workspace_id, None, old.matrix_txn_id or txn_id, None, "reused_queued"
            else:
                raise ExtensionRefusedError("import_source_changed", 409)

        attribution = inert_author_attribution(
            batch.source, message.author_external_id, message.author_display_name
        )
        body_text = f"{attribution}\nSource timestamp: {message.timestamp}\n\n{message.text}"

        if queue_only:
            if message.thread_parent_key is not None:
                parent_row = source_object(workspace_id, batch.source, message.thread_parent_key)
                if parent_row.channel_id is None or parent_row.replay_state not in {
                    "queued_matrix",
                    "replayed",
                }:
                    raise ExtensionRefusedError("import_parent_not_ready", 409)
            ImportedObject.objects.create(
                workspace_id=workspace_id,
                source=batch.source,
                external_key=message.external_key,
                source_sha256=message.sha256,
                document=None,
                channel_id=channel.id,
                matrix_txn_id=txn_id,
                matrix_event_id=None,
                replay_state="queued_matrix",
                thread_parent_key=message.thread_parent_key,
                replay_payload={"body": body_text},
                batch=batch,
            )
            audit(
                "message_queued",
                principal,
                organisation_id,
                batch.id,
                {
                    "source": batch.source,
                    "channel_id": str(channel.id),
                    "matrix_txn_id": txn_id,
                    "source_sha256": message.sha256,
                },
            )
            return workspace_id, None, txn_id, None, "queued"

        parent_event_id: str | None = None
        if message.thread_parent_key is not None:
            parent_row = source_object(workspace_id, batch.source, message.thread_parent_key)
            if parent_row.matrix_event_id is None:
                raise ExtensionRefusedError("import_parent_not_ready", 409)
            parent_event_id = parent_row.matrix_event_id
        content: dict[str, Any] = {
            "msgtype": "m.text",
            "body": body_text,
        }
        if parent_event_id is not None:
            content["m.relates_to"] = {
                "rel_type": "m.thread",
                "event_id": parent_event_id,
            }
        return workspace_id, None, txn_id, content, "ready"


@transaction.atomic
def _commit_matrix_step(
    *,
    verified: Any,
    organisation_id: UUID,
    batch_id: UUID,
    message: ImportedMessage,
    target_channel_id: UUID,
    txn_id: str,
    event_id: str,
) -> tuple[str, bool]:
    workspace_id, principal = admin(verified, organisation_id)
    batch = ImportBatch.objects.select_for_update().get(id=batch_id, workspace_id=workspace_id)
    channel = _validate_target_channel_locked(
        workspaces.channel_snapshot(
            channel_id=target_channel_id, workspace_id=workspace_id, for_update=True
        )
    )
    require_channel_post(
        channel_id=channel.id,
        membership_id=principal.membership_id,
        organisation_id=organisation_id,
        confidential_reason="import_confidential_channel_refused",
    )
    old = (
        ImportedObject.objects.select_for_update()
        .filter(workspace_id=workspace_id, source=batch.source, external_key=message.external_key)
        .first()
    )
    if old is not None:
        if old.source_sha256 != message.sha256 or old.document_id is not None:
            raise ExtensionRefusedError("import_source_changed", 409)
        if old.replay_state == "replayed" and old.matrix_event_id is not None:
            return old.matrix_event_id, False
        if old.replay_state != "queued_matrix":
            raise ExtensionRefusedError("import_source_changed", 409)
        old.replay_state = "replayed"
        old.matrix_event_id = event_id
        old.replay_payload = None
        old.save(update_fields=["replay_state", "matrix_event_id", "replay_payload", "updated_at"])
    else:
        ImportedObject.objects.create(
            workspace_id=workspace_id,
            source=batch.source,
            external_key=message.external_key,
            source_sha256=message.sha256,
            document=None,
            channel_id=channel.id,
            matrix_txn_id=txn_id,
            matrix_event_id=event_id,
            replay_state="replayed",
            thread_parent_key=message.thread_parent_key,
            replay_payload=None,
            batch=batch,
        )
    audit(
        "message_replayed",
        principal,
        organisation_id,
        batch.id,
        {
            "source": batch.source,
            "channel_id": str(channel.id),
            "matrix_txn_id": txn_id,
            "source_sha256": message.sha256,
        },
    )
    return event_id, True


@transaction.atomic
def checkpoint(*, verified, organisation_id, batch_id, report):
    workspace_id, _ = admin(verified, organisation_id)
    row = ImportBatch.objects.select_for_update().get(id=batch_id, workspace_id=workspace_id)
    row.report = report
    row.state = "complete" if report["complete"] else "partial"
    row.save(update_fields=["report", "state", "updated_at"])


def replay_matrix(
    *,
    verified: Any,
    organisation_id: UUID,
    source: str,
    raw: bytes,
    channel_map: Mapping[str, UUID],
    matrix_transport: MatrixReplayTransport | None = None,
    room_map: Mapping[UUID, str] | None = None,
    limit: int = 25,
) -> dict[str, Any]:
    """Replay or durably queue exported channel/thread history into non-confidential Matrix rooms."""
    if type(limit) is not int or not 1 <= limit <= 25:
        raise ExtensionRefusedError("import_batch_limit")
    if source not in {"slack", "discord"}:
        raise ExtensionRefusedError("import_matrix_source_unsupported")
    if not isinstance(channel_map, Mapping) or not channel_map:
        raise ExtensionRefusedError("import_target_channel_missing")

    parsed: Parsed = parse(source, raw)
    # Pre-check every mapped channel under canonical lock BEFORE starting batch writes so
    # confidential targets refuse with 403 even when `matrix_transport` is None (`ADR-0003`).
    with transaction.atomic():
        workspace_id, principal = admin(verified, organisation_id)
        for ch_uuid in set(channel_map.values()):
            channel = _validate_target_channel_locked(
                workspaces.channel_snapshot(
                    channel_id=ch_uuid, workspace_id=workspace_id, for_update=True
                )
            )
            require_channel_post(
                channel_id=channel.id,
                membership_id=principal.membership_id,
                organisation_id=organisation_id,
                confidential_reason="import_confidential_channel_refused",
            )
        member_match = match_external_users(
            organisation_id=organisation_id, external_users=parsed.external_users
        )

    batch = start(verified=verified, organisation_id=organisation_id, source=source, raw=raw)
    outcomes: list[dict[str, Any]] = []
    attempted = 0
    resolved_rooms: dict[UUID, str] = dict(room_map) if room_map is not None else {}

    for msg in parsed.messages:
        if attempted >= limit:
            break
        target_channel_id = channel_map.get(msg.channel_external_id) or channel_map.get(
            msg.channel_key
        )
        if target_channel_id is None:
            outcomes.append(
                {
                    "key": msg.external_key,
                    "outcome": "refused",
                    "status": 422,
                    "reason": "import_target_channel_missing",
                }
            )
            attempted += 1
            continue
        try:
            if matrix_transport is None:
                _, _, txn_id, _, step_status = _prepare_or_queue_matrix_step(
                    verified=verified,
                    organisation_id=organisation_id,
                    batch_id=batch.id,
                    message=msg,
                    target_channel_id=target_channel_id,
                    queue_only=True,
                )
                created_queue = step_status == "queued"
                outcomes.append(
                    {
                        "key": msg.external_key,
                        "channel_id": str(target_channel_id),
                        "matrix_txn_id": txn_id,
                        "matrix_event_id": None,
                        "outcome": "queued" if created_queue else "reused",
                    }
                )
                attempted += int(created_queue)
                continue

            # Resolve Matrix room BEFORE acquiring the pre-send authority fence so no network
            # resolution runs between the authority check and the idempotent Matrix PUT.
            room_id = resolved_rooms.get(target_channel_id)
            if room_id is None and hasattr(matrix_transport, "resolve_channel_room"):
                room_id = matrix_transport.resolve_channel_room(target_channel_id)
                if room_id is not None:
                    resolved_rooms[target_channel_id] = room_id
            if not room_id:
                raise ExtensionRefusedError("import_matrix_room_unready", 409)

            _, existing_event_id, txn_id, content, _ = _prepare_or_queue_matrix_step(
                verified=verified,
                organisation_id=organisation_id,
                batch_id=batch.id,
                message=msg,
                target_channel_id=target_channel_id,
                queue_only=False,
            )
            if existing_event_id is not None:
                outcomes.append(
                    {
                        "key": msg.external_key,
                        "channel_id": str(target_channel_id),
                        "matrix_txn_id": txn_id,
                        "matrix_event_id": existing_event_id,
                        "outcome": "reused",
                    }
                )
                continue
            if content is None:
                raise ExtensionRefusedError("import_matrix_room_unready", 409)

            sent_event_id = matrix_transport.send_message(
                room_id=room_id, txn_id=txn_id, content=content
            )
            try:
                event_id, created = _commit_matrix_step(
                    verified=verified,
                    organisation_id=organisation_id,
                    batch_id=batch.id,
                    message=msg,
                    target_channel_id=target_channel_id,
                    txn_id=txn_id,
                    event_id=sent_event_id,
                )
            except ExtensionRefusedError as commit_refused:
                if commit_refused.status in {401, 403, 410}:
                    try_compensating_redact(
                        matrix_transport,
                        room_id=room_id,
                        event_id=sent_event_id,
                        txn_id=f"{txn_id}-redact",
                        reason="import_authority_revoked",
                    )
                raise
            outcomes.append(
                {
                    "key": msg.external_key,
                    "channel_id": str(target_channel_id),
                    "matrix_txn_id": txn_id,
                    "matrix_event_id": event_id,
                    "outcome": "created" if created else "reused",
                }
            )
            attempted += int(created)
        except ExtensionRefusedError as refused:
            if refused.status in {401, 403, 410}:
                raise
            outcomes.append(
                {
                    "key": msg.external_key,
                    "outcome": "refused",
                    "status": refused.status,
                    "reason": str(refused),
                }
            )
            attempted += 1

    queued_count = sum(1 for row in outcomes if row["outcome"] == "queued")
    replayed_count = sum(1 for row in outcomes if row["outcome"] == "created")
    reused_count = sum(1 for row in outcomes if row["outcome"] == "reused")
    still_queued_in_db = ImportedObject.objects.filter(
        batch=batch, replay_state="queued_matrix"
    ).exists()
    complete = (
        len(outcomes) == len(parsed.messages)
        and queued_count == 0
        and not still_queued_in_db
        and all(row["outcome"] in {"created", "reused"} for row in outcomes)
    )
    warnings: list[str] = []
    if member_match.external_admin_privilege_ignored:
        warnings.append("external_admin_privilege_ignored")
    if parsed.omitted_assets > 0:
        warnings.append("unsupported_assets_omitted")
    report = {
        "batch_id": str(batch.id),
        "source": source,
        "state": "complete" if complete else "partial",
        "archive_sha256": batch.archive_sha256,
        "complete": complete,
        "omitted_assets": parsed.omitted_assets,
        "queued_messages": queued_count,
        "replayed_messages": replayed_count,
        "reused_messages": reused_count,
        "remaining": max(0, len(parsed.messages) - len(outcomes)),
        "member_mappings": response_member_mappings(member_match, warnings),
        "warnings": warnings,
        "objects": outcomes,
    }
    checkpoint(verified=verified, organisation_id=organisation_id, batch_id=batch.id, report=report)
    return report


def _lock_and_verify_batch_creator_authority(
    *, object_id: UUID
) -> tuple[UUID, ImportBatch, ImportedObject, workspaces.ChannelSnapshot]:
    """Acquire canonical `advisories -> m -> i -> u -> o -> w` locks for queued worker replay."""
    initial = ImportedObject.objects.select_related("batch").filter(id=object_id).first()
    if initial is None or initial.channel_id is None:
        raise ExtensionRefusedError("import_object_absent", 404)
    org_id: UUID = workspaces.workspace_organisation(workspace_id=initial.workspace_id)
    if not organisation_exists(organisation_id=org_id):
        raise ExtensionRefusedError("extension_workspace_absent", 404)
    if WorkspaceCutoff.objects.filter(organisation_id=org_id).exists():
        raise ExtensionRefusedError("extension_workspace_cut_off", 410)

    creator_membership_id: UUID = initial.batch.creator_id
    creator_user_id: UUID = organisations.membership_user_id(membership_id=initial.batch.creator_id)
    initial_identity = identities.first_organisation_identity_id(
        organisation_id=org_id, user_id=creator_user_id
    )
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
    if not organisations.active_organisation(organisation_id=org_id):
        raise ExtensionRefusedError("extension_organisation_inactive", 403)

    creator_active = (
        organisations.current_admin_role(
            membership_id=creator_membership_id, organisation_id=org_id
        )
        is not None
        and identities.enabled_user(user_id=locked_user_id)
        and identities.delivery_identity_exists(organisation_id=org_id, user_id=locked_user_id)
    )
    if not creator_active:
        raise ExtensionRefusedError("import_creator_authority_revoked", 403)

    batch = ImportBatch.objects.select_for_update().get(id=initial.batch_id)
    row = ImportedObject.objects.select_for_update().get(id=object_id)
    if row.channel_id is None:
        raise ExtensionRefusedError("import_object_absent", 404)
    channel = _validate_target_channel_locked(
        workspaces.channel_snapshot(
            channel_id=row.channel_id, workspace_id=row.workspace_id, for_update=True
        )
    )
    require_channel_post(
        channel_id=channel.id,
        membership_id=creator_membership_id,
        organisation_id=org_id,
        confidential_reason="import_confidential_channel_refused",
    )
    return org_id, batch, row, channel


def drain_queued_matrix_imports(
    *,
    matrix_transport: MatrixReplayTransport,
    organisation_id: UUID | None = None,
    room_map: Mapping[UUID, str] | None = None,
    limit: int = 25,
) -> dict[str, int]:
    """Drain `queued_matrix` `ImportedObject` rows over `SynapseReplayTransport` in causal order."""
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ExtensionRefusedError("import_batch_limit")
    qs = ImportedObject.objects.filter(replay_state="queued_matrix").order_by("created_at", "id")
    if organisation_id is not None:
        qs = qs.filter(workspace__organisation_id=organisation_id)
    candidates = list(qs.values_list("id", "channel_id")[:limit])
    resolved_rooms: dict[UUID, str] = dict(room_map) if room_map is not None else {}

    replayed = 0
    skipped_unready = 0
    obsoleted = 0

    for obj_id, ch_id in candidates:
        if ch_id is None:
            continue
        room_id = resolved_rooms.get(ch_id)
        if room_id is None and hasattr(matrix_transport, "resolve_channel_room"):
            room_id = matrix_transport.resolve_channel_room(ch_id)
            if room_id is not None:
                resolved_rooms[ch_id] = room_id
        if not room_id:
            skipped_unready += 1
            continue

        try:
            with transaction.atomic():
                _, _, locked_row, _ = _lock_and_verify_batch_creator_authority(object_id=obj_id)
                if locked_row.replay_state != "queued_matrix" or not isinstance(
                    locked_row.replay_payload, dict
                ):
                    continue
                txn_id = locked_row.matrix_txn_id or ""
                body_text = str(locked_row.replay_payload.get("body", ""))
                parent_event_id: str | None = None
                if locked_row.thread_parent_key is not None:
                    parent_row = source_object(
                        locked_row.workspace_id, locked_row.source, locked_row.thread_parent_key
                    )
                    if parent_row.matrix_event_id is None:
                        skipped_unready += 1
                        continue
                    parent_event_id = parent_row.matrix_event_id
                content: dict[str, Any] = {"msgtype": "m.text", "body": body_text}
                if parent_event_id is not None:
                    content["m.relates_to"] = {
                        "rel_type": "m.thread",
                        "event_id": parent_event_id,
                    }
        except ExtensionRefusedError as pre_err:
            if pre_err.status in {403, 404, 410}:
                with transaction.atomic():
                    ImportedObject.objects.filter(id=obj_id, replay_state="queued_matrix").update(
                        replay_state="obsolete", replay_payload=None
                    )
                obsoleted += 1
                continue
            skipped_unready += 1
            continue

        sent_event_id = matrix_transport.send_message(
            room_id=room_id, txn_id=txn_id, content=content
        )

        try:
            with transaction.atomic():
                _, batch, locked_row, _ = _lock_and_verify_batch_creator_authority(object_id=obj_id)
                if locked_row.replay_state == "queued_matrix":
                    locked_row.replay_state = "replayed"
                    locked_row.matrix_event_id = sent_event_id
                    locked_row.replay_payload = None
                    locked_row.save(
                        update_fields=[
                            "replay_state",
                            "matrix_event_id",
                            "replay_payload",
                            "updated_at",
                        ]
                    )
                    if (
                        not ImportedObject.objects.filter(
                            batch=batch, replay_state="queued_matrix"
                        ).exists()
                        and isinstance(batch.report, dict)
                        and batch.report.get("remaining", 0) == 0
                    ):
                        updated_report = dict(batch.report)
                        updated_report["complete"] = True
                        updated_report["state"] = "complete"
                        updated_report["queued_messages"] = 0
                        updated_report["replayed_messages"] = ImportedObject.objects.filter(
                            batch=batch, replay_state="replayed"
                        ).count()
                        batch.report = updated_report
                        batch.state = "complete"
                        batch.save(update_fields=["report", "state", "updated_at"])
                    replayed += 1
        except ExtensionRefusedError as post_err:
            if post_err.status in {401, 403, 404, 410}:
                try_compensating_redact(
                    matrix_transport,
                    room_id=room_id,
                    event_id=sent_event_id,
                    txn_id=f"{txn_id}-redact",
                    reason="import_authority_revoked",
                )
                with transaction.atomic():
                    ImportedObject.objects.filter(id=obj_id, replay_state="queued_matrix").update(
                        replay_state="obsolete", replay_payload=None
                    )
                obsoleted += 1
                continue
            raise

    return {"replayed": replayed, "skipped_unready": skipped_unready, "obsoleted": obsoleted}


def execute(
    *,
    verified,
    organisation_id: UUID,
    source: str,
    raw: bytes,
    limit: int = 25,
    dry_run: bool = False,
    channel_map: Mapping[str, UUID] | None = None,
    room_map: Mapping[UUID, str] | None = None,
    matrix_transport: MatrixReplayTransport | None = None,
) -> dict[str, Any]:
    if type(dry_run) is not bool:
        raise ExtensionRefusedError("import_dry_run_invalid")
    if dry_run:
        return preview(
            verified=verified,
            organisation_id=organisation_id,
            source=source,
            raw=raw,
            channel_map=channel_map,
        )
    if type(limit) is not int or not 1 <= limit <= 25:
        raise ExtensionRefusedError("import_batch_limit")
    if channel_map is not None or matrix_transport is not None:
        if channel_map is None:
            raise ExtensionRefusedError("import_target_channel_missing")
        return replay_matrix(
            verified=verified,
            organisation_id=organisation_id,
            source=source,
            raw=raw,
            channel_map=channel_map,
            matrix_transport=matrix_transport,
            room_map=room_map,
            limit=limit,
        )
    batch = start(verified=verified, organisation_id=organisation_id, source=source, raw=raw)
    parsed = parse(source, raw)
    with transaction.atomic():
        admin(verified, organisation_id)
        member_match = match_external_users(
            organisation_id=organisation_id, external_users=parsed.external_users
        )
    frozen_items = {item.external_key: item for item in parsed.items}
    outcomes: list[dict[str, Any]] = []
    attempted = 0
    for item in parsed.items:
        # Existing records are re-authorized even on a completed replay. Native user edits are
        # preserved: an unchanged source reuses its id, never writes it again.
        if attempted >= limit:
            break
        try:
            document_id, created = apply_item(
                verified=verified,
                organisation_id=organisation_id,
                batch_id=batch.id,
                item=item,
                frozen_collection=frozen_items.get(item.collection_key)
                if item.collection_key
                else None,
            )
            outcomes.append(
                {
                    "key": item.external_key,
                    "document_id": str(document_id),
                    "outcome": "created" if created else "reused",
                }
            )
            attempted += int(created)
        except (ExtensionRefusedError, RefusalError) as refused:
            if refused.status in {401, 403, 410}:
                raise
            outcomes.append(
                {
                    "key": item.external_key,
                    "outcome": "refused",
                    "status": refused.status,
                    "reason": str(refused)
                    if isinstance(refused, ExtensionRefusedError)
                    else "native_document_refused",
                }
            )
            attempted += 1
        except IntegrityError as error:
            detail = violation(error)
            if detail is None:
                raise
            outcomes.append(
                {
                    "key": item.external_key,
                    "outcome": "refused",
                    "reason": "workspace_quota_exceeded",
                    "quota": detail,
                }
            )
            attempted += 1
    complete = len(outcomes) == len(parsed.items) and all(
        row["outcome"] in {"created", "reused"} for row in outcomes
    )
    warnings: list[str] = []
    if member_match.external_admin_privilege_ignored:
        warnings.append("external_admin_privilege_ignored")
    if parsed.omitted_assets > 0:
        warnings.append("unsupported_assets_omitted")
    imported_count = sum(1 for row in outcomes if row["outcome"] == "created")
    reused_count = sum(1 for row in outcomes if row["outcome"] == "reused")
    report: dict[str, Any] = {
        "batch_id": str(batch.id),
        "source": source,
        "state": "complete" if complete else "partial",
        "archive_sha256": batch.archive_sha256,
        "complete": complete,
        "imported": imported_count,
        "reused": reused_count,
        "remaining": max(0, len(parsed.items) - len(outcomes)),
        "omitted_assets": parsed.omitted_assets,
        "member_mappings": response_member_mappings(member_match, warnings),
        "warnings": warnings,
        "objects": outcomes,
    }
    checkpoint(verified=verified, organisation_id=organisation_id, batch_id=batch.id, report=report)
    return report
