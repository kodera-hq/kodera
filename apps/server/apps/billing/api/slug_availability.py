"""checkSlugAvailability (contracts/core-api.openapi.yaml, tag Organisations): whether a tenant
slug is free, asked by the order step on every blur of the slug field.

Served as the billing reads are (apps/billing/api/views.py): the bearer token is verified, a staff
token is refused with `403` until the staff lane of these reads is built, and the caller's stored
role is checked in a read-only snapshot by apps/billing/access.py. The path names no organisation:
the organisation is the caller's own, the one their identity belongs to. The contract admits
`org_owner` and `org_admin`, the roles that prepare an order (only the owner places it), fewer than
its scope's readers, and declares no `404`, so a known caller with no current membership is refused
with `403`, as a member or billing user is. Every `403` is recorded as `authz.denied`.

The query is read once the caller is authorised, so an unauthenticated caller gets `401` whatever
it asked; then anything but exactly one `slug` of the tenant slug pattern is `400`. The
per-principal rate limit the contract describes is not enforced yet, as its description says.
"""

from typing import Any

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from apps.billing.access import (
    BillingForbiddenError,
    BillingNotFoundError,
    own_organisation,
    read_as_member,
    record_member_denial,
    record_no_membership_denial,
    record_staff_denial,
)
from apps.billing.slug_availability import availability
from core.api import lanes
from core.api.scopes import declares
from services.identity.trusted_issuers import verify_configured_token

from . import permissions as op
from .views import _answer, _bearer, _RefusedError

SCOPE = "organisation:read"
TARGET = "urn:kodera:slug-availability"
SLUG_CHECK_ROLES = frozenset({"org_owner", "org_admin"})


@declares(op.CHECK_SLUG_AVAILABILITY)
def slug_availability(request: HttpRequest) -> HttpResponse:
    def produce(request_id: str) -> Any:
        verified, lane = verify_configured_token(
            _bearer(request), trusted=settings.KODERA_AUTH_TRUST
        )
        verified, lane = lanes.admit(verified, lane)
        if lane == "staff":
            record_staff_denial(
                verified=verified, target_urn=TARGET, request_id=request_id, scope=SCOPE
            )
            raise _RefusedError()
        try:
            return read_as_member(
                verified=verified,
                organisation=lambda: own_organisation(verified),
                scope=SCOPE,
                roles=SLUG_CHECK_ROLES,
                read=lambda _: availability(request.META.get("QUERY_STRING", "")),
            )
        except BillingForbiddenError as refused:
            record_member_denial(refused=refused, target_urn=TARGET, request_id=request_id)
            raise _RefusedError() from None
        except BillingNotFoundError:
            record_no_membership_denial(
                verified=verified, target_urn=TARGET, request_id=request_id, scope=SCOPE
            )
            raise _RefusedError() from None

    return _answer(request, op.CHECK_SLUG_AVAILABILITY, produce)
