"""Resumable native document imports; external source ids never impersonate Core principals."""

from __future__ import annotations

import hashlib
from typing import Any
from uuid import UUID

from django.db import IntegrityError, transaction

from apps.docs import collections, services as documents
from apps.docs.errors import RefusalError
from apps.workspaces.quotas import violation

from .import_parsers import Item, parse
from .models import ImportBatch, ImportedObject
from .services import admin, audit
from .wire import ExtensionRefusedError


@transaction.atomic
def start(*, verified, organisation_id: UUID, source: str, raw: bytes) -> ImportBatch:
    workspace_id, principal = admin(verified, organisation_id)
    if (
        source not in {"slack", "discord", "notion"}
        or not isinstance(raw, bytes)
        or not 0 < len(raw) <= 20 * 1024 * 1024
    ):
        raise ExtensionRefusedError("import_source_or_size_invalid")
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


@transaction.atomic
def apply_item(*, verified, organisation_id: UUID, batch_id: UUID, item: Item) -> tuple[UUID, bool]:
    workspace_id, principal = admin(verified, organisation_id)
    batch = ImportBatch.objects.select_for_update().get(id=batch_id, workspace_id=workspace_id)
    old = (
        ImportedObject.objects.select_for_update()
        .filter(workspace_id=workspace_id, source=batch.source, external_key=item.external_key)
        .first()
    )
    if old is not None:
        if old.source_sha256 != item.sha256:
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
    parent_id = None
    if item.parent_key is not None:
        parent_id = source_object(workspace_id, batch.source, item.parent_key).document_id
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
    if item.collection_key is not None:
        table = source_object(workspace_id, batch.source, item.collection_key)
        if table.collection_id is None or item.values is None:
            raise ExtensionRefusedError("import_collection_binding_invalid", 409)
        model = collections.get(workspace_id, table.collection_id, principal, True)
        definitions = {prop["id"]: prop["type"] for prop in model.properties}
        typed = {
            key: {"type": definitions[key], "value": value} for key, value in item.values.items()
        }
        collections.put_row(
            verified=verified,
            organisation_id=organisation_id,
            collection_id=table.collection_id,
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


@transaction.atomic
def checkpoint(*, verified, organisation_id, batch_id, report):
    workspace_id, _ = admin(verified, organisation_id)
    row = ImportBatch.objects.select_for_update().get(id=batch_id, workspace_id=workspace_id)
    row.report = report
    row.state = "complete" if report["complete"] else "partial"
    row.save(update_fields=["report", "state", "updated_at"])


def execute(*, verified, organisation_id: UUID, source: str, raw: bytes, limit: int = 25) -> dict:
    if type(limit) is not int or not 1 <= limit <= 25:
        raise ExtensionRefusedError("import_batch_limit")
    batch = start(verified=verified, organisation_id=organisation_id, source=source, raw=raw)
    parsed = parse(source, raw)
    outcomes: list[dict[str, Any]] = []
    attempted = 0
    for item in parsed.items:
        # Existing records are re-authorized even on a completed replay. Native user edits are
        # preserved: an unchanged source reuses its id, never writes it again.
        if attempted >= limit:
            break
        try:
            document_id, created = apply_item(
                verified=verified, organisation_id=organisation_id, batch_id=batch.id, item=item
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
            if refused.status in {401, 403}:
                raise
            outcomes.append(
                {
                    "key": item.external_key,
                    "outcome": "refused",
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
    report = {
        "batch_id": str(batch.id),
        "source": source,
        "archive_sha256": batch.archive_sha256,
        "complete": complete,
        "omitted_assets": parsed.omitted_assets,
        "objects": outcomes,
    }
    checkpoint(verified=verified, organisation_id=organisation_id, batch_id=batch.id, report=report)
    return report
