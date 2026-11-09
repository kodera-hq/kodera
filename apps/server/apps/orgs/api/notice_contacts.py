"""The DPA's notice addresses: getNoticeContacts, patchNoticeContacts (ORGANISATION_NOTICE_CONTACTS.md)."""

import json
import logging
import re
from uuid import UUID

from django.conf import settings
from django.core.exceptions import RequestDataTooBig
from django.http import HttpRequest, HttpResponse

from apps.orgs.notice_contacts import (
    READ_SCOPE,
    UPDATE_SCOPE,
    NoticeBusyError,
    NoticeCallerUnknownError,
    NoticeContacts,
    NoticeForbiddenError,
    NoticeNotFoundError,
    NoticePatchInvalidError,
    NoticePreconditionFailedError,
    NoticePreconditionRequiredError,
    change_notice_contacts,
    parse_patch,
    read_notice_contacts,
    record_staff_denial,
    record_tenant_denial,
)
from core.api import lanes, problems
from core.api.scopes import declares
from core.db.ids import new_uuid7
from services.identity.access_tokens import MAX_TOKEN, TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

from .notice_contact_permissions import GET_NOTICE_CONTACTS, PATCH_NOTICE_CONTACTS

LOG = logging.getLogger(__name__)
REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,64}\Z")
ALLOWED = "GET, PATCH"
PATCH_MEDIA_TYPE = "application/merge-patch+json"
PROBLEMS = {
    "malformed-request": (400, "Malformed request"),
    "unauthenticated": (401, "Authentication required"),
    "forbidden": (403, "Access refused"),
    "not-found": (404, "Not found"),
    "method-not-allowed": (405, "Method not allowed"),
    "precondition-failed": (412, "The notice contacts changed since they were read"),
    "precondition-required": (428, "If-Match is required"),
    "service-unavailable": (503, "Busy, retry the same request"),
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
    if status == 503:
        response["Retry-After"] = "1"
    return response


def _bearer(request: HttpRequest) -> str:
    value = request.headers.get("Authorization", "")
    if len(value) > MAX_TOKEN + 7:
        raise TokenVerificationError()
    parts = value.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise TokenVerificationError()
    return parts[1]


def _body(request: HttpRequest) -> bytes:
    try:
        return request.body
    except RequestDataTooBig:
        raise NoticePatchInvalidError() from None


def _json(contacts: NoticeContacts, tag: str) -> HttpResponse:
    body: dict[str, object] = {"organisation_id": str(contacts.organisation_id)}
    for field, value in contacts.values().items():
        body[field] = value
        body[field.removesuffix("_email") + "_defaults_to_owners"] = value is None
    response = HttpResponse(
        json.dumps(body, ensure_ascii=False, separators=(",", ":")),
        content_type="application/json",
    )
    response["ETag"] = tag
    return response


@declares(GET_NOTICE_CONTACTS, PATCH_NOTICE_CONTACTS)
def notice_contacts(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    supplied = request.headers.get("X-Request-Id", "")
    request_id = supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
    scope = UPDATE_SCOPE if request.method == "PATCH" else READ_SCOPE
    try:
        if request.method not in {"GET", "PATCH"}:
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
                    scope=scope,
                    request_id=request_id,
                )
                response = _problem("forbidden", request_id)
            elif request.method == "GET":
                contacts, tag = read_notice_contacts(
                    verified=verified, organisation_id=organisation_id
                )
                response = _json(contacts, tag)
            else:
                media_type = request.headers.get("Content-Type", "").split(";")[0].strip()
                if media_type.lower() != PATCH_MEDIA_TYPE:
                    raise NoticePatchInvalidError()
                contacts, tag = change_notice_contacts(
                    verified=verified,
                    organisation_id=organisation_id,
                    patch=parse_patch(_body(request)),
                    if_match=request.headers.get("If-Match"),
                    request_id=request_id,
                )
                response = _json(contacts, tag)
    except TokenVerificationError:
        response = _problem("unauthenticated", request_id)
    except NoticeCallerUnknownError:
        response = problems.identity_unknown(
            request_id,
            (
                PATCH_NOTICE_CONTACTS if request.method == "PATCH" else GET_NOTICE_CONTACTS
            ).operation_id,
        )
    except NoticeForbiddenError as refused:
        response = _problem("forbidden", request_id)
        try:
            # AUTHZ.md §9 records a refused write; a refused tenant read is not recorded, so a
            # reader cannot fill the audit trail by repeating it.
            if request.method == "PATCH":
                record_tenant_denial(refused=refused, scope=scope, request_id=request_id)
        except Exception as failure:
            # AUTHZ.md §9: a refusal that cannot be recorded is not answered as recorded.
            LOG.error(
                "notice contacts denial record failed: %s request_id=%s",
                type(failure).__name__,
                request_id,
            )
            response = _problem("internal-error", request_id)
    except NoticeNotFoundError:
        response = _problem("not-found", request_id)
    except NoticePatchInvalidError:
        response = _problem("malformed-request", request_id)
    except NoticePreconditionRequiredError:
        response = _problem("precondition-required", request_id)
    except NoticeBusyError:
        response = _problem("service-unavailable", request_id, retry_after_s=1)
    except NoticePreconditionFailedError as stale:
        response = _problem("precondition-failed", request_id, current_etag=stale.current_etag)
        response["ETag"] = stale.current_etag
    except Exception as failure:
        # SQL diagnostics, credentials and contact facts never enter the body or the log: the log
        # names the exception's class and the request id, nothing of the request.
        LOG.error(
            "notice contacts %s failed: %s request_id=%s",
            request.method,
            type(failure).__name__,
            request_id,
        )
        response = _problem("internal-error", request_id)
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response
