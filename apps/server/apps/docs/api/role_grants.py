"""Conditional document subteam grant endpoints; all responses prohibit caching."""

from typing import Any
from uuid import UUID

from django.http import HttpRequest, HttpResponse

from core.api.scopes import Operation, declares
from services.identity.access_tokens import VerifiedAccessToken

from .. import role_grants as service
from ..errors import RefusalError
from . import http


def grant_response(document_id: UUID, snapshot: dict[str, Any]) -> HttpResponse:
    response = http.json_response(snapshot)
    response["ETag"] = service.etag(document_id, snapshot)
    return response


@declares(Operation("GET", "listDocumentRoleGrants", "workspace_document:read"))
def grants(request: HttpRequest, organisation_id: UUID, document_id: UUID) -> HttpResponse:
    def get(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        if request.GET:
            raise RefusalError(400)
        return grant_response(
            document_id,
            service.list_grants(
                verified=verified,
                organisation_id=organisation_id,
                document_id=document_id,
            ),
        )

    return http.serve(request, {"GET": get}, organisation_id)


@declares(
    Operation("PUT", "putDocumentRoleGrant", "workspace_document:update"),
    Operation("DELETE", "revokeDocumentRoleGrant", "workspace_document:update"),
)
def grant(
    request: HttpRequest, organisation_id: UUID, document_id: UUID, role_id: UUID
) -> HttpResponse:
    def put(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        body = http.body(request, {"role"}, {"role"})
        return grant_response(
            document_id,
            service.put_grant(
                verified=verified,
                organisation_id=organisation_id,
                document_id=document_id,
                role_id=role_id,
                permission=body["role"],
                if_match=request.headers.get("If-Match", ""),
                request_id=request_id,
            ),
        )

    def delete(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        return grant_response(
            document_id,
            service.revoke_grant(
                verified=verified,
                organisation_id=organisation_id,
                document_id=document_id,
                role_id=role_id,
                if_match=request.headers.get("If-Match", ""),
                request_id=request_id,
            ),
        )

    return http.serve(request, {"PUT": put, "DELETE": delete}, organisation_id)
