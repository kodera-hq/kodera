"""Read-only quota usage and explicit limits."""

from apps.docs.api import http
from apps.docs.errors import RefusalError
from apps.workspaces import quotas
from core.api.scopes import Operation, declares


@declares(Operation("GET", "getWorkspaceQuotaUsage", "workspace_quota:read"))
def usage(request, organisation_id):
    def get(verified, request_id):
        if request.GET:
            raise RefusalError(400)
        return http.json_response(
            quotas.read(verified=verified, organisation_id=organisation_id), etag=True
        )

    return http.serve(request, {"GET": get}, organisation_id)


@declares(Operation("GET", "getWorkspaceQuotaLimits", "workspace_quota:read"))
def limits(request, organisation_id):
    def get(verified, request_id):
        if request.GET:
            raise RefusalError(400)
        return http.json_response(
            quotas.read(verified=verified, organisation_id=organisation_id)["limits"], etag=True
        )

    return http.serve(request, {"GET": get}, organisation_id)
