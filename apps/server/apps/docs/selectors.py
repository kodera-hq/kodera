"""Materialized document and collection values for other applications' policies."""

from datetime import datetime
from uuid import UUID

from django.db import connection

from .models import Collection, Document


def document_is_visible(
    *,
    document_id: UUID,
    organisation_id: UUID,
    membership_id: UUID,
    identity_id: UUID,
    issuer: str,
    subject: str,
) -> bool:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT docs_document_role(%s,%s,%s,%s,%s,%s)",
            [document_id, organisation_id, membership_id, identity_id, issuer, subject],
        )
        return cursor.fetchone()[0] in {"viewer", "editor"}


def digest_document_candidates(
    *,
    workspace_id: UUID,
    period_start: datetime,
    period_end: datetime,
) -> tuple[UUID, ...]:
    """The original first thousand candidates, before the caller's visibility filter."""
    return tuple(
        Document.objects.filter(
            workspace_id=workspace_id,
            deleted_at__isnull=True,
            updated_at__gte=period_start,
            updated_at__lt=period_end,
        )
        .order_by("id")
        .values_list("id", flat=True)[:1000]
    )


def digest_collections(
    *,
    workspace_id: UUID,
    period_start: datetime,
    period_end: datetime,
) -> tuple[UUID, ...]:
    return tuple(
        Collection.objects.filter(
            workspace_id=workspace_id,
            deleted_at__isnull=True,
            updated_at__gte=period_start,
            updated_at__lt=period_end,
        )
        .order_by("id")
        .values_list("id", flat=True)[:1000]
    )


def digest_collection_count(*, workspace_id: UUID, collection_ids: list[str]) -> int:
    return Collection.objects.filter(
        id__in=collection_ids, workspace_id=workspace_id, deleted_at__isnull=True
    ).count()
