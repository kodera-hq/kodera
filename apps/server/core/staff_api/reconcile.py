"""PostgreSQL-trigger-compliant C1 reconciliation for `jobs_job` and `outbox_outboxdelivery`."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, NoReturn
from uuid import UUID

from django.db import connection

from core.db.ids import new_uuid7

from .audit import append_staff_audit_entry
from .auth import SRE_WRITE_ROLES, VerifiedStaffRequest, fence_staff_caller
from .errors import StaffApiError, staff_command_transaction
from .models import RECONCILE_EXITS, RECONCILE_OUTCOMES


@dataclass(frozen=True)
class _ParsedEvidence:
    provider: str
    resource_id: str
    request_id: str
    observed_at: datetime


@dataclass(frozen=True)
class _ParsedDecision:
    exit_code: str
    operation_outcome: str
    compute_terminated: _ParsedEvidence
    target_read: _ParsedEvidence


def _parse_iso_datetime(value: object, field_name: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise StaffApiError(
            400,
            "evidence_missing",
            "Invalid reconciliation evidence",
            f"{field_name}.observed_at must be an ISO-8601 timestamp with timezone",
        )
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise StaffApiError(
            400,
            "evidence_missing",
            "Invalid reconciliation evidence",
            f"{field_name}.observed_at is not a valid ISO-8601 timestamp",
        ) from exc
    if dt.tzinfo is None:
        raise StaffApiError(
            400,
            "evidence_missing",
            "Invalid reconciliation evidence",
            f"{field_name}.observed_at must include an explicit UTC or timezone offset",
        )
    return dt.astimezone(UTC)


def _parse_evidence_block(raw: object, field_name: str) -> _ParsedEvidence:
    if not isinstance(raw, dict):
        raise StaffApiError(
            400,
            "evidence_missing",
            "Missing reconciliation evidence",
            f"{field_name} must be a JSON object with provider, resource_id, request_id, observed_at",
        )
    provider = raw.get("provider")
    resource_id = raw.get("resource_id")
    request_id = raw.get("request_id")
    if (
        not isinstance(provider, str)
        or not provider.strip()
        or not isinstance(resource_id, str)
        or not resource_id.strip()
        or not isinstance(request_id, str)
        or not request_id.strip()
    ):
        raise StaffApiError(
            400,
            "evidence_missing",
            "Incomplete reconciliation evidence",
            f"{field_name} requires non-empty provider, resource_id, and request_id",
        )
    observed_at = _parse_iso_datetime(raw.get("observed_at"), field_name)
    return _ParsedEvidence(
        provider=provider,
        resource_id=resource_id,
        request_id=request_id,
        observed_at=observed_at,
    )


def _parse_decision_body(body: dict[str, Any]) -> _ParsedDecision:
    exit_code = body.get("exit")
    operation_outcome = body.get("operation_outcome")
    if exit_code not in RECONCILE_EXITS:
        raise StaffApiError(
            400,
            "invalid_exit",
            "Invalid reconciliation exit",
            "exit must be 'resume' or 'fail'",
        )
    if operation_outcome not in RECONCILE_OUTCOMES:
        raise StaffApiError(
            400,
            "invalid_operation_outcome",
            "Invalid operation outcome",
            "operation_outcome must be 'completed', 'no_effect', or 'partial'",
        )
    compute = _parse_evidence_block(body.get("compute_terminated"), "compute_terminated")
    target = _parse_evidence_block(body.get("target_read"), "target_read")
    return _ParsedDecision(
        exit_code=str(exit_code),
        operation_outcome=str(operation_outcome),
        compute_terminated=compute,
        target_read=target,
    )


def _decision_payload_json(
    parsed: _ParsedDecision, *, include_step_audit: bool
) -> tuple[UUID, str]:
    decision_id = new_uuid7()
    payload: dict[str, str] = {
        "decision_id": str(decision_id),
        "decision_audit_id": str(new_uuid7()),
        "exit": parsed.exit_code,
        "operation_outcome": parsed.operation_outcome,
        "c_provider": parsed.compute_terminated.provider,
        "c_resource_id": parsed.compute_terminated.resource_id,
        "c_request_id": parsed.compute_terminated.request_id,
        "c_observed_at": parsed.compute_terminated.observed_at.isoformat(timespec="microseconds"),
        "t_provider": parsed.target_read.provider,
        "t_resource_id": parsed.target_read.resource_id,
        "t_request_id": parsed.target_read.request_id,
        "t_observed_at": parsed.target_read.observed_at.isoformat(timespec="microseconds"),
    }
    if include_step_audit:
        payload["step_audit_id"] = str(new_uuid7())
    return decision_id, json.dumps(payload, separators=(",", ":"))


def _decode_port_result(row: tuple[Any, ...] | None) -> dict[str, Any]:
    if row is None or row[0] is None:
        raise RuntimeError("Reconciliation database port returned an empty payload")
    raw = row[0]
    if isinstance(raw, str):
        parsed = json.loads(raw)
    elif isinstance(raw, dict):
        parsed = raw
    else:
        raise RuntimeError("Reconciliation database port returned a non-JSON payload")
    if not isinstance(parsed, dict):
        raise RuntimeError("Reconciliation database port payload must be an object")
    return parsed


def _raise_reconcile_port_error(error_code: str, *, entity: str) -> NoReturn:
    if error_code == "job_not_found":
        raise StaffApiError(404, "job_not_found", "Job not found", "Unknown job_id")
    if error_code == "outbox_unavailable":
        raise StaffApiError(
            404,
            "delivery_not_found",
            "Outbox delivery unavailable",
            "Outbox schema is not installed on this database",
        )
    if error_code == "delivery_not_found":
        raise StaffApiError(
            404,
            "delivery_not_found",
            "Outbox delivery not found",
            "Unknown delivery_id",
        )
    if error_code == "not_in_reconciliation":
        label = "Job" if entity == "job" else "Delivery"
        plural = "jobs" if entity == "job" else "deliveries"
        raise StaffApiError(
            409,
            "not_in_reconciliation",
            f"{label} is not in needs_reconciliation",
            f"Only {plural} currently in needs_reconciliation can be reconciled",
        )
    if error_code == "sub_job_not_terminal":
        raise StaffApiError(
            409,
            "sub_job_not_terminal",
            "Live sub-job blocks reconciliation",
            "All child sub-jobs must reach a terminal state before reconciling the parent job",
        )
    if error_code == "role_missing":
        raise StaffApiError(
            403,
            "role_missing",
            "Active staff_operator grant required",
            "Caller holds no active unrevoked staff_operator grant in identity_staffrole",
        )
    if error_code == "evidence_out_of_order_start":
        raise StaffApiError(
            409,
            "evidence_out_of_order",
            "Reconciliation evidence out of order",
            "Recorded start timestamp is after decision timestamp",
        )
    if error_code == "evidence_out_of_order_compute":
        raise StaffApiError(
            409,
            "evidence_out_of_order",
            "Reconciliation evidence out of order",
            "compute_terminated.observed_at precedes dispatch start minus 5-minute clock tolerance",
        )
    if error_code == "evidence_out_of_order_target":
        raise StaffApiError(
            409,
            "evidence_out_of_order",
            "Reconciliation evidence out of order",
            "target_read.observed_at must be greater than or equal to compute_terminated.observed_at",
        )
    if error_code == "evidence_out_of_order_future":
        raise StaffApiError(
            409,
            "evidence_out_of_order",
            "Reconciliation evidence out of order",
            "target_read.observed_at is in the future beyond 5-minute clock tolerance",
        )
    if error_code == "partial_resume":
        raise StaffApiError(
            409,
            "partial_resume",
            "Partial outcome cannot resume",
            "A partial external side-effect may only fail, never resume",
        )
    raise StaffApiError(500, "reconcile_failed", "Reconciliation failed")


def reconcile_staff_job(
    *,
    caller: VerifiedStaffRequest,
    job_id: UUID,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, object]:
    parsed = _parse_decision_body(body)
    decision_id, decision_json = _decision_payload_json(parsed, include_step_audit=True)
    with staff_command_transaction():
        caller = fence_staff_caller(caller, allowed_roles=SRE_WRITE_ROLES, required_plane="ops")
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT staff_reconcile_job(%s, %s, %s::jsonb, %s)",
                [caller.identity_id, job_id, decision_json, request_id],
            )
            port_res = _decode_port_result(cursor.fetchone())
        if port_res.get("ok") is not True:
            _raise_reconcile_port_error(str(port_res.get("error", "")), entity="job")

        new_status = str(port_res["new_status"])
        raw_slug = port_res.get("organisation_slug")
        org_slug = str(raw_slug) if isinstance(raw_slug, str) and raw_slug else None

        append_staff_audit_entry(
            actor_identity_id=caller.identity_id,
            actor_roles=caller.roles,
            action="staff.job.reconciled",
            target_type="job",
            target_id=str(job_id),
            request_id=request_id,
            organisation_slug=org_slug,
            metadata={
                "decision_id": str(decision_id),
                "exit": parsed.exit_code,
                "operation_outcome": parsed.operation_outcome,
                "new_status": new_status,
            },
        )

    return {
        "job_id": str(job_id),
        "decision_id": str(decision_id),
        "exit": parsed.exit_code,
        "operation_outcome": parsed.operation_outcome,
        "status": new_status,
    }


def reconcile_staff_delivery(
    *,
    caller: VerifiedStaffRequest,
    delivery_id: UUID,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, object]:
    parsed = _parse_decision_body(body)
    decision_id, decision_json = _decision_payload_json(parsed, include_step_audit=False)
    with staff_command_transaction():
        caller = fence_staff_caller(caller, allowed_roles=SRE_WRITE_ROLES, required_plane="ops")
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT staff_reconcile_delivery(%s, %s, %s::jsonb, %s)",
                [caller.identity_id, delivery_id, decision_json, request_id],
            )
            port_res = _decode_port_result(cursor.fetchone())
        if port_res.get("ok") is not True:
            _raise_reconcile_port_error(str(port_res.get("error", "")), entity="delivery")

        new_status = str(port_res["new_status"])
        raw_slug = port_res.get("organisation_slug")
        org_slug = str(raw_slug) if isinstance(raw_slug, str) and raw_slug else None

        append_staff_audit_entry(
            actor_identity_id=caller.identity_id,
            actor_roles=caller.roles,
            action="staff.delivery.reconciled",
            target_type="outbox_delivery",
            target_id=str(delivery_id),
            request_id=request_id,
            organisation_slug=org_slug,
            metadata={
                "decision_id": str(decision_id),
                "exit": parsed.exit_code,
                "operation_outcome": parsed.operation_outcome,
                "new_status": new_status,
            },
        )

    return {
        "delivery_id": str(delivery_id),
        "decision_id": str(decision_id),
        "exit": parsed.exit_code,
        "operation_outcome": parsed.operation_outcome,
        "status": new_status,
    }
