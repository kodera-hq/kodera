"""Runner writes: docs/specs/JOB_QUEUE.md §4.4 and §5.1.

Every runner write is one transaction whose first queue statement locks the job's row under the claim's
fence and lease, and which writes nothing and returns a refusal when that finds no row. A lease is
compared with clock_timestamp() and checked again once the row is held: PostgreSQL does not
re-evaluate the first statement's predicate when the row it waited on was released unchanged.
"""

from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from django.db import connection

from apps.audit.services import record_job_event
from core import faults
from core.db.ids import new_uuid7

from . import locks, mutants, sql
from ._claim import require_no_transaction
from ._enqueue import EPOCH, audit_created, insert_job, insert_steps
from .keys import derive_key, sub_job_key
from .kinds import KINDS, SUB_JOB_RELATIONS, SubJobRelation, lock_set, sub_job_relation
from .models import DISPATCH_OUTCOMES, ERROR_CODES
from .transactions import queue_atomic
from .types import Claim, JobRequest

_Parameters = Sequence[Any] | Mapping[str, Any]


@dataclass(frozen=True)
class JobRow:
    id: UUID
    organisation_id: UUID
    tenant_id: UUID | None
    kind: str
    parent_job_id: UUID | None
    fence: int
    status: str


def _one(statement: str, parameters: _Parameters) -> tuple[Any, ...] | None:
    with connection.cursor() as cursor:
        cursor.execute(statement, parameters)
        row: tuple[Any, ...] | None = cursor.fetchone()
        return row


def _execute(statement: str, parameters: _Parameters) -> None:
    with connection.cursor() as cursor:
        cursor.execute(statement, parameters)


def _row_lock(writer: str) -> str:  # noqa: PLR0911 - one arm per writer
    """FOR NO KEY UPDATE for every runner write, each writer's mode read through its own flag."""
    on = mutants.on
    match writer:
        case "renew":
            for_update = on("renew_locks_for_update")
        case "step":
            for_update = on("step_locks_for_update")
        case "dispatch":
            if on("dispatch_without_row_lock"):
                return ""
            for_update = on("dispatch_locks_for_update")
        case "retarget":
            for_update = on("retarget_locks_for_update")
        case "subjob_start":
            for_update = on("subjob_start_locks_for_update")
        case "close":
            for_update = on("close_locks_for_update")
        case "hold":
            for_update = on("hold_locks_for_update")
        case "finish":
            for_update = on("finish_locks_for_update")
        case "completed_ack":
            return sql.NO_KEY_UPDATE
        case _:
            raise ValueError(f"{writer!r} is not a runner write")
    return sql.UPDATE if for_update else sql.NO_KEY_UPDATE


def _parent_holds(job: JobRow) -> bool:
    """The parent is running, with the dispatch naming this sub-job open at its current fence."""
    parent = _one(sql.PARENT_HELD, [job.parent_job_id])
    if parent is None or (parent[0] != "running" and not mutants.on("parent_write_ignores_status")):
        return False
    found = _one(
        sql.PARENT_DISPATCH_OPEN.format(
            owner=""
            if mutants.on("parent_write_ignores_dispatch_owner")
            else sql.PARENT_DISPATCH_OWNER,
            child=""
            if mutants.on("parent_write_ignores_dispatch_child")
            else sql.PARENT_DISPATCH_CHILD,
            open=""
            if mutants.on("parent_write_ignores_dispatch_open")
            else sql.PARENT_DISPATCH_IS_OPEN,
            fence=""
            if mutants.on("parent_write_ignores_dispatch_fence")
            else sql.PARENT_DISPATCH_FENCE,
        ),
        {"parent": job.parent_job_id, "job": job.id, "parent_fence": parent[1]},
    )
    return found is not None


@dataclass(frozen=True)
class _LockCondition:
    """Which clauses of a writer's lock condition hold: each read through its own literal flag."""

    fence: bool
    lease: bool
    recheck: bool
    parent_recheck: bool = False


def _lock_condition(writer: str) -> _LockCondition:  # noqa: PLR0911 - one arm per writer
    on = mutants.on
    match writer:
        case "renew":
            return _LockCondition(
                fence=not on("renew_ignores_fence"),
                lease=not on("renew_ignores_lease"),
                recheck=not on("renew_no_recheck_after_lock"),
            )
        case "step":
            return _LockCondition(
                fence=not on("step_ignores_fence"),
                lease=not on("step_ignores_lease"),
                recheck=not on("step_no_recheck_after_lock"),
                parent_recheck=not on("step_no_recheck_after_parent"),
            )
        case "dispatch":
            return _LockCondition(
                fence=not on("dispatch_ignores_fence"),
                lease=not on("dispatch_ignores_lease"),
                recheck=not on("dispatch_no_recheck_after_lock"),
                parent_recheck=not on("dispatch_no_recheck_after_parent"),
            )
        case "retarget":
            return _LockCondition(
                fence=not on("retarget_ignores_fence"),
                lease=not on("retarget_ignores_lease"),
                recheck=not on("retarget_no_recheck_after_lock"),
                parent_recheck=not on("retarget_no_recheck_after_parent"),
            )
        case "subjob_start":
            return _LockCondition(
                fence=not on("subjob_start_ignores_fence"),
                lease=not on("subjob_start_ignores_lease"),
                recheck=not on("subjob_start_no_recheck_after_lock"),
                parent_recheck=not on("subjob_start_no_recheck_after_parent"),
            )
        case "close":
            return _LockCondition(
                fence=not on("close_ignores_fence"),
                lease=not on("close_ignores_lease"),
                recheck=not on("close_no_recheck_after_lock"),
            )
        case "hold":
            return _LockCondition(
                fence=not on("hold_ignores_fence"),
                lease=not on("hold_ignores_lease"),
                recheck=not on("hold_no_recheck_after_lock"),
            )
        case "finish":
            return _LockCondition(
                fence=not on("finish_ignores_fence"),
                lease=not on("finish_ignores_lease"),
                recheck=not on("finish_no_recheck_after_lock"),
            )
        case "completed_ack":
            return _LockCondition(fence=True, lease=True, recheck=True)
    raise ValueError(f"{writer!r} is not a runner write")


def _needs_parent(writer: str, to_running: bool) -> bool:  # noqa: PLR0911 - one arm per writer
    """Whether a sub-job's write checks its parent (§4.4): the four writes that start an effect do,
    the five reports do not. Each writer's side of the rule is read through its own flag."""
    on = mutants.on
    match writer:
        case "renew":
            return on("renew_needs_parent")
        case "step":
            if to_running:
                return not on("subjob_writes_ignore_parent")
            return on("subjob_reports_need_parent")
        case "dispatch":
            return not on("dispatch_ignores_parent")
        case "retarget":
            return not on("retarget_ignores_parent")
        case "subjob_start":
            return not on("subjob_start_ignores_parent")
        case "close":
            return on("close_needs_parent")
        case "hold":
            return on("hold_needs_parent")
        case "finish":
            return on("finish_needs_parent")
        case "completed_ack":
            return False
    raise ValueError(f"{writer!r} is not a runner write")


def _owned(claim: Claim, *, writer: str, to_running: bool = False) -> JobRow | None:
    """The first queue statement of every runner write, then the re-check, then a sub-job's parent check.
    `to_running` is record_step's alone: the one writer that starts an effect or reports one."""
    condition = _lock_condition(writer)
    clock = (
        sql.TRANSACTION_START
        if writer != "completed_ack" and mutants.on("lease_uses_now")
        else sql.CLOCK
    )
    statement = sql.OWNED.format(
        fence=sql.OWNED_FENCE if condition.fence else "",
        lease=sql.OWNED_LEASE.format(clock=clock) if condition.lease else "",
        row_lock=_row_lock(writer),
    )
    found = _one(statement, {"job": claim.job_id, "fence": claim.fence})
    if found is None:
        return None
    job = JobRow(*found)
    if condition.lease and condition.recheck:
        held = _one(sql.LEASE_HELD.format(clock=clock), [job.id])
        if held is None or not held[0]:
            return None
    if job.parent_job_id is not None and _needs_parent(writer, to_running):
        if not _parent_holds(job):
            return None
        # The parent row may have held us past the lease, after the child-row re-check.
        # Keep the child's row locked and use the database clock again before any effect.
        if condition.lease and condition.parent_recheck:
            held = _one(sql.LEASE_HELD.format(clock=clock), [job.id])
            if held is None or not held[0]:
                return None
    return job


def _event(action: str, job: JobRow, metadata: dict[str, object]) -> None:
    record_job_event(
        action=action,
        job_id=job.id,
        organisation_id=job.organisation_id,
        actor_type="system",
        actor_id=None,
        request_id=None,
        metadata=metadata,
    )


def _exists(statement: str, job_id: UUID) -> bool:
    found = _one(statement, [job_id])
    return bool(found and found[0])


def renew_lease(*, claim: Claim) -> bool:
    """Move the lease to clock_timestamp() + 120 s under the same fence."""
    require_no_transaction("renew_lease", allowed=mutants.on("renew_inside_transaction_allowed"))
    if mutants.on("renew_always_false"):
        return False
    with queue_atomic("renew_lease"):
        if _owned(claim, writer="renew") is None:
            return False
        if not mutants.on("renew_does_not_extend"):
            _execute(sql.RENEW, [claim.job_id])
    return True


def _lower_steps_done(job: JobRow, seq: int) -> bool:
    found = _one(sql.LOWER_STEPS_DONE, [job.id, seq])
    return bool(found and found[0])


def _run_step(job: JobRow, step_id: UUID, step_status: str, seq: int) -> bool:
    if step_status == "succeeded" and not mutants.on("rerun_succeeded_step"):
        return False
    if step_status == "skipped" and not mutants.on("run_skipped_step"):
        return False
    if step_status == "compensated":
        return False
    if not mutants.on("step_order_unchecked") and not _lower_steps_done(job, seq):
        return False
    _execute(sql.SET_STEP, ["running", step_id])
    _execute(sql.JOB_RUNNING, [job.id])
    return True


def _skip_step(job: JobRow, step_id: UUID, step_status: str, conditional: bool, seq: int) -> bool:
    if step_status != "pending" and not mutants.on("skip_any_status"):
        return False
    if not conditional and not mutants.on("skip_any_step"):
        return False
    if not mutants.on("skip_out_of_order") and not _lower_steps_done(job, seq):
        return False
    _execute(sql.SET_STEP, ["skipped", step_id])
    return True


def _end_step(
    job: JobRow,
    step_id: UUID,
    seq: int,
    status: str,
    error_code: str | None,
    output_ref: str | None,
) -> None:
    kept = sql.END_STEP_KEEP_OUTPUT_REF if mutants.on("output_ref_dropped") else None
    statement = sql.END_STEP.format(output_ref=kept or sql.END_STEP_OUTPUT_REF)
    found = _one(
        statement,
        {"status": status, "error_code": error_code, "output_ref": output_ref, "step": step_id},
    )
    recorded = None if found is None else found[0]
    if status == "succeeded":
        if mutants.on("step_succeeded_unaudited"):
            return
        action = "job.step_succeeded"
    elif status == "failed":
        if mutants.on("step_failed_unaudited"):
            return
        action = "job.step_failed"
        if mutants.on("step_failed_audit_drops_output_ref"):
            recorded = None
    else:
        return
    _event(action, job, {"seq": seq, "step_id": str(step_id), "output_ref": recorded})


def _check_step_arguments(status: str, error_code: str | None, output_ref: str | None) -> None:
    """Raise ValueError for an argument record_step never accepts: a programming error, not a
    refusal (§4.4)."""
    if status == "compensated":
        if mutants.on("step_accepts_compensated"):
            return
        raise ValueError("record_step does not write compensated, which has no writer in A3")
    if status not in ("running", "succeeded", "failed", "skipped"):
        if mutants.on("step_accepts_unknown_status"):
            return
        raise ValueError(f"{status!r} is not a status record_step writes")
    if output_ref is not None and status == "running":
        if mutants.on("output_ref_accepted_with_running"):
            return
        raise ValueError("an output_ref goes with succeeded or failed, never with running")
    if output_ref is not None and status == "skipped":
        if mutants.on("output_ref_accepted_with_skipped"):
            return
        raise ValueError("an output_ref goes with succeeded or failed, never with skipped")
    if error_code is not None and status != "failed":
        if mutants.on("step_error_code_without_failed"):
            return
        raise ValueError(f"an error_code goes with failed, never with {status}")


def record_step(
    *,
    claim: Claim,
    seq: int,
    status: str,
    error_code: str | None = None,
    output_ref: str | None = None,
) -> bool:
    """Move one step of the claimed job, as §3.3 and §4.4 allow."""
    require_no_transaction("record_step", allowed=mutants.on("step_inside_transaction_allowed"))
    _check_step_arguments(status, error_code, output_ref)
    with queue_atomic("record_step"):
        job = _owned(claim, writer="step", to_running=status == "running")
        if job is None:
            return False
        step = _one(sql.STEP, [job.id, seq])
        if step is None:
            return False
        step_id, step_status, conditional = step
        if status == "running":
            return _run_step(job, step_id, step_status, seq)
        if status == "skipped":
            return _skip_step(job, step_id, step_status, conditional, seq)
        if step_status != "running" and not mutants.on("step_ends_from_any_status"):
            return False
        _end_step(job, step_id, seq, status, error_code, output_ref)
    return True


class _CompletionRefused(Exception):  # noqa: N818 - private rollback signal
    pass


def _acknowledge_completed_dispatch(
    *, claim: Claim, seq: int, dispatch_id: UUID, operation_ref: str, evidence_ref: str
) -> bool:
    """Atomically report an authenticated live completion or an unchanged retained completion.

    A refusal is never replay permission. Dispatch authorship belongs to its original fence;
    retained reporting belongs to the current live claim, including a child of a stopped parent.
    """
    from .runner_selectors import completion_read

    require_no_transaction("completed_ack", allowed=False)
    if not evidence_ref.strip(sql.EVIDENCE_WHITESPACE):
        return False
    try:
        with queue_atomic("completed_ack"):
            job = _owned(claim, writer="completed_ack")
            if job is None:
                return False
            found = completion_read(job.id, seq)
            row = found.row
            if (
                row is None
                or row.dispatch_id != dispatch_id
                or row.operation_ref != operation_ref
                or found.kind in ("absent", "ineligible")
            ):
                return False
            if found.kind == "completed":
                if row.evidence_ref != evidence_ref:
                    return False
                if row.status == "succeeded":
                    return row.output_ref == evidence_ref and row.error_code is None
                if row.status not in ("pending", "running"):
                    return False
            else:
                if row.closed_at is not None or row.status != "running" or row.fence != claim.fence:
                    return False
                closed = _one(
                    sql.ACK_CLOSE_COMPLETED,
                    {
                        "job": job.id,
                        "step": row.step_id,
                        "dispatch": dispatch_id,
                        "fence": claim.fence,
                        "operation": operation_ref,
                        "evidence": evidence_ref,
                    },
                )
                if closed is None:
                    raise _CompletionRefused
                faults.reach("worker:inside-completed-ack-before-step")
            _end_step(job, row.step_id, seq, "succeeded", None, evidence_ref)
        faults.reach("worker:after-completed-ack")
        return True
    except _CompletionRefused:
        return False


@dataclass(frozen=True)
class _DispatchRules:
    """Which rules of a dispatch hold for one of the two writers that record one: each read through
    that writer's own literal flag."""

    one_open: bool
    class_c_once: bool
    new_cycles: bool
    from_latest_resume: bool
    across_claims: bool


def _dispatch_rules(writer: str) -> _DispatchRules:
    on = mutants.on
    match writer:
        case "dispatch":
            return _DispatchRules(
                one_open=not on("second_open_dispatch"),
                class_c_once=not on("class_c_unlimited"),
                new_cycles=not on("class_c_never_again"),
                from_latest_resume=not on("cycle_from_first_resume"),
                across_claims=not on("class_c_cycle_restarts_at_claim"),
            )
        case "subjob_start":
            return _DispatchRules(
                one_open=not on("subjob_start_second_open_dispatch"),
                class_c_once=not on("subjob_start_class_c_unlimited"),
                new_cycles=not on("subjob_start_class_c_never_again"),
                from_latest_resume=not on("subjob_start_cycle_from_first_resume"),
                across_claims=not on("subjob_start_class_c_cycle_restarts_at_claim"),
            )
    raise ValueError(f"{writer!r} records no dispatch")


def _may_dispatch(job: JobRow, seq: int, *, writer: str) -> UUID | None:
    """The step a dispatch may start: running, no other open dispatch on the job, and for a class C
    step no dispatch in its current resolution cycle. record_dispatch and start_sub_job both
    record a dispatch, and each holds every one of these rules."""
    rules = _dispatch_rules(writer)
    step = _one(sql.DISPATCH_STEP, [job.id, seq])
    if step is None:
        return None
    step_id, step_status, retry_class = step
    if step_status != "running":
        return None
    if rules.one_open and _exists(sql.DISPATCH_OPEN, job.id):
        return None
    if retry_class == "C" and rules.class_c_once:
        cycle = ""
        if rules.new_cycles:
            bound = sql.CYCLE_FROM_LATEST if rules.from_latest_resume else sql.CYCLE_FROM_FIRST
            cycle = sql.CYCLE.format(bound=bound)
            if not rules.across_claims:
                cycle += sql.CYCLE_CURRENT_CLAIM
        if _exists(sql.CLASS_C_DISPATCHED.format(cycle=cycle), step_id):
            return None
    dispatchable: UUID = step_id
    return dispatchable


def _insert_dispatch(
    job: JobRow, step_id: UUID, operation_ref: str, dispatch_id: UUID, sub_job_id: UUID | None
) -> None:
    _execute(
        sql.INSERT_DISPATCH,
        {
            "id": dispatch_id,
            "job": job.id,
            "step": step_id,
            "fence": job.fence,
            "operation_ref": operation_ref,
            "sub_job": sub_job_id,
        },
    )


def record_dispatch(*, claim: Claim, seq: int, operation_ref: str) -> UUID | None:
    """Record an open dispatch of a running step before its operation starts."""
    require_no_transaction(
        "record_dispatch", allowed=mutants.on("dispatch_inside_transaction_allowed")
    )
    with queue_atomic("record_dispatch"):
        job = _owned(claim, writer="dispatch")
        if job is None:
            return None
        step_id = _may_dispatch(job, seq, writer="dispatch")
        if step_id is None:
            return None
        dispatch_id = new_uuid7()
        _insert_dispatch(job, step_id, operation_ref, dispatch_id, None)
    return dispatch_id


def retarget_dispatch(*, claim: Claim, dispatch_id: UUID, operation_ref: str) -> bool:
    """Replace an open dispatch's operation_ref; never one naming a sub-job."""
    require_no_transaction(
        "retarget_dispatch", allowed=mutants.on("retarget_inside_transaction_allowed")
    )
    with queue_atomic("retarget_dispatch"):
        if _owned(claim, writer="retarget") is None:
            return False
        if mutants.on("retarget_noop"):
            return True
        statement = sql.RETARGET.format(
            open="" if mutants.on("retarget_closed") else sql.DISPATCH_IS_OPEN,
            not_sub_job="" if mutants.on("retarget_subjob_dispatch") else sql.DISPATCH_NOT_SUB_JOB,
        )
        found = _one(
            statement,
            {"operation_ref": operation_ref, "dispatch": dispatch_id, "job": claim.job_id},
        )
    return found is not None


def _sub_job_key(job: JobRow, seq: int, kind: str, dispatch_id: UUID) -> str:
    if mutants.on("subjob_key_by_step"):
        return derive_key(["sub", job.id, seq, kind])
    return sub_job_key(job.id, dispatch_id)


def _start_sub_job(
    *,
    claim: Claim,
    seq: int,
    kind: str,
    desired_spec_hash: str,
    allowed_relations: Collection[SubJobRelation],
) -> UUID | None:
    """A dispatch and the sub-job it starts, in one transaction: §3.4's key from that dispatch, the
    parent's organisation and tenant, and no place in request order."""
    require_no_transaction(
        "start_sub_job", allowed=mutants.on("subjob_start_inside_transaction_allowed")
    )
    if kind not in KINDS:
        raise ValueError(f"{kind!r} is not a job kind")
    with queue_atomic("start_sub_job"):
        job = _owned(claim, writer="subjob_start")
        if job is None:
            return None
        relation = sub_job_relation(job.kind, seq, kind)
        if relation is None or (
            relation not in allowed_relations and not mutants.on("subjob_relation_unguarded")
        ):
            return None
        step_id = _may_dispatch(job, seq, writer="subjob_start")
        if step_id is None:
            return None
        dispatch_id = new_uuid7()
        request = JobRequest(
            organisation_id=job.organisation_id,
            tenant_id=job.tenant_id,
            kind=kind,
            idempotency_key=_sub_job_key(job, seq, kind, dispatch_id),
            desired_spec_hash=desired_spec_hash,
            actor_type="system",
            actor_id=None,
        )
        sub_job_id = insert_job(
            request=request,
            max_attempts=KINDS[kind].max_attempts,
            not_before=EPOCH if mutants.on("subjob_not_before_not_now") else None,
            parent_job_id=job.id,
        )
        if sub_job_id is None:
            return None
        insert_steps(sub_job_id, kind)
        audit_created(request, sub_job_id)
        if mutants.on("subjob_gets_request_time"):
            _execute(sql.SUB_JOB_PLACE, [sub_job_id])
        _insert_dispatch(job, step_id, f"urn:kodera:job:{sub_job_id}", dispatch_id, sub_job_id)
    return sub_job_id


def start_sub_job(*, claim: Claim, seq: int, kind: str, desired_spec_hash: str) -> UUID | None:
    """Start only a sub-job relation authorized by the closed production kind registry."""
    return _start_sub_job(
        claim=claim,
        seq=seq,
        kind=kind,
        desired_spec_hash=desired_spec_hash,
        allowed_relations=SUB_JOB_RELATIONS,
    )


def close_dispatch(*, claim: Claim, dispatch_id: UUID, outcome: str, evidence_ref: str) -> bool:
    """Close one open dispatch of the job with its terminal outcome and proof; never one naming a
    sub-job."""
    require_no_transaction("close_dispatch", allowed=mutants.on("close_inside_transaction_allowed"))
    if outcome not in DISPATCH_OUTCOMES and not mutants.on("close_accepts_any_outcome"):
        raise ValueError(f"{outcome!r} is not a dispatch outcome")
    if not mutants.on("close_accepts_blank_evidence") and not (evidence_ref or "").strip():
        raise ValueError("a dispatch is closed with a reference to its terminal proof")
    with queue_atomic("close_dispatch"):
        job = _owned(claim, writer="close")
        if job is None:
            return False
        if job.kind == "realm_create" and outcome == "completed":
            # The provider reported the realm created; nothing local acknowledges it yet.
            faults.reach("realm_create:after-provider-success-before-acknowledgement")
        statement = sql.CLOSE_DISPATCH.format(
            not_sub_job=""
            if mutants.on("parent_closes_subjob_dispatch")
            else sql.DISPATCH_NOT_SUB_JOB
        )
        found = _one(
            statement,
            {
                "outcome": outcome,
                "evidence_ref": evidence_ref,
                "dispatch": dispatch_id,
                "job": claim.job_id,
            },
        )
    return found is not None


def hold_for_reconciliation(*, claim: Claim, dispatch_id: UUID) -> bool:
    """Move the job to needs_reconciliation on its open dispatch, keeping the reservation."""
    require_no_transaction(
        "hold_for_reconciliation", allowed=mutants.on("hold_inside_transaction_allowed")
    )
    with queue_atomic("hold_for_reconciliation"):
        job = _owned(claim, writer="hold")
        if job is None:
            return False
        found = _one(sql.OPEN_DISPATCH, [dispatch_id, job.id])
        if found is None:
            return False
        step_id, operation_ref = found
        _execute(sql.HOLD, {"step": step_id, "operation_ref": operation_ref, "job": job.id})
        if mutants.on("hold_ends_reservation"):
            _execute(sql.END_RESERVATIONS, [job.id])
        if not mutants.on("hold_unaudited"):
            _event(
                "job.reconciliation_required",
                job,
                {"unresolved_step": str(step_id), "unresolved_operation_ref": operation_ref},
            )
    return True


def _finish_allowed(job: JobRow, status: str) -> bool:
    succeeded = status == "succeeded"
    if succeeded and not mutants.on("finish_ignores_steps"):
        if _exists(sql.STEPS_UNFINISHED, job.id):
            return False
    if succeeded:
        ignore_dispatch = mutants.on("finish_ignores_open_dispatch")
        ignore_sub_job = mutants.on("finish_ignores_live_subjob")
    else:
        ignore_dispatch = mutants.on("finish_failed_with_open_dispatch")
        ignore_sub_job = mutants.on("finish_failed_ignores_live_subjob")
    if not ignore_dispatch and _exists(sql.DISPATCH_OPEN, job.id):
        return False
    return ignore_sub_job or not _exists(sql.SUB_JOB_LIVE, job.id)


def _close_parent_dispatch(job: JobRow, status: str) -> None:
    """§3.3: completed for a sub-job that succeeded, failed otherwise; the reference to the sub-job
    is the evidence."""
    if mutants.on("finish_leaves_parent_dispatch_open"):
        return
    outcome = "completed" if status == "succeeded" else "failed"
    if mutants.on("subjob_close_always_completed"):
        outcome = "completed"
    elif mutants.on("subjob_close_always_failed"):
        outcome = "failed"
    evidence = (
        sql.EVIDENCE_NONE
        if mutants.on("finish_closes_without_evidence_ref")
        else sql.EVIDENCE_OPERATION_REF
    )
    _execute(
        sql.CLOSE_PARENT_DISPATCH.format(evidence_ref=evidence),
        {"outcome": outcome, "job": job.id},
    )


def finish_job(*, claim: Claim, status: str, error_code: str | None = None) -> bool:
    """End the claimed job succeeded or failed, then release its live locks once committed."""
    require_no_transaction("finish_job", allowed=mutants.on("finish_inside_transaction_allowed"))
    if status == "succeeded":
        if error_code is not None and not mutants.on("finish_succeeded_with_error_code"):
            raise ValueError("finish_job(succeeded) takes no error_code")
    elif status != "failed":
        if not mutants.on("finish_accepts_any_status"):
            raise ValueError(f"{status!r} is not a status finish_job writes")
    elif error_code not in ERROR_CODES and not mutants.on("finish_error_code_outside_set"):
        raise ValueError(
            f"finish_job(failed) needs an error code of models.ERROR_CODES, not {error_code!r}"
        )
    with queue_atomic("finish_job"):
        job = _owned(claim, writer="finish")
        if job is None or not _finish_allowed(job, status):
            return False
        _execute(sql.FINISH, {"status": status, "error_code": error_code, "job": job.id})
        _execute(sql.END_RESERVATIONS, [job.id])
        metadata: dict[str, object] = {} if status == "succeeded" else {"error_code": error_code}
        _event(f"job.{status}", job, metadata)
        if job.parent_job_id is not None:
            _close_parent_dispatch(job, status)
    if job.parent_job_id is None and not mutants.on("finish_keeps_live_locks"):
        for lock in lock_set(job.kind, job.organisation_id, job.tenant_id):
            locks.unlock_all(lock)
    return True
