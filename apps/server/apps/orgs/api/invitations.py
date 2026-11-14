"""The six invitation operations (docs/specs/INVITATIONS.md §3).

Each view authenticates, admits the lane, authorises the caller against current state and only
then writes; the batch, the resend and acceptance run their write once per `Idempotency-Key`
through the replay store. The preview writes nothing and takes no key. Problem bodies carry the
type, the request id and nothing of the request.
"""

import json
import logging
from datetime import UTC, datetime
from urllib.parse import parse_qs
from uuid import UUID

from django.conf import settings
from django.core.exceptions import RequestDataTooBig
from django.http import HttpRequest, HttpResponse

from apps.orgs import invitations as service
from core.api import lanes, problems
from core.api.guarded_replay import respond_once
from core.api.idempotency import StoredResponse
from core.api.scopes import declares
from core.db.ids import new_uuid7
from services.identity.access_tokens import TokenVerificationError, VerifiedAccessToken
from services.identity.trusted_issuers import verify_configured_token

from .detail import REQUEST_ID, _bearer
from .invitation_permissions import (
    ACCEPT_INVITATION,
    INVITE_TO_ORGANISATION,
    LIST_INVITATIONS,
    PREVIEW_INVITATION,
    RESEND_INVITATION,
    REVOKE_INVITATION,
)

LOG = logging.getLogger(__name__)
PROBLEM_BASE = "https://kodera.io/problems/"
PROBLEM_TYPE = "application/problem+json"
PROBLEMS = {
    "malformed-request": (400, "Malformed request"),
    "unauthenticated": (401, "Authentication required"),
    "forbidden": (403, "Access refused"),
    "not-found": (404, "Not found"),
    "method-not-allowed": (405, "Method not allowed"),
    "conflict": (409, "The invitation does not allow this"),
    "invitation-expired": (410, "The invitation has expired"),
    "invitation-revoked": (410, "The invitation was revoked"),
    "rate-limited": (429, "Too many requests"),
    "internal-error": (500, "Internal error"),
}


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


def _problem(kind: str, request_id: str, *, allow: str | None = None) -> HttpResponse:
    extensions: dict[str, object] = {} if allow is None else {"allowed": allow.split(", ")}
    status, body = _document(kind, request_id, **extensions)
    response = HttpResponse(body, status=status, content_type=PROBLEM_TYPE)
    if status == 401:
        response["WWW-Authenticate"] = "Bearer"
    if allow is not None:
        response["Allow"] = allow
    return response


def _stamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _invitation(view: service.InvitationView) -> dict[str, object]:
    body: dict[str, object] = {
        "id": str(view.id),
        "organisation_id": str(view.organisation_id),
        "email": view.email,
        "role": view.role,
        "state": view.state,
        "realm": view.realm,
        "invited_by": str(view.invited_by),
        "expires_at": _stamp(view.expires_at),
        "accepted_at": _stamp(view.accepted_at),
        "membership_id": None if view.membership_id is None else str(view.membership_id),
        "last_sent_at": _stamp(view.last_sent_at),
        "created_at": _stamp(view.created_at),
    }
    # `sent_count` is at least 1 when present: an invitation created without a mail omits it.
    if view.sent_count:
        body["sent_count"] = view.sent_count
    return body


def _json(body: object) -> bytes:
    return json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()


def _batch(result: service.BatchResult) -> dict[str, object]:
    counts = {"created": 0, "skipped": 0, "failed": 0}
    rows = []
    for outcome in result.outcomes:
        if outcome.outcome == "created":
            counts["created"] += 1
        elif outcome.outcome in {"already_member", "already_invited"}:
            counts["skipped"] += 1
        else:
            counts["failed"] += 1
        rows.append(
            {
                "email": outcome.email,
                "outcome": outcome.outcome,
                "invitation": None
                if outcome.invitation is None
                else _invitation(outcome.invitation),
                "detail": outcome.detail,
            }
        )
    return {**counts, "results": rows}


def _membership(accepted: service.AcceptedMembership) -> dict[str, object]:
    return {
        "id": str(accepted.id),
        "organisation_id": str(accepted.organisation_id),
        "person_id": str(accepted.user_id),
        "identity_id": str(accepted.identity_id),
        "email": accepted.email,
        "display_name": accepted.display_name,
        "role": accepted.role,
        "state": accepted.state,
        "source": "invitation",
        "created_at": _stamp(accepted.created_at),
        "updated_at": _stamp(accepted.updated_at),
    }


def _preview(card: service.InvitationPreview) -> dict[str, object]:
    return {
        "organisation_name": card.organisation_name,
        "inviter_display_name": card.inviter_display_name,
        "role": card.role,
        "expires_at": _stamp(card.expires_at),
    }


def _body(request: HttpRequest) -> bytes:
    try:
        return request.body
    except RequestDataTooBig:
        raise service.InvitationInputError() from None


def _verified(request: HttpRequest) -> tuple[VerifiedAccessToken, str]:
    verified, lane = verify_configured_token(_bearer(request), trusted=settings.KODERA_AUTH_TRUST)
    return lanes.admit(verified, lane)


def _finish(response: HttpResponse, request_id: str) -> HttpResponse:
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response


def _refused(
    failure: Exception, request: HttpRequest, request_id: str, operation_id: str
) -> HttpResponse:
    """The answer to every refusal the six views share."""
    if isinstance(failure, service.InvitationCallerUnknownError):
        return problems.identity_unknown(request_id, operation_id)
    if isinstance(failure, service.InvitationForbiddenError):
        try:
            service.record_tenant_denial(refused=failure, request_id=request_id)
        except Exception as unrecorded:
            # AUTHZ.md §9: a refusal that cannot be recorded is not answered as recorded.
            LOG.error(
                "invitation denial not recorded: %s request_id=%s",
                type(unrecorded).__name__,
                request_id,
            )
            return _problem("internal-error", request_id)
        return _problem("forbidden", request_id)
    kind = {
        service.InvitationNotFoundError: "not-found",
        service.InvitationInputError: "malformed-request",
        service.InvitationStateError: "conflict",
    }.get(type(failure))
    if kind is not None:
        return _problem(kind, request_id)
    if isinstance(failure, service.InvitationGoneError):
        return _problem(f"invitation-{failure.reason}", request_id)
    if isinstance(failure, service.InvitationRateLimitedError):
        response = _problem("rate-limited", request_id)
        response["Retry-After"] = str(failure.retry_after_s)
        return response
    # SQL diagnostics, tokens and addresses never enter the body or the log.
    LOG.error(
        "%s %s failed: %s request_id=%s",
        operation_id,
        request.method,
        type(failure).__name__,
        request_id,
    )
    return _problem("internal-error", request_id)


def _staff(
    verified: VerifiedAccessToken, organisation_id: UUID | None, scope: str, request_id: str
) -> HttpResponse:
    service.record_staff_denial(
        verified=verified, organisation_id=organisation_id, scope=scope, request_id=request_id
    )
    return _problem("forbidden", request_id)


@declares(LIST_INVITATIONS, INVITE_TO_ORGANISATION)
def organisation_invitations(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    supplied = request.headers.get("X-Request-Id", "")
    request_id = supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
    operation = INVITE_TO_ORGANISATION if request.method == "POST" else LIST_INVITATIONS
    try:
        if request.method not in {"GET", "POST"}:
            return _finish(
                _problem("method-not-allowed", request_id, allow="GET, POST"), request_id
            )
        verified, lane = _verified(request)
        if lane == "staff":
            return _finish(
                _staff(verified, organisation_id, operation.scope, request_id), request_id
            )
        if request.method == "GET":
            query = parse_qs(request.META.get("QUERY_STRING", ""), keep_blank_values=True)
            limit, state, cursor = service.parse_query(query)
            caller = service.authorise(
                verified=verified, organisation_id=organisation_id, scope=service.READ_SCOPE
            )
            page = service.list_invitations(caller=caller, limit=limit, state=state, cursor=cursor)
            body = {
                "data": [_invitation(view) for view in page.data],
                "next_cursor": page.next_cursor,
                "has_more": page.next_cursor is not None,
            }
            response = HttpResponse(_json(body), content_type="application/json")
        else:
            caller = service.authorise(
                verified=verified, organisation_id=organisation_id, scope=service.CREATE_SCOPE
            )
            batch = service.parse_batch(_body(request))
            service.check_grantable(caller=caller, batch=batch)

            def handler() -> StoredResponse:
                result = service.invite(caller=caller, batch=batch, request_id=request_id)
                return StoredResponse(
                    status=201, body=_json(_batch(result)), content_type="application/json"
                )

            response = respond_once(
                request,
                issuer=verified.issuer,
                subject=verified.subject,
                request_id=request_id,
                handler=handler,
                policy=service.quota_replay_policy(),
            )
    except TokenVerificationError:
        response = _problem("unauthenticated", request_id)
    except Exception as failure:
        response = _refused(failure, request, request_id, operation.operation_id)
    return _finish(response, request_id)


@declares(REVOKE_INVITATION)
def invitation(request: HttpRequest, invitation_id: UUID) -> HttpResponse:
    supplied = request.headers.get("X-Request-Id", "")
    request_id = supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
    try:
        if request.method != "DELETE":
            return _finish(_problem("method-not-allowed", request_id, allow="DELETE"), request_id)
        verified, lane = _verified(request)
        if lane == "staff":
            # staff_operator's revocation is declared but not served yet (docs/specs/INVITATIONS.md).
            return _finish(_staff(verified, None, service.DELETE_SCOPE, request_id), request_id)
        organisation_id = service.invitation_organisation(invitation_id=invitation_id)
        caller = service.authorise(
            verified=verified, organisation_id=organisation_id, scope=service.DELETE_SCOPE
        )
        service.revoke(caller=caller, invitation_id=invitation_id, request_id=request_id)
        response = HttpResponse(status=204)
    except TokenVerificationError:
        response = _problem("unauthenticated", request_id)
    except Exception as failure:
        response = _refused(failure, request, request_id, REVOKE_INVITATION.operation_id)
    return _finish(response, request_id)


@declares(RESEND_INVITATION)
def resend_invitation(request: HttpRequest, invitation_id: UUID) -> HttpResponse:
    supplied = request.headers.get("X-Request-Id", "")
    request_id = supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
    try:
        if request.method != "POST":
            return _finish(_problem("method-not-allowed", request_id, allow="POST"), request_id)
        verified, lane = _verified(request)
        if lane == "staff":
            return _finish(_staff(verified, None, service.ACT_SCOPE, request_id), request_id)
        if _body(request) not in {b"", b"{}"}:
            raise service.InvitationInputError()
        organisation_id = service.invitation_organisation(invitation_id=invitation_id)
        caller = service.authorise(
            verified=verified, organisation_id=organisation_id, scope=service.ACT_SCOPE
        )

        def handler() -> StoredResponse:
            view = service.resend(caller=caller, invitation_id=invitation_id, request_id=request_id)
            return StoredResponse(
                status=200, body=_json(_invitation(view)), content_type="application/json"
            )

        response = respond_once(
            request,
            issuer=verified.issuer,
            subject=verified.subject,
            request_id=request_id,
            handler=handler,
            policy=service.quota_replay_policy(),
        )
    except TokenVerificationError:
        response = _problem("unauthenticated", request_id)
    except Exception as failure:
        response = _refused(failure, request, request_id, RESEND_INVITATION.operation_id)
    return _finish(response, request_id)


@declares(ACCEPT_INVITATION)
def accept_invitation(request: HttpRequest) -> HttpResponse:
    supplied = request.headers.get("X-Request-Id", "")
    request_id = supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
    try:
        if request.method != "POST":
            return _finish(_problem("method-not-allowed", request_id, allow="POST"), request_id)
        verified, lane = _verified(request)
        accepted_request = service.parse_accept(_body(request))

        def handler() -> StoredResponse:
            accepted = service.accept(
                verified=verified, lane=lane, request=accepted_request, request_id=request_id
            )
            return StoredResponse(
                status=200, body=_json(_membership(accepted)), content_type="application/json"
            )

        response = respond_once(
            request,
            issuer=verified.issuer,
            subject=verified.subject,
            request_id=request_id,
            handler=handler,
            policy=service.quota_replay_policy(),
        )
    except TokenVerificationError:
        response = _problem("unauthenticated", request_id)
    except Exception as failure:
        response = _refused(failure, request, request_id, ACCEPT_INVITATION.operation_id)
    return _finish(response, request_id)


@declares(PREVIEW_INVITATION)
def preview_invitation(request: HttpRequest) -> HttpResponse:
    """The invitation card, read before acceptance: no `Idempotency-Key`, no replay, no write."""
    supplied = request.headers.get("X-Request-Id", "")
    request_id = supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
    try:
        if request.method != "POST":
            return _finish(_problem("method-not-allowed", request_id, allow="POST"), request_id)
        verified, lane = _verified(request)
        token = service.parse_preview(_body(request))
        card = service.preview(verified=verified, lane=lane, token=token)
        response = HttpResponse(_json(_preview(card)), status=200, content_type="application/json")
    except TokenVerificationError:
        response = _problem("unauthenticated", request_id)
    except Exception as failure:
        response = _refused(failure, request, request_id, PREVIEW_INVITATION.operation_id)
    return _finish(response, request_id)
