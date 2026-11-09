"""Completed acknowledgement acceptance; PostgreSQL and real worker deaths run in CI."""

import json
import time
from pathlib import Path
from unittest.mock import Mock, patch

import pytest
from worker_harness import (
    Control,
    WorkerProcess,
    advisory_locks_once_exited,
    database_name,
    dispatches,
    enqueue,
    expire_lease,
    job,
    open_reservations,
    short_directory,
    steps,
)

from apps.audit.models import AuditEvent
from apps.jobs import services as queue
from apps.jobs.models import JobStep

pytestmark = pytest.mark.django_db(transaction=True)

EVIDENCE_WHITESPACE = "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"


@pytest.mark.parametrize(
    "proof",
    ["\v", "\xa0", "\x1c", "\u2003", EVIDENCE_WHITESPACE],
    ids=["VT", "NBSP", "U001C", "EMSPACE", "full-class"],
)
def test_malformed_closed_class_c_proof_stays_pending_and_runner_refuses(proof):
    from django.utils import timezone

    from apps.jobs.models import JobDispatch
    from worker.registry import JobContext
    from worker.runner import Runner

    job_id = enqueue()
    claim = queue.claim_job(runner_id="malformed-history", job_id=job_id)
    assert isinstance(claim, queue.Claim)
    for seq in (1, 2):
        assert queue.record_step(claim=claim, seq=seq, status="running")
        assert queue.record_step(claim=claim, seq=seq, status="succeeded")
    assert queue.record_step(claim=claim, seq=3, status="running")
    step = JobStep.objects.get(job_id=job_id, seq=3)
    # A representable initial historical row: no closed-row rewrite, trigger disable or
    # malformed public close is used. Existing FK/outcome/immutability guards stay enabled.
    recorded_at = timezone.now()
    JobDispatch.objects.create(
        job_id=job_id,
        step=step,
        fence=claim.fence,
        operation_ref="synthetic-malformed-history",
        dispatched_at=recorded_at,
        closed_at=recorded_at,
        terminal_outcome="completed",
        terminal_evidence_ref=proof,
    )
    original = dispatches(job_id)[-1]
    queue.release_live_locks(claim=claim)
    expire_lease(job_id)
    queue.sweep_expired_leases()
    newer = queue.claim_job(runner_id="reject-malformed-history", job_id=job_id)
    assert isinstance(newer, queue.Claim)
    try:
        assert steps(job_id)[2] == "pending", "claim admitted whitespace-only proof"
        assert not AuditEvent.objects.filter(
            job_id=job_id, action="job.step_succeeded", metadata__seq=3
        ).exists()
        runner = object.__new__(Runner)
        runner.registry = Mock()
        runner.registry.plan.side_effect = AssertionError("ineligible proof reached plan")
        runner.emit = Mock()
        runner.credentials = Mock()
        runner.provider = Mock()
        lease = Mock()
        lease.is_lost.return_value = False
        with (
            patch.object(
                runner, "_step", side_effect=AssertionError("ineligible proof reached provider")
            ),
            patch("apps.jobs._runner.record_step") as record,
        ):
            context = JobContext(
                job_id, "backup", job(job_id)["organisation_id"], job(job_id)["tenant_id"]
            )
            assert runner._steps(newer, context, Mock(), lease) == "refused"
        record.assert_not_called()
        runner.registry.plan.assert_not_called()
        runner.credentials.load.assert_not_called()
        runner.provider.request.assert_not_called()
        assert dispatches(job_id)[-1] == original
        assert JobStep.objects.get(pk=step.id).output_ref is None
        assert not AuditEvent.objects.filter(
            job_id=job_id, action="job.step_succeeded", metadata__seq=3
        ).exists()
    finally:
        queue.release_live_locks(claim=newer)


def test_class_c_claim_preserves_raw_nonblank_proof_with_all_whitespace_surrounds():
    from apps.jobs._runner import _acknowledge_completed_dispatch

    job_id, claim, dispatch_id = started(seq=3)
    proof = EVIDENCE_WHITESPACE + "object://synthetic/raw-proof" + EVIDENCE_WHITESPACE[::-1]
    assert queue.close_dispatch(
        claim=claim, dispatch_id=dispatch_id, outcome="completed", evidence_ref=proof
    )
    original = dispatches(job_id)[-1]
    queue.release_live_locks(claim=claim)
    expire_lease(job_id)
    queue.sweep_expired_leases()
    newer = queue.claim_job(runner_id="raw-proof", job_id=job_id)
    assert isinstance(newer, queue.Claim)
    try:
        assert_tuple(job_id, 3, original)
        assert JobStep.objects.get(job_id=job_id, seq=3).output_ref == proof
        assert _acknowledge_completed_dispatch(
            claim=newer,
            seq=3,
            dispatch_id=dispatch_id,
            operation_ref="synthetic-completion",
            evidence_ref=proof,
        )
        assert_tuple(job_id, 3, original)
    finally:
        queue.release_live_locks(claim=newer)


def started(kind="backup", seq=1):
    job_id = enqueue(kind)
    claim = queue.claim_job(runner_id="completion-first", job_id=job_id)
    assert isinstance(claim, queue.Claim)
    for earlier in range(1, seq):
        assert queue.record_step(claim=claim, seq=earlier, status="running")
        assert queue.record_step(claim=claim, seq=earlier, status="succeeded")
    assert queue.record_step(claim=claim, seq=seq, status="running")
    dispatch_id = queue.record_dispatch(claim=claim, seq=seq, operation_ref="synthetic-completion")
    assert dispatch_id is not None
    return job_id, claim, dispatch_id


@pytest.mark.parametrize(
    "kind,seq", [("backup", 1), ("backup", 3), ("provision", 5), ("provision", 12)]
)
def test_legacy_completion_preserves_claim_boundary_and_recovers_proof(kind, seq):
    from apps.jobs._runner import _acknowledge_completed_dispatch

    job_id, claim, dispatch_id = started(kind, seq)
    proof = "object://synthetic/retained"
    assert queue.close_dispatch(
        claim=claim, dispatch_id=dispatch_id, outcome="completed", evidence_ref=proof
    )
    original = dispatches(job_id)[-1]
    queue.release_live_locks(claim=claim)
    expire_lease(job_id)
    queue.sweep_expired_leases()
    newer = queue.claim_job(runner_id="completion-new", job_id=job_id)
    assert isinstance(newer, queue.Claim) and newer.fence > claim.fence
    try:
        assert steps(job_id)[seq - 1] == (
            "succeeded" if seq == 3 and kind == "backup" else "pending"
        )
        assert _acknowledge_completed_dispatch(
            claim=newer,
            seq=seq,
            dispatch_id=dispatch_id,
            operation_ref="synthetic-completion",
            evidence_ref=proof,
        )
        assert JobStep.objects.get(job_id=job_id, seq=seq).output_ref == proof
        assert dispatches(job_id)[-1] == original
    finally:
        queue.release_live_locks(claim=newer)


def test_atomic_ack_rolls_back_closed_dispatch_when_step_audit_fails():
    from apps.jobs._runner import _acknowledge_completed_dispatch

    job_id, claim, dispatch_id = started()
    try:
        with patch("apps.jobs._runner._event", side_effect=RuntimeError("audit refused")):
            with pytest.raises(RuntimeError, match="audit refused"):
                _acknowledge_completed_dispatch(
                    claim=claim,
                    seq=1,
                    dispatch_id=dispatch_id,
                    operation_ref="synthetic-completion",
                    evidence_ref="object://synthetic/live",
                )
        assert dispatches(job_id)[-1]["closed_at"] is None
        step = JobStep.objects.get(job_id=job_id, seq=1)
        assert step.status == "running" and step.output_ref is None
    finally:
        queue.release_live_locks(claim=claim)


def wait_until(check):
    deadline = time.monotonic() + 30
    while not check():
        assert time.monotonic() < deadline, "completion barrier was not reached"
        time.sleep(0.05)


def marker(control):
    path = control / "completion-marker.json"
    wait_until(path.exists)
    return json.loads(path.read_text())


def assert_tuple(job_id, seq, original):
    step = JobStep.objects.get(job_id=job_id, seq=seq)
    assert step.status == "succeeded", "retained completion did not converge"
    assert step.output_ref == original["terminal_evidence_ref"]
    assert step.error_code is None
    event = AuditEvent.objects.get(job_id=job_id, action="job.step_succeeded", metadata__seq=seq)
    assert event.metadata == {"seq": seq, "step_id": str(step.id), "output_ref": step.output_ref}
    assert [row for row in dispatches(job_id) if row["seq"] == seq] == [original]


@pytest.mark.parametrize(
    "kind,seq", [("backup", 1), ("backup", 3), ("provision", 5), ("provision", 12)]
)
@pytest.mark.parametrize("second_death", [False, True])
def test_legacy_completed_dispatch_survives_two_worker_deaths(
    tmp_path: Path, kind, seq, second_death
):
    control = Control(tmp_path)
    with short_directory("completion") as root:
        job_id = enqueue(kind)
        first = WorkerProcess(
            database=database_name(),
            control=tmp_path,
            job_root=root,
            completion_mode="legacy",
            completion_seq=seq,
        )
        try:
            old = first.wait_for(lambda e: e["event"] == "claimed")
            assert marker(tmp_path)["phase"] == "legacy"
            original = [row for row in dispatches(job_id) if row["seq"] == seq][0]
            assert original["terminal_outcome"] == "completed" and original["closed_at"]
            assert steps(job_id)[seq - 1] == "running"
            assert not AuditEvent.objects.filter(
                job_id=job_id, action="job.step_succeeded", metadata__seq=seq
            ).exists()
            assert any(
                e["dispatch_id"] == str(original["id"])
                and e["reason"] == "authenticated terminal proof"
                for e in first.events("settled")
            )
        finally:
            first.kill()
        assert advisory_locks_once_exited(int(old["backend_pid"])) == 0
        credentials_before = len((tmp_path / "credentials.jsonl").read_text().splitlines())
        expire_lease(job_id)
        queue.sweep_expired_leases()
        assert steps(job_id)[seq - 1] == "pending"
        if second_death:
            if kind == "backup" and seq == 3:
                control.arm("worker:after-completion-claim-projection", "kill")
            else:
                control.arm("worker:after-completed-ack", "kill")
        second = WorkerProcess(
            database=database_name(),
            control=tmp_path,
            job_root=root,
            completion_mode="normal",
            completion_seq=seq,
        )
        try:
            newer = second.wait_for(lambda e: e["event"] == "claimed")
            assert newer["fence"] > old["fence"]
            if second_death:
                point = (
                    "worker:after-completion-claim-projection"
                    if kind == "backup" and seq == 3
                    else "worker:after-completed-ack"
                )
                wait_until(lambda: control.reached(point))
                assert_tuple(job_id, seq, original)
                assert all(status == "pending" for status in steps(job_id)[seq:])
                assert (
                    len((tmp_path / "credentials.jsonl").read_text().splitlines())
                    == credentials_before
                )
            else:
                assert second.ended(job_id) == "succeeded"
        finally:
            second.kill()
        if second_death:
            expire_lease(job_id)
            (tmp_path / "armed.json").write_text("[]")
            third = WorkerProcess(
                database=database_name(),
                control=tmp_path,
                job_root=root,
                completion_mode="normal",
                completion_seq=seq,
            )
            try:
                final = third.wait_for(lambda e: e["event"] == "claimed")
                assert final["fence"] > newer["fence"]
                assert third.ended(job_id) == "succeeded"
            finally:
                third.kill()
        assert_tuple(job_id, seq, original)
        assert job(job_id)["status"] == "succeeded" and open_reservations(job_id) == 0
        assert (
            len(
                [
                    row
                    for row in control.ledger()
                    if row["step"] == JobStep.objects.get(job_id=job_id, seq=seq).name
                ]
            )
            == 1
        )


def test_sigkill_inside_atomic_ack_leaves_open_dispatch_and_reservation(tmp_path: Path):
    control = Control(tmp_path)
    control.arm("worker:inside-completed-ack-before-step", "kill")
    with short_directory("ack-rollback") as root:
        job_id = enqueue()
        worker = WorkerProcess(database=database_name(), control=tmp_path, job_root=root)
        try:
            claimed = worker.wait_for(lambda e: e["event"] == "claimed")
            wait_until(lambda: control.reached("worker:inside-completed-ack-before-step"))
            # Independent observer cannot see the uncommitted close, step or audit.
            assert dispatches(job_id)[0]["closed_at"] is None
            assert steps(job_id)[0] == "running"
            assert not AuditEvent.objects.filter(
                job_id=job_id, action="job.step_succeeded"
            ).exists()
        finally:
            worker.kill()
        assert advisory_locks_once_exited(int(claimed["backend_pid"])) == 0
        expire_lease(job_id)
        queue.sweep_expired_leases()
        assert job(job_id)["status"] == "needs_reconciliation"
        assert open_reservations(job_id) > 0
        assert len(control.ledger()) == 1


@pytest.mark.parametrize("claim_loss", [False, True])
def test_physical_commit_survives_lost_acknowledgement(tmp_path: Path, claim_loss):
    control = Control(tmp_path)
    seq = 3 if claim_loss else 1
    with short_directory("commit-loss") as root:
        job_id = enqueue()
        if claim_loss:
            first = WorkerProcess(
                database=database_name(),
                control=tmp_path,
                job_root=root,
                completion_mode="legacy",
                completion_seq=seq,
            )
            try:
                marker(tmp_path)
            finally:
                first.kill()
            expire_lease(job_id)
            (tmp_path / "completion-marker.json").unlink()
        worker = WorkerProcess(
            database=database_name(),
            control=tmp_path,
            job_root=root,
            completion_mode="claim-commit-loss" if claim_loss else "commit-loss",
            completion_seq=seq,
        )
        try:
            assert marker(tmp_path)["phase"] == (
                "committed-claim-lost" if claim_loss else "committed-ack-lost"
            )
            original = [row for row in dispatches(job_id) if row["seq"] == seq][0]
            assert_tuple(job_id, seq, original)
            fence = job(job_id)["fence"]
            if claim_loss:
                assert fence > original["fence"]
            else:
                assert fence == original["fence"]
            assert steps(job_id)[seq:] == ["pending"] * (4 - seq)
        finally:
            worker.kill()
        expire_lease(job_id)
        final = WorkerProcess(database=database_name(), control=tmp_path, job_root=root)
        try:
            assert final.ended(job_id) == "succeeded"
            assert job(job_id)["fence"] > fence
        finally:
            final.kill()
        assert_tuple(job_id, seq, original)
        assert (
            len(
                [
                    row
                    for row in control.ledger()
                    if row["step"] == JobStep.objects.get(job_id=job_id, seq=seq).name
                ]
            )
            == 1
        )
        assert open_reservations(job_id) == 0


def test_owned_completion_recovery_removal_fails_convergence(tmp_path: Path):
    control = Control(tmp_path)
    with short_directory("completion-mutant") as root:
        job_id = enqueue()
        first = WorkerProcess(
            database=database_name(), control=tmp_path, job_root=root, completion_mode="legacy"
        )
        try:
            marker(tmp_path)
            original = dispatches(job_id)[0]
        finally:
            first.kill()
        expire_lease(job_id)
        mutant = WorkerProcess(
            database=database_name(),
            control=tmp_path,
            job_root=root,
            completion_mode="skip-recovery",
        )
        try:
            # Class A can replay when recovery is removed: the convergence owner must catch
            # the extra provider operation/dispatch, rather than accepting a green final status.
            mutant.ended(job_id)
            with pytest.raises(AssertionError):
                assert_tuple(job_id, 1, original)
            assert len([row for row in control.ledger() if row["step"] == "quiesce"]) == 2
        finally:
            mutant.kill()


def test_live_ack_is_idempotent_and_clears_error_without_rewriting_dispatch():
    from apps.jobs._runner import _acknowledge_completed_dispatch as ack

    job_id, claim, dispatch_id = started()
    fields = dict(
        claim=claim,
        seq=1,
        dispatch_id=dispatch_id,
        operation_ref="synthetic-completion",
        evidence_ref="object://synthetic/live",
    )
    try:
        JobStep.objects.filter(job_id=job_id, seq=1).update(error_code="step_failed")
        assert ack(**fields)
        original = dispatches(job_id)[0]
        assert_tuple(job_id, 1, original)
        assert ack(**fields)
        assert not ack(**{**fields, "evidence_ref": "object://synthetic/conflict"})
        assert_tuple(job_id, 1, original)
    finally:
        queue.release_live_locks(claim=claim)


@pytest.mark.parametrize("wrong", ["fence", "expired", "seq", "dispatch", "operation", "blank"])
def test_refused_live_ack_leaves_every_queue_row_unchanged(wrong):
    from dataclasses import replace
    from uuid import uuid4

    from apps.jobs._runner import _acknowledge_completed_dispatch as ack

    job_id, claim, dispatch_id = started()
    fields = dict(
        claim=claim,
        seq=1,
        dispatch_id=dispatch_id,
        operation_ref="synthetic-completion",
        evidence_ref="object://synthetic/live",
    )
    if wrong == "fence":
        fields["claim"] = replace(claim, fence=claim.fence + 1)
    if wrong == "expired":
        expire_lease(job_id)
    if wrong == "seq":
        fields["seq"] = 2
    if wrong == "dispatch":
        fields["dispatch_id"] = uuid4()
    if wrong == "operation":
        fields["operation_ref"] = "different"
    if wrong == "blank":
        fields["evidence_ref"] = " \t\n"
    before = dispatches(job_id)
    try:
        assert not ack(**fields)
        assert dispatches(job_id) == before
        assert steps(job_id)[0] == "running"
        assert not AuditEvent.objects.filter(job_id=job_id, action="job.step_succeeded").exists()
    finally:
        queue.release_live_locks(claim=claim)


@pytest.mark.parametrize("outcome", [None, "failed", "no_effect"])
def test_latest_noncompletion_defeats_older_completed_dispatch(outcome):
    from apps.jobs._runner import _acknowledge_completed_dispatch as ack
    from apps.jobs.runner_selectors import completion_read

    job_id, claim, old = started()
    try:
        assert queue.close_dispatch(
            claim=claim, dispatch_id=old, outcome="completed", evidence_ref="object://synthetic/old"
        )
        latest = queue.record_dispatch(claim=claim, seq=1, operation_ref="synthetic-newer")
        assert latest is not None
        if outcome:
            assert queue.close_dispatch(
                claim=claim,
                dispatch_id=latest,
                outcome=outcome,
                evidence_ref="object://synthetic/newer",
            )
        assert completion_read(job_id, 1).kind == "not_completed"
        assert not ack(
            claim=claim,
            seq=1,
            dispatch_id=old,
            operation_ref="synthetic-completion",
            evidence_ref="object://synthetic/old",
        )
        assert steps(job_id)[0] == "running"
    finally:
        queue.release_live_locks(claim=claim)


@pytest.mark.parametrize("last", [False, True])
def test_live_child_reports_to_stopped_parent_but_cannot_start_another_effect(last):
    from apps.jobs._runner import _acknowledge_completed_dispatch as ack, _start_sub_job
    from apps.jobs.kinds import KINDS, SubJobRelation

    job_id = enqueue()
    parent = queue.claim_job(runner_id="parent-report", job_id=job_id)
    assert isinstance(parent, queue.Claim)
    for prior in (1, 2):
        assert queue.record_step(claim=parent, seq=prior, status="running")
        assert queue.record_step(claim=parent, seq=prior, status="succeeded")
    assert queue.record_step(claim=parent, seq=3, status="running")
    child_id = _start_sub_job(
        claim=parent,
        seq=3,
        kind="export",
        desired_spec_hash="0" * 64,
        allowed_relations=frozenset({SubJobRelation("backup", "record", "export")}),
    )
    assert child_id is not None
    child = queue.claim_job(runner_id="child-report", job_id=child_id)
    assert isinstance(child, queue.Claim)
    seq = len(KINDS["export"].steps) if last else 1
    try:
        for prior in range(1, seq):
            assert queue.record_step(claim=child, seq=prior, status="running")
            assert queue.record_step(claim=child, seq=prior, status="succeeded")
        assert queue.record_step(claim=child, seq=seq, status="running")
        direct = queue.record_dispatch(claim=child, seq=seq, operation_ref="child-report")
        assert direct is not None
        parent_dispatch = dispatches(job_id)[-1]["id"]
        assert queue.hold_for_reconciliation(claim=parent, dispatch_id=parent_dispatch)
        assert ack(
            claim=child,
            seq=seq,
            dispatch_id=direct,
            operation_ref="child-report",
            evidence_ref="object://synthetic/child",
        )
        if last:
            assert queue.finish_job(claim=child, status="succeeded")
        else:
            assert not queue.record_step(claim=child, seq=seq + 1, status="running")
    finally:
        queue.release_live_locks(claim=child)
        queue.release_live_locks(claim=parent)


def test_class_c_claim_keeps_completed_subjob_proof_but_direct_ack_refuses_it():
    from apps.jobs._runner import _acknowledge_completed_dispatch as ack, _start_sub_job
    from apps.jobs.kinds import KINDS, SubJobRelation

    job_id = enqueue()
    parent = queue.claim_job(runner_id="parent", job_id=job_id)
    assert isinstance(parent, queue.Claim)
    for seq in (1, 2):
        assert queue.record_step(claim=parent, seq=seq, status="running")
        assert queue.record_step(claim=parent, seq=seq, status="succeeded")
    assert queue.record_step(claim=parent, seq=3, status="running")
    child_id = _start_sub_job(
        claim=parent,
        seq=3,
        kind="export",
        desired_spec_hash="0" * 64,
        allowed_relations=frozenset({SubJobRelation("backup", "record", "export")}),
    )
    assert child_id is not None
    child = queue.claim_job(runner_id="child", job_id=child_id)
    assert isinstance(child, queue.Claim)
    try:
        for seq in range(1, len(KINDS["export"].steps) + 1):
            assert queue.record_step(claim=child, seq=seq, status="running")
            assert queue.record_step(claim=child, seq=seq, status="succeeded")
        assert queue.finish_job(claim=child, status="succeeded")
        original = dispatches(job_id)[-1]
        assert not ack(
            claim=parent,
            seq=3,
            dispatch_id=original["id"],
            operation_ref=original["operation_ref"],
            evidence_ref=original["terminal_evidence_ref"],
        )
    finally:
        queue.release_live_locks(claim=child)
        queue.release_live_locks(claim=parent)
    expire_lease(job_id)
    queue.sweep_expired_leases()
    newer = queue.claim_job(runner_id="retained-subjob", job_id=job_id)
    assert isinstance(newer, queue.Claim)
    try:
        assert_tuple(job_id, 3, original)
    finally:
        queue.release_live_locks(claim=newer)


def test_completion_reader_and_writer_reject_old_resolution_cycle(settings):
    from django.utils import timezone

    from apps.identity.command_principal import staff_principal_for_command
    from apps.identity.models import Identity, StaffRole, User
    from apps.jobs._runner import _acknowledge_completed_dispatch as ack, _start_sub_job
    from apps.jobs.kinds import SubJobRelation
    from apps.jobs.runner_selectors import completion_read

    settings.KODERA_STAFF_ISSUER = "https://staff.test/realms/kodera-staff"
    person = User.objects.create(email="completion-operator@staff.test", enabled=True)
    identity = Identity.objects.create(
        user=person,
        issuer=settings.KODERA_STAFF_ISSUER,
        realm="kodera-staff",
        subject="completion-operator",
        email=person.email,
        enabled=True,
    )
    StaffRole.objects.create(identity=identity, realm="kodera-staff", role="staff_operator")
    job_id = enqueue()
    claim = queue.claim_job(runner_id="before-resume", job_id=job_id)
    assert isinstance(claim, queue.Claim)
    for seq in (1, 2):
        assert queue.record_step(claim=claim, seq=seq, status="running")
        assert queue.record_step(claim=claim, seq=seq, status="succeeded")
    assert queue.record_step(claim=claim, seq=3, status="running")
    child_id = _start_sub_job(
        claim=claim,
        seq=3,
        kind="export",
        desired_spec_hash="0" * 64,
        allowed_relations=frozenset({SubJobRelation("backup", "record", "export")}),
    )
    assert child_id is not None
    dispatch = dispatches(job_id)[-1]
    child = queue.claim_job(runner_id="child", job_id=child_id)
    assert isinstance(child, queue.Claim)
    from apps.jobs.kinds import KINDS

    for seq in range(1, len(KINDS["export"].steps) + 1):
        assert queue.record_step(claim=child, seq=seq, status="running")
        assert queue.record_step(claim=child, seq=seq, status="succeeded")
    assert queue.hold_for_reconciliation(claim=claim, dispatch_id=dispatch["id"])
    queue.release_live_locks(claim=claim)
    assert queue.finish_job(claim=child, status="succeeded")
    evidence = queue.Evidence("synthetic", "gone", "read", timezone.now())
    assert isinstance(
        queue.record_reconciliation_decision(
            principal=staff_principal_for_command(identity.id),
            decision=queue.ReconciliationDecision(
                job_id, "resume", "no_effect", evidence, evidence
            ),
        ),
        queue.DecisionRecorded,
    )
    newer = queue.claim_job(runner_id="new-cycle", job_id=job_id)
    assert isinstance(newer, queue.Claim)
    try:
        assert completion_read(job_id, 3).kind == "absent"
        assert not ack(
            claim=newer,
            seq=3,
            dispatch_id=dispatch["id"],
            operation_ref=dispatch["operation_ref"],
            evidence_ref="object://synthetic/old",
        )
        assert steps(job_id)[2] == "pending"
    finally:
        queue.release_live_locks(claim=newer)


def test_ack_rechecks_database_clock_after_unchanged_row_lock_wait_and_sweep():
    from concurrent.futures import ThreadPoolExecutor
    from queue import Queue

    from django.db import connection, connections, transaction

    from apps.jobs._runner import _acknowledge_completed_dispatch as ack

    job_id, claim, dispatch_id = started()
    pid_queue = Queue()

    def acknowledge():
        try:
            with connections["default"].cursor() as cursor:
                cursor.execute("SELECT pg_backend_pid()")
                pid_queue.put(cursor.fetchone()[0])
            return ack(
                claim=claim,
                seq=1,
                dispatch_id=dispatch_id,
                operation_ref="synthetic-completion",
                evidence_ref="object://synthetic/late",
            )
        finally:
            connections["default"].close()

    def sweep():
        try:
            queue.sweep_expired_leases()
        finally:
            connections["default"].close()

    def query(statement, parameters):
        with connection.cursor() as cursor:
            cursor.execute(statement, parameters)
            return cursor.fetchone()[0]

    try:
        # Give the writer enough time to evaluate a live predicate, then hold its unchanged
        # row past expiry. PostgreSQL need not re-evaluate that predicate on unchanged release.
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE jobs_job SET lease_expires_at = clock_timestamp() + interval '1 second' WHERE id = %s",
                [job_id],
            )
        with ThreadPoolExecutor(max_workers=2) as pool:
            with transaction.atomic():
                query("SELECT id FROM jobs_job WHERE id = %s FOR NO KEY UPDATE", [job_id])
                future = pool.submit(acknowledge)
                pid = pid_queue.get(timeout=5)
                wait_until(lambda: query("SELECT cardinality(pg_blocking_pids(%s)) > 0", [pid]))
                wait_until(
                    lambda: query(
                        "SELECT lease_expires_at < clock_timestamp() FROM jobs_job WHERE id = %s",
                        [job_id],
                    )
                )
                pool.submit(sweep).result(timeout=5)  # SKIP LOCKED cannot steal the held row.
            assert future.result(timeout=5) is False
        assert dispatches(job_id)[0]["closed_at"] is None
        assert steps(job_id)[0] == "running"
        assert not AuditEvent.objects.filter(job_id=job_id, action="job.step_succeeded").exists()
        queue.sweep_expired_leases()
        assert job(job_id)["status"] == "needs_reconciliation"
        assert open_reservations(job_id) > 0
    finally:
        queue.release_live_locks(claim=claim)
