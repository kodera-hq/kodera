"""Claiming a job: docs/specs/JOB_QUEUE.md §4.2, §4.3 and §5.3.

A claim of one job is one transaction. A refusal raises _Refused inside the atomic block so the block
rolls back; the live advisory locks it took are session locks, which a rollback keeps, so every exit
that does not commit a claim releases them explicitly.
"""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from django.db import connection
from django.db.transaction import TransactionManagementError

from apps.audit.services import record_job_event
from apps.outbox.selectors import realm_change_open
from core.db.ids import new_uuid7

from . import locks, mutants, sql
from .kinds import REALM_KINDS, Lock, lock_set
from .transactions import queue_atomic
from .types import Claim, ClaimRefused

TERMINAL = frozenset({"succeeded", "failed", "cancelled"})
CLAIMABLE = frozenset({"queued", "orphaned"})


class _Refused(Exception):  # noqa: N818 - a refusal, not an error: it never leaves this module
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class _Row:
    id: UUID
    status: str
    due: bool
    parent_job_id: UUID | None
    depends_on_job_id: UUID | None
    lock_requested_at: datetime | None
    kind: str
    organisation_id: UUID
    tenant_id: UUID | None
    fence: int


def require_no_transaction(name: str, *, allowed: bool) -> None:
    """Refuse a call made inside a transaction its caller opened; `allowed` is the call's flag."""
    if allowed:
        return
    if connection.in_atomic_block or not connection.get_autocommit():
        raise TransactionManagementError(
            f"{name} must be called with no transaction open (JOB_QUEUE.md §4)"
        )


def row_lock(*, for_update: bool, waits: bool) -> str:
    strength = sql.UPDATE if for_update else sql.NO_KEY_UPDATE
    return strength + ("" if waits else sql.SKIP_LOCKED)


def promote(function: str = "claim_job") -> None:
    """§5.3: give every due, unplaced top-level job its place, in its own checked, committed transaction.
    Every claim and every sweep commits it first; each caller's call is read through its own flag."""
    statement = sql.PROMOTION.format(
        placed_at=(
            sql.PROMOTION_AT_EACH_ROW
            if mutants.on("promotion_instant_per_row")
            else sql.PROMOTION_AT_INSTANT
        ),
        due="" if mutants.on("promotion_ignores_not_before") else sql.PROMOTION_DUE,
        row_lock=row_lock(
            for_update=mutants.on("promotion_locks_for_update"),
            waits=mutants.on("promotion_waits"),
        ),
    )
    with queue_atomic(function), connection.cursor() as cursor:
        cursor.execute(statement)


def _scan() -> list[UUID]:
    only = ""
    if mutants.on("scan_skips_subjobs"):
        only = sql.SCAN_TOP_LEVEL_ONLY
    elif mutants.on("scan_skips_dependency_failed"):
        only = sql.SCAN_PLACED_ONLY
    statement = sql.SCAN.format(
        only=only,
        sub_jobs=(
            sql.SCAN_SUB_JOBS_LAST if mutants.on("scan_subjobs_last") else sql.SCAN_SUB_JOBS_FIRST
        ),
    )
    with queue_atomic("claim_job"), connection.cursor() as cursor:
        cursor.execute(statement)
        return [job_id for (job_id,) in cursor.fetchall()]


def _system_event(action: str, job: _Row, metadata: dict[str, object]) -> None:
    record_job_event(
        action=action,
        job_id=job.id,
        organisation_id=job.organisation_id,
        actor_type="system",
        actor_id=None,
        request_id=None,
        metadata=metadata,
    )


def _read_row(job_id: UUID) -> _Row | None:
    statement = sql.CLAIM_ROW.format(
        row_lock=row_lock(
            for_update=mutants.on("claim_locks_for_update"), waits=mutants.on("claim_waits")
        )
    )
    with connection.cursor() as cursor:
        cursor.execute(statement, [job_id])
        found = cursor.fetchone()
    return None if found is None else _Row(job_id, *found)


def _parent_running(job: _Row) -> bool:
    statement = sql.PARENT_RUNNING.format(
        fence="" if mutants.on("subjob_ignores_fence") else sql.PARENT_FENCE
    )
    with connection.cursor() as cursor:
        cursor.execute(statement, {"parent": job.parent_job_id, "job": job.id})
        return cursor.fetchone() is not None


def _dependency_status(job: _Row) -> str | None:
    """None when the job waits on no dependency, or when the check is skipped."""
    if job.depends_on_job_id is None or mutants.on("claim_ignores_dependency"):
        return None
    with connection.cursor() as cursor:
        cursor.execute(sql.DEPENDENCY_STATUS, [job.depends_on_job_id])
        return str(cursor.fetchone()[0])


def _conflicts(mine: Lock, theirs: Lock) -> bool:
    if (mine.lock_class, mine.key) != (theirs.lock_class, theirs.key):
        return False
    if mine.mode == "exclusive":
        return True
    return theirs.mode == "exclusive" and not mutants.on("shared_passes_exclusive")


def _reservation_conflict(job: _Row, lock: Lock) -> bool:
    with connection.cursor() as cursor:
        cursor.execute(
            sql.RESERVATION_CONFLICT,
            {"job": job.id, "class": lock.lock_class, "key": lock.key, "mode": lock.mode},
        )
        return cursor.fetchone() is not None


def _check_reservations(job: _Row, wanted: tuple[Lock, ...]) -> None:
    if mutants.on("no_reservation_check"):
        return
    for lock in wanted:
        if _reservation_conflict(job, lock):
            raise _Refused("reservation_conflict")


def _check_deliveries(job: _Row) -> None:
    if job.kind not in REALM_KINDS or mutants.on("no_delivery_check"):
        return
    if realm_change_open(job.organisation_id):
        raise _Refused("delivery_in_flight")


def _check_session(wanted: tuple[Lock, ...]) -> None:
    """Check 0: the session holds no live lock of the set already."""
    if mutants.on("reentrant_claim"):
        return
    for lock in wanted:
        if lock.lock_class == "organisation" and mutants.on("reentrant_org_unchecked"):
            continue
        if locks.held(lock):
            raise _Refused("session_holds_lock")


def _check_request_order(job: _Row, wanted: tuple[Lock, ...]) -> None:
    """Check 2: no earlier, still claimable and unclaimed request needs a conflicting lock."""
    if mutants.on("no_request_order"):
        return
    compared = wanted
    if mutants.on("request_order_tenant_only"):
        compared = tuple(lock for lock in wanted if lock.lock_class == "tenant")
    with connection.cursor() as cursor:
        cursor.execute(
            sql.EARLIER_REQUESTS,
            {
                "job": job.id,
                "placed": job.lock_requested_at,
                "organisation": job.organisation_id,
                "tenant": job.tenant_id,
            },
        )
        earlier = cursor.fetchall()
    for kind, organisation_id, tenant_id in earlier:
        for theirs in lock_set(kind, organisation_id, tenant_id):
            if any(_conflicts(mine, theirs) for mine in compared):
                raise _Refused("earlier_request")


def _take(wanted: tuple[Lock, ...], taken: list[Lock]) -> None:
    """Check 3: each lock in order, never waiting; a refusal releases what this claim took."""
    for lock in wanted:
        if not locks.try_lock(lock):
            if not mutants.on("keep_locks_on_refusal"):
                locks.unlock(taken)
            taken.clear()
            raise _Refused("live_lock_busy")
        taken.append(lock)


def _take_checking_each(job: _Row, wanted: tuple[Lock, ...], taken: list[Lock]) -> None:
    """Checks 1 and 3 lock by lock instead of the whole set's reservations first."""
    for lock in wanted:
        _check_reservations(job, (lock,))
        _take((lock,), taken)


def _check_again(job: _Row, wanted: tuple[Lock, ...], taken: list[Lock]) -> None:
    """Check 4: check 1 again, all of it, with the live locks held."""
    try:
        if not mutants.on("check4_skips_reservations"):
            _check_reservations(job, wanted)
        _check_deliveries(job)
    except _Refused:
        locks.unlock(taken)
        taken.clear()
        raise


def _complete_class_c(job: _Row) -> None:
    """Mark succeeded each pending class C step whose latest dispatch of the current resolution
    cycle closed completed, copying its proof and clearing error before auditing each.
    Sub-job completion remains eligible here; only the runner's direct-provider writer excludes it.
    """
    if mutants.on("claim_ignores_closed_class_c"):
        return
    cycle = ""
    if not mutants.on("claim_completes_across_cycles"):
        cycle = sql.CYCLE.format(
            bound=(
                sql.CYCLE_FROM_FIRST
                if mutants.on("claim_cycle_from_first_resume")
                else sql.CYCLE_FROM_LATEST
            )
        )
    statement = sql.COMPLETE_CLASS_C.format(
        class_c="" if mutants.on("claim_completes_any_class") else sql.CLASS_C, cycle=cycle
    )
    with connection.cursor() as cursor:
        cursor.execute(statement, {"job": job.id, "evidence_whitespace": sql.EVIDENCE_WHITESPACE})
        completed = cursor.fetchall()
    if mutants.on("claim_completion_unaudited"):
        return
    for step_id, seq, output_ref in sorted(completed, key=lambda row: row[1]):
        _system_event(
            "job.step_succeeded",
            job,
            {"seq": seq, "step_id": str(step_id), "output_ref": output_ref},
        )


def _recover_failed_class_c(job: _Row) -> None:
    """Project terminal failed proof once, under the claim's job lock and transaction.

    The dispatch and its original close fence stay immutable. Only pending class-C steps in the
    latest resolution cycle change, so another claim cannot emit a second failure audit.
    """
    statement = sql.RECOVER_FAILED_CLASS_C.format(
        cycle=sql.CYCLE.format(bound=sql.CYCLE_FROM_LATEST)
    )
    with connection.cursor() as cursor:
        cursor.execute(statement, {"job": job.id})
        recovered = cursor.fetchall()
    for step_id, seq, output_ref in sorted(recovered, key=lambda row: row[1]):
        _system_event(
            "job.step_failed",
            job,
            {"seq": seq, "step_id": str(step_id), "output_ref": output_ref},
        )


def _commit(job: _Row, runner_id: str, reserved: tuple[Lock, ...]) -> Claim:
    """Step 5: lease the job under a new fence and bind its reservations to it."""
    attempt = (
        sql.ATTEMPT_ALWAYS
        if mutants.on("resume_claim_counts_attempt")
        else sql.ATTEMPT_UNLESS_RESUMED
    )
    with connection.cursor() as cursor:
        cursor.execute(
            sql.COMMIT_CLAIM.format(attempt=attempt),
            {"runner": runner_id, "job": job.id, "status": job.status, "fence": job.fence},
        )
        found = cursor.fetchone()
        if found is None:
            raise RuntimeError(f"job {job.id} changed under the claim's row lock")
        fence = int(found[0])
        cursor.execute(sql.END_RESERVATIONS, [job.id])
        for lock in reserved:
            cursor.execute(
                sql.INSERT_RESERVATION,
                [new_uuid7(), job.id, fence, lock.lock_class, lock.key, lock.mode],
            )
    _complete_class_c(job)
    _recover_failed_class_c(job)
    if job.fence == 0 or mutants.on("started_every_claim"):
        _system_event("job.started", job, {"fence": fence, "runner_id": runner_id})
    return Claim(job_id=job.id, fence=fence, runner_id=runner_id)


def _claim_locked(job_id: UUID, runner_id: str, taken: list[Lock]) -> Claim | ClaimRefused:
    """Steps 1 to 5 of §4.2, inside the claim's transaction."""
    job = _read_row(job_id)
    if job is None or job.status not in CLAIMABLE:
        raise _Refused("not_claimable")
    if not job.due and not mutants.on("claim_ignores_not_before"):
        raise _Refused("not_claimable")
    sub_job = job.parent_job_id is not None
    if sub_job:
        if not _parent_running(job):
            raise _Refused("parent_not_running")
        if not mutants.on("subjob_full_checks"):
            return _commit(job, runner_id, ())

    dependency = _dependency_status(job)
    if dependency is not None and dependency != "succeeded":
        if dependency not in TERMINAL:
            raise _Refused("waiting_on_dependency")
        if not mutants.on("prerequisite_not_failed"):
            with connection.cursor() as cursor:
                cursor.execute(sql.FAIL_PREREQUISITE, [job.id])
            _system_event("job.failed", job, {"error_code": "prerequisite_failed"})
            return ClaimRefused(job_id=job.id, reason="prerequisite_failed")

    if not sub_job and job.lock_requested_at is None:
        raise _Refused("not_claimable")

    wanted = lock_set(job.kind, job.organisation_id, job.tenant_id)
    _check_session(wanted)
    if mutants.on("interleave_reservation_and_live"):
        _check_request_order(job, wanted)
        _take_checking_each(job, wanted, taken)
        _check_deliveries(job)
    else:
        if mutants.on("check1_reads_deliveries_first"):
            _check_deliveries(job)
            _check_reservations(job, wanted)
        else:
            _check_reservations(job, wanted)
            _check_deliveries(job)
        _check_request_order(job, wanted)
        _take(wanted, taken)
    _check_again(job, wanted, taken)
    return _commit(job, runner_id, wanted)


def _claim_one(job_id: UUID, runner_id: str) -> Claim | ClaimRefused:
    taken: list[Lock] = []
    committed = False
    try:
        with queue_atomic("claim_job"):
            result = _claim_locked(job_id, runner_id, taken)
        committed = True
        return result
    except _Refused as refused:
        return ClaimRefused(job_id=job_id, reason=refused.reason)
    finally:
        if not committed and not mutants.on("no_finally_release"):
            locks.unlock(taken)


def claim_job(*, runner_id: str, job_id: UUID | None = None) -> Claim | ClaimRefused | None:
    """§4.2: commit the promotion, then claim the named job, or scan for the first claimable one."""
    require_no_transaction("claim_job", allowed=mutants.on("claim_inside_transaction_allowed"))
    if not mutants.on("claim_skips_promotion"):
        promote()
    if job_id is not None:
        return _claim_one(job_id, runner_id)
    for candidate in _scan():
        result = _claim_one(candidate, runner_id)
        if isinstance(result, Claim):
            return result
    return None


def release_live_locks(*, claim: Claim) -> None:
    """Release every live lock of the claimed job's set this session holds; write nothing."""
    if mutants.on("release_noop"):
        return
    with connection.cursor() as cursor:
        cursor.execute(sql.RELEASE_SUBJECT, [claim.job_id])
        found = cursor.fetchone()
    if found is None:
        return
    kind, organisation_id, tenant_id, parent_job_id = found
    if parent_job_id is not None:
        return
    for lock in lock_set(kind, organisation_id, tenant_id):
        locks.unlock_all(lock)
