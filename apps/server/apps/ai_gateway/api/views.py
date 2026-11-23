"""Workspace AI policy, consent, and guarded voice-note transcription views."""

from __future__ import annotations

from uuid import UUID

from django.db import connection
from django.http import HttpRequest, HttpResponse

from core.api.scopes import declares
from services.identity.access_tokens import VerifiedAccessToken

from .. import services as service
from ..adapters import AiGatewayRefusalError
from . import http, permissions

POLICY_FIELDS = {
    "enabled",
    "provider",
    "providerRegion",
    "euSovereignOnly",
    "selfHostedEndpoint",
    "model",
    "monthlyBudgetMicros",
    "byomConfig",
    "clearByomConfig",
}
CHANNEL_FIELDS = {"aiEnabled"}
CONSENT_FIELDS = {"enabled"}
TRANSCRIBE_FIELDS = {"channelId", "roomId", "language"}


@declares(permissions.GET_POLICY, permissions.PUT_POLICY)
def policy(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def get(verified: VerifiedAccessToken, _request_id: str) -> HttpResponse:
        return http.json_response(
            service.get_ai_policy(verified=verified, organisation_id=organisation_id)
        )

    def put(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        data = http.body(request, POLICY_FIELDS, set())
        return http.json_response(
            service.update_workspace_ai_policy(
                verified=verified,
                organisation_id=organisation_id,
                body=data,
                request_id=request_id,
            )
        )

    return http.serve(
        request,
        {"GET": get, "PUT": put},
        organisation_id,
        operations=(permissions.GET_POLICY, permissions.PUT_POLICY),
    )


@declares(permissions.PUT_CHANNEL_POLICY)
def channel_policy(request: HttpRequest, organisation_id: UUID, channel_id: UUID) -> HttpResponse:
    def put(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        data = http.body(request, CHANNEL_FIELDS, {"aiEnabled"})
        return http.json_response(
            service.update_channel_ai_policy(
                verified=verified,
                organisation_id=organisation_id,
                channel_id=channel_id,
                body=data,
                request_id=request_id,
            )
        )

    return http.serve(
        request, {"PUT": put}, organisation_id, operations=(permissions.PUT_CHANNEL_POLICY,)
    )


@declares(permissions.PUT_CONSENT)
def consent(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def put(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        data = http.body(request, CONSENT_FIELDS, {"enabled"})
        return http.json_response(
            service.update_member_ai_consent(
                verified=verified,
                organisation_id=organisation_id,
                body=data,
                request_id=request_id,
            )
        )

    return http.serve(request, {"PUT": put}, organisation_id, operations=(permissions.PUT_CONSENT,))


@declares(permissions.TRANSCRIBE_VOICE_NOTE)
def transcribe(request: HttpRequest, organisation_id: UUID, attachment_id: UUID) -> HttpResponse:
    prepared_holder: list[service.PreparedVoiceNoteTranscription] = []

    def parse_optional_body() -> dict[str, object]:
        if not request.body:
            return {}
        return http.body(request, TRANSCRIBE_FIELDS, set())

    def prepare(verified: VerifiedAccessToken, _request_id: str) -> http.Handler:
        data = parse_optional_body()
        prepared = service.prepare_voice_note_transcription(
            verified=verified,
            organisation_id=organisation_id,
            attachment_id=attachment_id,
            body=data,
        )
        prepared_holder.append(prepared)

        def post(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
            return http.json_response(
                service.commit_voice_note_transcription(
                    verified=verified,
                    organisation_id=organisation_id,
                    prepared=prepared,
                    request_id=request_id,
                )
            )

        return post

    def unprepared(_verified: VerifiedAccessToken, _request_id: str) -> HttpResponse:
        raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable")

    def replay_auth(verified: VerifiedAccessToken) -> None:
        data = parse_optional_body()
        service.authorize_voice_note_transcription(
            verified=verified,
            organisation_id=organisation_id,
            attachment_id=attachment_id,
            body=data,
        )

    try:
        return http.serve(
            request,
            {"POST": unprepared},
            organisation_id,
            operations=(permissions.TRANSCRIBE_VOICE_NOTE,),
            prepare=prepare,
            replay_authorize=replay_auth,
        )
    finally:
        if prepared_holder and not connection.in_atomic_block:
            service.release_uncommitted_transcription_budget(prepared_holder[0])
