"""Authenticated community support bridge; no request text appears in logs or responses."""

import json

from django.http import HttpRequest, HttpResponse

from apps.orgs.community import community_member, ensure_community_membership
from apps.support import tickets as service
from apps.support.community import CommunitySupportForbiddenError, open_community_ticket
from core.api.idempotency import StoredResponse, respond_once
from core.api.scopes import Operation, declares
from services.identity.access_tokens import TokenVerificationError

from . import views


@declares(Operation("POST", "createCommunitySupportTicket", "support_ticket:create"))
def community_support_tickets(request: HttpRequest) -> HttpResponse:
    request_id = views._request_id(request)
    try:
        if request.method != "POST":
            response = views._problem("method-not-allowed", request_id)
            response["Allow"] = "POST"
            return views._finish(response, request_id)
        verified, _lane = views._verified(request)
        ensure_community_membership(verified=verified)
        if community_member(verified=verified) is None:
            raise CommunitySupportForbiddenError()
        ticket_request = service.parse_request(views._body(request), request.content_type or "")

        def handler() -> StoredResponse:
            result = open_community_ticket(
                verified=verified, request=ticket_request, request_id=request_id
            )
            return StoredResponse(
                status=201, body=json.dumps(result).encode(), content_type="application/json"
            )

        response = respond_once(
            request,
            issuer=verified.issuer,
            subject=verified.subject,
            request_id=request_id,
            handler=handler,
        )
    except TokenVerificationError:
        response = views._problem("unauthenticated", request_id)
    except CommunitySupportForbiddenError:
        response = views._problem("forbidden", request_id)
    except service.TicketInputError as error:
        response = views._malformed(request_id, error)
    except service.TicketRateLimitedError as error:
        response = views._problem("rate-limited", request_id)
        response["Retry-After"] = str(error.retry_after_s)
    except Exception:
        response = views._problem("internal-error", request_id)
    return views._finish(response, request_id)
