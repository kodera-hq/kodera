"""Workspace AI policy, consent, and guarded voice-note transcription views."""

from __future__ import annotations

from uuid import UUID

from django.db import connection
from django.http import HttpRequest, HttpResponse

from core.api.scopes import declares
from services.identity.access_tokens import VerifiedAccessToken

from .. import call_captions, services as service
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
TRANSLATE_MESSAGE_FIELDS = {"text", "targetLanguage", "sourceLanguage", "eventId", "roomId"}
CALL_CAPTION_SESSION_FIELDS = {
    "action",
    "sessionId",
    "callInstanceId",
    "targetLanguage",
    "participantMembershipIds",
    "participantUserIds",
    "grantCallConsent",
    "roomId",
}
CALL_CAPTION_CHUNK_FIELDS = {
    "sessionId",
    "generation",
    "audioBase64",
    "contentType",
    "filename",
    "targetLanguage",
    "participantMembershipIds",
    "participantUserIds",
    "roomId",
}
MAX_TRANSLATE_BODY_BYTES = 65_536
MAX_CALL_CHUNK_BODY_BYTES = 1_500_000


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


@declares(permissions.TRANSLATE_CHANNEL_MESSAGE)
def translate_message(
    request: HttpRequest, organisation_id: UUID, channel_id: UUID
) -> HttpResponse:
    prepared_holder: list[service.PreparedChannelMessageTranslation] = []

    def parse_body() -> dict[str, object]:
        return http.body(
            request,
            TRANSLATE_MESSAGE_FIELDS,
            {"text", "targetLanguage"},
            max_bytes=MAX_TRANSLATE_BODY_BYTES,
        )

    def prepare(verified: VerifiedAccessToken, _request_id: str) -> http.Handler:
        data = parse_body()
        prepared = service.prepare_channel_message_translation(
            verified=verified,
            organisation_id=organisation_id,
            channel_id=channel_id,
            body=data,
        )
        prepared_holder.append(prepared)

        def post(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
            return http.json_response(
                service.commit_channel_message_translation(
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
        data = parse_body()
        service.authorize_channel_message_translation(
            verified=verified,
            organisation_id=organisation_id,
            channel_id=channel_id,
            body=data,
        )

    try:
        return http.serve(
            request,
            {"POST": unprepared},
            organisation_id,
            operations=(permissions.TRANSLATE_CHANNEL_MESSAGE,),
            prepare=prepare,
            replay_authorize=replay_auth,
            ephemeral_response=True,
        )
    finally:
        if prepared_holder and not connection.in_atomic_block:
            service.release_uncommitted_translation_budget(prepared_holder[0])


@declares(permissions.GET_CALL_CAPTION_SESSION, permissions.UPDATE_CALL_CAPTION_SESSION)
def call_captions_session(
    request: HttpRequest, organisation_id: UUID, channel_id: UUID
) -> HttpResponse:
    def parse_body() -> dict[str, object]:
        return http.body(request, CALL_CAPTION_SESSION_FIELDS, {"action"})

    def get(verified: VerifiedAccessToken, _request_id: str) -> HttpResponse:
        raw_session_id = request.GET.get("sessionId")
        raw_call_instance_id = request.GET.get("callInstanceId")
        session_uuid: UUID | None = None
        if raw_session_id is not None:
            try:
                session_uuid = UUID(raw_session_id)
            except ValueError:
                raise AiGatewayRefusalError(422, "invalid_session_id", "validation-error") from None
        return http.json_response(
            call_captions.get_live_call_caption_session(
                verified=verified,
                organisation_id=organisation_id,
                channel_id=channel_id,
                session_id=session_uuid,
                call_instance_id=raw_call_instance_id,
            )
        )

    def prepare(verified: VerifiedAccessToken, _request_id: str) -> http.Handler:
        data = parse_body()
        prepared_session = call_captions.prepare_live_call_caption_session(
            verified=verified,
            organisation_id=organisation_id,
            channel_id=channel_id,
            body=data,
        )

        def post(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
            return http.json_response(
                call_captions.update_live_call_caption_session(
                    verified=verified,
                    organisation_id=organisation_id,
                    channel_id=channel_id,
                    body=data,
                    request_id=request_id,
                    prepared_session=prepared_session,
                )
            )

        return post

    def unprepared(_verified: VerifiedAccessToken, _request_id: str) -> HttpResponse:
        raise call_captions.LiveCallCaptionsUnavailableError()

    def replay_auth(verified: VerifiedAccessToken) -> None:
        data = parse_body()
        call_captions.authorize_live_call_session_replay(
            verified=verified,
            organisation_id=organisation_id,
            channel_id=channel_id,
            body=data,
        )

    return http.serve(
        request,
        {"GET": get, "POST": unprepared},
        organisation_id,
        operations=(
            permissions.GET_CALL_CAPTION_SESSION,
            permissions.UPDATE_CALL_CAPTION_SESSION,
        ),
        prepare=prepare,
        replay_authorize=replay_auth,
    )


@declares(permissions.TRANSCRIBE_CALL_CAPTION_CHUNK)
def call_captions_chunks(
    request: HttpRequest, organisation_id: UUID, channel_id: UUID
) -> HttpResponse:
    prepared_holder: list[call_captions.PreparedLiveCallChunk] = []

    def parse_body() -> dict[str, object]:
        return http.body(
            request,
            CALL_CAPTION_CHUNK_FIELDS,
            {"audioBase64", "sessionId", "generation"},
            max_bytes=MAX_CALL_CHUNK_BODY_BYTES,
        )

    def prepare(verified: VerifiedAccessToken, _request_id: str) -> http.Handler:
        data = parse_body()
        prepared = call_captions.prepare_live_call_chunk(
            verified=verified,
            organisation_id=organisation_id,
            channel_id=channel_id,
            body=data,
        )
        prepared_holder.append(prepared)

        def post(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
            return http.json_response(
                call_captions.commit_live_call_chunk(
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
        data = parse_body()
        call_captions.authorize_live_call_session_replay(
            verified=verified,
            organisation_id=organisation_id,
            channel_id=channel_id,
            body=data,
        )

    try:
        return http.serve(
            request,
            {"POST": unprepared},
            organisation_id,
            operations=(permissions.TRANSCRIBE_CALL_CAPTION_CHUNK,),
            prepare=prepare,
            replay_authorize=replay_auth,
            ephemeral_response=True,
        )
    finally:
        if prepared_holder and not connection.in_atomic_block:
            call_captions.release_uncommitted_call_chunk_budget(prepared_holder[0])
