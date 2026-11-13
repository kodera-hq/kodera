"""Contract 0.44 collection HTTP operations."""

from django.http import HttpResponse

from core.api.scopes import Operation, declares

from .. import collections as service
from . import http
from .views import page


@declares(
    Operation("GET", "listWorkspaceCollections", "workspace_collection:read"),
    Operation("POST", "createWorkspaceCollection", "workspace_collection:create"),
)
def collections(request, organisation_id):
    def get(verified, request_id):
        cursor, limit = page(request)
        return http.json_response(
            service.list_collections(
                verified=verified, organisation_id=organisation_id, cursor=cursor, limit=limit
            ),
            etag=True,
        )

    def post(verified, request_id):
        body = http.body(
            request, {"title", "properties", "views"}, {"title", "properties", "views"}
        )
        return http.json_response(
            service.create(
                verified=verified, organisation_id=organisation_id, body=body, request_id=request_id
            ),
            201,
            etag=True,
        )

    return http.serve(request, {"GET": get, "POST": post}, organisation_id)


@declares(
    Operation("GET", "getWorkspaceCollection", "workspace_collection:read"),
    Operation("PATCH", "updateWorkspaceCollection", "workspace_collection:update"),
    Operation("DELETE", "deleteWorkspaceCollection", "workspace_collection:delete"),
)
def collection(request, organisation_id, collection_id):
    def get(verified, request_id):
        return http.json_response(
            service.read(
                verified=verified, organisation_id=organisation_id, collection_id=collection_id
            ),
            etag=True,
        )

    def patch(verified, request_id):
        body = http.body(request, {"title", "properties", "views"}, set())
        return http.json_response(
            service.patch(
                verified=verified,
                organisation_id=organisation_id,
                collection_id=collection_id,
                body=body,
                if_match=request.headers.get("If-Match", ""),
                request_id=request_id,
            ),
            etag=True,
        )

    def delete(verified, request_id):
        service.delete(
            verified=verified,
            organisation_id=organisation_id,
            collection_id=collection_id,
            request_id=request_id,
        )
        return HttpResponse(status=204)

    return http.serve(request, {"GET": get, "PATCH": patch, "DELETE": delete}, organisation_id)


@declares(Operation("POST", "queryWorkspaceCollection", "workspace_collection:read"))
def query(request, organisation_id, collection_id):
    def post(verified, request_id):
        cursor, limit = page(request)
        body = http.body(request, {"viewId", "filters", "sorts"}, set())
        return http.json_response(
            service.query(
                verified=verified,
                organisation_id=organisation_id,
                collection_id=collection_id,
                body=body,
                cursor=cursor,
                limit=limit,
            )
        )

    return http.serve(request, {"POST": post}, organisation_id)


@declares(
    Operation("GET", "getWorkspaceCollectionRow", "workspace_collection:read"),
    Operation("PUT", "putWorkspaceCollectionRow", "workspace_collection:update"),
    Operation("DELETE", "deleteWorkspaceCollectionRow", "workspace_collection:delete"),
)
def row(request, organisation_id, collection_id, document_id):
    def get(verified, request_id):
        return http.json_response(
            service.read_row(
                verified=verified,
                organisation_id=organisation_id,
                collection_id=collection_id,
                document_id=document_id,
            ),
            etag=True,
        )

    def put(verified, request_id):
        body = http.body(request, {"values"}, {"values"})
        return http.json_response(
            service.put_row(
                verified=verified,
                organisation_id=organisation_id,
                collection_id=collection_id,
                document_id=document_id,
                body=body,
                if_match=request.headers.get("If-Match", ""),
                if_none_match=request.headers.get("If-None-Match", ""),
                request_id=request_id,
            ),
            201 if request.headers.get("If-None-Match") == "*" else 200,
            etag=True,
        )

    def delete(verified, request_id):
        service.delete_row(
            verified=verified,
            organisation_id=organisation_id,
            collection_id=collection_id,
            document_id=document_id,
            if_match=request.headers.get("If-Match", ""),
            request_id=request_id,
        )
        return HttpResponse(status=204)

    return http.serve(request, {"GET": get, "PUT": put, "DELETE": delete}, organisation_id)
