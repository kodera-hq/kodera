"""GET-only issuer-bound directory, current authority before every page."""

import json
import re

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from apps.orgs.membership_pagination import InvalidDirectoryInputError
from apps.orgs.membership_services import (
    DirectoryForbiddenError,
    DirectoryNotFoundError,
    UnknownDirectoryCustomerError,
    read_directory,
)
from core.api import lanes, problems
from core.api.scopes import declares
from core.db.ids import new_uuid7
from services.identity.access_tokens import MAX_TOKEN, TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

from .membership_permissions import LIST_MEMBERSHIPS
from .membership_serializers import serialize_page

REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,64}\Z")
PROBLEMS = {
    400: ("validation-error", "Invalid request"),
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
    value = request.headers.get("Authorization", "")
    if len(value) > MAX_TOKEN + 7:
        raise TokenVerificationError()
    parts = value.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise TokenVerificationError()
    return parts[1]


@declares(LIST_MEMBERSHIPS)
def membership_directory(request: HttpRequest, organisation_id: str) -> HttpResponse:
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
                page = read_directory(
                    verified=verified,
                    target=organisation_id,
                    raw_query=request.META.get("QUERY_STRING", ""),
                    signing_input=getattr(settings, "KODERA_MEMBERSHIP_CURSOR_KEY", None),
                )
                response = HttpResponse(serialize_page(page), content_type="application/json")
    except TokenVerificationError:
        response = _problem(401, request_id)
    except UnknownDirectoryCustomerError:
        response = problems.identity_unknown(request_id, LIST_MEMBERSHIPS.operation_id)
    except DirectoryForbiddenError:
        response = _problem(403, request_id)
    except DirectoryNotFoundError:
        response = _problem(404, request_id)
    except InvalidDirectoryInputError:
        response = _problem(400, request_id)
    except Exception:
        # Never expose SQL diagnostics, credentials or stored identity facts.
        response = _problem(500, request_id)
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response
