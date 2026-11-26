"""Editor-managed subteam grants, serialized with document and workspace mutations."""

from typing import Any
from uuid import UUID

from django.db import connection, transaction

from apps.orgs.actor_selectors import TenantCaller
from apps.workspaces.selectors import subteam_role_id
from services.identity.access_tokens import VerifiedAccessToken

from . import services
from .errors import RefusalError
from .models import Document, DocumentRoleGrant


def wire(document: Document) -> dict[str, Any]:
    return {
        "revision": document.revision,
        "data": [
            {
                "workspaceRoleId": str(grant.workspace_role_id),
                "name": grant.workspace_role.name,
                "slug": grant.workspace_role.slug,
                "role": grant.role,
            }
            for grant in DocumentRoleGrant.objects.filter(document=document)
            .select_related("workspace_role")
            .order_by("workspace_role_id")
        ],
    }


def etag(document_id: UUID, snapshot: dict[str, Any]) -> str:
    """Sharing concurrency depends only on this document's ordered direct grant state."""
    return services.tag({"documentId": str(document_id), "data": snapshot["data"]})


def require_confidential_authority(
    document: Document, principal: TenantCaller, verified: VerifiedAccessToken
) -> None:
    if not services.is_document_confidential(document, principal.organisation_id):
        return
    from apps.e2ee.selectors import has_active_owned_device
    from apps.e2ee.services import resolve_confidential_collab_epoch

    device_id = verified.device_id
    if device_id is None:
        raise RefusalError(403)
    epoch = resolve_confidential_collab_epoch(
        organisation_id=principal.organisation_id,
        membership_id=principal.membership_id,
        identity_id=principal.identity_id,
        channel_id=document.channel_id,
        document_epoch=document.encryption_epoch,
        device_id=device_id,
    )
    # Standalone documents have no room roster: still require an owned, active device.
    if epoch is None or not has_active_owned_device(
        device_id=device_id,
        organisation_id=principal.organisation_id,
        membership_id=principal.membership_id,
        identity_id=principal.identity_id,
    ):
        raise RefusalError(403)


@transaction.atomic
def list_grants(
    *, verified: VerifiedAccessToken, organisation_id: UUID, document_id: UUID
) -> dict[str, Any]:
    # This transaction starts before any reads, so revision, authority and grants
    # share a snapshot without contending on the workspace structural write lock.
    with connection.cursor() as cursor:
        cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
    workspace_id, principal = services.read_context(verified, organisation_id)
    document, _ = services.resource(
        workspace_id=workspace_id,
        principal=principal,
        verified=verified,
        document_id=document_id,
        edit=True,
    )
    require_confidential_authority(document, principal, verified)
    return wire(document)


def mutate(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    document_id: UUID,
    role_id: UUID,
    permission: str | None,
    if_match: str,
    request_id: str,
) -> dict[str, Any]:
    workspace_id, principal = services.write_context(verified, organisation_id)
    # Match direct document deletion/cascade lock order before touching any grant.
    document = (
        Document.objects.select_for_update()
        .filter(pk=document_id, workspace_id=workspace_id, deleted_at__isnull=True)
        .first()
    )
    if document is None:
        raise RefusalError(404)
    document, _ = services.resource(
        workspace_id=workspace_id,
        principal=principal,
        verified=verified,
        document_id=document_id,
        edit=True,
    )
    require_confidential_authority(document, principal, verified)
    if not if_match:
        raise RefusalError(428)
    # A wildcard cannot protect a Share dialog against lost updates.
    current_etag = etag(document.id, wire(document))
    if if_match != current_etag:
        raise RefusalError(412, current_etag=current_etag)
    subteam = subteam_role_id(workspace_id=workspace_id, role_id=role_id)
    if subteam is None:
        raise RefusalError(404)
    if permission is None:
        deleted, _ = DocumentRoleGrant.objects.filter(
            document=document, workspace_role_id=subteam
        ).delete()
        if not deleted:
            return wire(document)
        action = "role_grant_revoked"
    else:
        grant = DocumentRoleGrant.objects.filter(
            document=document, workspace_role_id=subteam
        ).first()
        if grant is None:
            DocumentRoleGrant.objects.create(
                document=document, workspace_role_id=subteam, role=permission
            )
        else:
            if grant.role == permission:
                return wire(document)
            grant.role = permission
            grant.save(update_fields=["role", "updated_at"])
        action = "role_grant_updated"
    document.revision += 1
    document.save(update_fields=["revision"])
    services.audit(principal, document, action, request_id)
    # Sessions re-evaluate the same SQL decision after every workspace-serialized write.
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_notify('kodera_docs',%s)", [str(document.id)])
    return wire(document)


@transaction.atomic
def put_grant(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    document_id: UUID,
    role_id: UUID,
    permission: Any,
    if_match: str,
    request_id: str,
) -> dict[str, Any]:
    if not isinstance(permission, str) or permission not in {"editor", "viewer"}:
        raise RefusalError(422)
    return mutate(
        verified=verified,
        organisation_id=organisation_id,
        document_id=document_id,
        role_id=role_id,
        permission=permission,
        if_match=if_match,
        request_id=request_id,
    )


@transaction.atomic
def revoke_grant(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    document_id: UUID,
    role_id: UUID,
    if_match: str,
    request_id: str,
) -> dict[str, Any]:
    return mutate(
        verified=verified,
        organisation_id=organisation_id,
        document_id=document_id,
        role_id=role_id,
        permission=None,
        if_match=if_match,
        request_id=request_id,
    )
