"""Authenticated privacy lifecycle routes; archive delivery and erasure admission remain held."""

import json
import re

from django.conf import settings
from django.core.exceptions import RequestDataTooBig
from django.http import HttpRequest, HttpResponse

from apps.orgs.privacy_selectors import PrivacyHttpError, admit_privacy_request
from core.api import lanes, problems
from core.api.scopes import Operation, declares
from core.db.ids import new_uuid7
from services.identity.access_tokens import MAX_TOKEN, TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,64}\Z")
PROBLEM_BASE = "https://kodera.io/problems/"
PROBLEM_TYPE = "application/problem+json"
PROBLEMS = {
    "malformed-request": (400, "Malformed request"),
    "idempotency-key-missing": (400, "Idempotency key required"),
    "unauthenticated": (401, "Authentication required"),
    "forbidden": (403, "Access refused"),
    "not-found": (404, "Not found"),
    "method-not-allowed": (405, "Method not allowed"),
    "conflict": (409, "The structure does not allow this change"),
    "last-owner-protected": (409, "The last owner cannot be removed or demoted"),
    "service-unavailable": (503, "Busy, retry the same request"),
}


def _request_id(request: HttpRequest) -> str:
    supplied = request.headers.get("X-Request-Id", "")
    return supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())


def _bearer(request: HttpRequest) -> str:
    authorization = request.headers.get("Authorization", "")
    if len(authorization) > MAX_TOKEN + 7:
        raise TokenVerificationError()
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise TokenVerificationError()
    return parts[1]


def _problem(kind: str, correlation: str, **extensions: object) -> HttpResponse:
    status, title = PROBLEMS[kind]
    body = {
        "type": PROBLEM_BASE + kind,
        "title": title,
        "status": status,
        "request_id": correlation,
        **extensions,
    }
    response = HttpResponse(json.dumps(body).encode(), status=status, content_type=PROBLEM_TYPE)
    if status == 401:
        response["WWW-Authenticate"] = "Bearer"
    if status == 503:
        response["Retry-After"] = "60"
    return response


def _finish(response: HttpResponse, correlation: str) -> HttpResponse:
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = correlation
    return response


def _handle(request, *, operation_id, kind, organisation_id=None, request_id=None, download=False):
    correlation = _request_id(request)
    method = "POST" if request_id is None else "GET"
    try:
        if request.method != method:
            response = _problem("method-not-allowed", correlation)
            response["Allow"] = method
        else:
            verified, lane = verify_configured_token(
                _bearer(request), trusted=settings.KODERA_AUTH_TRUST
            )
            verified, lane = lanes.admit(verified, lane)
            if lane == "staff":
                raise PrivacyHttpError("forbidden")
            content, etag = admit_privacy_request(
                request, verified, organisation_id, request_id, kind, download
            )
            response = HttpResponse(content, content_type="application/json")
            response["ETag"] = etag
    except TokenVerificationError:
        response = _problem("unauthenticated", correlation)
    except RequestDataTooBig:
        response = _problem("malformed-request", correlation)
    except PrivacyHttpError as failure:
        response = (
            problems.identity_unknown(correlation, operation_id)
            if failure.kind == "identity-unknown"
            else _problem(failure.kind, correlation, **failure.extensions)
        )
    return _finish(response, correlation)


@declares(Operation("POST", "requestAccountExport", "privacy_account:create"))
def account_exports(request):
    return _handle(request, operation_id="requestAccountExport", kind="export")


@declares(Operation("GET", "getAccountExport", "privacy_account:read"))
def account_export(request, request_id):
    return _handle(request, operation_id="getAccountExport", kind="export", request_id=request_id)


@declares(Operation("GET", "getAccountExportDownloadLink", "privacy_account:read"))
def account_download(request, request_id):
    return _handle(
        request,
        operation_id="getAccountExportDownloadLink",
        kind="export",
        request_id=request_id,
        download=True,
    )


@declares(Operation("POST", "requestAccountDeletion", "privacy_account:create"))
def account_deletions(request):
    return _handle(request, operation_id="requestAccountDeletion", kind="deletion")


@declares(Operation("GET", "getAccountDeletion", "privacy_account:read"))
def account_deletion(request, request_id):
    return _handle(
        request, operation_id="getAccountDeletion", kind="deletion", request_id=request_id
    )


@declares(Operation("POST", "requestWorkspaceExport", "privacy_workspace:create"))
def workspace_exports(request, organisation_id):
    return _handle(
        request,
        operation_id="requestWorkspaceExport",
        kind="export",
        organisation_id=organisation_id,
    )


@declares(Operation("GET", "getWorkspaceExport", "privacy_workspace:read"))
def workspace_export(request, organisation_id, request_id):
    return _handle(
        request,
        operation_id="getWorkspaceExport",
        kind="export",
        organisation_id=organisation_id,
        request_id=request_id,
    )


@declares(Operation("GET", "getWorkspaceExportDownloadLink", "privacy_workspace:read"))
def workspace_download(request, organisation_id, request_id):
    return _handle(
        request,
        operation_id="getWorkspaceExportDownloadLink",
        kind="export",
        organisation_id=organisation_id,
        request_id=request_id,
        download=True,
    )


@declares(Operation("POST", "requestWorkspaceDeletion", "privacy_workspace:create"))
def workspace_deletions(request, organisation_id):
    return _handle(
        request,
        operation_id="requestWorkspaceDeletion",
        kind="deletion",
        organisation_id=organisation_id,
    )


@declares(Operation("GET", "getWorkspaceDeletion", "privacy_workspace:read"))
def workspace_deletion(request, organisation_id, request_id):
    return _handle(
        request,
        operation_id="getWorkspaceDeletion",
        kind="deletion",
        organisation_id=organisation_id,
        request_id=request_id,
    )
