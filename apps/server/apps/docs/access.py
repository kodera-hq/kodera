"""Immutable current-visibility port for authenticated inbox producers and readers."""

from collections.abc import Iterable
from uuid import UUID

from apps.orgs.actor_selectors import TenantCaller
from services.identity.access_tokens import VerifiedAccessToken

from . import services
from .errors import RefusalError
from .models import Document


def visible_document_ids(
    principal: TenantCaller,
    document_ids: Iterable[UUID],
    *,
    verified: VerifiedAccessToken,
) -> set[UUID]:
    ids = set(document_ids)
    if not ids:
        return set()
    try:
        workspace_id, current = services.read_context(verified, principal.organisation_id)
        if (current.membership_id, current.identity_id) != (
            principal.membership_id,
            principal.identity_id,
        ):
            return set()
    except RefusalError as error:
        if error.status in {403, 404}:
            return set()
        raise
    rows = list(
        Document.objects.filter(
            id__in=ids,
            workspace_id=workspace_id,
            deleted_at__isnull=True,
        )
        .annotate(_permission=services.role_expression(current, verified, "id"))
        .filter(_permission__isnull=False)
        .values_list("id", "_permission")
    )
    if any(permission not in {"editor", "viewer"} for _, permission in rows):
        raise RefusalError(503, "service-unavailable")
    return {doc_id for doc_id, _ in rows}


def document_visible(
    principal: TenantCaller, document_id: UUID, *, verified: VerifiedAccessToken
) -> bool:
    return document_id in visible_document_ids(principal, (document_id,), verified=verified)
