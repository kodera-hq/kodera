"""PostgreSQL-trigger-compliant C1 reconciliation for `jobs_job` and `outbox_outboxdelivery`."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from django.db import connection, transaction

from core.db.ids import new_uuid7

from .audit import append_staff_audit_entry
from .auth import VerifiedStaffRequest
from .errors import StaffApiError
from .models import RECONCILE_EXITS, RECONCILE_OUTCOMES, STAFF_REALM

DECIDING_ROLE = "staff_operator"
CLOCK_TOLERANCE = timedelta(minutes=5)
CLOSES_DISPATCH_WITH = {
    "completed": "completed",
    "no_effect": "no_effect",
    "partial": "failed",
}
DELIVERY_EXIT_STATUS = {
    "completed": "succeeded",
    "no_effect": "pending",
}


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


def _db_clock_now(cursor: Any) -> datetime:
    cursor.execute("SELECT clock_timestamp()")
    row = cursor.fetchone()
    if row is None or not isinstance(row[0], datetime):
        raise RuntimeError("clock_timestamp() returned no datetime")
    return row[0]


def _lock_operator_grant_for_share(cursor: Any, identity_id: UUID) -> UUID:
    cursor.execute(
        """
        SELECT r.id
        FROM identity_staffrole r
        JOIN identity_identity i ON i.id = r.identity_id
        JOIN identity_user u ON u.id = i.user_id
        WHERE r.identity_id = %s
          AND r.realm = %s
          AND r.role = %s
          AND r.revoked_at IS NULL
          AND i.deleted_at IS NULL
          AND i.enabled = TRUE
          AND u.deleted_at IS NULL
          AND u.enabled = TRUE
        ORDER BY r.created_at, r.id
        LIMIT 1
        FOR SHARE OF r, i, u
        """,
        [identity_id, STAFF_REALM, DECIDING_ROLE],
    )
    found = cursor.fetchone()
    if found is None:
        raise StaffApiError(
            403,
            "role_missing",
            "Active staff_operator grant required",
            "Caller holds no active unrevoked staff_operator grant in identity_staffrole",
        )
    return found[0] if isinstance(found[0], UUID) else UUID(str(found[0]))


def _check_evidence_order_and_partial(
    parsed: _ParsedDecision,
    *,
    dispatched_at: datetime | None,
    decided_at: datetime,
    reject_future_start: bool,
) -> None:
    if reject_future_start and dispatched_at is not None and dispatched_at > decided_at:
        raise StaffApiError(
            409,
            "evidence_out_of_order",
            "Reconciliation evidence out of order",
            "Recorded start timestamp is after decision timestamp",
        )
    compute_at = parsed.compute_terminated.observed_at
    target_at = parsed.target_read.observed_at
    if dispatched_at is not None and not (dispatched_at - CLOCK_TOLERANCE < compute_at):
        raise StaffApiError(
            409,
            "evidence_out_of_order",
            "Reconciliation evidence out of order",
            "compute_terminated.observed_at precedes dispatch start minus 5-minute clock tolerance",
        )
    if not (compute_at <= target_at):
        raise StaffApiError(
            409,
            "evidence_out_of_order",
            "Reconciliation evidence out of order",
            "target_read.observed_at must be greater than or equal to compute_terminated.observed_at",
        )
    if not (target_at <= decided_at + CLOCK_TOLERANCE):
        raise StaffApiError(
            409,
            "evidence_out_of_order",
            "Reconciliation evidence out of order",
            "target_read.observed_at is in the future beyond 5-minute clock tolerance",
        )
    if parsed.operation_outcome == "partial" and parsed.exit_code == "resume":
        raise StaffApiError(
            409,
            "partial_resume",
            "Partial outcome cannot resume",
            "A partial external side-effect may only fail, never resume",
        )


def _lookup_org_slug(cursor: Any, organisation_id: UUID) -> str | None:
    cursor.execute(
        "SELECT slug FROM orgs_organisation WHERE id = %s AND deleted_at IS NULL",
        [organisation_id],
    )
    row = cursor.fetchone()
    return str(row[0]) if row and row[0] else None


def reconcile_staff_job(
    *,
    caller: VerifiedStaffRequest,
    job_id: UUID,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, object]:
    parsed = _parse_decision_body(body)
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, status, organisation_id, parent_job_id,
                       unresolved_step_id, unresolved_operation_ref
                FROM jobs_job
                WHERE id = %s
                FOR NO KEY UPDATE
                """,
                [job_id],
            )
            job_row = cursor.fetchone()
            if job_row is None:
                raise StaffApiError(404, "job_not_found", "Job not found", "Unknown job_id")
            _, current_status, org_id_raw, parent_job_id, unresolved_step_id, unresolved_op_ref = job_row
            if current_status != "needs_reconciliation" or unresolved_step_id is None or unresolved_op_ref is None:
                raise StaffApiError(
                    409,
                    "not_in_reconciliation",
                    "Job is not in needs_reconciliation",
                    "Only jobs currently in needs_reconciliation can be reconciled",
                )
            organisation_id = org_id_raw if isinstance(org_id_raw, UUID) else UUID(str(org_id_raw))
            decided_at = _db_clock_now(cursor)

            cursor.execute(
                """
                SELECT EXISTS (
                  SELECT 1 FROM jobs_job
                  WHERE parent_job_id = %s AND status NOT IN ('succeeded', 'failed', 'cancelled')
                )
                """,
                [job_id],
            )
            live_sub = cursor.fetchone()
            if live_sub is not None and bool(live_sub[0]):
                raise StaffApiError(
                    409,
                    "sub_job_not_terminal",
                    "Live sub-job blocks reconciliation",
                    "All child sub-jobs must reach a terminal state before reconciling the parent job",
                )

            cursor.execute(
                """
                SELECT id, dispatched_at, terminal_outcome
                FROM jobs_jobdispatch
                WHERE job_id = %s AND step_id = %s AND operation_ref = %s
                ORDER BY dispatched_at DESC, id DESC
                LIMIT 1
                """,
                [job_id, unresolved_step_id, unresolved_op_ref],
            )
            dispatch_row = cursor.fetchone()
            dispatch_id, dispatched_at, closed_outcome = dispatch_row or (None, None, None)

            grant_id = _lock_operator_grant_for_share(cursor, caller.identity_id)
            _check_evidence_order_and_partial(
                parsed,
                dispatched_at=dispatched_at,
                decided_at=decided_at,
                reject_future_start=False,
            )

            closes_with = CLOSES_DISPATCH_WITH[parsed.operation_outcome]
            decision_id = new_uuid7()
            cursor.execute(
                """
                INSERT INTO jobs_jobreconciliationdecision (
                  id, job_id, exit, operation_outcome,
                  compute_terminated_provider, compute_terminated_resource_id,
                  compute_terminated_request_id, compute_terminated_observed_at,
                  target_read_provider, target_read_resource_id,
                  target_read_request_id, target_read_observed_at,
                  unresolved_step_id, unresolved_operation_ref, dispatch_outcome_at_decision,
                  decided_by_identity_id, decided_by_role, decided_at
                )
                VALUES (
                  %(id)s, %(job)s, %(exit)s, %(operation_outcome)s,
                  %(c_provider)s, %(c_resource_id)s, %(c_request_id)s, %(c_observed_at)s,
                  %(t_provider)s, %(t_resource_id)s, %(t_request_id)s, %(t_observed_at)s,
                  %(step)s, %(operation_ref)s, %(dispatch_outcome)s,
                  %(identity)s, %(role)s, %(decided_at)s
                )
                """,
                {
                    "id": decision_id,
                    "job": job_id,
                    "exit": parsed.exit_code,
                    "operation_outcome": parsed.operation_outcome,
                    "c_provider": parsed.compute_terminated.provider,
                    "c_resource_id": parsed.compute_terminated.resource_id,
                    "c_request_id": parsed.compute_terminated.request_id,
                    "c_observed_at": parsed.compute_terminated.observed_at,
                    "t_provider": parsed.target_read.provider,
                    "t_resource_id": parsed.target_read.resource_id,
                    "t_request_id": parsed.target_read.request_id,
                    "t_observed_at": parsed.target_read.observed_at,
                    "step": unresolved_step_id,
                    "operation_ref": unresolved_op_ref,
                    "dispatch_outcome": closed_outcome,
                    "identity": caller.identity_id,
                    "role": DECIDING_ROLE,
                    "decided_at": decided_at,
                },
            )

            audit_meta = json.dumps(
                {
                    "exit": parsed.exit_code,
                    "reconciliation_decision_ref": str(decision_id),
                    "staff_role_grant_ref": str(grant_id),
                }
            )
            cursor.execute(
                """
                INSERT INTO audit_auditevent (
                  id, occurred_at, actor_type, actor_id, actor_label,
                  organisation_id, action, target_urn, request_id, job_id,
                  retention_class, metadata
                )
                VALUES (
                  %s, clock_timestamp(), 'staff', %s, %s,
                  %s, 'job.reconciliation_decided', %s, %s, %s,
                  'standard', %s::jsonb
                )
                """,
                [
                    new_uuid7(),
                    caller.identity_id,
                    f"urn:kodera:identity:{caller.identity_id}",
                    organisation_id,
                    f"urn:kodera:job:{job_id}",
                    request_id,
                    job_id,
                    audit_meta,
                ],
            )

            if dispatch_id is not None:
                cursor.execute(
                    """
                    UPDATE jobs_jobdispatch
                    SET closed_at = clock_timestamp(),
                        terminal_outcome = %s,
                        terminal_evidence_ref = %s
                    WHERE id = %s AND closed_at IS NULL
                    """,
                    [closes_with, parsed.target_read.request_id, dispatch_id],
                )

            if parsed.exit_code == "resume":
                step_next_status = (
                    "succeeded" if parsed.operation_outcome == "completed" else "pending"
                )
                cursor.execute(
                    "UPDATE jobs_jobstep SET status = %s WHERE id = %s",
                    [step_next_status, unresolved_step_id],
                )
                if parsed.operation_outcome == "completed":
                    cursor.execute(
                        "SELECT seq, output_ref FROM jobs_jobstep WHERE id = %s",
                        [unresolved_step_id],
                    )
                    step_info = cursor.fetchone()
                    seq, output_ref = step_info if step_info is not None else (None, None)
                    step_meta = json.dumps(
                        {
                            "seq": seq,
                            "step_id": str(unresolved_step_id),
                            "output_ref": output_ref,
                        }
                    )
                    cursor.execute(
                        """
                        INSERT INTO audit_auditevent (
                          id, occurred_at, actor_type, actor_id, actor_label,
                          organisation_id, action, target_urn, request_id, job_id,
                          retention_class, metadata
                        )
                        VALUES (
                          %s, clock_timestamp(), 'system', NULL, 'system',
                          %s, 'job.step_succeeded', %s, NULL, %s,
                          'standard', %s::jsonb
                        )
                        """,
                        [
                            new_uuid7(),
                            organisation_id,
                            f"urn:kodera:job:{job_id}",
                            job_id,
                            step_meta,
                        ],
                    )
                cursor.execute(
                    """
                    UPDATE jobs_job
                    SET status = 'queued', lease_expires_at = NULL, reconciliation_decision_ref = %s
                    WHERE id = %s
                    """,
                    [decision_id, job_id],
                )
                new_status = "queued"
            else:
                cursor.execute(
                    """
                    UPDATE jobs_job
                    SET status = 'failed', error_code = 'reconciliation_failed',
                        lease_expires_at = NULL, reconciliation_decision_ref = %s
                    WHERE id = %s
                    """,
                    [decision_id, job_id],
                )
                cursor.execute(
                    """
                    UPDATE jobs_joblockreservation
                    SET ended_at = clock_timestamp()
                    WHERE job_id = %s AND ended_at IS NULL
                    """,
                    [job_id],
                )
                if parent_job_id is not None:
                    cursor.execute(
                        """
                        UPDATE jobs_jobdispatch
                        SET closed_at = clock_timestamp(),
                            terminal_outcome = 'failed',
                            terminal_evidence_ref = operation_ref
                        WHERE sub_job_id = %s AND closed_at IS NULL
                        """,
                        [job_id],
                    )
                new_status = "failed"

            org_slug = _lookup_org_slug(cursor, organisation_id)

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
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SELECT to_regclass('public.outbox_outboxdelivery')")
            reg = cursor.fetchone()
            if reg is None or reg[0] is None:
                raise StaffApiError(
                    404,
                    "delivery_not_found",
                    "Outbox delivery unavailable",
                    "Outbox schema is not installed on this database",
                )

            cursor.execute(
                """
                SELECT status, started_at, organisation_id
                FROM outbox_outboxdelivery
                WHERE id = %s
                FOR NO KEY UPDATE
                """,
                [delivery_id],
            )
            delivery_row = cursor.fetchone()
            if delivery_row is None:
                raise StaffApiError(
                    404,
                    "delivery_not_found",
                    "Outbox delivery not found",
                    "Unknown delivery_id",
                )
            current_status, started_at, org_id_raw = delivery_row
            if current_status != "needs_reconciliation":
                raise StaffApiError(
                    409,
                    "not_in_reconciliation",
                    "Delivery is not in needs_reconciliation",
                    "Only deliveries currently in needs_reconciliation can be reconciled",
                )
            organisation_id = org_id_raw if isinstance(org_id_raw, UUID) else UUID(str(org_id_raw))
            decided_at = _db_clock_now(cursor)

            grant_id = _lock_operator_grant_for_share(cursor, caller.identity_id)
            _check_evidence_order_and_partial(
                parsed,
                dispatched_at=started_at,
                decided_at=decided_at,
                reject_future_start=True,
            )

            decision_id = new_uuid7()
            cursor.execute(
                """
                INSERT INTO outbox_deliverydecision (
                  id, delivery_id, exit, operation_outcome,
                  compute_terminated_provider, compute_terminated_resource_id,
                  compute_terminated_request_id, compute_terminated_observed_at,
                  target_read_provider, target_read_resource_id,
                  target_read_request_id, target_read_observed_at,
                  decided_by_identity_id, decided_by_role
                )
                VALUES (
                  %(id)s, %(delivery)s, %(exit)s, %(operation_outcome)s,
                  %(c_provider)s, %(c_resource_id)s, %(c_request_id)s, %(c_observed_at)s,
                  %(t_provider)s, %(t_resource_id)s, %(t_request_id)s, %(t_observed_at)s,
                  %(identity)s, %(role)s
                )
                """,
                {
                    "id": decision_id,
                    "delivery": delivery_id,
                    "exit": parsed.exit_code,
                    "operation_outcome": parsed.operation_outcome,
                    "c_provider": parsed.compute_terminated.provider,
                    "c_resource_id": parsed.compute_terminated.resource_id,
                    "c_request_id": parsed.compute_terminated.request_id,
                    "c_observed_at": parsed.compute_terminated.observed_at,
                    "t_provider": parsed.target_read.provider,
                    "t_resource_id": parsed.target_read.resource_id,
                    "t_request_id": parsed.target_read.request_id,
                    "t_observed_at": parsed.target_read.observed_at,
                    "identity": caller.identity_id,
                    "role": DECIDING_ROLE,
                },
            )

            audit_meta = json.dumps(
                {
                    "exit": parsed.exit_code,
                    "reconciliation_decision_ref": str(decision_id),
                    "staff_role_grant_ref": str(grant_id),
                }
            )
            cursor.execute(
                """
                INSERT INTO audit_auditevent (
                  id, occurred_at, actor_type, actor_id, actor_label,
                  organisation_id, action, target_urn, request_id,
                  retention_class, metadata
                )
                VALUES (
                  %s, clock_timestamp(), 'staff', %s, %s,
                  %s, 'outbox_delivery.reconciliation_decided', %s, %s,
                  'standard', %s::jsonb
                )
                """,
                [
                    new_uuid7(),
                    caller.identity_id,
                    f"urn:kodera:identity:{caller.identity_id}",
                    organisation_id,
                    f"urn:kodera:outbox_delivery:{delivery_id}",
                    request_id,
                    audit_meta,
                ],
            )

            new_status = (
                "failed"
                if parsed.exit_code == "fail"
                else DELIVERY_EXIT_STATUS[parsed.operation_outcome]
            )
            cursor.execute(
                """
                UPDATE outbox_outboxdelivery
                SET status = %s, reconciliation_decision_ref = %s
                WHERE id = %s
                """,
                [new_status, decision_id, delivery_id],
            )

            org_slug = _lookup_org_slug(cursor, organisation_id)

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
