"""GET-only organisation detail with current authority before conditional responses."""

import json
import re
from uuid import UUID

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.utils.http import parse_etags

from apps.orgs.detail_services import (
    OrganisationNotFoundError,
    OrganisationReadForbiddenError,
    UnknownOrganisationCustomerError,
    read_organisation,
)
from core.api import lanes, problems
from core.api.scopes import declares
from core.db.ids import new_uuid7
from services.identity.access_tokens import MAX_TOKEN, TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

from .detail_permissions import GET_ORGANISATION
from .detail_serializers import serialize_organisation

REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,64}\Z")
PROBLEMS = {
    401: ("unauthenticated", "Authentication required"),
    403: ("forbidden", "Access refused"),
    404: ("not-found", "Not found"),
    405: ("method-not-allowed", "Method not allowed"),
    500: ("internal-error", "Internal error"),
}


def _problem(status: int, request_id: str) -> HttpResponse:
    kind, title = PROBLEMS[status]
    body: dict[str, object] = {
        "type": "https://kodera.io/problems/" + kind,
        "title": title,
        "status": status,
        "request_id": request_id,
    }
    if status == 405:
        body["allowed"] = ["GET"]
    response = HttpResponse(
        json.dumps(body), status=status, content_type="application/problem+json"
    )
    if status == 401:
        response["WWW-Authenticate"] = "Bearer"
    if status == 405:
        response["Allow"] = "GET"
    return response


def _bearer(request: HttpRequest) -> str:
    authorization = request.headers.get("Authorization", "")
    if len(authorization) > MAX_TOKEN + 7:
        raise TokenVerificationError()
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise TokenVerificationError()
    return parts[1]


@declares(GET_ORGANISATION)
def organisation_detail(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    supplied = request.headers.get("X-Request-Id", "")
    request_id = supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
    try:
        if request.method != "GET":
            response = _problem(405, request_id)
        else:
            verified, lane = verify_configured_token(
                _bearer(request), trusted=settings.KODERA_AUTH_TRUST
            )
            verified, lane = lanes.admit(verified, lane)
            if lane == "staff":
                response = _problem(403, request_id)
            else:
                detail = read_organisation(verified=verified, target_id=organisation_id)
                content, etag = serialize_organisation(detail)
                candidates = parse_etags(request.headers.get("If-None-Match", ""))
                matched = "*" in candidates or any(
                    candidate.removeprefix("W/") == etag for candidate in candidates
                )
                response = (
                    HttpResponse(status=304)
                    if matched
                    else HttpResponse(content, content_type="application/json")
                )
                response["ETag"] = etag
    except TokenVerificationError:
        response = _problem(401, request_id)
    except UnknownOrganisationCustomerError:
        response = problems.identity_unknown(request_id, GET_ORGANISATION.operation_id)
    except OrganisationReadForbiddenError:
        response = _problem(403, request_id)
    except OrganisationNotFoundError:
        response = _problem(404, request_id)
    except Exception:
        # SQL diagnostics, credentials and identity data never enter the error body or logs.
        response = _problem(500, request_id)
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response
