"""Recorded VAT checks: authorize before transport and reauthorize before committing evidence."""

import hashlib
import json
from uuid import UUID

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from apps.billing import vies
from apps.billing.access import (
    READERS,
    BillingCallerUnknownError,
    BillingForbiddenError,
    BillingNotFoundError,
    read_as_member,
    record_member_denial,
)
from apps.billing.callers import require_role, tenant_caller
from core.api import lanes, problems
from core.api.idempotency import (
    KEY_HEADER,
    StoredResponse,
    holds_answer,
    is_malformed,
    is_missing,
    respond_once,
)
from core.api.scopes import declares
from core.db.ids import new_uuid7
from services.identity.access_tokens import TokenVerificationError, VerifiedAccessToken
from services.identity.trusted_issuers import verify_configured_token

from . import permissions as op, views


def _step(
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    country: str,
    number: str,
    answer: vies.Answer,
    request_id: str,
) -> StoredResponse:
    caller = tenant_caller(verified=verified, organisation_id=organisation_id)
    require_role(caller, roles=READERS["billing_vat:update"], scope="billing_vat:update")
    try:
        vies.record_consultation(
            organisation_id=organisation_id, country_code=country, vat_number=number, answer=answer
        )
    except vies.ViesRefusedError:
        return views._stored_problem(409, "conflict", "Billing profile changed", request_id)
    return StoredResponse(
        status=200,
        content_type="application/json",
        body=json.dumps(vies.vat_status(organisation_id)).encode(),
    )


def _validate(request: HttpRequest, organisation_id: UUID, request_id: str) -> HttpResponse:
    verified, lane = verify_configured_token(
        views._bearer(request), trusted=settings.KODERA_AUTH_TRUST
    )
    verified, lane = lanes.admit(verified, lane)
    if lane == "staff":
        from apps.billing.access import record_staff_denial

        record_staff_denial(
            verified=verified,
            target_urn=f"urn:kodera:organisation:{organisation_id}",
            request_id=request_id,
            scope="billing_vat:update",
        )
        raise views._RefusedError()
    read_as_member(
        verified=verified,
        organisation=lambda: organisation_id,
        scope="billing_vat:update",
        read=lambda _: None,
    )
    if len(request.body) > 2048 or request.content_type != "application/json":
        return views._problem(400, request_id)
    try:
        body = json.loads(request.body)
        if not isinstance(body, dict) or set(body) != {"vat_number", "country_code"}:
            raise ValueError
        country, number = body["country_code"], body["vat_number"]
        vies.normalise(country, number)
    except (ValueError, TypeError):
        return views._problem(400, request_id)
    if not vies.profile_matches(
        organisation_id=organisation_id, country_code=country, vat_number=number
    ):
        return views._conflict(request_id, "VAT request must match the current billing profile.")
    key = request.headers.get(KEY_HEADER, "")
    answer = vies.Answer(
        "unavailable",
        None,
        {"outcome": "unavailable"},
        hashlib.sha256(b"vies:unavailable").hexdigest(),
    )
    if (
        not is_missing(key)
        and not is_malformed(key)
        and not holds_answer(request, issuer=verified.issuer, subject=verified.subject, key=key)
    ):
        issuer = getattr(settings, "KODERA_BILLING_ISSUER", None)
        if issuer is not None:
            answer = vies.consult(
                country_code=country, vat_number=number, requester=issuer.vat_number
            )
    return respond_once(
        request,
        issuer=verified.issuer,
        subject=verified.subject,
        request_id=request_id,
        handler=lambda: _step(verified, organisation_id, country, number, answer, request_id),
    )


@declares(op.GET_BILLING_VAT, op.VALIDATE_BILLING_VAT)
def billing_vat(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    if request.method == "GET":
        response = views._answer(
            request,
            op.GET_BILLING_VAT,
            lambda request_id: views._member_read(
                request,
                request_id,
                organisation=lambda: organisation_id,
                scope="billing_vat:read",
                target_urn=f"urn:kodera:organisation:{organisation_id}",
                read=lambda: vies.vat_status(organisation_id),
            ),
        )
        if response.status_code == 200:
            response["ETag"] = '"sha256-' + hashlib.sha256(response.content).hexdigest() + '"'
        return response
    request_id = request.headers.get("X-Request-Id", "")
    if not views.REQUEST_ID.fullmatch(request_id):
        request_id = str(new_uuid7())
    try:
        response = (
            _validate(request, organisation_id, request_id)
            if request.method == "POST"
            else views._problem(405, request_id, allow="GET, POST")
        )
    except TokenVerificationError:
        response = views._problem(401, request_id)
    except BillingCallerUnknownError:
        response = problems.identity_unknown(request_id, op.VALIDATE_BILLING_VAT.operation_id)
    except BillingNotFoundError:
        response = views._problem(404, request_id)
    except BillingForbiddenError as refused:
        record_member_denial(
            refused=refused,
            target_urn=f"urn:kodera:organisation:{organisation_id}",
            request_id=request_id,
        )
        response = views._problem(403, request_id)
    except views._RefusedError:
        response = views._problem(403, request_id)
    except Exception as failure:
        views.LOG.error(
            "validateBillingVat failed: %s request_id=%s", type(failure).__name__, request_id
        )
        response = views._problem(500, request_id)
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response
