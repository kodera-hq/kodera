"""Consume's named bootstrap exception; configured bearer authentication remains unchanged."""

import json

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from core.api import lanes, problems
from core.api.idempotency import render, respond_once
from core.api.scopes import declares
from core.db.ids import new_uuid7
from services.identity.access_tokens import TokenVerificationError, VerifiedAccessToken
from services.identity.trusted_issuers import verify_configured_token

from ..claim_consumption import consumption_operation, record_adapter_denial
from .bootstrap_permissions import BOOTSTRAP_OPERATIONS
from .detail import REQUEST_ID, _bearer, _problem
from .owner_claim_permissions import (
    CONSUME_OWNER_CLAIM,
    ConsumeGuardError,
    ConsumerUnknownError,
    StaffConsumerUnknownError,
)
from .owner_claim_serializers import (
    parse_consume_request,
    serialize_consume_refusal,
    serialize_consume_result,
)


def consume_request(
    request: HttpRequest, *, verified: VerifiedAccessToken, lane: str, request_id: str
) -> HttpResponse:
    if "consumeOwnerClaim" not in BOOTSTRAP_OPERATIONS:
        raise ConsumeGuardError("forbidden")
    with consumption_operation(
        verified=verified,
        lane=lane,
        body=request.body,
        parser=parse_consume_request,
        request_id=request_id,
    ) as operation:

        def handler():
            result = operation.fresh()
            return (
                serialize_consume_refusal(result, request_id)
                if isinstance(result, ConsumeGuardError)
                else serialize_consume_result(result)
            )

        response = respond_once(
            request,
            issuer=verified.issuer,
            subject=verified.subject,
            request_id=request_id,
            handler=handler,
            authority=operation.authority,
            final_authority=operation.final_authority,
        )
        operation.observe_commit_lag()
        if response.status_code >= 400:
            record_adapter_denial(operation)
        return response


@declares(CONSUME_OWNER_CLAIM)
def consume_owner_claim(request: HttpRequest) -> HttpResponse:
    supplied = request.headers.get("X-Request-Id", "")
    request_id = supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
    try:
        if request.method != "POST":
            response = HttpResponse(
                json.dumps(
                    {
                        "type": "https://kodera.io/problems/method-not-allowed",
                        "title": "Method not allowed",
                        "status": 405,
                        "request_id": request_id,
                        "allowed": ["POST"],
                    }
                ),
                status=405,
                content_type="application/problem+json",
            )
            response["Allow"] = "POST"
        else:
            verified, lane = verify_configured_token(
                _bearer(request), trusted=settings.KODERA_AUTH_TRUST
            )
            verified, lane = lanes.admit(verified, lane)
            response = consume_request(request, verified=verified, lane=lane, request_id=request_id)
    except (TokenVerificationError, StaffConsumerUnknownError):
        response = _problem(401, request_id)
    except ConsumerUnknownError:
        response = problems.identity_unknown(request_id, CONSUME_OWNER_CLAIM.operation_id)
    except ConsumeGuardError as refusal:
        response = render(serialize_consume_refusal(refusal, request_id))
        if response.status_code == 503:
            response["Retry-After"] = "1"
    except Exception:
        response = _problem(500, request_id)
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response
