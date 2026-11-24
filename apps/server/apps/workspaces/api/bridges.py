"""Customer governance handlers; authority and stored rows stay in workspace services."""

import json
from typing import Any
from uuid import UUID

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from core.api import lanes, problems
from core.api.idempotency import StoredResponse, respond_once
from core.api.scopes import Operation, declares
from services.identity.access_tokens import TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

from .. import bridges
from ..moderation import authorise_workspace
from . import responses

FIELDS = {
    "propose": (
        {
            "partnerOrganisationId",
            "channelId",
            "partnerChannelId",
            "localHomeserver",
            "partnerHomeserver",
            "matrixRoomId",
            "historyDisclosureAccepted",
        },
        set(),
    ),
    "transition": ({"revision", "action"}, set()),
    "grant_guest": (
        {"guestIdentityId", "matrixUserId", "channelId", "matrixRoomId", "expiresAt"},
        {"allowCalls"},
    ),
    "revoke_guest": (set(), set()),
}


def _json(body: Any, status: int = 200) -> HttpResponse:
    return HttpResponse(json.dumps(body), status=status, content_type="application/json")


def _serve(
    request: HttpRequest, organisation_id: UUID, operation: str, operation_id: str, **kwargs: Any
) -> HttpResponse:
    request_id = responses.request_id(request)
    expected = "GET" if operation in {"overview", "guest_channel"} else "POST"
    try:
        if request.method != expected:
            response = responses.problem("method-not-allowed", request_id)
            response["Allow"] = expected
            return responses.finish(response, request_id)
        verified, lane = verify_configured_token(
            responses.bearer(request), trusted=settings.KODERA_AUTH_TRUST
        )
        verified, lane = lanes.admit(verified, lane)
        if lane == "staff":
            raise bridges.RefusalError(403)
        args = {"verified": verified, "organisation_id": organisation_id, **kwargs}
        effect = getattr(bridges, operation)
        if expected == "GET":
            result = effect(**args)
            if request.GET:
                raise bridges.RefusalError(422)
            response = _json(result)
        else:

            def authority(_: Any) -> None:
                authorise_workspace(verified=verified, organisation_id=organisation_id, admin=True)

            authority(None)
            if request.content_type != "application/json" or len(request.body) > 16384:
                raise bridges.RefusalError(400)
            try:

                def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
                    value: dict[str, Any] = {}
                    for key, item in pairs:
                        if key in value:
                            raise ValueError("duplicate field")
                        value[key] = item
                    return value

                body = json.loads(request.body, object_pairs_hook=unique)
            except (ValueError, UnicodeError, RecursionError):
                raise bridges.RefusalError(400) from None
            required, optional = FIELDS[operation]
            if (
                not isinstance(body, dict)
                or not required <= body.keys()
                or body.keys() - required - optional
            ):
                raise bridges.RefusalError(422)

            def execute() -> StoredResponse:
                result = _json(
                    effect(**args, body=body, request_id=request_id),
                    201 if operation in {"propose", "grant_guest"} else 200,
                )
                return StoredResponse(
                    status=result.status_code, body=result.content, content_type="application/json"
                )

            response = respond_once(
                request,
                issuer=verified.issuer,
                subject=verified.subject,
                request_id=request_id,
                handler=execute,
                authority=authority,
            )
    except TokenVerificationError:
        response = responses.problem("unauthenticated", request_id)
    except bridges.RefusalError as failure:
        response = (
            problems.identity_unknown(request_id, operation_id)
            if failure.kind == "identity-unknown"
            else responses.problem(failure.kind, request_id)
        )
    return responses.finish(response, request_id)


@declares(Operation("GET", "getChannelGovernance", "workspace:read"))
def overview(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    return _serve(request, organisation_id, "overview", "getChannelGovernance")


@declares(Operation("POST", "proposePartnerChannelAgreement", "workspace:create"))
def propose(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    return _serve(request, organisation_id, "propose", "proposePartnerChannelAgreement")


@declares(Operation("POST", "transitionPartnerChannelAgreement", "workspace:act"))
def transition(request: HttpRequest, organisation_id: UUID, agreement_id: UUID) -> HttpResponse:
    return _serve(
        request,
        organisation_id,
        "transition",
        "transitionPartnerChannelAgreement",
        agreement_id=agreement_id,
    )


@declares(Operation("POST", "grantSingleChannelGuest", "workspace:create"))
def guests(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    return _serve(request, organisation_id, "grant_guest", "grantSingleChannelGuest")


@declares(Operation("POST", "revokeSingleChannelGuest", "workspace:act"))
def revoke(request: HttpRequest, organisation_id: UUID, grant_id: UUID) -> HttpResponse:
    return _serve(
        request, organisation_id, "revoke_guest", "revokeSingleChannelGuest", grant_id=grant_id
    )


@declares(Operation("GET", "getSingleGuestChannel", "workspace:read"))
def guest_channel(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    return _serve(request, organisation_id, "guest_channel", "getSingleGuestChannel")
