"""Core 0.43 attachment and public URL-preview operations."""

from uuid import UUID

from django.http import HttpRequest, HttpResponse

from core.api.scopes import Operation, declares
from services.identity.access_tokens import VerifiedAccessToken

from .. import services as service
from . import http


@declares(Operation("POST", "createAttachmentUpload", "workspace_attachment:create"))
def uploads(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def post(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        data = http.body(
            request,
            {"filename", "contentType", "sizeBytes", "sha256"},
            {"filename", "contentType", "sizeBytes", "sha256"},
        )
        return http.json_response(
            service.create_upload(
                verified=verified, organisation_id=organisation_id, body=data, request_id=request_id
            ),
            201,
        )

    return http.serve(request, {"POST": post}, organisation_id)


@declares(Operation("POST", "completeAttachmentUpload", "workspace_attachment:act"))
def complete(request: HttpRequest, organisation_id: UUID, attachment_id: UUID) -> HttpResponse:
    def post(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        if request.body:
            http.body(request, set(), set())
        return http.json_response(
            service.complete_upload(
                verified=verified,
                organisation_id=organisation_id,
                attachment_id=attachment_id,
                request_id=request_id,
            )
        )

    return http.serve(request, {"POST": post}, organisation_id)


@declares(Operation("GET", "getAttachment", "workspace_attachment:read"))
def attachment(request: HttpRequest, organisation_id: UUID, attachment_id: UUID) -> HttpResponse:
    def get(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        return http.json_response(
            service.get_attachment(
                verified=verified, organisation_id=organisation_id, attachment_id=attachment_id
            ),
            etag=True,
        )

    return http.serve(request, {"GET": get}, organisation_id)


@declares(Operation("POST", "unfurlUrl", "workspace_unfurl:create"))
def unfurl(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def prepare(verified: VerifiedAccessToken, request_id: str) -> http.Handler:
        data = http.body(request, {"url"}, {"url"})
        result = service.prepare_preview(
            verified=verified, organisation_id=organisation_id, url=data["url"]
        )

        def post(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
            return http.json_response(
                service.record_preview(
                    verified=verified,
                    organisation_id=organisation_id,
                    result=result,
                    request_id=request_id,
                )
            )

        return post

    def unprepared(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        # An answer may expire between the preparation probe and the replay lookup.
        # Retry in autocommit rather than fetching inside the replay transaction.
        raise service.RefusalError(503, "service-unavailable")

    return http.serve(request, {"POST": unprepared}, organisation_id, prepare=prepare)
