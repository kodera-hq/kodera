"""Core 0.43 native documents, backlink pages and scoped workspace search."""

from uuid import UUID

from django.http import HttpRequest, HttpResponse

from core.api.scopes import Operation, declares
from services.identity.access_tokens import VerifiedAccessToken

from .. import services as service
from . import http


def page(request: HttpRequest, extra: set[str] | None = None) -> tuple[str | None, int]:
    if set(request.GET) - {"cursor", "limit", *(extra or set())} or any(
        len(values) != 1 for _, values in request.GET.lists()
    ):
        raise service.RefusalError(400)
    try:
        limit = int(request.GET.get("limit", "50"))
    except ValueError:
        raise service.RefusalError(400) from None
    return request.GET.get("cursor"), limit


@declares(
    Operation("GET", "listWorkspaceDocuments", "workspace_document:read"),
    Operation("POST", "createWorkspaceDocument", "workspace_document:create"),
)
def documents(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def get(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        cursor, limit = page(request, {"parentId"})
        parent = http.uuid(request.GET["parentId"]) if "parentId" in request.GET else None
        return http.json_response(
            service.list_documents(
                verified=verified,
                organisation_id=organisation_id,
                cursor=cursor,
                limit=limit,
                parent_id=parent,
            )
        )

    def post(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        body = http.body(request, {"title", "parentId", "templateKey"}, {"title"})
        parent = http.uuid(body["parentId"]) if body.get("parentId") is not None else None
        if "templateKey" in body and not isinstance(body["templateKey"], str):
            raise service.RefusalError(422)
        result = service.create(
            verified=verified,
            organisation_id=organisation_id,
            name=body["title"],
            parent_id=parent,
            template_key=body.get("templateKey"),
            request_id=request_id,
        )
        return http.json_response(result, 201, etag=True)

    return http.serve(request, {"GET": get, "POST": post}, organisation_id)


@declares(
    Operation("GET", "getWorkspaceDocument", "workspace_document:read"),
    Operation("PATCH", "updateWorkspaceDocument", "workspace_document:update"),
    Operation("DELETE", "deleteWorkspaceDocument", "workspace_document:delete"),
)
def document(request: HttpRequest, organisation_id: UUID, document_id: UUID) -> HttpResponse:
    def get(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        return http.json_response(
            service.read(
                verified=verified, organisation_id=organisation_id, document_id=document_id
            ),
            etag=True,
        )

    def patch(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        body = http.body(request, {"title", "parentId", "markdown"}, set())
        if "parentId" in body and body["parentId"] is not None:
            body["parentId"] = http.uuid(body["parentId"])
        return http.json_response(
            service.patch(
                verified=verified,
                organisation_id=organisation_id,
                document_id=document_id,
                changes=body,
                if_match=request.headers.get("If-Match", ""),
                request_id=request_id,
            ),
            etag=True,
        )

    def delete(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        service.delete(
            verified=verified,
            organisation_id=organisation_id,
            document_id=document_id,
            request_id=request_id,
        )
        return HttpResponse(status=204)

    return http.serve(request, {"GET": get, "PATCH": patch, "DELETE": delete}, organisation_id)


@declares(Operation("GET", "listDocumentBacklinks", "workspace_document:read"))
def backlinks(request: HttpRequest, organisation_id: UUID, document_id: UUID) -> HttpResponse:
    def get(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        cursor, limit = page(request)
        return http.json_response(
            service.backlinks(
                verified=verified,
                organisation_id=organisation_id,
                document_id=document_id,
                cursor=cursor,
                limit=limit,
            )
        )

    return http.serve(request, {"GET": get}, organisation_id)


@declares(Operation("POST", "createDocumentCollabSession", "workspace_document:act"))
def session(request: HttpRequest, organisation_id: UUID, document_id: UUID) -> HttpResponse:
    def post(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        if request.body:
            http.body(request, set(), set())
        return http.json_response(
            service.collab_session(
                verified=verified,
                organisation_id=organisation_id,
                document_id=document_id,
                request_id=request_id,
            ),
            201,
        )

    return http.serve(
        request,
        {"POST": post},
        organisation_id,
        authority=lambda verified: service.authorize_document(
            verified=verified, organisation_id=organisation_id, document_id=document_id
        ),
    )


@declares(Operation("GET", "searchWorkspace", "workspace_search:read"))
def search(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def get(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        cursor, limit = page(request, {"q"})
        if "q" not in request.GET:
            raise service.RefusalError(400)
        return http.json_response(
            service.search(
                verified=verified,
                organisation_id=organisation_id,
                query=request.GET["q"],
                cursor=cursor,
                limit=limit,
            )
        )

    return http.serve(request, {"GET": get}, organisation_id)
