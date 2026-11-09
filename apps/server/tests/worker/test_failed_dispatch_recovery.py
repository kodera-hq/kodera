"""Failed-dispatch recovery against PostgreSQL and real worker deaths; run in CI."""

from __future__ import annotations

import time
from pathlib import Path
from uuid import UUID

import pytest
from worker_harness import (
    Control,
    WorkerProcess,
    advisory_locks,
    advisory_locks_once_exited,
    audit_actions,
    database_name,
    dispatches,
    enqueue,
    expire_lease,
    job,
    open_reservations,
    short_directory,
    steps,
)

from apps.jobs import services as queue
from apps.jobs.models import JobStep

pytestmark = pytest.mark.django_db(transaction=True)

CLOSED = "worker:after-failed-dispatch-close-before-step-record"
RECOVERED = "worker:after-recovered-failed-step"


def wait_point(control: Control, point: str) -> None:
    deadline = time.monotonic() + 30
    while not control.reached(point):
        assert time.monotonic() < deadline, f"worker never reached {point}"
        time.sleep(0.05)


def failure_row(job_id: UUID) -> dict[str, object]:
    (row,) = [row for row in dispatches(job_id) if row["seq"] == 3]
    assert row["closed_at"] is not None and row["terminal_outcome"] == "failed"
    assert row["terminal_evidence_ref"]
    return row


def assert_converged(job_id: UUID, control: Control, original: dict[str, object]) -> None:
    assert job(job_id)["status"] == "failed", "failed dispatch was not recovered"
    assert job(job_id)["error_code"] == "step_failed"
    assert steps(job_id) == ["succeeded", "succeeded", "failed", "pending"]
    assert failure_row(job_id) == original, "recovery rewrote the closed dispatch"
    assert JobStep.objects.get(job_id=job_id, seq=3).output_ref == original["terminal_evidence_ref"]
    assert len(dispatches(job_id)) == 3
    assert len([row for row in control.ledger() if row["step"] == "record"]) == 1
    assert not [row for row in control.ledger() if row["step"] == "verify_age"]
    assert audit_actions(job_id).count("job.step_failed") == 1
    assert audit_actions(job_id).count("job.failed") == 1
    from apps.audit.models import AuditEvent

    assert AuditEvent.objects.get(job_id=job_id, action="job.step_failed").metadata == {
        "seq": 3,
        "step_id": str(JobStep.objects.get(job_id=job_id, seq=3).pk),
        "output_ref": original["terminal_evidence_ref"],
    }
    assert open_reservations(job_id) == 0


@pytest.mark.parametrize("kill_after_projection", [False, True])
def test_failed_dispatch_survives_worker_deaths(
    tmp_path: Path, kill_after_projection: bool
) -> None:
    control = Control(tmp_path)
    control.plan(record=["fail"])
    control.arm("worker:after-failed-dispatch-close-before-step-record", "kill")
    with short_directory("failed") as root:
        first = WorkerProcess(database=database_name(), control=tmp_path, job_root=root)
        try:
            job_id = enqueue()
            claimed = first.wait_for(lambda event: event["event"] == "claimed")
            wait_point(control, CLOSED)
            original = failure_row(job_id)
            assert original["fence"] == claimed["fence"]
            assert any(
                event["dispatch_id"] == str(original["id"])
                and event["action"] == "close"
                and event["reason"] == "authenticated terminal proof"
                for event in first.events("settled")
            )
            assert steps(job_id) == ["succeeded", "succeeded", "running", "pending"]
            assert job(job_id)["status"] == "running"
            assert "job.step_failed" not in audit_actions(job_id)
            assert open_reservations(job_id) > 0
        finally:
            first.kill()
        assert advisory_locks_once_exited(int(claimed["backend_pid"])) == 0
        expire_lease(job_id)
        queue.sweep_expired_leases()
        assert job(job_id)["status"] == "orphaned"
        assert steps(job_id)[2] == "pending"
        if kill_after_projection:
            control.arm("worker:after-recovered-failed-step", "kill")
        else:
            (tmp_path / "armed.json").write_text("[]")
        second = WorkerProcess(database=database_name(), control=tmp_path, job_root=root)
        try:
            newer = second.wait_for(lambda event: event["event"] == "claimed")
            assert int(newer["fence"]) > int(claimed["fence"])
            if kill_after_projection:
                wait_point(control, RECOVERED)
                assert steps(job_id)[2] == "failed"
                assert job(job_id)["status"] == "leased"
                assert audit_actions(job_id).count("job.step_failed") == 1
            else:
                assert second.ended(job_id) == "failed"
                assert_converged(job_id, control, original)
                assert advisory_locks(int(newer["backend_pid"])) == 0
        finally:
            second.kill()
        if kill_after_projection:
            expire_lease(job_id)
            queue.sweep_expired_leases()
            assert job(job_id)["status"] == "orphaned"
            (tmp_path / "armed.json").write_text("[]")
            third = WorkerProcess(database=database_name(), control=tmp_path, job_root=root)
            try:
                latest = third.wait_for(lambda event: event["event"] == "claimed")
                assert int(latest["fence"]) > int(newer["fence"])
                assert third.ended(job_id) == "failed"
                assert_converged(job_id, control, original)
                assert advisory_locks(int(latest["backend_pid"])) == 0
            finally:
                third.kill()


def test_recovery_removal_mutant_fails_convergence(tmp_path: Path) -> None:
    control = Control(tmp_path)
    control.plan(record=["fail"])
    control.arm("worker:after-failed-dispatch-close-before-step-record", "kill")
    with short_directory("failure-mutant") as root:
        first = WorkerProcess(database=database_name(), control=tmp_path, job_root=root)
        try:
            job_id = enqueue()
            wait_point(control, CLOSED)
            original = failure_row(job_id)
        finally:
            first.kill()
        expire_lease(job_id)
        (tmp_path / "armed.json").write_text("[]")
        mutant = WorkerProcess(
            database=database_name(), control=tmp_path, job_root=root, skip_failed_recovery=True
        )
        try:
            assert mutant.ended(job_id) == "refused"
            with pytest.raises(AssertionError) as rejected:
                assert_converged(job_id, control, original)
            assert str(rejected.value).splitlines()[0] == "failed dispatch was not recovered"
            assert failure_row(job_id) == original
            assert len([row for row in control.ledger() if row["step"] == "record"]) == 1
            assert not [row for row in control.ledger() if row["step"] == "verify_age"]
            assert "job.step_failed" not in audit_actions(job_id)
        finally:
            mutant.kill()


@pytest.mark.parametrize("outcome", [None, "no_effect", "completed", "failed"])
def test_projection_respects_terminal_outcome_and_stale_fences(outcome: str | None) -> None:
    job_id = enqueue()
    claim = queue.claim_job(runner_id="before", job_id=job_id)
    assert isinstance(claim, queue.Claim)
    for seq in (1, 2):
        assert queue.record_step(claim=claim, seq=seq, status="running")
        assert queue.record_step(claim=claim, seq=seq, status="succeeded")
    assert queue.record_step(claim=claim, seq=3, status="running")
    dispatch_id = queue.record_dispatch(claim=claim, seq=3, operation_ref="synthetic-control")
    assert dispatch_id is not None
    if outcome is not None:
        assert queue.close_dispatch(
            claim=claim,
            dispatch_id=dispatch_id,
            outcome=outcome,
            evidence_ref="object://synthetic/control",
        )
    queue.release_live_locks(claim=claim)
    expire_lease(job_id)
    queue.sweep_expired_leases()
    assert not queue.record_step(claim=claim, seq=3, status="failed")
    assert not queue.finish_job(claim=claim, status="failed", error_code="step_failed")
    if outcome is None:
        assert job(job_id)["status"] == "needs_reconciliation"
        assert isinstance(queue.claim_job(runner_id="after", job_id=job_id), queue.ClaimRefused)
        assert "job.step_failed" not in audit_actions(job_id)
        return
    newer = queue.claim_job(runner_id="after", job_id=job_id)
    assert isinstance(newer, queue.Claim)
    try:
        assert newer.fence > claim.fence
        assert (
            steps(job_id)[2]
            == {"completed": "succeeded", "no_effect": "pending", "failed": "failed"}[outcome]
        )
        assert audit_actions(job_id).count("job.step_failed") == int(outcome == "failed")
        assert not queue.record_step(claim=claim, seq=3, status="failed")
        assert not queue.finish_job(claim=claim, status="failed", error_code="step_failed")
        assert not queue.close_dispatch(
            claim=claim,
            dispatch_id=dispatch_id,
            outcome="failed",
            evidence_ref="object://synthetic/stale",
        )
    finally:
        queue.release_live_locks(claim=newer)


def test_unverified_failure_is_held_without_projection(tmp_path: Path) -> None:
    control = Control(tmp_path)
    control.plan(record=["garble"])
    with short_directory("unknown") as root:
        worker = WorkerProcess(database=database_name(), control=tmp_path, job_root=root)
        try:
            job_id = enqueue()
            assert worker.ended(job_id) == "held"
        finally:
            worker.kill()
    assert job(job_id)["status"] == "needs_reconciliation"
    assert steps(job_id)[2] == "running"
    assert dispatches(job_id)[-1]["closed_at"] is None
    assert "job.step_failed" not in audit_actions(job_id)


def test_class_a_failed_dispatch_is_not_projected() -> None:
    job_id = enqueue()
    claim = queue.claim_job(runner_id="class-a", job_id=job_id)
    assert isinstance(claim, queue.Claim)
    assert queue.record_step(claim=claim, seq=1, status="running")
    dispatch_id = queue.record_dispatch(claim=claim, seq=1, operation_ref="synthetic-class-a")
    assert dispatch_id is not None
    assert queue.close_dispatch(
        claim=claim,
        dispatch_id=dispatch_id,
        outcome="failed",
        evidence_ref="object://synthetic/class-a",
    )
    queue.release_live_locks(claim=claim)
    expire_lease(job_id)
    queue.sweep_expired_leases()
    newer = queue.claim_job(runner_id="class-a-retry", job_id=job_id)
    assert isinstance(newer, queue.Claim)
    try:
        assert steps(job_id)[0] == "pending"
        assert "job.step_failed" not in audit_actions(job_id)
    finally:
        queue.release_live_locks(claim=newer)


def test_old_cycle_failed_dispatch_does_not_fail_a_resumed_step(settings) -> None:
    from django.utils import timezone

    from apps.identity.command_principal import staff_principal_for_command
    from apps.identity.models import Identity, StaffRole, User
    from apps.jobs._runner import _start_sub_job
    from apps.jobs.kinds import SubJobRelation

    settings.KODERA_STAFF_ISSUER = "https://staff.test/realms/kodera-staff"
    person = User.objects.create(email="operator@staff.test", enabled=True)
    identity = Identity.objects.create(
        user=person,
        issuer=settings.KODERA_STAFF_ISSUER,
        realm="kodera-staff",
        subject="recovery-operator",
        email=person.email,
        enabled=True,
    )
    StaffRole.objects.create(identity=identity, realm="kodera-staff", role="staff_operator")
    job_id = enqueue()
    parent = queue.claim_job(runner_id="parent", job_id=job_id)
    assert isinstance(parent, queue.Claim)
    for seq in (1, 2):
        assert queue.record_step(claim=parent, seq=seq, status="running")
        assert queue.record_step(claim=parent, seq=seq, status="succeeded")
    assert queue.record_step(claim=parent, seq=3, status="running")
    # Test-only relation, as in the queue harness; the production relation registry stays empty.
    child_id = _start_sub_job(
        claim=parent,
        seq=3,
        kind="export",
        desired_spec_hash="0" * 64,
        allowed_relations=frozenset({SubJobRelation("backup", "record", "export")}),
    )
    assert child_id is not None
    dispatch_id = dispatches(job_id)[-1]["id"]
    child = queue.claim_job(runner_id="child", job_id=child_id)
    assert isinstance(child, queue.Claim)
    assert queue.hold_for_reconciliation(claim=parent, dispatch_id=dispatch_id)
    queue.release_live_locks(claim=parent)
    assert queue.finish_job(claim=child, status="failed", error_code="step_failed")
    original = failure_row(job_id)
    evidence = queue.Evidence("synthetic", "gone", "read", timezone.now())
    decision = queue.ReconciliationDecision(job_id, "resume", "no_effect", evidence, evidence)
    assert isinstance(
        queue.record_reconciliation_decision(
            principal=staff_principal_for_command(identity.id), decision=decision
        ),
        queue.DecisionRecorded,
    )
    newer = queue.claim_job(runner_id="new-cycle", job_id=job_id)
    assert isinstance(newer, queue.Claim)
    try:
        assert steps(job_id)[2] == "pending", "old-cycle failure crossed a no-effect resume"
        assert "job.step_failed" not in audit_actions(job_id)
        assert failure_row(job_id) == original
        assert queue.record_step(claim=newer, seq=3, status="running")
        assert (
            queue.record_dispatch(claim=newer, seq=3, operation_ref="synthetic-new-cycle")
            is not None
        )
    finally:
        queue.release_live_locks(claim=newer)


def test_the_exit_wait_fails_when_the_backend_stays() -> None:
    """advisory_locks_once_exited can fail: a backend that never exits trips its deadline."""
    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_backend_pid()")
        (alive,) = cursor.fetchone()
    with pytest.raises(AssertionError, match=f"backend {alive} outlived its killed worker"):
        advisory_locks_once_exited(alive, within=0.2)
