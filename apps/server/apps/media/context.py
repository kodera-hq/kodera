"""Current persisted membership, workspace access and non-disclosing audit records."""

from uuid import UUID

from django.db import connection

from apps.audit.services import record_workspace_resource_event
from apps.identity.selectors import current_identity
from apps.orgs.actor_selectors import TenantCaller
from apps.workspaces.moderation import RefusalError as WorkspaceRefusal, authorise_workspace
from services.identity.access_tokens import VerifiedAccessToken


class RefusalError(ValueError):
    def __init__(self, status: int, kind: str | None = None, reason: str | None = None) -> None:
        super().__init__("workspace request refused")
        self.status, self.kind, self.reason = status, kind, reason


def caller(verified: VerifiedAccessToken, organisation_id: UUID | None = None) -> TenantCaller:
    if not connection.in_atomic_block:
        raise RuntimeError("workspace access is read in the operation transaction")
    if organisation_id is None:
        resolved = current_identity(issuer=verified.issuer, subject=verified.subject)
        if resolved is None:
            raise RefusalError(403, "identity-unknown")
        organisation_id = resolved[1].organisation_id
    if organisation_id is None:
        raise RefusalError(403, "identity-unknown")
    try:
        return authorise_workspace(verified=verified, organisation_id=organisation_id)
    except WorkspaceRefusal as failure:
        raise RefusalError(failure.status, failure.kind) from None


def audit(principal: TenantCaller, action: str, resource: UUID, request_id: str) -> None:
    record_workspace_resource_event(
        action=action,
        actor_id=principal.identity_id,
        organisation_id=principal.organisation_id,
        target_id=resource,
        request_id=request_id,
    )
