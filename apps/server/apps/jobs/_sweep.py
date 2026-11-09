"""The sweep: docs/specs/JOB_QUEUE.md §5.2.

It decides from dispatch records alone and never reads a heartbeat, a session or an advisory lock:
an expired lease, a stale heartbeat or a lock nobody holds establishes nothing about an operation.
Each job it moves is its own transaction, on a row it locked without waiting and re-checked.
"""

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from django.db import connection

from apps.audit.services import record_job_event

from . import mutants, sql
from ._claim import promote, require_no_transaction, row_lock
from .transactions import queue_atomic


@dataclass(frozen=True)
class _Expired:
    id: UUID
    organisation_id: UUID
    fence: int
    status: str
    attempt: int
    max_attempts: int
    parent_job_id: UUID | None


def _one(statement: str, parameters: Any) -> tuple[Any, ...] | None:
    with connection.cursor() as cursor:
        cursor.execute(statement, parameters)
        row: tuple[Any, ...] | None = cursor.fetchone()
        return row


def _all(statement: str, parameters: Any = None) -> list[tuple[Any, ...]]:
    with queue_atomic("sweep_expired_leases"), connection.cursor() as cursor:
        cursor.execute(statement, parameters)
        rows: list[tuple[Any, ...]] = cursor.fetchall()
        return rows


def _execute(statement: str, parameters: Any) -> None:
    with connection.cursor() as cursor:
        cursor.execute(statement, parameters)


def _event(action: str, job_id: UUID, organisation_id: UUID, metadata: dict[str, object]) -> None:
    record_job_event(
        action=action,
        job_id=job_id,
        organisation_id=organisation_id,
        actor_type="system",
        actor_id=None,
        request_id=None,
        metadata=metadata,
    )


def _close_parent_dispatch(
    job_id: UUID, *, leaves_open: bool, closes_completed: bool, without_evidence_ref: bool
) -> None:
    """§3.3: a sub-job the sweep fails closes its parent's dispatch naming it failed, with the
    reference to the sub-job as the evidence."""
    if leaves_open:
        return
    evidence = sql.EVIDENCE_NONE if without_evidence_ref else sql.EVIDENCE_OPERATION_REF
    _execute(
        sql.CLOSE_PARENT_DISPATCH.format(evidence_ref=evidence),
        {"outcome": "completed" if closes_completed else "failed", "job": job_id},
    )


def _lock_expired(job_id: UUID, fence: int, expired: bool) -> _Expired | None:
    """Lock the candidate without waiting and re-check what was read, before any dispatch read."""
    statement = sql.SWEEP_ROW.format(
        row_lock=row_lock(
            for_update=mutants.on("sweep_locks_for_update"), waits=mutants.on("sweep_waits")
        )
    )
    found = _one(statement, [job_id])
    if found is None:
        return None
    job = _Expired(*found)
    if job.status not in ("leased", "running") or job.fence != fence:
        return None
    if expired:
        still = _one(sql.SWEEP_STILL_EXPIRED, [job.id])
        if still is None or not still[0]:
            return None
    return job


def _unresolved(job: _Expired) -> tuple[Any, ...] | None:
    """The earliest open dispatch or, when none is open, the dispatch naming a live sub-job."""
    if not mutants.on("sweep_ignores_dispatch"):
        sub_job = sql.DISPATCH_NOT_SUB_JOB if mutants.on("sweep_ignores_subjob_dispatch") else ""
        found = _one(sql.SWEEP_OPEN_DISPATCH.format(sub_job=sub_job), [job.id])
        if found is not None:
            return found
    if mutants.on("sweep_reads_only_dispatch_records"):
        return None
    return _one(sql.SWEEP_LIVE_SUB_JOB_DISPATCH, [job.id])


def _hold(job: _Expired, step_id: UUID, operation_ref: str) -> None:
    _execute(sql.HOLD, {"step": step_id, "operation_ref": operation_ref, "job": job.id})
    _event(
        "job.reconciliation_required",
        job.id,
        job.organisation_id,
        {"unresolved_step": str(step_id), "unresolved_operation_ref": operation_ref},
    )


def _fail_exhausted(job: _Expired) -> None:
    _execute(sql.FINISH, {"status": "failed", "error_code": "orphaned_exhausted", "job": job.id})
    _execute(sql.END_RESERVATIONS, [job.id])
    if mutants.on("exhausted_resets_steps"):
        _execute(sql.RUNNING_STEPS_PENDING, [job.id])
    _event("job.failed", job.id, job.organisation_id, {"error_code": "orphaned_exhausted"})
    if job.parent_job_id is not None:
        _close_parent_dispatch(
            job.id,
            leaves_open=mutants.on("exhausted_subjob_leaves_dispatch_open"),
            closes_completed=mutants.on("exhausted_closes_completed"),
            without_evidence_ref=mutants.on("exhausted_closes_without_evidence_ref"),
        )


def _orphan(job: _Expired) -> None:
    lock_requested_at = sql.ORPHAN_LOSES_PLACE if mutants.on("orphan_loses_place") else ""
    _execute(sql.ORPHAN.format(lock_requested_at=lock_requested_at), [job.id])
    _execute(sql.END_RESERVATIONS, [job.id])
    if mutants.on("sweep_completes_closed_step"):
        _execute(sql.RUNNING_STEPS_COMPLETED, [job.id])
    if not mutants.on("sweep_no_step_reset"):
        _execute(sql.RUNNING_STEPS_PENDING, [job.id])
    _event("job.orphaned", job.id, job.organisation_id, {})


def _sweep_one(job_id: UUID, fence: int, expired: bool) -> None:
    with queue_atomic("sweep_expired_leases"):
        job = _lock_expired(job_id, fence, expired)
        if job is None:
            return
        if mutants.on("budget_off_by_one"):
            exhausted = job.attempt > job.max_attempts
        else:
            exhausted = job.attempt >= job.max_attempts
        if exhausted and mutants.on("budget_before_dispatch"):
            _fail_exhausted(job)
            return
        unresolved = _unresolved(job)
        if unresolved is not None:
            _hold(job, *unresolved)
        elif exhausted:
            _fail_exhausted(job)
        else:
            _orphan(job)


def _parent_holds(parent_job_id: UUID, job_id: UUID) -> bool:
    """The parent is running, with an open dispatch naming the sub-job at its current fence."""
    parent = _one(sql.STRANDING_PARENT, [parent_job_id])
    if parent is None or parent[0] != "running":
        return False
    fence = "" if mutants.on("stranding_ignores_fence") else sql.STRANDING_FENCE
    found = _one(
        sql.STRANDING_DISPATCH.format(fence=fence),
        {"parent": parent_job_id, "job": job_id, "parent_fence": parent[1]},
    )
    return found is not None


def _strand_one(job_id: UUID) -> None:
    statement = sql.STRANDING_ROW.format(
        row_lock=row_lock(
            for_update=mutants.on("stranding_locks_for_update"),
            waits=mutants.on("stranding_waits"),
        )
    )
    with queue_atomic("sweep_expired_leases"):
        found = _one(statement, [job_id])
        if found is None:
            return
        _, organisation_id, status, parent_job_id = found
        if status not in ("queued", "orphaned"):
            return
        if not mutants.on("stranding_ignores_parent") and _parent_holds(parent_job_id, job_id):
            return
        _execute(
            sql.FINISH, {"status": "failed", "error_code": "parent_not_running", "job": job_id}
        )
        _event("job.failed", job_id, organisation_id, {"error_code": "parent_not_running"})
        if mutants.on("stranding_resets_steps"):
            _execute(sql.SUCCEEDED_STEPS_PENDING, [job_id])
        _close_parent_dispatch(
            job_id,
            leaves_open=mutants.on("stranding_leaves_dispatch_open"),
            closes_completed=mutants.on("stranding_closes_completed"),
            without_evidence_ref=mutants.on("stranding_closes_without_evidence_ref"),
        )


def sweep_expired_leases() -> None:
    """Commit the promotion, move every expired lease from its dispatch records, then fail every
    queued or orphaned sub-job whose parent no longer runs its dispatch."""
    require_no_transaction(
        "sweep_expired_leases", allowed=mutants.on("sweep_inside_transaction_allowed")
    )
    if not mutants.on("no_promotion"):
        promote("sweep_expired_leases")
    # sweep_unexpired disables the one guard "the lease expired" at both sites that read it.
    expired = not mutants.on("sweep_unexpired")
    candidates = _all(sql.SWEEP_CANDIDATES.format(expired=sql.SWEEP_EXPIRED if expired else ""))
    for job_id, fence in candidates:
        _sweep_one(job_id, fence, expired)
    if mutants.on("stranded_subjob_kept"):
        return
    for (job_id,) in _all(sql.STRANDING_CANDIDATES):
        _strand_one(job_id)
