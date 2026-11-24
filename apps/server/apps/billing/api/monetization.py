"""Authenticated HTTP endpoints for H3.1 community workspace boosts, VIP Connect, and DAC7.

Enforces bearer authentication, lane admission (`staff` refused with `403`), tenant membership &
role authorization (`apps.billing.access`), `Idempotency-Key` header validation on checkout and
Connect onboarding mutations, and zero `models` or foreign-app imports (`test_application_boundaries`).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any
from uuid import UUID

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.utils import timezone

from apps.billing import boosts, monetization_services, vip_connect
from apps.billing.access import (
    BillingCallerUnknownError,
    BillingForbiddenError,
    BillingNotFoundError,
    read_as_member,
    record_member_denial,
    record_staff_denial,
)
from apps.billing.payments import services as payment_services
from apps.billing.payments.port import (
    ProviderRefusedError,
    ProviderUnavailableError,
    ReturnUrlRequiredError,
)
from apps.billing.services import IdempotencyKeyReuseError
from core.api import lanes, problems
from core.api.idempotency import KEY_HEADER, is_malformed, is_missing
from core.api.scopes import Operation, declares
from core.db.ids import new_uuid7
from services.identity.access_tokens import TokenVerificationError, VerifiedAccessToken
from services.identity.trusted_issuers import verify_configured_token

from . import permissions as op, views

MAX_JSON_BODY = 16_384


def _json_problem(
    status: int, kind: str, title: str, request_id: str, detail: str = ""
) -> HttpResponse:
    body: dict[str, object] = {
        "type": views.PROBLEM_BASE + kind,
        "title": title,
        "status": status,
        "request_id": request_id,
    }
    if detail:
        body["detail"] = detail
    return HttpResponse(
        json.dumps(body),
        status=status,
        content_type="application/problem+json",
    )


def _authenticate_tenant_request(
    request: HttpRequest,
    *,
    organisation_id: UUID,
    request_id: str,
    scope: str,
) -> VerifiedAccessToken:
    verified, lane = verify_configured_token(
        views._bearer(request), trusted=settings.KODERA_AUTH_TRUST
    )
    verified, lane = lanes.admit(verified, lane)
    if lane == "staff":
        record_staff_denial(
            verified=verified,
            target_urn=f"urn:kodera:organisation:{organisation_id}",
            request_id=request_id,
            scope=scope,
        )
        raise views._RefusedError()
    return verified


def _parse_json_object(request: HttpRequest) -> dict[str, Any]:
    if len(request.body) > MAX_JSON_BODY:
        raise ValueError("body too large")
    content_type = (request.content_type or "").split(";")[0].strip().lower()
    if content_type != "application/json":
        raise ValueError("content-type must be application/json")
    parsed = json.loads(request.body.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError("JSON body must be an object")
    return parsed


def _run_post(
    request: HttpRequest,
    *,
    organisation_id: UUID,
    operation: Operation,
    require_idempotency_key: bool,
    produce: Callable[[VerifiedAccessToken, str, dict[str, Any]], tuple[int, dict[str, Any]]],
) -> HttpResponse:
    supplied = request.headers.get("X-Request-Id", "")
    request_id = supplied if views.REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
    try:
        if request.method != "POST":
            response = views._problem(405, request_id, allow="POST")
        else:
            verified = _authenticate_tenant_request(
                request,
                organisation_id=organisation_id,
                request_id=request_id,
                scope=operation.scope,
            )
            idem_key = request.headers.get(KEY_HEADER, "").strip()
            if require_idempotency_key and (is_missing(idem_key) or is_malformed(idem_key)):
                response = _json_problem(
                    400,
                    "idempotency-key-missing" if is_missing(idem_key) else "malformed-request",
                    "Idempotency-Key header required",
                    request_id,
                )
            else:
                payload = _parse_json_object(request)
                status_code, answer = produce(verified, idem_key, payload)
                response = HttpResponse(
                    json.dumps(answer),
                    status=status_code,
                    content_type="application/json",
                )
    except TokenVerificationError:
        response = views._problem(401, request_id)
    except BillingCallerUnknownError:
        response = problems.identity_unknown(request_id, operation.operation_id)
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
    except boosts.WithdrawalWaiverRequiredError as exc:
        response = _json_problem(
            422,
            "validation-error",
            "Explicit 14-day withdrawal waiver required",
            request_id,
            str(exc),
        )
    except IdempotencyKeyReuseError:
        response = _json_problem(
            409,
            "idempotency-key-reuse",
            "Idempotency key reused with different request parameters",
            request_id,
        )
    except (
        vip_connect.ConnectOutcomeUnknownError,
        vip_connect.ConnectAccountNotReadyError,
    ) as exc:
        response = _json_problem(
            409,
            "conflict",
            "Connect account not ready",
            request_id,
            str(exc),
        )
    except (
        payment_services.ReturnUrlRefusedError,
        ReturnUrlRequiredError,
    ):
        response = _json_problem(
            400,
            "malformed-request",
            "Return or refresh URL is not on an allowed console origin",
            request_id,
        )
    except (
        boosts.BoostValidationError,
        vip_connect.VipConnectValidationError,
        ProviderRefusedError,
        ValueError,
        TypeError,
    ) as exc:
        response = _json_problem(
            422,
            "validation-error",
            "Validation error",
            request_id,
            str(exc)[:200],
        )
    except ProviderUnavailableError:
        response = _json_problem(
            502,
            "upstream-unavailable",
            "Payment provider unavailable",
            request_id,
        )
    except Exception as failure:
        views.LOG.error(
            "%s failed: %s request_id=%s",
            operation.operation_id,
            type(failure).__name__,
            request_id,
        )
        response = views._problem(500, request_id)

    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response


@declares(op.GET_WORKSPACE_MONETIZATION)
def workspace_monetization(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    return views._answer(
        request,
        op.GET_WORKSPACE_MONETIZATION,
        lambda request_id: _read_overview(request, organisation_id, request_id),
    )


def _read_overview(request: HttpRequest, organisation_id: UUID, request_id: str) -> dict[str, Any]:
    verified = _authenticate_tenant_request(
        request,
        organisation_id=organisation_id,
        request_id=request_id,
        scope=op.GET_WORKSPACE_MONETIZATION.scope,
    )
    try:
        return read_as_member(
            verified=verified,
            organisation=lambda: organisation_id,
            scope=op.GET_WORKSPACE_MONETIZATION.scope,
            read=lambda caller: monetization_services.read_workspace_monetization_overview(
                caller=caller
            ),
        )
    except BillingForbiddenError as refused:
        record_member_denial(
            refused=refused,
            target_urn=f"urn:kodera:organisation:{organisation_id}",
            request_id=request_id,
        )
        raise views._RefusedError() from None


@declares(op.CREATE_WORKSPACE_BOOST_CHECKOUT)
def boost_checkout(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    return _run_post(
        request,
        organisation_id=organisation_id,
        operation=op.CREATE_WORKSPACE_BOOST_CHECKOUT,
        require_idempotency_key=True,
        produce=lambda verified, idem_key, payload: (
            201,
            monetization_services.start_boost_checkout_for_caller(
                verified=verified,
                organisation_id=organisation_id,
                idempotency_key=idem_key,
                payload=payload,
            ),
        ),
    )


@declares(op.START_CREATOR_CONNECT_ONBOARDING)
def connect_onboarding(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    return _run_post(
        request,
        organisation_id=organisation_id,
        operation=op.START_CREATOR_CONNECT_ONBOARDING,
        require_idempotency_key=True,
        produce=lambda verified, idem_key, payload: (
            200,
            monetization_services.start_connect_onboarding_for_caller(
                verified=verified,
                organisation_id=organisation_id,
                idempotency_key=idem_key,
                payload=payload,
            ),
        ),
    )


@declares(op.CREATE_VIP_TIER_OFFER)
def vip_tiers(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    return _run_post(
        request,
        organisation_id=organisation_id,
        operation=op.CREATE_VIP_TIER_OFFER,
        require_idempotency_key=True,
        produce=lambda verified, _idem_key, payload: (
            201,
            monetization_services.create_vip_tier_for_caller(
                verified=verified,
                organisation_id=organisation_id,
                payload=payload,
            ),
        ),
    )


@declares(op.CREATE_VIP_PASS_CHECKOUT)
def vip_pass_checkout(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    return _run_post(
        request,
        organisation_id=organisation_id,
        operation=op.CREATE_VIP_PASS_CHECKOUT,
        require_idempotency_key=True,
        produce=lambda verified, idem_key, payload: (
            201,
            monetization_services.start_vip_pass_checkout_for_caller(
                verified=verified,
                organisation_id=organisation_id,
                idempotency_key=idem_key,
                payload=payload,
            ),
        ),
    )


@declares(op.EXPORT_WORKSPACE_DAC7_REPORT)
def dac7_report_export(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    supplied = request.headers.get("X-Request-Id", "")
    request_id = supplied if views.REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
    try:
        if request.method != "GET":
            response = views._problem(405, request_id, allow="GET")
        else:
            verified = _authenticate_tenant_request(
                request,
                organisation_id=organisation_id,
                request_id=request_id,
                scope=op.EXPORT_WORKSPACE_DAC7_REPORT.scope,
            )
            raw_year = request.GET.get("year")
            year = int(raw_year) if raw_year is not None else timezone.now().year
            export_format = request.GET.get("format", "json").strip().lower()
            if export_format not in {"json", "xml"}:
                raise ValueError("format must be json or xml")
            body_bytes, content_type = read_as_member(
                verified=verified,
                organisation=lambda: organisation_id,
                scope=op.EXPORT_WORKSPACE_DAC7_REPORT.scope,
                roles=monetization_services.DAC7_EXPORT_ROLES,
                read=lambda caller: monetization_services.export_workspace_dac7_for_caller(
                    caller=caller,
                    reporting_year=year,
                    export_format=export_format,
                ),
            )
            response = HttpResponse(body_bytes, status=200, content_type=content_type)
    except TokenVerificationError:
        response = views._problem(401, request_id)
    except BillingCallerUnknownError:
        response = problems.identity_unknown(
            request_id, op.EXPORT_WORKSPACE_DAC7_REPORT.operation_id
        )
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
    except (ValueError, TypeError):
        response = views._problem(400, request_id)
    except Exception as failure:
        views.LOG.error(
            "exportWorkspaceDac7Report failed: %s request_id=%s",
            type(failure).__name__,
            request_id,
        )
        response = views._problem(500, request_id)

    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response
