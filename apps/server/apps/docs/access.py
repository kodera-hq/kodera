"""Immutable current-visibility port for authenticated inbox producers and readers."""

from uuid import UUID

from apps.orgs.actor_selectors import TenantCaller
from services.identity.access_tokens import VerifiedAccessToken

from . import services
from .errors import RefusalError


def document_visible(
    principal: TenantCaller, document_id: UUID, *, verified: VerifiedAccessToken
) -> bool:
    try:
        workspace_id, current = services.context(verified, principal.organisation_id)
        if (current.membership_id, current.identity_id) != (
            principal.membership_id,
            principal.identity_id,
        ):
            return False
        services.resource(
            workspace_id=workspace_id, principal=current, verified=verified, document_id=document_id
        )
        return True
    except RefusalError as error:
        if error.status in {403, 404}:
            return False
        raise
