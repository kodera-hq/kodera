"""Feature-gated customer handlers for confidential envelope transport."""

from uuid import UUID

from django.http import HttpRequest, HttpResponse

from core.api.scopes import Operation, declares

from .. import services
from . import http


@declares(Operation("POST", "registerConfidentialDevice", "confidential_device:create"))
def devices(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    return http.serve(
        request,
        organisation_id=organisation_id,
        operation="register-device",
        effect=services.register_device,
        status=201,
    )


@declares(Operation("POST", "revokeConfidentialDevice", "confidential_device:act"))
def revoke(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    return http.serve(
        request,
        organisation_id=organisation_id,
        operation="revoke-device",
        effect=services.revoke_device,
    )


@declares(Operation("POST", "publishConfidentialKeyPackage", "confidential_key_package:create"))
def packages(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    return http.serve(
        request,
        organisation_id=organisation_id,
        operation="publish-key-package",
        effect=services.publish_package,
        status=201,
    )


@declares(Operation("POST", "createConfidentialRoom", "confidential_room:create"))
def rooms(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    return http.serve(
        request,
        organisation_id=organisation_id,
        operation="create-room",
        effect=services.create_room,
        status=201,
    )


@declares(Operation("POST", "claimConfidentialKeyPackage", "confidential_key_package:act"))
def claims(request: HttpRequest, organisation_id: UUID, room_id: UUID) -> HttpResponse:
    return http.serve(
        request,
        organisation_id=organisation_id,
        room_id=room_id,
        operation="claim-key-package",
        effect=services.claim_package,
    )


@declares(Operation("POST", "commitConfidentialEpoch", "confidential_room:act"))
def commits(request: HttpRequest, organisation_id: UUID, room_id: UUID) -> HttpResponse:
    return http.serve(
        request,
        organisation_id=organisation_id,
        room_id=room_id,
        operation="commit-epoch",
        effect=services.commit_epoch,
        status=201,
    )


@declares(Operation("POST", "retireConfidentialParticipant", "confidential_room:act"))
def retire(request: HttpRequest, organisation_id: UUID, room_id: UUID) -> HttpResponse:
    return http.serve(
        request,
        organisation_id=organisation_id,
        room_id=room_id,
        operation="retire-room-device",
        effect=services.retire_device,
    )


@declares(
    Operation("GET", "listConfidentialEnvelopes", "confidential_envelope:read"),
    Operation("POST", "sendConfidentialEnvelope", "confidential_envelope:create"),
)
def envelopes(request: HttpRequest, organisation_id: UUID, room_id: UUID) -> HttpResponse:
    reading = request.method == "GET"
    return http.serve(
        request,
        organisation_id=organisation_id,
        room_id=room_id,
        operation="read-envelopes" if reading else "send-application",
        effect=services.read_envelopes if reading else services.send_application,
        status=200 if reading else 201,
    )
