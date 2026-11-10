"""Claim an already prepared database allocation, with current owner authority on every replay."""

import json
import logging
from uuid import UUID

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from apps.workspaces.instant_claim import (
    ClaimConflictError,
    ClaimForbiddenError,
    ClaimIdentityUnknownError,
    PoolUnavailableError,
    authorise_instant_claim,
    claim_allocation,
    reauthorise_instant_claim,
)
from apps.workspaces.warm_pool import InstantClaimInputError, parse_instant_claim_request
from core.api import lanes, problems
from core.api.idempotency import StoredResponse, respond_once
from core.api.scopes import Operation, declares
from services.identity.access_tokens import TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

from . import responses

OPERATION = Operation(method="POST", operation_id="instantClaimWorkspace", scope="workspace:act")
LOG = logging.getLogger(__name__)


def _claim(request: HttpRequest, organisation_id: UUID, request_id: str) -> StoredResponse:
    try:
        payload = parse_instant_claim_request(request.body, request.content_type or "")
        result = claim_allocation(payload, organisation_id)
    except (InstantClaimInputError, ClaimConflictError) as failure:
        code = "malformed-request" if isinstance(failure, InstantClaimInputError) else "conflict"
        status, body = responses.document(code, request_id, {})
        return StoredResponse(status=status, body=body, content_type=responses.PROBLEM_TYPE)
    return StoredResponse(
        status=201, body=json.dumps(result).encode(), content_type="application/json"
    )


@declares(OPERATION)
def instant_claim(request: HttpRequest) -> HttpResponse:
    request_id = responses.request_id(request)
    try:
        if request.method != "POST":
            response = responses.problem("method-not-allowed", request_id, allowed=["POST"])
            response["Allow"] = "POST"
            return responses.finish(response, request_id)
        verified, lane = verify_configured_token(
            responses.bearer(request), trusted=settings.KODERA_AUTH_TRUST
        )
        verified, lane = lanes.admit(verified, lane)
        if lane != "customer":
            raise ClaimForbiddenError()
        organisation_id = authorise_instant_claim(verified)

        def authority(_event):
            reauthorise_instant_claim(verified, organisation_id)

        response = respond_once(
            request,
            issuer=verified.issuer,
            subject=verified.subject,
            request_id=request_id,
            authority=authority,
            handler=lambda: _claim(request, organisation_id, request_id),
        )
    except TokenVerificationError:
        response = responses.problem("unauthenticated", request_id)
    except ClaimIdentityUnknownError:
        response = problems.identity_unknown(request_id, OPERATION.operation_id)
    except ClaimForbiddenError:
        response = responses.problem("forbidden", request_id)
    except PoolUnavailableError:
        response = responses.problem(
            "service-unavailable", request_id, code="warm_pool_unavailable"
        )
    except Exception as failure:
        LOG.error(
            "instantClaimWorkspace failed: %s request_id=%s", type(failure).__name__, request_id
        )
        response = responses.problem("internal-error", request_id)
    return responses.finish(response, request_id)
