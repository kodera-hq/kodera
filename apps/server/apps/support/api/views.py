"""createSupportTicket (contracts/core-api.openapi.yaml, tag Support): docs/specs/SUPPORT_TICKETS.md.

The view authenticates, admits the lane, authorises the caller against current state, checks that
a support mailbox is configured, reads the body, and only then writes, once per `Idempotency-Key`,
through the replay store. Problem bodies carry the type, the request id and, for a malformed body,
the pointers, escaped (RFC 6901), to the members it named: never the values of the request.
"""

import json
import logging

from django.conf import settings
from django.core.exceptions import RequestDataTooBig
from django.http import HttpRequest, HttpResponse

from apps.support import tickets as service
from core.api import lanes, problems
from core.api.idempotency import StoredResponse, respond_once
from core.api.scopes import declares
from core.db.ids import new_uuid7
from services.identity.access_tokens import TokenVerificationError, VerifiedAccessToken
from services.identity.trusted_issuers import verify_configured_token

from .permissions import CREATE_SUPPORT_TICKET

LOG = logging.getLogger(__name__)
PROBLEM_BASE = "https://kodera.io/problems/"
PROBLEM_TYPE = "application/problem+json"
REQUEST_ID_ALPHABET = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
MAX_TOKEN = 16 * 1024
# A ticket mailbox that is missing is a deployment's fix, not the caller's: a minute is a hint.
UNAVAILABLE_RETRY_S = 60
PROBLEMS = {
    "malformed-request": (400, "Malformed request"),
    "unauthenticated": (401, "Authentication required"),
    "forbidden": (403, "Access refused"),
    "method-not-allowed": (405, "Method not allowed"),
    "rate-limited": (429, "Too many requests"),
    "internal-error": (500, "Internal error"),
    "service-unavailable": (503, "Support is not available"),
}


def _request_id(request: HttpRequest) -> str:
    supplied = request.headers.get("X-Request-Id", "")
    if 8 <= len(supplied) <= 64 and set(supplied) <= REQUEST_ID_ALPHABET:
        return supplied
    return str(new_uuid7())


def _document(kind: str, request_id: str, **extensions: object) -> tuple[int, bytes]:
    status, title = PROBLEMS[kind]
    body = {
        "type": PROBLEM_BASE + kind,
        "title": title,
        "status": status,
        "request_id": request_id,
        **extensions,
    }
    return status, json.dumps(body).encode()


def _problem(kind: str, request_id: str, **extensions: object) -> HttpResponse:
    status, body = _document(kind, request_id, **extensions)
    response = HttpResponse(body, status=status, content_type=PROBLEM_TYPE)
    if status == 401:
        # AUTHZ.md §2: a failed verification carries the Bearer challenge.
        response["WWW-Authenticate"] = "Bearer"
    return response


def _malformed(request_id: str, refused: service.TicketInputError) -> HttpResponse:
    if not refused.errors:
        return _problem("malformed-request", request_id)
    errors = [{"pointer": pointer, "code": code} for pointer, code in refused.errors]
    return _problem("malformed-request", request_id, errors=errors)


def _bearer(request: HttpRequest) -> str:
    authorization = request.headers.get("Authorization", "")
    if len(authorization) > MAX_TOKEN + 7:
        raise TokenVerificationError()
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise TokenVerificationError()
    return parts[1]


def _verified(request: HttpRequest) -> tuple[VerifiedAccessToken, str]:
    verified, lane = verify_configured_token(_bearer(request), trusted=settings.KODERA_AUTH_TRUST)
    return lanes.admit(verified, lane)


def _finish(response: HttpResponse, request_id: str) -> HttpResponse:
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response


def _denied(refused: service.TicketForbiddenError, request_id: str) -> HttpResponse:
    try:
        service.record_tenant_denial(refused=refused, request_id=request_id)
    except Exception as unrecorded:
        # AUTHZ.md §9: a refusal that cannot be recorded is not answered as recorded.
        LOG.error(
            "support ticket denial not recorded: %s request_id=%s",
            type(unrecorded).__name__,
            request_id,
        )
        return _problem("internal-error", request_id)
    return _problem("forbidden", request_id)


def _body(request: HttpRequest) -> bytes:
    try:
        return request.body
    except RequestDataTooBig:
        raise service.TicketInputError() from None


@declares(CREATE_SUPPORT_TICKET)
def support_tickets(request: HttpRequest) -> HttpResponse:
    request_id = _request_id(request)
    operation = CREATE_SUPPORT_TICKET.operation_id
    try:
        if request.method != "POST":
            response = _problem("method-not-allowed", request_id)
            response["Allow"] = "POST"
            return _finish(response, request_id)
        verified, lane = _verified(request)
        if lane == "staff":
            service.record_staff_denial(verified=verified, request_id=request_id)
            return _finish(_problem("forbidden", request_id), request_id)
        caller = service.authorise(verified=verified)
        if service.support_mailbox() is None:
            response = _problem(
                "service-unavailable", request_id, retry_after_s=UNAVAILABLE_RETRY_S
            )
            response["Retry-After"] = str(UNAVAILABLE_RETRY_S)
            return _finish(response, request_id)
        ticket_request = service.parse_request(_body(request), request.content_type or "")
        service.check_organisation(caller, ticket_request)

        def handler() -> StoredResponse:
            ticket = service.open_ticket(
                verified=verified, request=ticket_request, request_id=request_id
            )
            return StoredResponse(
                status=201,
                body=json.dumps(service.representation(ticket)).encode(),
                content_type="application/json",
                location=f"/api/v1/support/tickets/{ticket.id}",
            )

        response = respond_once(
            request,
            issuer=verified.issuer,
            subject=verified.subject,
            request_id=request_id,
            handler=handler,
        )
    except TokenVerificationError:
        response = _problem("unauthenticated", request_id)
    except service.TicketCallerUnknownError:
        response = problems.identity_unknown(request_id, operation)
    except service.TicketForbiddenError as refused:
        response = _denied(refused, request_id)
    except service.TicketInputError as refused:
        response = _malformed(request_id, refused)
    except service.TicketRateLimitedError as limited:
        response = _problem("rate-limited", request_id)
        response["Retry-After"] = str(limited.retry_after_s)
    except Exception as failure:
        # SQL diagnostics, the request's text and addresses never enter the body or the log.
        LOG.error("%s failed: %s request_id=%s", operation, type(failure).__name__, request_id)
        response = _problem("internal-error", request_id)
    return _finish(response, request_id)
