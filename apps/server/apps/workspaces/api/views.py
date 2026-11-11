"""getWorkspace and initialiseWorkspace, current authority first: PILOT_WORKSPACE_ONBOARDING.md §§5–6.

Both views authenticate the bearer token against the trust configuration and refuse a staff token
(staff hold no cell of the Workspace row, AUTHZ.md §5) before any read. The initialise view then
authorises the caller against current state and only then hands the request to the replay store,
whose one transaction runs the step once per key (IDEMPOTENCY_REPLAY.md §2.3).
"""

import json
import logging
from uuid import UUID

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.utils.http import parse_etags

from apps.workspaces.initialise import (
    READ_SCOPE,
    InitialiseForbiddenError,
    Initialiser,
    InitialiseStateError,
    authorise_initialise,
    initialise_workspace,
    record_staff_denial,
    record_tenant_denial,
)
from apps.workspaces.structure import (
    WorkspaceCallerUnknownError,
    WorkspaceNotFoundError,
    read_workspace,
)
from core.api import lanes, problems
from core.api.idempotency import MALFORMED, StoredResponse, problem, respond_once
from core.api.scopes import declares
from services.identity.access_tokens import TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

from . import responses
from .permissions import GET_WORKSPACE, INITIALISE_WORKSPACE
from .serializers import serialize_workspace

# The kinds this module's statuses answer with.
KINDS = {
    401: "unauthenticated",
    403: "forbidden",
    404: "not-found",
    405: "method-not-allowed",
    500: "internal-error",
}
LOG = logging.getLogger(__name__)
INITIALISED = json.dumps({"state": "initialised"}, separators=(",", ":")).encode()


def _problem(status: int, request_id: str, *, allow: str = "GET") -> HttpResponse:
    if status != 405:
        return responses.problem(KINDS[status], request_id)
    response = responses.problem(KINDS[status], request_id, allowed=[allow])
    response["Allow"] = allow
    return response


@declares(GET_WORKSPACE)
def workspace(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    request_id = responses.request_id(request)
    try:
        if request.method != "GET":
            return responses.finish(_problem(405, request_id), request_id)
        verified, lane = verify_configured_token(
            responses.bearer(request), trusted=settings.KODERA_AUTH_TRUST
        )
        verified, lane = lanes.admit(verified, lane)
        from apps.workspaces.community import prepare_community_read

        shared = prepare_community_read(organisation_id=organisation_id, verified=verified)
        if lane == "staff" and not shared:
            record_staff_denial(
                verified=verified,
                organisation_id=organisation_id,
                request_id=request_id,
                required_scope=READ_SCOPE,
            )
            return responses.finish(_problem(403, request_id), request_id)
        # Authorisation and filtering run before the tag is compared: a revoked view never 304s.
        content, etag = serialize_workspace(
            read_workspace(verified=verified, organisation_id=organisation_id)
        )
        # Weak comparison (RFC 9110 §13.1.2): a `W/` prefix on a candidate does not stop a match.
        candidates = parse_etags(request.headers.get("If-None-Match", ""))
        matched = "*" in candidates or any(
            candidate.removeprefix("W/") == etag for candidate in candidates
        )
        if matched:
            response = HttpResponse(status=304)
            del response["Content-Type"]
        else:
            response = HttpResponse(content, content_type="application/json")
        response["ETag"] = etag
    except TokenVerificationError:
        response = _problem(401, request_id)
    except WorkspaceCallerUnknownError:
        response = problems.identity_unknown(request_id, GET_WORKSPACE.operation_id)
    except WorkspaceNotFoundError:
        response = _problem(404, request_id)
    except Exception as failure:
        # SQL diagnostics, credentials and identity data never enter the error body or logs: the
        # log names the exception's class and the request id, nothing of the request.
        LOG.error("getWorkspace failed: %s request_id=%s", type(failure).__name__, request_id)
        response = _problem(500, request_id)
    return responses.finish(response, request_id)


def _initialise_step(
    request: HttpRequest, initialiser: Initialiser, request_id: str
) -> StoredResponse:
    """The step the replay store runs once per key; its 4xx answers are stored and replayed."""
    if request.body:
        return problem(MALFORMED, request_id)
    try:
        created = initialise_workspace(initialiser=initialiser, request_id=request_id)
    except InitialiseStateError as refused:
        status, body = responses.document(
            "invalid-state-transition",
            request_id,
            {"allowed_states": list(refused.allowed_states)},
        )
        return StoredResponse(status=status, body=body, content_type=responses.PROBLEM_TYPE)
    return StoredResponse(
        status=201 if created else 200,
        body=INITIALISED,
        content_type="application/json",
        location=f"/api/v1/organisations/{initialiser.organisation_id}/workspace",
    )


@declares(INITIALISE_WORKSPACE)
def initialise(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    request_id = responses.request_id(request)
    try:
        if request.method != "POST":
            return responses.finish(_problem(405, request_id, allow="POST"), request_id)
        verified, lane = verify_configured_token(
            responses.bearer(request), trusted=settings.KODERA_AUTH_TRUST
        )
        verified, lane = lanes.admit(verified, lane)
        if lane == "staff":
            record_staff_denial(
                verified=verified, organisation_id=organisation_id, request_id=request_id
            )
            return responses.finish(_problem(403, request_id), request_id)
        initialiser = authorise_initialise(verified=verified, organisation_id=organisation_id)
        response = respond_once(
            request,
            issuer=verified.issuer,
            subject=verified.subject,
            request_id=request_id,
            handler=lambda: _initialise_step(request, initialiser, request_id),
        )
    except TokenVerificationError:
        response = _problem(401, request_id)
    except WorkspaceCallerUnknownError:
        response = problems.identity_unknown(request_id, INITIALISE_WORKSPACE.operation_id)
    except WorkspaceNotFoundError:
        response = _problem(404, request_id)
    except InitialiseForbiddenError as refused:
        try:
            record_tenant_denial(refused=refused, request_id=request_id)
            response = _problem(403, request_id)
        except Exception as failure:
            LOG.error(
                "initialiseWorkspace denial not recorded: %s request_id=%s",
                type(failure).__name__,
                request_id,
            )
            response = _problem(500, request_id)
    except Exception as failure:
        # The step rolled back with nothing stored: the same key runs it again. The log names the
        # exception's class and the request id, never the body, a header or the token.
        LOG.error(
            "initialiseWorkspace failed: %s request_id=%s", type(failure).__name__, request_id
        )
        response = _problem(500, request_id)
    return responses.finish(response, request_id)
