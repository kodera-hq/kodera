"""The tenant reads and the shell's status summary (contracts/core-api.openapi.yaml, tags Tenants
and Organisations), served as the billing reads are: the bearer token is verified, a staff token
is refused with `403` until the staff lane of these reads is built, and a member's stored role is
checked by apps/billing/access.py before apps/billing/tenant_reads.py reads anything. A tenant of
another organisation answers `404`."""

from uuid import UUID

from django.http import HttpRequest, HttpResponse

from core.api.scopes import declares
from core.db.ids import new_uuid7

from .. import tenant_reads as selectors
from . import permissions as op
from .create_tenant import create as create_tenant
from .views import REQUEST_ID, _organisation_list, _problem, _resource

_list_tenants = _organisation_list(
    op.LIST_TENANTS, "tenant:read", {"status": selectors.TENANT_STATUSES}, selectors.list_tenants
)


@declares(op.LIST_TENANTS, op.CREATE_TENANT)
def tenants(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    """listTenants, or createTenant on a deployment that does not bill (QUICK_WORKSPACE.md §4)."""
    if request.method == "POST":
        created: HttpResponse = create_tenant(request, organisation_id=organisation_id)
        return created
    if request.method != "GET":
        supplied = request.headers.get("X-Request-Id", "")
        request_id = supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
        refused = _problem(405, request_id, allow="GET, POST")
        refused["Cache-Control"] = "no-store"
        refused["X-Request-Id"] = request_id
        return refused
    listed: HttpResponse = _list_tenants(request, organisation_id=organisation_id)
    return listed


tenant = _resource(
    op.GET_TENANT, "tenant:read", "tenant", selectors.tenant_owner, selectors.get_tenant
)
tenant_status = _resource(
    op.GET_TENANT_STATUS, "tenant:read", "tenant", selectors.tenant_owner, selectors.tenant_status
)
status_summary = _resource(
    op.GET_STATUS_SUMMARY,
    "organisation:read",
    "organisation",
    lambda organisation_id: organisation_id,
    lambda organisation_id, _: selectors.status_summary(organisation_id),
)
