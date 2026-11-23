"""Granular role, profile and administrative table HTTP operations."""

from typing import Any
from uuid import UUID

from django.http import HttpRequest, HttpResponse

from apps.workspaces import governance, iam
from apps.workspaces.moderation import RefusalError
from core.api.scopes import Operation, declares

from .moderation import _body, _json, _serve


@declares(
    Operation("GET", "listWorkspaceRoles", "workspace_role:read"),
    Operation("POST", "createWorkspaceRole", "workspace_role:create"),
)
def roles(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def post(verified: Any, request_id: str) -> HttpResponse:
        body = iam.create_role(
            verified=verified,
            organisation_id=organisation_id,
            data=_body(request, iam.ROLE_FIELDS, {"name", "slug"}),
            request_id=request_id,
        )
        return _json(body, 201, etag=body["etag"])

    return _serve(
        request,
        {
            "GET": lambda verified, _: _json(
                iam.list_roles(verified=verified, organisation_id=organisation_id),
                etag=True,
            ),
            "POST": post,
            "AUTHORIZE": lambda verified: iam.authorize(verified, organisation_id, "manage_roles"),
        },
    )


@declares(
    Operation("PATCH", "updateWorkspaceRole", "workspace_role:update"),
    Operation("DELETE", "deleteWorkspaceRole", "workspace_role:delete"),
)
def role(request: HttpRequest, organisation_id: UUID, role_id: UUID) -> HttpResponse:
    def patch(verified: Any, request_id: str) -> HttpResponse:
        body = iam.update_role(
            verified=verified,
            organisation_id=organisation_id,
            role_id=role_id,
            data=_body(request, iam.ROLE_FIELDS, set()),
            if_match=request.headers.get("If-Match", ""),
            request_id=request_id,
        )
        return _json(body, etag=body["etag"])

    def delete(verified: Any, request_id: str) -> HttpResponse:
        iam.delete_role(
            verified=verified,
            organisation_id=organisation_id,
            role_id=role_id,
            request_id=request_id,
        )
        return HttpResponse(status=204)

    return _serve(
        request,
        {
            "PATCH": patch,
            "DELETE": delete,
        },
    )


@declares(Operation("PUT", "setWorkspaceMemberRoles", "workspace_role:update"))
def member_roles(request: HttpRequest, organisation_id: UUID, membership_id: UUID) -> HttpResponse:
    return _serve(
        request,
        {
            "PUT": lambda verified, request_id: _json(
                iam.assign_roles(
                    verified=verified,
                    organisation_id=organisation_id,
                    membership_id=membership_id,
                    role_ids=_body(request, {"role_ids"}, {"role_ids"})["role_ids"],
                    request_id=request_id,
                )
            )
        },
    )


@declares(
    Operation("GET", "getWorkspaceChannelOverrides", "workspace_role:read"),
    Operation("PUT", "setWorkspaceChannelOverrides", "workspace_role:update"),
)
def overrides(request: HttpRequest, organisation_id: UUID, channel_id: UUID) -> HttpResponse:
    return _serve(
        request,
        {
            "GET": lambda verified, _: _json(
                governance.overrides(
                    verified=verified, organisation_id=organisation_id, channel_id=channel_id
                )
            ),
            "PUT": lambda verified, request_id: _json(
                governance.overrides(
                    verified=verified,
                    organisation_id=organisation_id,
                    channel_id=channel_id,
                    data=_body(request, {"overrides"}, {"overrides"})["overrides"],
                    request_id=request_id,
                )
            ),
        },
    )


@declares(
    Operation("GET", "getWorkspaceProfile", "workspace_profile:read"),
    Operation("PATCH", "updateWorkspaceProfile", "workspace_profile:update"),
)
def profile(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def get(verified: Any, _: str) -> HttpResponse:
        body, etag = governance.profile_with_etag(
            verified=verified, organisation_id=organisation_id
        )
        return _json(body, etag=etag)

    def patch(verified: Any, request_id: str) -> HttpResponse:
        body, etag = governance.profile_with_etag(
            verified=verified,
            organisation_id=organisation_id,
            data=_body(request, governance.PROFILE_FIELDS, set(), limit=2830000),
            if_match=request.headers.get("If-Match", ""),
            request_id=request_id,
        )
        return _json(body, etag=etag)

    return _serve(
        request,
        {
            "GET": get,
            "PATCH": patch,
        },
    )


def _page(request: HttpRequest, organisation_id: UUID, kind: str) -> HttpResponse:
    def get(verified: Any, _: str) -> HttpResponse:
        if any(len(values) != 1 for _, values in request.GET.lists()):
            raise RefusalError(400)
        return _json(
            governance.admin_page(
                verified=verified,
                organisation_id=organisation_id,
                kind=kind,
                query=request.GET.dict(),
            )
        )

    return _serve(request, {"GET": get})


@declares(Operation("GET", "listWorkspaceBans", "workspace_moderation:read"))
def bans(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    return _page(request, organisation_id, "bans")


@declares(Operation("GET", "listWorkspaceAuditLogs", "workspace_audit:read"))
def audit_logs(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    return _page(request, organisation_id, "audit")
