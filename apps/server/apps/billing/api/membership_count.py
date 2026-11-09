"""countMemberships (contracts/core-api.openapi.yaml, tag Memberships): how many people of an
organisation match a filter, for the People screen's member, admin and invitation counts.

Served as the billing reads are (apps/billing/api/views.py): the bearer token is verified, a staff
token is refused with `403` until the staff lane of these reads is built, and the caller's stored
role is checked in a read-only snapshot by apps/billing/access.py, which also answers `404` for an
organisation the caller is not a current member of (`listMemberships` answers a known person with
no current membership `403`; both are in the contract). The roles are those that read the People
directory, `listMemberships`, one constant for both; apps/billing/membership_count.py reads the query and the count, once
the caller is authorised, so an unauthenticated caller gets `401` whatever it asked. The
per-principal rate limit the contract mentions is not enforced yet, as its description says.
"""

from typing import Any
from uuid import UUID

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from apps.billing.access import (
    BillingForbiddenError,
    read_as_member,
    record_member_denial,
    record_staff_denial,
)
from apps.billing.membership_count import counted
from core.api import lanes
from core.api.scopes import declares
from services.identity.trusted_issuers import verify_configured_token

from . import permissions as op
from .views import _answer, _bearer, _RefusedError

SCOPE = "membership:read"


@declares(op.COUNT_MEMBERSHIPS)
def membership_count(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    target = f"urn:kodera:organisation:{organisation_id}"

    def produce(request_id: str) -> Any:
        verified, lane = verify_configured_token(
            _bearer(request), trusted=settings.KODERA_AUTH_TRUST
        )
        verified, lane = lanes.admit(verified, lane)
        if lane == "staff":
            record_staff_denial(
                verified=verified, target_urn=target, request_id=request_id, scope=SCOPE
            )
            raise _RefusedError()

        try:
            return read_as_member(
                verified=verified,
                organisation=lambda: organisation_id,
                scope=SCOPE,
                # The caller's organisation, which access.py has matched to the path's.
                read=lambda caller: counted(
                    caller.organisation_id, request.META.get("QUERY_STRING", "")
                ),
            )
        except BillingForbiddenError as refused:
            record_member_denial(refused=refused, target_urn=target, request_id=request_id)
            raise _RefusedError() from None

    return _answer(request, op.COUNT_MEMBERSHIPS, produce)
