"""The runner against the test database, with real kills (G1.5-B).

Each test starts a real worker (tests/worker/worker_entry.py) serving the synthetic registry, and
acts on it from outside as the kernel or an operator would: a SIGKILL of the step child, a lease
the database clock has ended, a worker killed whole. What happened is read from the database and
from the operating system, never from the worker's account of itself.
"""

from __future__ import annotations

import os
import signal
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from worker_harness import (
    Control,
    WorkerProcess,
    advisory_locks,
    audit_actions,
    database_name,
    dispatches,
    enqueue,
    expire_lease,
    job,
    open_reservations,
    reaped,
    short_directory,
    steps,
)

from worker.handoff import LOCK_TIMEOUT, NOT_OWNED, REREAD_REFUSED, WRITTEN

pytestmark = pytest.mark.django_db(transaction=True)


def wait_status(job_id: object, status: str, timeout: float = 30.0) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        found = job(job_id)  # type: ignore[arg-type]
        if found["status"] == status:
            return found
        time.sleep(0.1)
    raise AssertionError(f"job {job_id} is {job(job_id)['status']}, never {status}")  # type: ignore[arg-type]


def test_a_lost_lease_stops_the_step_and_leaves_the_job_held_with_its_reservation(tmp_path: Path):
    control = Control(tmp_path)
    control.plan(quiesce=["hold"])
    with short_directory("lease") as jobs:
        worker = WorkerProcess(database=database_name(), control=tmp_path, job_root=jobs)
        try:
            job_id = enqueue()
            _, child = control.held()
            claimed = worker.wait_for(lambda e: e["event"] == "claimed")
            expire_lease(job_id)
            # One renewal refused: the lease is lost at once (worker/lease.py), and the runner kills
            # and reaps its step and writes nothing.
            assert worker.ended(job_id) == "lost"
            event = worker.wait_for(lambda e: e["event"] == "reaped" and e["pid"] == child)
            assert event["killed"] == "lease_lost"
            # The worker, the step's parent, is alive: a zombie would be a step it never reaped.
            assert reaped(child), "the step child was not reaped"
            assert advisory_locks(int(claimed["backend_pid"])) == 0, "live locks were kept"
            assert not worker.job_directory(job_id).exists()
            # The next sweep holds the open dispatch for an operator; the reservation stays.
            held = wait_status(job_id, "needs_reconciliation")
        finally:
            worker.kill()
    (dispatch,) = dispatches(job_id)
    assert dispatch["closed_at"] is None
    assert held["unresolved_operation_ref"] == dispatch["operation_ref"]
    assert open_reservations(job_id) == 1
    assert "job.reconciliation_required" in audit_actions(job_id)


@pytest.mark.parametrize("after_the_sweep", ["answered", "child-killed"])
def test_a_swept_claim_cannot_write(tmp_path: Path, after_the_sweep: str):
    # The lease ends and the sweep moves the job on while the runner still waits on its step: the
    # step's answer arrives at a claim that no longer owns the job, and every write is refused. The
    # fence itself (a superseded fence writes nothing, whatever the writer) is owned by the queue's
    # A3 test, tests/job_queue/test_job_queue_acceptance.py::
    # test_a3_03_a_superseded_fence_or_an_expired_lease_writes_nothing; this proves the runner meets
    # that refusal and ends `refused`, holding nothing.
    #
    # Or the step child dies with no answer after the sweep, before the keeper (renewing every
    # 600 s here) notices: quiesce registers a safe-convergence contract, yet no replay starts on
    # a job the sweep holds (worker/runner.py `_owned`; the replay read requires ownership too).
    control = Control(tmp_path)
    control.plan(quiesce=["hold"])
    with short_directory("stale") as jobs:
        worker = WorkerProcess(
            database=database_name(), control=tmp_path, job_root=jobs, renew_every_s=600
        )
        try:
            job_id = enqueue()
            name, child = control.held()
            claimed = worker.wait_for(lambda e: e["event"] == "claimed")
            expire_lease(job_id)
            from apps.jobs.services import sweep_expired_leases

            sweep_expired_leases()
            assert job(job_id)["status"] == "needs_reconciliation"
            if after_the_sweep == "answered":
                control.release(name)
            else:
                os.kill(child, signal.SIGKILL)
            assert worker.ended(job_id) == "refused"
            assert advisory_locks(int(claimed["backend_pid"])) == 0
            assert worker.events("replay") == [], "a replay started on a job the sweep holds"
            assert len(worker.events("child")) == 1, "a second step child was started"
        finally:
            worker.kill()
    assert len([row for row in control.ledger() if row["step"] == "quiesce"]) == 1
    (dispatch,) = dispatches(job_id)
    assert dispatch["closed_at"] is None, "a stale claim closed its dispatch"
    assert steps(job_id)[0] == "running", "a stale claim moved its step"
    assert "job.step_succeeded" not in audit_actions(job_id)
    assert job(job_id)["status"] == "needs_reconciliation"
    assert open_reservations(job_id) == 1


def test_the_ownership_read_refuses_each_clause_on_postgres():
    # The worker tests reach the ownership rule's positive answer on every call; here each clause's
    # refusal is read from PostgreSQL itself, on a claim no worker holds: a claimed job is `leased`,
    # not yet running; another fence is not this claim's; a lease the database clock has ended is
    # no lease, and the replay read returns nothing for any of them.
    from apps.jobs._claim import claim_job, release_live_locks
    from apps.jobs.runner_selectors import job_ownership, open_dispatch
    from apps.jobs.types import Claim

    job_id = enqueue()
    claim = claim_job(runner_id="runner-ownership", job_id=job_id)
    assert isinstance(claim, Claim), claim
    try:
        held = job_ownership(job_id, claim.fence)
        assert held is not None
        assert (held.running, held.current_fence, held.lease_live) == (False, True, True)
        other = job_ownership(job_id, claim.fence + 1)
        assert other is not None and not other.current_fence
        expire_lease(job_id)
        ended = job_ownership(job_id, claim.fence)
        assert ended is not None and (ended.current_fence, ended.lease_live) == (True, False)
        assert open_dispatch(job_id, claim.fence) is None
    finally:
        release_live_locks(claim=claim)
    assert job_ownership(uuid.uuid4(), claim.fence) is None


def _from_another_connection(attempt: Callable[[Any], object]) -> object:
    """Run `attempt(cursor)` in its own transaction on another connection, as a sweep would."""
    from django.db import connection, transaction

    found: list[object] = []

    def run() -> None:
        try:
            with transaction.atomic(), connection.cursor() as cursor:
                found.append(attempt(cursor))
        except Exception as error:  # noqa: BLE001 - the answer is the error itself
            found.append(error)
        finally:
            connection.close()

    thread = threading.Thread(target=run)
    thread.start()
    thread.join(30)
    assert found, "the other connection never answered"
    return found[0]


def recorded(writes: list[bool]) -> bool:
    """A request's write, as a test records it: it happened."""
    writes.append(True)
    return True


def running_claim(runner_id: str) -> tuple[uuid.UUID, Any]:
    """A job claimed in this process, its first step running: what the handoff is asked about."""
    from apps.jobs._claim import claim_job
    from apps.jobs._runner import record_step
    from apps.jobs.types import Claim

    job_id = enqueue()
    claim = claim_job(runner_id=runner_id, job_id=job_id)
    assert isinstance(claim, Claim), claim
    assert record_step(claim=claim, seq=1, status="running")
    return job_id, claim


def handoff_refusals(job_id: uuid.UUID, fence: int) -> list[str]:
    """Why the handoff let another connection take or move the job between the authorisation and
    the send, or refused a job the fence owns, or []. The hook runs where the request's write runs,
    under the lock."""
    from django.db import OperationalError

    from apps.jobs import sql
    from apps.jobs._claim import row_lock
    from worker.handoff import hand_off

    def sweep_locks(cursor: Any) -> bool:
        # The sweep's own row lock (apps/jobs/_sweep.py `_lock_expired`): SKIP LOCKED.
        cursor.execute(
            sql.SWEEP_ROW.format(row_lock=row_lock(for_update=False, waits=False)), [job_id]
        )
        return cursor.fetchone() is not None

    def moves(cursor: Any) -> bool:
        cursor.execute("SET LOCAL lock_timeout = '200ms'")
        cursor.execute(
            "UPDATE jobs_job SET status = 'needs_reconciliation' WHERE id = %s", [job_id]
        )
        raise RuntimeError("rolled back: the move is only attempted")

    seen: dict[str, object] = {}

    def write() -> bool:
        seen["sweep"] = _from_another_connection(sweep_locks)
        seen["move"] = _from_another_connection(moves)
        return True

    refusals = []
    if hand_off(job_id, fence, write) != WRITTEN:
        refusals.append("the handoff refused a job this claim owns")
    if seen.get("sweep") is not False:
        refusals.append("the sweep could lock the job between the authorisation and the send")
    if not isinstance(seen.get("move"), OperationalError):
        refusals.append(
            "another connection could move the job between the authorisation and the send"
        )
    return refusals


@pytest.mark.parametrize("mutant", [None, "handoff_without_row_lock"])
def test_the_handoff_holds_the_job_against_the_sweep(mutant: str | None):
    # The interleaving the extra review named, played by a hook at the handoff point: a sweep, or a
    # status move, on another connection between the final authorisation and the send. Under the
    # handoff's row lock the sweep skips the job (its own SKIP LOCKED) and the move waits past its
    # lock_timeout; once committed, both would see a job already handed off. The mutant drops the
    # lock, and this check names it (worker/mutants.py, tests/worker DATABASE_OWNED).
    from apps.jobs._claim import release_live_locks
    from worker import mutants

    job_id, claim = running_claim("runner-handoff")
    try:
        if mutant is None:
            assert handoff_refusals(job_id, claim.fence) == []
        else:
            mutants.activate(mutant)
            try:
                refusals = handoff_refusals(job_id, claim.fence)
            finally:
                mutants.deactivate()
            assert "the sweep could lock the job between the authorisation and the send" in refusals
        assert job(job_id)["status"] == "running"
    finally:
        release_live_locks(claim=claim)


def test_the_handoff_hands_nothing_off_for_a_job_the_fence_does_not_own():
    from apps.jobs._claim import claim_job, release_live_locks
    from apps.jobs.types import Claim
    from worker.handoff import hand_off

    job_id = enqueue()
    claim = claim_job(runner_id="runner-handoff-refused", job_id=job_id)
    assert isinstance(claim, Claim), claim
    delivered: list[bool] = []
    try:
        # Claimed, so `leased`: not yet running.
        assert hand_off(job_id, claim.fence, lambda: recorded(delivered)) == NOT_OWNED
    finally:
        release_live_locks(claim=claim)
    assert delivered == [], "the handoff ran its delivery for a job that is not running"


def _waiting_for_a_lock(cursor: Any) -> bool:
    cursor.execute("SELECT pg_stat_clear_snapshot()")
    cursor.execute(
        "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
        "AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()"
    )
    return bool(cursor.fetchone()[0])


def lock_wait_refusals(job_id: uuid.UUID, fence: int, *, moved: bool) -> list[str]:
    """Why the handoff wrote a request under a lease that ended while it waited for the job's row
    lock, or []. This connection holds the lock; the handoff, on another, is seen waiting while the
    lease is live; then the lease ends, by an UPDATE into the past (`moved`) or by the database's
    clock passing it on a row held unchanged, and the lock is released by the commit."""
    from django.db import connection, transaction

    from worker.handoff import hand_off

    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE jobs_job SET lease_expires_at = clock_timestamp() + interval '3 seconds' "
            "WHERE id = %s",
            [job_id],
        )
    written: list[bool] = []
    outcome: list[object] = []

    def handing_off() -> None:
        try:
            outcome.append(hand_off(job_id, fence, lambda: recorded(written)))
        except Exception as error:  # noqa: BLE001 - reported below
            outcome.append(error)
        finally:
            connection.close()

    thread = threading.Thread(target=handing_off)
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("SELECT id FROM jobs_job WHERE id = %s FOR NO KEY UPDATE", [job_id])
        thread.start()
        deadline = time.monotonic() + 10
        while not _waiting_for_a_lock(cursor):
            assert time.monotonic() < deadline, "the handoff never waited for the row lock"
            time.sleep(0.02)
        cursor.execute(
            "SELECT lease_expires_at > clock_timestamp() FROM jobs_job WHERE id = %s", [job_id]
        )
        assert cursor.fetchone()[0], "the lease ended before the handoff was seen waiting"
        if moved:
            cursor.execute(
                "UPDATE jobs_job SET lease_expires_at = clock_timestamp() - interval '1 second' "
                "WHERE id = %s",
                [job_id],
            )
        else:
            while True:
                cursor.execute(
                    "SELECT lease_expires_at < clock_timestamp() FROM jobs_job WHERE id = %s",
                    [job_id],
                )
                if cursor.fetchone()[0]:
                    break
                assert time.monotonic() < deadline, "the lease never ended"
                cursor.execute("SELECT pg_sleep(0.05)")
    thread.join(30)
    assert outcome and not isinstance(outcome[0], Exception), outcome
    if outcome[0] == WRITTEN or written:
        return ["the handoff wrote a request under a lease that ended while it waited for the lock"]
    if outcome[0] == LOCK_TIMEOUT:
        # The vacuous pass the round-5 review found: the wait was cut (statement_timeout) before
        # the lease ended, so nothing after the lock was ever exercised.
        return ["the handoff gave up the lock wait before the lease ended: nothing was re-read"]
    expected = (NOT_OWNED, REREAD_REFUSED) if moved else (REREAD_REFUSED,)
    if outcome[0] not in expected:
        return [f"the handoff refused for another reason than the re-read: {outcome[0]}"]
    return []


@pytest.mark.parametrize("mutant", [None, "handoff_without_reread_after_lock"])
def test_a_lease_that_ends_while_the_handoff_waits_for_the_lock_refuses(
    mutant: str | None, monkeypatch: pytest.MonkeyPatch
):
    # The extra review's lock-wait case: the locking SELECT's predicate was evaluated before it
    # waited, and PostgreSQL re-evaluates it only for a row updated meanwhile, so the handoff
    # re-reads the rule in a fresh statement once the lock is had (worker/handoff.py). The row held
    # unchanged while the lease runs out is the case only that re-read refuses, and the mutant
    # `handoff_without_reread_after_lock` must fail it by its message (tests/worker
    # DATABASE_OWNED). The lease moved into the past is refused either way, by the re-check
    # PostgreSQL makes of an updated row.
    from apps.jobs import sql
    from apps.jobs._claim import release_live_locks
    from worker import mutants

    # The handoff must outwait the holder: a lock timeout, or the connection's own 2 s
    # statement_timeout (config/environment.py), would cut the wait and refuse for another reason
    # (LOCK_TIMEOUT, which lock_wait_refusals names). Both are raised for this test's handoff alone.
    monkeypatch.setattr(
        sql,
        "RUNNER_HANDOFF_TIMEOUTS",
        ("SET LOCAL lock_timeout = '20s'", "SET LOCAL statement_timeout = '30s'"),
    )
    job_id, claim = running_claim("runner-lock-wait")
    try:
        if mutant is None:
            assert lock_wait_refusals(job_id, claim.fence, moved=False) == []
            job_again, claim_again = running_claim("runner-lock-wait-moved")
            try:
                assert lock_wait_refusals(job_again, claim_again.fence, moved=True) == []
            finally:
                release_live_locks(claim=claim_again)
        else:
            mutants.activate(mutant)
            try:
                refusals = lock_wait_refusals(job_id, claim.fence, moved=False)
            finally:
                mutants.deactivate()
            assert refusals == [
                "the handoff wrote a request under a lease that ended while it waited for the lock"
            ]
    finally:
        release_live_locks(claim=claim)


def test_a_lease_that_ends_during_the_spawn_refuses_the_handoff(tmp_path: Path):
    # The extra review's spawn case: the child is spawned before the handoff, and the lease ends
    # between Popen and BEGIN (a hook expires it). The re-read under the lock refuses; the child,
    # waiting on stdin, is killed and reaped unsent, and the provider never hears of the call.
    import subprocess
    from unittest import mock

    from apps.jobs._claim import release_live_locks
    from worker import child
    from worker.child import run_child
    from worker.handoff import hand_off
    from worker.providers.synthetic import SyntheticProvider

    job_id, claim = running_claim("runner-spawn")
    control = tmp_path / "control"
    control.mkdir()
    found = SyntheticProvider.for_run(control)
    call = found.request(
        dispatch_id=str(uuid.uuid4()),
        operation_ref="urn:kodera:worker:spawn",
        payload_hash="0" * 64,
        step="quiesce",
        attempt=1,
    )
    (tmp_path / "job").mkdir()
    real_popen = subprocess.Popen

    def popen(*arguments: object, **options: object) -> object:
        spawned = real_popen(*arguments, **options)  # type: ignore[call-overload]
        expire_lease(job_id)  # between Popen and BEGIN
        return spawned

    try:
        with mock.patch("worker.child.subprocess.Popen", popen):
            result = run_child(
                call,
                directory=tmp_path / "job",
                secret=None,
                lost=threading.Event().is_set,
                timeout_s=60,
                hand_off=lambda write: hand_off(job_id, claim.fence, write) == WRITTEN,
            )
    finally:
        release_live_locks(claim=claim)
    assert result.killed == child.NOT_OWNED, result
    assert reaped(result.pid), "the unsent step child was not killed and reaped"
    assert not (found.directory / "ledger").exists(), "the provider heard of a refused call"
    assert job(job_id)["status"] == "running"


def test_a_killed_child_is_replayed_under_its_one_dispatch(tmp_path: Path):
    control = Control(tmp_path)
    control.plan(snapshot=["hold", "complete"])
    with short_directory("replay") as jobs:
        worker = WorkerProcess(database=database_name(), control=tmp_path, job_root=jobs)
        try:
            job_id = enqueue()
            _, child = control.held()
            os.kill(child, signal.SIGKILL)
            assert worker.ended(job_id) == "succeeded"
            assert len(worker.events("replay")) == 1
        finally:
            worker.kill()
    snapshot = [row for row in dispatches(job_id) if row["seq"] == 2]
    assert len(snapshot) == 1, "a replay opened a second dispatch"
    assert snapshot[0]["terminal_outcome"] == "completed"
    calls = [row for row in control.ledger() if row["step"] == "snapshot"]
    assert [row["attempt"] for row in calls] == [1, 2]
    assert {(row["dispatch_id"], row["operation_ref"], row["payload_hash"]) for row in calls} == {
        (str(snapshot[0]["id"]), snapshot[0]["operation_ref"], calls[0]["payload_hash"])
    }


def test_a_killed_child_with_no_convergence_contract_is_held(tmp_path: Path):
    control = Control(tmp_path)
    control.plan(record=["hold"])
    with short_directory("held") as jobs:
        worker = WorkerProcess(database=database_name(), control=tmp_path, job_root=jobs)
        try:
            job_id = enqueue()
            _, child = control.held()
            os.kill(child, signal.SIGKILL)
            assert worker.ended(job_id) == "held"
            (refused,) = worker.events("replay_refused")
            assert refused["reasons"] == ["step record registers no safe-convergence contract"]
        finally:
            worker.kill()
    assert job(job_id)["status"] == "needs_reconciliation"
    record = [row for row in dispatches(job_id) if row["seq"] == 3]
    assert len(record) == 1 and record[0]["closed_at"] is None
    assert open_reservations(job_id) == 1
    assert len([row for row in control.ledger() if row["step"] == "record"]) == 1


def test_the_worker_does_not_claim_a_realm_create_job(tmp_path: Path):
    # Lane decision W4: the realm_create jobs operator bootstrap enqueues wait for G1.5-C.
    with short_directory("w4") as jobs:
        worker = WorkerProcess(database=database_name(), control=tmp_path, job_root=jobs)
        try:
            realm = enqueue("realm_create")
            served = enqueue()
            assert worker.ended(served) == "succeeded"
            time.sleep(1)
            claimed = {event["job_id"] for event in worker.events("claimed")}
        finally:
            worker.kill()
    assert claimed == {str(served)}
    assert job(realm)["status"] == "queued" and job(realm)["fence"] == 0
