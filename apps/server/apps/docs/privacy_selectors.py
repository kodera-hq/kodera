"""Scoped materialized document projections and native bytes for private export workers."""

from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from django.db import connection

from .models import Collection, CollectionRow, Document, DocumentSnapshot, DocumentUpdate


class PrivacySourceRefusalError(Exception):
    """A native snapshot/journal cannot provide a complete export projection."""


@dataclass(frozen=True)
class ExportPart:
    kind: str
    identifier: UUID
    value: dict[str, Any] | bytes
    relative_path: str | None = None


def document_disclosure_context(*, identifier: UUID) -> tuple[UUID, UUID] | None:
    row = (
        Document.objects.filter(id=identifier, deleted_at__isnull=True)
        .values("workspace__organisation_id", "creator__user_id")
        .first()
    )
    if row is None:
        return None
    return row["workspace__organisation_id"], row["creator__user_id"]


def document_role_permitted(
    *,
    identifier: UUID,
    organisation_id: UUID,
    membership_id: UUID,
    identity_id: UUID,
    issuer: str,
    subject: str,
) -> bool:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT docs_document_role(%s,%s,%s,%s,%s,%s)",
            [identifier, organisation_id, membership_id, identity_id, issuer, subject],
        )
        return cursor.fetchone()[0] in {"editor", "viewer"}


def collection_export_permitted(
    *, identifier: UUID, scope: str, user_id: str, workspace_ids: tuple[UUID, ...]
) -> bool:
    rows = Collection.objects.filter(
        id=identifier, deleted_at__isnull=True, workspace_id__in=workspace_ids
    )
    if scope == "account":
        rows = rows.filter(creator__user_id=user_id)
    return rows.exists()


def document_export_parts(
    *,
    scope: str,
    user_id: str,
    workspace_ids: tuple[UUID, ...],
    permitted: Callable[[UUID], bool],
    max_journal_entries: int,
) -> Iterator[ExportPart]:
    if not connection.in_atomic_block:
        raise RuntimeError("private document export requires the capture transaction")
    rows = Document.objects.filter(workspace_id__in=workspace_ids, deleted_at__isnull=True)
    if scope == "account":
        rows = rows.filter(creator__user_id=user_id)
    for document in rows.order_by("id").iterator():
        if not permitted(document.id):
            continue
        snapshot = DocumentSnapshot.objects.select_for_update().filter(document=document).first()
        if snapshot is None:
            raise PrivacySourceRefusalError("native document snapshot absent")
        if not 0 <= snapshot.head_sequence - snapshot.sequence <= max_journal_entries:
            raise PrivacySourceRefusalError("native document journal incomplete")
        yield ExportPart(
            "document",
            document.id,
            {
                "id": document.id,
                "title": document.title,
                "parentId": document.parent_id,
                "revision": document.revision,
                "markdownProjection": document.markdown,
                "snapshotSequence": snapshot.sequence,
                "headSequence": snapshot.head_sequence,
                "format": "yjs-v1",
            },
        )
        prefix = f"native/{document.id}"
        yield ExportPart("document", document.id, bytes(snapshot.state), prefix + "/snapshot.bin")
        expected = snapshot.sequence + 1
        for update in (
            DocumentUpdate.objects.filter(
                document=document,
                sequence__gt=snapshot.sequence,
                sequence__lte=snapshot.head_sequence,
            )
            .order_by("sequence")
            .iterator(chunk_size=1)
        ):
            if update.sequence != expected:
                raise PrivacySourceRefusalError("native document journal incomplete")
            expected += 1
            yield ExportPart(
                "document",
                document.id,
                bytes(update.state),
                prefix + f"/update_{update.sequence}.bin",
            )
        if expected != snapshot.head_sequence + 1:
            raise PrivacySourceRefusalError("native document journal incomplete")


def collection_export_parts(
    *,
    scope: str,
    user_id: str,
    workspace_ids: tuple[UUID, ...],
    permitted: Callable[[UUID], bool],
) -> Iterator[ExportPart]:
    rows = Collection.objects.filter(workspace_id__in=workspace_ids, deleted_at__isnull=True)
    if scope == "account":
        rows = rows.filter(creator__user_id=user_id)
    for row in rows.order_by("id").iterator():
        yield ExportPart(
            "collection",
            row.id,
            {
                "id": row.id,
                "title": row.title,
                "properties": row.properties,
                "views": row.views,
                "revision": row.revision,
            },
        )
        for member in CollectionRow.objects.filter(collection=row).order_by("id").iterator():
            if permitted(member.document_id):
                # Both collection and document authority are necessary for this row.
                yield ExportPart(
                    "document",
                    member.document_id,
                    {
                        "collectionId": row.id,
                        "documentId": member.document_id,
                        "values": member.values,
                    },
                    f"rows/{row.id}/{member.document_id}.json",
                )
