"""Bounded GET-only customer endpoint with safe problems and fresh conditional reads."""

import hashlib
import json
import re

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.utils.http import parse_etags

from apps.identity.services import CustomerReadForbiddenError, UnknownCustomerError, read_customer
from core.api import lanes, problems
from core.api.scopes import declares
from core.db.ids import new_uuid7
from services.identity.access_tokens import MAX_TOKEN, TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

from .permissions import GET_ME
from .serializers import serialize_customer

REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,64}\Z")
PROBLEM_TITLES = {
    401: ("unauthenticated", "Authentication required"),
    403: ("forbidden", "Access refused"),
    405: ("method-not-allowed", "Method not allowed"),
    500: ("internal-error", "Internal error"),
}


def _problem(status: int, request_id: str) -> HttpResponse:
    kind, title = PROBLEM_TITLES[status]
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


@declares(GET_ME)
def me(request: HttpRequest) -> HttpResponse:
    supplied_id = request.headers.get("X-Request-Id", "")
    request_id = supplied_id if REQUEST_ID.fullmatch(supplied_id) else str(new_uuid7())
    try:
        if request.method != "GET":
            response = _problem(405, request_id)
        else:
            verified, lane = verify_configured_token(
                _bearer(request), trusted=settings.KODERA_AUTH_TRUST
            )
            verified, lane = lanes.admit(verified, lane)
            if lane == "staff":
                from apps.identity.selectors import IdentitySnapshot, PersonSnapshot
                from apps.identity.services import CustomerRead
                from apps.orgs.community import community_member, ensure_community_membership
                from apps.orgs.selectors import person_memberships

                ensure_community_membership(verified=verified)
                shared = community_member(verified=verified)
                if shared is None:
                    response = _problem(403, request_id)
                else:
                    principal, member = shared
                    content = serialize_customer(
                        CustomerRead(
                            PersonSnapshot(
                                principal.user_id, principal.user.email, principal.user.display_name
                            ),
                            (
                                IdentitySnapshot(
                                    principal.id,
                                    member.organisation_id,
                                    principal.issuer,
                                    principal.realm,
                                    principal.subject,
                                    principal.email,
                                ),
                            ),
                            tuple(
                                m
                                for m in person_memberships(user_id=principal.user_id)
                                if m.organisation.id == member.organisation_id
                            ),
                            principal.id,
                            None,
                        )
                    )
                    projection = json.loads(content)
                    projection["staff"] = True
                    response = HttpResponse(json.dumps(projection), content_type="application/json")
            else:
                content = serialize_customer(
                    read_customer(
                        verified=verified,
                        lane=lane,
                        console_client_id=settings.KODERA_CONSOLE_CLIENT_ID,
                    )
                )
                etag = '"' + hashlib.sha256(content).hexdigest() + '"'
                # Authorization and complete projection always precede conditional handling.
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
    except UnknownCustomerError:
        response = problems.identity_unknown(request_id, GET_ME.operation_id)
    except CustomerReadForbiddenError:
        response = _problem(403, request_id)
    except Exception:
        # No driver diagnostics, bearer claims or request-selected values enter logs/problems.
        response = _problem(500, request_id)
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response
