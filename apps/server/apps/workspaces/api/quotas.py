"""Read-only quota usage and explicit limits under current workspace authority."""

import hashlib
import json

from django.conf import settings
from django.http import HttpResponse

from apps.workspaces import quotas
from apps.workspaces.moderation import RefusalError
from core.api import lanes, problems
from core.api.scopes import Operation, declares
from services.identity.access_tokens import TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

from . import responses


def _read(request, organisation_id, *, limits_only, operation_id):
    request_id = responses.request_id(request)
    try:
        if request.method != "GET":
            response = responses.problem("method-not-allowed", request_id)
            response["Allow"] = "GET"
            return responses.finish(response, request_id)
        verified, lane = verify_configured_token(
            responses.bearer(request), trusted=settings.KODERA_AUTH_TRUST
        )
        verified, lane = lanes.admit(verified, lane)
        if lane == "staff":
            raise RefusalError(403)
        # Admission precedes syntax errors as well as representation construction.
        content = quotas.read(verified=verified, organisation_id=organisation_id)
        if request.GET:
            raise RefusalError(400)
        if limits_only:
            content = content["limits"]
        encoded = json.dumps(content, sort_keys=True, separators=(",", ":")).encode()
        response = HttpResponse(encoded, content_type="application/json")
        response["ETag"] = '"' + hashlib.sha256(encoded).hexdigest() + '"'
    except TokenVerificationError:
        response = responses.problem("unauthenticated", request_id)
    except RefusalError as failure:
        if failure.kind == "identity-unknown":
            response = problems.identity_unknown(request_id, operation_id)
        else:
            response = responses.problem(failure.kind, request_id)
    return responses.finish(response, request_id)


@declares(Operation("GET", "getWorkspaceQuotaUsage", "workspace_quota:read"))
def usage(request, organisation_id):
    return _read(request, organisation_id, limits_only=False, operation_id="getWorkspaceQuotaUsage")


@declares(Operation("GET", "getWorkspaceQuotaLimits", "workspace_quota:read"))
def limits(request, organisation_id):
    return _read(request, organisation_id, limits_only=True, operation_id="getWorkspaceQuotaLimits")
