"""Core attachment and public URL-preview operations."""

from uuid import UUID

from django.http import HttpRequest, HttpResponse

from core.api.scopes import Operation, declares
from services.identity.access_tokens import VerifiedAccessToken

from .. import services as service
from . import http

UPLOAD_FIELDS = {"filename", "contentType", "sizeBytes", "sha256", "channelId", "roomId"}
UPLOAD_REQUIRED = {"filename", "contentType", "sizeBytes", "sha256"}


@declares(Operation("POST", "createAttachmentUpload", "workspace_attachment:create"))
def uploads(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def prepare(verified: VerifiedAccessToken, request_id: str) -> http.Handler:
        data = http.body(request, UPLOAD_FIELDS, UPLOAD_REQUIRED)
        prepared = service.prepare_upload(
            verified=verified, organisation_id=organisation_id, body=data
        )

        def post(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
            return http.json_response(
                service.commit_upload(
                    verified=verified,
                    organisation_id=organisation_id,
                    prepared=prepared,
                    request_id=request_id,
                ),
                201,
            )

        return post

    def unprepared(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        # An answer may expire between the preparation probe and the replay lookup.
        # Retry in autocommit rather than performing storage or room-verifier I/O
        # inside the replay transaction.
        raise service.RefusalError(503, "service-unavailable")

    def replay_auth(verified: VerifiedAccessToken) -> None:
        data = http.body(request, UPLOAD_FIELDS, UPLOAD_REQUIRED)
        service.authorize_upload_replay(
            verified=verified, organisation_id=organisation_id, body=data
        )

    def post_commit_auth(verified: VerifiedAccessToken) -> None:
        data = http.body(request, UPLOAD_FIELDS, UPLOAD_REQUIRED)
        service.authorize_upload_dm(verified=verified, organisation_id=organisation_id, body=data)

    return http.serve(
        request,
        {"POST": unprepared},
        organisation_id,
        prepare=prepare,
        replay_authorize=replay_auth,
        post_commit_authorize=post_commit_auth,
    )


@declares(Operation("POST", "completeAttachmentUpload", "workspace_attachment:act"))
def complete(request: HttpRequest, organisation_id: UUID, attachment_id: UUID) -> HttpResponse:
    def prepare(verified: VerifiedAccessToken, request_id: str) -> http.Handler:
        if request.body:
            http.body(request, set(), set())
        prepared = service.prepare_complete(
            verified=verified, organisation_id=organisation_id, attachment_id=attachment_id
        )

        def post(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
            return http.json_response(
                service.commit_complete(
                    verified=verified,
                    organisation_id=organisation_id,
                    prepared=prepared,
                    request_id=request_id,
                )
            )

        return post

    def unprepared(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        # An answer may expire between the preparation probe and the replay lookup.
        # Retry in autocommit rather than performing storage or room-verifier I/O
        # inside the replay transaction.
        raise service.RefusalError(503, "service-unavailable")

    def replay_auth(verified: VerifiedAccessToken) -> None:
        service.authorize_complete(
            verified=verified, organisation_id=organisation_id, attachment_id=attachment_id
        )

    def post_commit_auth(verified: VerifiedAccessToken) -> None:
        service.authorize_complete_dm(
            verified=verified, organisation_id=organisation_id, attachment_id=attachment_id
        )

    return http.serve(
        request,
        {"POST": unprepared},
        organisation_id,
        prepare=prepare,
        replay_authorize=replay_auth,
        post_commit_authorize=post_commit_auth,
    )


@declares(
    Operation("GET", "getAttachment", "workspace_attachment:read"),
    Operation("DELETE", "cancelAttachmentUpload", "workspace_attachment:delete"),
)
def attachment(request: HttpRequest, organisation_id: UUID, attachment_id: UUID) -> HttpResponse:
    def get(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        return http.json_response(
            service.get_attachment(
                verified=verified, organisation_id=organisation_id, attachment_id=attachment_id
            ),
            etag=True,
        )

    def delete(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        if request.body:
            http.body(request, set(), set())
        service.cancel_upload(
            verified=verified,
            organisation_id=organisation_id,
            attachment_id=attachment_id,
            request_id=request_id,
        )
        return HttpResponse(status=204)

    return http.serve(request, {"GET": get, "DELETE": delete}, organisation_id)


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
