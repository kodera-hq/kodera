"""DRF views for all 21 C1 `/staff/v1/{read,triage,ops}/*` operations."""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from django.http import HttpRequest, HttpResponse
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny

from core.api.scopes import Operation, declares

from .auth import authenticate_staff_request
from .errors import StaffApiError, error_to_response, request_correlation_id, staff_json_response
from .models import STAFF_ROLES
from .reconcile import reconcile_staff_delivery, reconcile_staff_job
from .services import (
    complete_sar_record,
    create_feedback_github_draft,
    create_sar_record,
    grant_staff_role_mutation,
    open_waitlist_cohort,
    read_feedback,
    read_finops,
    read_organisations,
    read_overview,
    read_pipeline,
    read_security,
    read_sre,
    record_finops_snapshot_mutation,
    register_issuer_snapshot_mutation,
    revoke_staff_role_mutation,
    triage_feedback_item,
    upsert_deal_card,
    verify_audit_chain_endpoint,
)

STAFF_SCOPE = "staff"
MAX_JSON_BODY_BYTES = 65536

ORGANISATIONS_ROLES = (
    "staff_owner",
    "staff_operator",
    "staff_security",
    "staff_support",
    "staff_backend",
    "staff_frontend",
)
PIPELINE_READ_ROLES = ("staff_owner", "staff_operator", "staff_growth")
PIPELINE_WRITE_ROLES = ("staff_owner", "staff_growth")
TRIAGE_ROLES = ("staff_owner", "staff_operator", "staff_support", "staff_backend", "staff_frontend")
FINOPS_READ_ROLES = ("staff_owner", "staff_operator", "staff_growth")
FINOPS_WRITE_ROLES = ("staff_owner", "staff_operator")
SRE_READ_ROLES = ("staff_owner", "staff_operator", "staff_security", "staff_backend")
SRE_WRITE_ROLES = ("staff_operator",)
SECURITY_READ_ROLES = ("staff_owner", "staff_operator", "staff_security", "staff_support")
SAR_ROLES = ("staff_owner", "staff_operator", "staff_security", "staff_support")
ROLE_ADMIN_ROLES = ("staff_owner", "staff_operator")
ISSUER_SNAPSHOT_ROLES = ("staff_operator",)
AUDIT_VERIFY_ROLES = ("staff_owner", "staff_operator", "staff_security")


def _json_body(request: HttpRequest, *, allow_empty: bool = False) -> dict[str, Any]:
    raw = request.body
    if not raw:
        if allow_empty:
            return {}
        raise StaffApiError(
            400, "invalid_json", "Invalid JSON body", "Request body must be a JSON object"
        )
    if len(raw) > MAX_JSON_BODY_BYTES:
        raise StaffApiError(
            400, "payload_too_large", "Payload too large", "Request body exceeds 64 KiB limit"
        )
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise StaffApiError(
            400, "invalid_json", "Invalid JSON body", "Malformed UTF-8 JSON object"
        ) from exc
    if not isinstance(parsed, dict):
        raise StaffApiError(
            400, "invalid_json", "Invalid JSON body", "Request body must be a JSON object"
        )
    return parsed


# ------------------------------------------------------------------ /read/* ----


@declares(Operation("GET", "getStaffOverview", STAFF_SCOPE))
@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def overview_view(request: HttpRequest) -> HttpResponse:
    try:
        caller = authenticate_staff_request(request, plane="read", allowed_roles=STAFF_ROLES)
        return staff_json_response(request, read_overview(caller))
    except StaffApiError as err:
        return error_to_response(request, err)


@declares(Operation("GET", "getStaffOrganisations", STAFF_SCOPE))
@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def organisations_view(request: HttpRequest) -> HttpResponse:
    try:
        caller = authenticate_staff_request(
            request, plane="read", allowed_roles=ORGANISATIONS_ROLES
        )
        return staff_json_response(request, read_organisations(caller))
    except StaffApiError as err:
        return error_to_response(request, err)


@declares(Operation("GET", "getStaffPipeline", STAFF_SCOPE))
@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def pipeline_view(request: HttpRequest) -> HttpResponse:
    try:
        authenticate_staff_request(request, plane="read", allowed_roles=PIPELINE_READ_ROLES)
        return staff_json_response(request, read_pipeline())
    except StaffApiError as err:
        return error_to_response(request, err)


@declares(Operation("GET", "getStaffFeedback", STAFF_SCOPE))
@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def feedback_view(request: HttpRequest) -> HttpResponse:
    try:
        caller = authenticate_staff_request(request, plane="read", allowed_roles=TRIAGE_ROLES)
        status_q = request.GET.get("status") or None
        kind_q = request.GET.get("kind") or None
        return staff_json_response(
            request,
            read_feedback(caller, status_filter=status_q, kind_filter=kind_q, engineering_only=False),
        )
    except StaffApiError as err:
        return error_to_response(request, err)


@declares(Operation("GET", "getStaffEngineering", STAFF_SCOPE))
@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def engineering_view(request: HttpRequest) -> HttpResponse:
    try:
        caller = authenticate_staff_request(request, plane="read", allowed_roles=TRIAGE_ROLES)
        status_q = request.GET.get("status") or None
        kind_q = request.GET.get("kind") or None
        return staff_json_response(
            request,
            read_feedback(caller, status_filter=status_q, kind_filter=kind_q, engineering_only=True),
        )
    except StaffApiError as err:
        return error_to_response(request, err)


@declares(Operation("GET", "getStaffFinops", STAFF_SCOPE))
@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def finops_view(request: HttpRequest) -> HttpResponse:
    try:
        authenticate_staff_request(request, plane="read", allowed_roles=FINOPS_READ_ROLES)
        period_q = request.GET.get("period_month")
        return staff_json_response(request, read_finops(period_month=period_q))
    except StaffApiError as err:
        return error_to_response(request, err)


@declares(Operation("GET", "getStaffSre", STAFF_SCOPE))
@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def sre_view(request: HttpRequest) -> HttpResponse:
    try:
        authenticate_staff_request(request, plane="read", allowed_roles=SRE_READ_ROLES)
        return staff_json_response(request, read_sre())
    except StaffApiError as err:
        return error_to_response(request, err)


@declares(Operation("GET", "getStaffSecurity", STAFF_SCOPE))
@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def security_view(request: HttpRequest) -> HttpResponse:
    try:
        authenticate_staff_request(request, plane="read", allowed_roles=SECURITY_READ_ROLES)
        return staff_json_response(request, read_security())
    except StaffApiError as err:
        return error_to_response(request, err)


# ---------------------------------------------------------------- /triage/* ----


@declares(Operation("POST", "triageStaffFeedback", STAFF_SCOPE))
@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def triage_feedback_view(request: HttpRequest, feedback_id: UUID) -> HttpResponse:
    try:
        caller = authenticate_staff_request(request, plane="triage", allowed_roles=TRIAGE_ROLES)
        payload = triage_feedback_item(
            caller=caller,
            feedback_id=feedback_id,
            body=_json_body(request),
            request_id=request_correlation_id(request),
        )
        return staff_json_response(request, payload)
    except StaffApiError as err:
        return error_to_response(request, err)


@declares(Operation("POST", "createStaffFeedbackGithubDraft", STAFF_SCOPE))
@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def feedback_github_draft_view(request: HttpRequest, feedback_id: UUID) -> HttpResponse:
    try:
        caller = authenticate_staff_request(request, plane="triage", allowed_roles=TRIAGE_ROLES)
        payload = create_feedback_github_draft(
            caller=caller,
            feedback_id=feedback_id,
            body=_json_body(request),
            request_id=request_correlation_id(request),
        )
        return staff_json_response(request, payload)
    except StaffApiError as err:
        return error_to_response(request, err)


@declares(Operation("POST", "upsertStaffDeal", STAFF_SCOPE))
@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def triage_deals_view(request: HttpRequest) -> HttpResponse:
    try:
        caller = authenticate_staff_request(
            request, plane="triage", allowed_roles=PIPELINE_WRITE_ROLES
        )
        payload = upsert_deal_card(
            caller=caller,
            body=_json_body(request),
            request_id=request_correlation_id(request),
        )
        return staff_json_response(request, payload)
    except StaffApiError as err:
        return error_to_response(request, err)


@declares(Operation("POST", "openStaffWaitlistCohort", STAFF_SCOPE))
@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def waitlist_open_cohort_view(request: HttpRequest) -> HttpResponse:
    try:
        caller = authenticate_staff_request(
            request, plane="triage", allowed_roles=PIPELINE_WRITE_ROLES
        )
        payload = open_waitlist_cohort(
            caller=caller,
            body=_json_body(request),
            request_id=request_correlation_id(request),
        )
        return staff_json_response(request, payload)
    except StaffApiError as err:
        return error_to_response(request, err)


@declares(Operation("POST", "createStaffSar", STAFF_SCOPE))
@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def create_sar_view(request: HttpRequest) -> HttpResponse:
    try:
        caller = authenticate_staff_request(request, plane="triage", allowed_roles=SAR_ROLES)
        payload = create_sar_record(
            caller=caller,
            body=_json_body(request),
            request_id=request_correlation_id(request),
        )
        return staff_json_response(request, payload, status=201)
    except StaffApiError as err:
        return error_to_response(request, err)


@declares(Operation("POST", "completeStaffSar", STAFF_SCOPE))
@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def complete_sar_view(request: HttpRequest, sar_id: UUID) -> HttpResponse:
    try:
        caller = authenticate_staff_request(request, plane="triage", allowed_roles=SAR_ROLES)
        payload = complete_sar_record(
            caller=caller,
            sar_id=sar_id,
            body=_json_body(request),
            request_id=request_correlation_id(request),
        )
        return staff_json_response(request, payload)
    except StaffApiError as err:
        return error_to_response(request, err)


# ------------------------------------------------------------------- /ops/* ----


@declares(Operation("POST", "reconcileStaffJob", STAFF_SCOPE))
@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def reconcile_job_view(request: HttpRequest, job_id: UUID) -> HttpResponse:
    try:
        caller = authenticate_staff_request(request, plane="ops", allowed_roles=SRE_WRITE_ROLES)
        payload = reconcile_staff_job(
            caller=caller,
            job_id=job_id,
            body=_json_body(request),
            request_id=request_correlation_id(request),
        )
        return staff_json_response(request, payload)
    except StaffApiError as err:
        return error_to_response(request, err)


@declares(Operation("POST", "reconcileStaffDelivery", STAFF_SCOPE))
@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def reconcile_delivery_view(request: HttpRequest, delivery_id: UUID) -> HttpResponse:
    try:
        caller = authenticate_staff_request(request, plane="ops", allowed_roles=SRE_WRITE_ROLES)
        payload = reconcile_staff_delivery(
            caller=caller,
            delivery_id=delivery_id,
            body=_json_body(request),
            request_id=request_correlation_id(request),
        )
        return staff_json_response(request, payload)
    except StaffApiError as err:
        return error_to_response(request, err)


@declares(Operation("POST", "grantStaffRole", STAFF_SCOPE))
@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def grant_staff_role_view(request: HttpRequest) -> HttpResponse:
    try:
        caller = authenticate_staff_request(request, plane="ops", allowed_roles=ROLE_ADMIN_ROLES)
        payload = grant_staff_role_mutation(
            caller=caller,
            body=_json_body(request),
            request_id=request_correlation_id(request),
        )
        return staff_json_response(request, payload)
    except StaffApiError as err:
        return error_to_response(request, err)


@declares(Operation("POST", "revokeStaffRole", STAFF_SCOPE))
@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def revoke_staff_role_view(request: HttpRequest) -> HttpResponse:
    try:
        caller = authenticate_staff_request(request, plane="ops", allowed_roles=ROLE_ADMIN_ROLES)
        payload = revoke_staff_role_mutation(
            caller=caller,
            body=_json_body(request),
            request_id=request_correlation_id(request),
        )
        return staff_json_response(request, payload)
    except StaffApiError as err:
        return error_to_response(request, err)


@declares(Operation("POST", "registerStaffIssuerSnapshot", STAFF_SCOPE))
@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def register_issuer_snapshot_view(request: HttpRequest) -> HttpResponse:
    try:
        caller = authenticate_staff_request(
            request, plane="ops", allowed_roles=ISSUER_SNAPSHOT_ROLES
        )
        payload = register_issuer_snapshot_mutation(
            caller=caller,
            body=_json_body(request),
            request_id=request_correlation_id(request),
        )
        return staff_json_response(request, payload, status=201)
    except StaffApiError as err:
        return error_to_response(request, err)


@declares(Operation("POST", "recordStaffFinopsSnapshot", STAFF_SCOPE))
@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def record_finops_snapshot_view(request: HttpRequest) -> HttpResponse:
    try:
        caller = authenticate_staff_request(request, plane="ops", allowed_roles=FINOPS_WRITE_ROLES)
        payload = record_finops_snapshot_mutation(
            caller=caller,
            body=_json_body(request),
            request_id=request_correlation_id(request),
        )
        return staff_json_response(request, payload, status=201)
    except StaffApiError as err:
        return error_to_response(request, err)


@declares(Operation("POST", "verifyStaffAuditChain", STAFF_SCOPE))
@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def verify_audit_chain_view(request: HttpRequest) -> HttpResponse:
    try:
        authenticate_staff_request(request, plane="ops", allowed_roles=AUDIT_VERIFY_ROLES)
        payload = verify_audit_chain_endpoint(_json_body(request, allow_empty=True))
        return staff_json_response(request, payload)
    except StaffApiError as err:
        return error_to_response(request, err)
