"""One membership: getMembership, changeMembershipRole, removeMembership (MEMBERSHIP_LIFECYCLE.md)."""

import json
import logging
import re
from datetime import datetime
from uuid import UUID

from django.conf import settings
from django.core.exceptions import RequestDataTooBig
from django.core.validators import EmailValidator
from django.http import HttpRequest, HttpResponse

from apps.orgs.membership_lifecycle import (
    DELETE_SCOPE,
    READ_SCOPE,
    UPDATE_SCOPE,
    LastOwnerError,
    MembershipCallerUnknownError,
    MembershipDetailView,
    MembershipForbiddenError,
    MembershipNotFoundError,
    MembershipPatchInvalidError,
    MembershipStateError,
    MembershipView,
    PreconditionFailedError,
    PreconditionRequiredError,
    change_membership,
    parse_patch,
    read_membership,
    record_staff_denial,
    record_tenant_denial,
    remove_membership,
)
from core.api import lanes, problems
from core.api.scopes import declares
from core.db.ids import new_uuid7
from services.identity.access_tokens import MAX_TOKEN, TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

from .membership_permissions import CHANGE_MEMBERSHIP_ROLE, GET_MEMBERSHIP, REMOVE_MEMBERSHIP

LOG = logging.getLogger(__name__)
REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,64}\Z")
ALLOWED = "GET, PATCH, DELETE"
PATCH_MEDIA_TYPE = "application/merge-patch+json"
EMAIL = EmailValidator(allowlist=[])
PROBLEMS = {
    "malformed-request": (400, "Malformed request"),
    "unauthenticated": (401, "Authentication required"),
    "forbidden": (403, "Access refused"),
    "not-found": (404, "Not found"),
    "method-not-allowed": (405, "Method not allowed"),
    "last-owner-protected": (409, "The last owner cannot be removed or demoted"),
    "invalid-state-transition": (409, "The membership's state does not allow this change"),
    "precondition-failed": (412, "The membership changed since it was read"),
    "precondition-required": (428, "If-Match is required"),
    "internal-error": (500, "Internal error"),
}


def _problem(kind: str, request_id: str, **extensions: object) -> HttpResponse:
    status, title = PROBLEMS[kind]
    body: dict[str, object] = {
        "type": "https://kodera.io/problems/" + kind,
        "title": title,
        "status": status,
        "request_id": request_id,
        **extensions,
    }
    response = HttpResponse(
        json.dumps(body), status=status, content_type="application/problem+json"
    )
    if status == 401:
        response["WWW-Authenticate"] = "Bearer"
    if status == 405:
        response["Allow"] = ALLOWED
    return response


def _bearer(request: HttpRequest) -> str:
    value = request.headers.get("Authorization", "")
    if len(value) > MAX_TOKEN + 7:
        raise TokenVerificationError()
    parts = value.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise TokenVerificationError()
    return parts[1]


def _stamp(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _membership(view: MembershipView) -> dict[str, object]:
    if len(view.email) > 320 or any(char in view.email for char in "\r\n"):
        raise ValueError("stored contact is outside the projection contract")
    EMAIL(view.email)
    return {
        "id": str(view.id),
        "organisation_id": str(view.organisation_id),
        "person_id": str(view.user_id),
        "identity_id": None if view.identity_id is None else str(view.identity_id),
        "email": view.email,
        "display_name": view.display_name,
        "role": view.role,
        "state": view.state,
        "created_at": _stamp(view.created_at),
        "updated_at": _stamp(view.updated_at),
    }


def _removed(view: MembershipView) -> dict[str, object]:
    """A removal's answer, first or repeated: the row's required facts, never the former member's
    contact, which a read of the removed row would not disclose either."""
    return {
        "id": str(view.id),
        "organisation_id": str(view.organisation_id),
        "role": view.role,
        "state": view.state,
        "created_at": _stamp(view.created_at),
        "updated_at": _stamp(view.updated_at),
    }


def _detail(detail: MembershipDetailView) -> dict[str, object]:
    return {
        **_membership(detail.membership),
        "can_change_role": detail.can_change_role,
        "can_remove": detail.can_remove,
        "blocked_reason": detail.blocked_reason,
        "invitation_id": None,
    }


def _json(body: dict[str, object], tag: str | None = None) -> HttpResponse:
    response = HttpResponse(
        json.dumps(body, ensure_ascii=False, separators=(",", ":")),
        content_type="application/json",
    )
    if tag is not None:
        response["ETag"] = tag
    return response


def _body(request: HttpRequest) -> bytes:
    """The request body, or a malformed request when it is over the server's size limit."""
    try:
        return request.body
    except RequestDataTooBig:
        raise MembershipPatchInvalidError() from None


@declares(GET_MEMBERSHIP, CHANGE_MEMBERSHIP_ROLE, REMOVE_MEMBERSHIP)
def membership(request: HttpRequest, organisation_id: UUID, membership_id: UUID) -> HttpResponse:
    supplied = request.headers.get("X-Request-Id", "")
    request_id = supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
    scope = {"GET": READ_SCOPE, "PATCH": UPDATE_SCOPE, "DELETE": DELETE_SCOPE}.get(
        request.method or ""
    )
    try:
        if request.method not in {"GET", "PATCH", "DELETE"}:
            response = _problem("method-not-allowed", request_id, allowed=ALLOWED.split(", "))
        else:
            verified, lane = verify_configured_token(
                _bearer(request), trusted=settings.KODERA_AUTH_TRUST
            )
            verified, lane = lanes.admit(verified, lane)
            if lane == "staff":
                # AUTHZ.md §9: a staff read refused is recorded as well as a staff write.
                record_staff_denial(
                    verified=verified,
                    organisation_id=organisation_id,
                    scope=scope or READ_SCOPE,
                    request_id=request_id,
                )
                response = _problem("forbidden", request_id)
            elif request.method == "GET":
                detail, tag = read_membership(
                    verified=verified, organisation_id=organisation_id, membership_id=membership_id
                )
                response = _json(_detail(detail), tag)
            elif request.method == "PATCH":
                media_type = request.headers.get("Content-Type", "").split(";")[0].strip()
                if media_type.lower() != PATCH_MEDIA_TYPE:
                    raise MembershipPatchInvalidError()
                changed, tag = change_membership(
                    verified=verified,
                    organisation_id=organisation_id,
                    membership_id=membership_id,
                    patch=parse_patch(_body(request)),
                    if_match=request.headers.get("If-Match"),
                    request_id=request_id,
                )
                response = _json(_membership(changed), tag)
            else:
                removed = remove_membership(
                    verified=verified,
                    organisation_id=organisation_id,
                    membership_id=membership_id,
                    if_match=request.headers.get("If-Match"),
                    request_id=request_id,
                )
                response = _json(_removed(removed))
    except TokenVerificationError:
        response = _problem("unauthenticated", request_id)
    except MembershipCallerUnknownError:
        response = problems.identity_unknown(
            request_id,
            {"PATCH": CHANGE_MEMBERSHIP_ROLE, "DELETE": REMOVE_MEMBERSHIP}.get(
                request.method or "", GET_MEMBERSHIP
            ).operation_id,
        )
    except MembershipForbiddenError as refused:
        response = _problem("forbidden", request_id)
        try:
            # AUTHZ.md §9 records a refused write; a refused tenant read is not recorded, so a
            # reader cannot fill the audit trail by repeating it.
            if request.method in {"PATCH", "DELETE"}:
                record_tenant_denial(
                    refused=refused, scope=scope or READ_SCOPE, request_id=request_id
                )
        except Exception as failure:
            # AUTHZ.md §9: a refusal that cannot be recorded is not answered as recorded.
            LOG.error(
                "membership denial record failed: %s request_id=%s",
                type(failure).__name__,
                request_id,
            )
            response = _problem("internal-error", request_id)
    except MembershipNotFoundError:
        response = _problem("not-found", request_id)
    except MembershipPatchInvalidError:
        response = _problem("malformed-request", request_id)
    except PreconditionRequiredError:
        response = _problem("precondition-required", request_id)
    except PreconditionFailedError as stale:
        response = _problem("precondition-failed", request_id, current_etag=stale.current_etag)
        response["ETag"] = stale.current_etag
    except LastOwnerError as last:
        response = _problem(
            "last-owner-protected", request_id, organisation_id=str(last.organisation_id)
        )
    except MembershipStateError as invalid:
        response = _problem(
            "invalid-state-transition", request_id, allowed_states=list(invalid.allowed_states)
        )
    except Exception as failure:
        # SQL diagnostics, credentials and identity facts never enter the body or the log: the
        # log names the exception's class and the request id, nothing of the request.
        LOG.error(
            "membership %s failed: %s request_id=%s",
            request.method,
            type(failure).__name__,
            request_id,
        )
        response = _problem("internal-error", request_id)
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response
