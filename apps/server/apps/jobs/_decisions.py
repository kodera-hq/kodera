"""Leaving needs_reconciliation: docs/specs/JOB_QUEUE.md §5.4.

Only an operator's decision moves a job, or an outbox delivery, out of reconciliation. The checks on
the principal and the evidence are shared by both; the order of the refusals is the specification's.
A refusal writes nothing: the function's block is rolled back and the refusal returned.

The principal is an exact-class StaffPrincipal from the verified-token resolver or the ratified
command-only pilot builder (STAFF_IDENTITY.md §5). Any other object is a caller's defect, raised
before anything is read.
Its role is not carried: the decision reads, in its own transaction, the current `staff_operator`
grant of that identity, enabled, of an enabled person, and locks it `FOR SHARE` until it commits, so a
revocation either waits for the decision or is seen by it (docs/specs/STAFF_IDENTITY.md §5). A job's
decision and a delivery's each name the grant they relied on in their audit row.
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from django.db import connection, transaction

from apps.audit.services import record_delivery_decision_event, record_job_event
from apps.identity.selectors import current_staff_grant
from apps.identity.staff import StaffPrincipal, is_staff_principal
from apps.outbox import services as outbox
from core.db.ids import new_uuid7

from . import mutants, sql
from .transactions import queue_atomic
from .types import (
    DECIDING_ROLE,
    DECISION_EXITS,
    OPERATION_OUTCOMES,
    DecisionRecorded,
    DecisionRefused,
    Evidence,
    ReconciliationDecision,
)

TOLERANCE = timedelta(minutes=5)

# The outcome a decision closes the unresolved dispatch with: a dispatch has no "partial".
_CLOSES_WITH = {"completed": "completed", "no_effect": "no_effect", "partial": "failed"}


def validate_principal(principal: object) -> None:
    """An object neither authorized staff constructor built is a caller's defect, raised before
    anything is read: no look-alike object stands in for a stored staff identity."""
    if not is_staff_principal(principal):
        raise TypeError("a decision needs the StaffPrincipal resolve_staff_principal built")


def validate_closed_sets(decision: ReconciliationDecision) -> None:
    """A value outside a closed set is a caller's defect, raised before anything is read."""
    if decision.exit not in DECISION_EXITS:
        raise ValueError(f"{decision.exit!r} is not a decision exit")
    if decision.operation_outcome not in OPERATION_OUTCOMES:
        raise ValueError(f"{decision.operation_outcome!r} is not an operation outcome")


@dataclass(frozen=True)
class EvidenceFlags:
    """The mutants of the shared checks, each set by the caller from its own literal flag."""

    any_role: bool = False
    any_identity: bool = False
    revoked_role: bool = False
    disabled_identity: bool = False
    deleted_identity: bool = False
    disabled_person: bool = False
    deleted_person: bool = False
    either_evidence: bool = False
    provider_only: bool = False
    ignores_compute: bool = False
    ignores_target: bool = False
    start_order_unchecked: bool = False
    target_before_compute: bool = False
    future_allowed: bool = False
    reject_future_start: bool = False
    no_tolerance: bool = False
    partial_resume: bool = False
    evidence_before_role: bool = False
    order_before_presence: bool = False
    partial_before_order: bool = False


def _complete(piece: Evidence | None, provider_only: bool) -> bool:
    if piece is None:
        return False
    fields = (
        (piece.provider,)
        if provider_only
        else (
            piece.provider,
            piece.resource_id,
            piece.request_id,
        )
    )
    return all(field.strip() for field in fields)


def _role_refusal(
    principal: StaffPrincipal, flags: EvidenceFlags, relied: list[UUID] | None = None
) -> str | None:
    """The principal's identity holds a current staff_operator grant, read now and locked FOR SHARE:
    seven clauses — the grant's identity, its role, its revocation, the identity enabled and not
    deleted, its person enabled and not deleted — each with its own flag. The grant read is
    appended to `relied`."""
    grant = current_staff_grant(
        identity_id=principal.identity_id,
        role=DECIDING_ROLE,
        any_identity=flags.any_identity,
        any_role=flags.any_role,
        revoked_counts=flags.revoked_role,
        disabled_identity_counts=flags.disabled_identity,
        deleted_identity_counts=flags.deleted_identity,
        disabled_person_counts=flags.disabled_person,
        deleted_person_counts=flags.deleted_person,
    )
    if grant is None:
        return "role_missing"
    if relied is not None:
        relied.append(grant)
    return None


def _presence_refusal(decision: ReconciliationDecision, flags: EvidenceFlags) -> str | None:
    compute = flags.ignores_compute or _complete(decision.compute_terminated, flags.provider_only)
    target = flags.ignores_target or _complete(decision.target_read, flags.provider_only)
    present = (compute or target) if flags.either_evidence else (compute and target)
    return None if present else "evidence_missing"


def _order_refusal(
    decision: ReconciliationDecision,
    dispatched_at: datetime | None,
    decided_at: datetime,
    flags: EvidenceFlags,
) -> str | None:
    """dispatched_at − 5 min < compute.observed_at <= target.observed_at <= decided_at + 5 min."""
    if flags.reject_future_start and dispatched_at is not None and dispatched_at > decided_at:
        return "evidence_out_of_order"
    tolerance = timedelta(0) if flags.no_tolerance else TOLERANCE
    compute = decision.compute_terminated.observed_at
    target = decision.target_read.observed_at
    if not flags.start_order_unchecked and dispatched_at is not None:
        if not dispatched_at - tolerance < compute:
            return "evidence_out_of_order"
    if not flags.target_before_compute and not compute <= target:
        return "evidence_out_of_order"
    if not flags.future_allowed and not target <= decided_at + tolerance:
        return "evidence_out_of_order"
    return None


def _partial_refusal(decision: ReconciliationDecision, flags: EvidenceFlags) -> str | None:
    if flags.partial_resume:
        return None
    if decision.operation_outcome == "partial" and decision.exit == "resume":
        return "partial_resume"
    return None


def evidence_refusal(
    *,
    principal: StaffPrincipal,
    decision: ReconciliationDecision,
    dispatched_at: datetime | None,
    decided_at: datetime,
    flags: EvidenceFlags,
    relied: list[UUID] | None = None,
) -> str | None:
    """First of role_missing, evidence_missing, evidence_out_of_order, partial_resume, in that
    order; the three order flags each swap one adjacent pair. The grant the role check relied on is
    appended to `relied`."""
    checks: list[Callable[[], str | None]] = [
        lambda: _role_refusal(principal, flags, relied),
        lambda: _presence_refusal(decision, flags),
        lambda: _order_refusal(decision, dispatched_at, decided_at, flags),
        lambda: _partial_refusal(decision, flags),
    ]
    if flags.evidence_before_role:
        checks[0], checks[1] = checks[1], checks[0]
    if flags.order_before_presence:
        checks[1], checks[2] = checks[2], checks[1]
    if flags.partial_before_order:
        checks[2], checks[3] = checks[3], checks[2]
    for check in checks:
        reason = check()
        if reason is not None:
            return reason
    return None


def _job_flags() -> EvidenceFlags:
    on = mutants.on
    return EvidenceFlags(
        any_role=on("any_role"),
        any_identity=on("role_of_any_identity"),
        revoked_role=on("revoked_role_decides"),
        disabled_identity=on("disabled_staff_identity_decides"),
        deleted_identity=on("deleted_staff_identity_decides"),
        disabled_person=on("disabled_staff_person_decides"),
        deleted_person=on("deleted_staff_person_decides"),
        either_evidence=on("decide_either_evidence"),
        provider_only=on("structured_evidence_unchecked"),
        start_order_unchecked=on("evidence_order_unchecked"),
        target_before_compute=on("target_before_compute_allowed"),
        future_allowed=on("future_evidence_allowed"),
        no_tolerance=on("no_clock_tolerance"),
        partial_resume=on("partial_resume"),
        evidence_before_role=on("evidence_checked_before_role"),
        order_before_presence=on("order_checked_before_presence"),
        partial_before_order=on("partial_checked_before_order"),
    )


def _one(statement: str, parameters: Any) -> tuple[Any, ...] | None:
    with connection.cursor() as cursor:
        cursor.execute(statement, parameters)
        row: tuple[Any, ...] | None = cursor.fetchone()
        return row


def _execute(statement: str, parameters: Any) -> None:
    with connection.cursor() as cursor:
        cursor.execute(statement, parameters)


def _clock() -> datetime:
    found = _one(sql.CLOCK_NOW, None)
    if found is None:
        raise RuntimeError("clock_timestamp() returned no row")
    now: datetime = found[0]
    return now


@dataclass(frozen=True)
class _Reconciling:
    id: UUID
    organisation_id: UUID
    parent_job_id: UUID | None
    unresolved_step_id: UUID
    unresolved_operation_ref: str


def _lock_job(job_id: UUID) -> _Reconciling | None:
    if mutants.on("decide_without_row_lock"):
        row_lock = ""
    elif mutants.on("decide_locks_for_update"):
        row_lock = sql.UPDATE
    else:
        row_lock = sql.NO_KEY_UPDATE
    status = "" if mutants.on("decide_any_status") else sql.DECIDE_RECONCILING
    found = _one(sql.DECIDE_JOB.format(status=status, row_lock=row_lock), [job_id])
    return None if found is None else _Reconciling(*found)


def _event(
    action: str, job: _Reconciling, metadata: dict[str, object], principal: StaffPrincipal | None
) -> None:
    record_job_event(
        action=action,
        job_id=job.id,
        organisation_id=job.organisation_id,
        actor_type="system" if principal is None else "staff",
        actor_id=None if principal is None else principal.identity_id,
        request_id=None,
        metadata=metadata,
    )


def _dispatch_outcome_at_decision(closed_outcome: str | None, closes_with: str) -> str | None:
    if mutants.on("decision_omits_closed_outcome"):
        return None
    if closed_outcome is None and mutants.on("outcome_at_decision_always"):
        return closes_with
    return closed_outcome


def _closes_with(outcome: str) -> str:
    if mutants.on("decide_closes_always_no_effect"):
        return "no_effect"
    if mutants.on("decide_closes_always_completed"):
        return "completed"
    if outcome == "partial" and mutants.on("decide_closes_partial_no_effect"):
        return "no_effect"
    return _CLOSES_WITH[outcome]


def _insert_decision(
    job: _Reconciling,
    principal: StaffPrincipal,
    decision: ReconciliationDecision,
    dispatch_outcome: str | None,
    decided_at: datetime,
) -> UUID:
    decision_id = new_uuid7()
    compute, target = decision.compute_terminated, decision.target_read
    _execute(
        sql.INSERT_DECISION,
        {
            "id": decision_id,
            "job": job.id,
            "exit": decision.exit,
            "operation_outcome": decision.operation_outcome,
            "c_provider": compute.provider,
            "c_resource_id": compute.resource_id,
            "c_request_id": compute.request_id,
            "c_observed_at": compute.observed_at,
            "t_provider": target.provider,
            "t_resource_id": target.resource_id,
            "t_request_id": target.request_id,
            "t_observed_at": target.observed_at,
            "step": job.unresolved_step_id,
            "operation_ref": job.unresolved_operation_ref,
            "dispatch_outcome": dispatch_outcome,
            "identity": principal.identity_id,
            "role": DECIDING_ROLE,
            "decided_at": decided_at,
        },
    )
    return decision_id


def _resume(job: _Reconciling, outcome: str, decision_id: UUID) -> None:
    """The decision governs the step: succeeded for completed, pending for no_effect."""
    succeeded = outcome == "completed" or mutants.on("no_effect_marks_succeeded")
    _execute(sql.SET_STEP, ["succeeded" if succeeded else "pending", job.unresolved_step_id])
    audited = outcome == "completed" or mutants.on("no_effect_resume_audited")
    if audited and not mutants.on("resume_completion_unaudited"):
        step = _one(sql.STEP_SEQ, [job.unresolved_step_id])
        seq, output_ref = step if step is not None else (None, None)
        _event(
            "job.step_succeeded",
            job,
            {"seq": seq, "step_id": str(job.unresolved_step_id), "output_ref": output_ref},
            None,
        )
    _execute(sql.RESUME_JOB, [decision_id, job.id])


def _fail(job: _Reconciling, decision_id: UUID) -> None:
    _execute(sql.FAIL_JOB, [decision_id, job.id])
    if not mutants.on("fail_keeps_reservation"):
        _execute(sql.END_RESERVATIONS, [job.id])
    if mutants.on("fail_decision_resets_steps"):
        _execute(sql.RUNNING_STEPS_PENDING, [job.id])
    if job.parent_job_id is None or mutants.on("fail_decision_leaves_parent_dispatch_open"):
        return
    evidence = (
        sql.EVIDENCE_NONE
        if mutants.on("fail_decision_closes_without_evidence_ref")
        else sql.EVIDENCE_OPERATION_REF
    )
    outcome = "completed" if mutants.on("fail_decision_closes_completed") else "failed"
    _execute(
        sql.CLOSE_PARENT_DISPATCH.format(evidence_ref=evidence),
        {"outcome": outcome, "job": job.id},
    )


def _decide(principal: StaffPrincipal, decision: ReconciliationDecision) -> DecisionRecorded | str:
    """The decision, or the reason it is refused."""
    flags = _job_flags()
    decided_at = _clock() if mutants.on("decided_at_before_lock") else None
    if mutants.on("role_checked_before_status") and _role_refusal(principal, flags):
        return "role_missing"
    job = _lock_job(decision.subject_id)
    if job is None:
        return "not_in_reconciliation"
    if decided_at is None:
        decided_at = _clock()
    if mutants.on("role_checked_before_subjobs") and _role_refusal(principal, flags):
        return "role_missing"
    if not mutants.on("decide_with_live_subjob"):
        live = _one(sql.SUB_JOB_LIVE, [job.id])
        if live is not None and live[0]:
            return "sub_job_not_terminal"
    dispatch = _one(
        sql.UNRESOLVED_DISPATCH, [job.id, job.unresolved_step_id, job.unresolved_operation_ref]
    )
    dispatch_id, dispatched_at, closed_outcome = dispatch or (None, None, None)
    relied: list[UUID] = []
    reason = evidence_refusal(
        principal=principal,
        decision=decision,
        dispatched_at=dispatched_at,
        decided_at=decided_at,
        flags=flags,
        relied=relied,
    )
    if reason is not None:
        return reason
    closes_with = _closes_with(decision.operation_outcome)
    decision_id = _insert_decision(
        job,
        principal,
        decision,
        _dispatch_outcome_at_decision(closed_outcome, closes_with),
        decided_at,
    )
    metadata: dict[str, object] = {
        "exit": decision.exit,
        "reconciliation_decision_ref": str(decision_id),
    }
    if relied and not mutants.on("decision_audit_omits_staff_grant"):
        # The staff_operator grant this decision relied on, held FOR SHARE until it commits.
        metadata["staff_role_grant_ref"] = str(relied[-1])
    _event("job.reconciliation_decided", job, metadata, principal)
    if dispatch_id is not None and not mutants.on("decide_leaves_dispatch_open"):
        rewrites = mutants.on("decision_rewrites_closed_dispatch")
        _execute(
            sql.DECISION_CLOSES_DISPATCH.format(open="" if rewrites else sql.DISPATCH_IS_OPEN),
            {
                "outcome": closes_with,
                "evidence_ref": decision.target_read.request_id,
                "dispatch": dispatch_id,
            },
        )
    if decision.exit == "resume":
        governing = decision.operation_outcome
        if closed_outcome is not None and mutants.on("closed_dispatch_governs_step"):
            governing = closed_outcome
        _resume(job, governing, decision_id)
    else:
        _fail(job, decision_id)
    return DecisionRecorded(decision_id=decision_id)


def record_reconciliation_decision(
    *, principal: StaffPrincipal, decision: ReconciliationDecision
) -> DecisionRecorded | DecisionRefused:
    """§5.4: the first refusal that applies, or the decision and the job's exit, in one
    transaction (a savepoint inside the caller's)."""
    validate_principal(principal)
    validate_closed_sets(decision)
    with queue_atomic("record_reconciliation_decision"):
        result = _decide(principal, decision)
        if isinstance(result, str):
            transaction.set_rollback(True)
            return DecisionRefused(subject_id=decision.subject_id, reason=result)
    return result


# A delivery's exit, by the decision: its exit trigger binds each status to the decision it names.
_DELIVERY_STATUS = {"completed": "succeeded", "no_effect": "pending"}


def _delivery_flags() -> EvidenceFlags:
    on = mutants.on
    return EvidenceFlags(
        any_role=on("delivery_decision_ignores_role"),
        any_identity=on("delivery_role_of_any_identity"),
        revoked_role=on("delivery_revoked_role_decides"),
        disabled_identity=on("delivery_disabled_staff_identity_decides"),
        deleted_identity=on("delivery_deleted_staff_identity_decides"),
        disabled_person=on("delivery_disabled_staff_person_decides"),
        deleted_person=on("delivery_deleted_staff_person_decides"),
        ignores_compute=on("delivery_decision_ignores_compute"),
        ignores_target=on("delivery_decision_ignores_target"),
        start_order_unchecked=on("delivery_decision_ignores_start_order"),
        target_before_compute=on("delivery_decision_target_before_compute"),
        future_allowed=on("delivery_decision_future"),
        reject_future_start=not on("delivery_future_start_allowed"),
        no_tolerance=on("delivery_no_clock_tolerance"),
        partial_resume=on("delivery_decision_partial_resume"),
        evidence_before_role=on("delivery_evidence_checked_before_role"),
        order_before_presence=on("delivery_order_checked_before_presence"),
        partial_before_order=on("delivery_partial_checked_before_order"),
    )


def _delivery_status(decision: ReconciliationDecision) -> str:
    if decision.exit == "fail":
        return "pending" if mutants.on("delivery_decide_fail_maps_pending") else "failed"
    if decision.operation_outcome == "no_effect" and mutants.on(
        "delivery_decide_no_effect_maps_succeeded"
    ):
        return "succeeded"
    return _DELIVERY_STATUS[decision.operation_outcome]


def _delivery_row_lock() -> str:
    if mutants.on("delivery_decide_without_row_lock"):
        return ""
    return sql.UPDATE if mutants.on("delivery_decide_locks_for_update") else sql.NO_KEY_UPDATE


def _decide_delivery(
    principal: StaffPrincipal,
    decision: ReconciliationDecision,
    deferred: list[Callable[[], None]],
) -> DecisionRecorded | str:
    """The decision, or the reason it is refused. `deferred` receives what a mutant moves out of
    the decision's transaction; the conforming function defers nothing."""
    locked = outbox.lock_reconciling(
        decision.subject_id,
        any_status=mutants.on("delivery_decide_any_status"),
        row_lock=_delivery_row_lock(),
    )
    if locked is None:
        return "not_in_reconciliation"
    started_at, organisation_id = locked
    relied: list[UUID] = []
    reason = evidence_refusal(
        principal=principal,
        decision=decision,
        dispatched_at=started_at,
        decided_at=_clock(),
        flags=_delivery_flags(),
        relied=relied,
    )
    if reason is not None:
        return reason
    compute, target = decision.compute_terminated, decision.target_read
    decision_id = outbox.insert_decision(
        delivery_id=decision.subject_id,
        identity_id=principal.identity_id,
        exit_=decision.exit,
        operation_outcome=decision.operation_outcome,
        compute_provider=compute.provider,
        compute_resource_id=compute.resource_id,
        compute_request_id=compute.request_id,
        compute_observed_at=compute.observed_at,
        target_provider=target.provider,
        target_resource_id=target.resource_id,
        target_request_id=target.request_id,
        target_observed_at=target.observed_at,
    )
    metadata: dict[str, object] = {
        "exit": decision.exit,
        "reconciliation_decision_ref": str(decision_id),
    }
    if relied and not mutants.on("delivery_decision_audit_omits_staff_grant"):
        # The staff_operator grant this decision relied on, held FOR SHARE until it commits.
        metadata["staff_role_grant_ref"] = str(relied[-1])

    def audit() -> None:
        record_delivery_decision_event(
            delivery_id=decision.subject_id,
            organisation_id=organisation_id,
            actor_id=principal.identity_id,
            metadata=metadata,
        )

    if mutants.on("delivery_decision_audit_second_txn"):
        deferred.append(audit)
    elif not mutants.on("delivery_decision_unaudited"):
        audit()
    outbox.leave_reconciliation(
        decision.subject_id, status=_delivery_status(decision), decision_id=decision_id
    )
    return DecisionRecorded(decision_id=decision_id)


def record_delivery_reconciliation_decision(
    *, principal: StaffPrincipal, decision: ReconciliationDecision
) -> DecisionRecorded | DecisionRefused:
    """§5.4 for an outbox delivery: the same refusals in the same order, the decision, its
    `outbox_delivery.reconciliation_decided` audit row naming the grant it relied on, and the
    delivery's exit, in one transaction (a savepoint inside the caller's)."""
    validate_principal(principal)
    validate_closed_sets(decision)
    deferred: list[Callable[[], None]] = []
    with queue_atomic("record_delivery_reconciliation_decision"):
        result = _decide_delivery(principal, decision, deferred)
        if isinstance(result, str):
            transaction.set_rollback(True)
            return DecisionRefused(subject_id=decision.subject_id, reason=result)
    for write in deferred:
        with queue_atomic("record_delivery_reconciliation_decision"):
            write()
    return result
