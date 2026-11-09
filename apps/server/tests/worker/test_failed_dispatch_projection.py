"""Fast regressions for the claim projection and the runner's terminal-step boundary."""

from unittest.mock import Mock, patch
from uuid import uuid4

import pytest

from apps.jobs import _claim, sql
from apps.jobs.types import Claim
from worker.registry import JobContext
from worker.runner import Runner


@pytest.mark.parametrize("owned", [True, False])
def test_recovered_failure_finishes_before_running_or_provider(owned: bool) -> None:
    claim = Claim(job_id=uuid4(), fence=2, runner_id="recovery")
    job = JobContext(claim.job_id, "backup", uuid4(), uuid4())
    runner = object.__new__(Runner)
    runner.registry = Mock()
    lease = Mock()
    lease.is_lost.return_value = False
    with (
        patch(
            "apps.jobs.runner_selectors.step_statuses",
            return_value={1: "succeeded", 2: "succeeded", 3: "failed", 4: "pending"},
        ),
        patch("apps.jobs._runner.record_step") as record,
        patch("apps.jobs._runner.finish_job", return_value=owned) as finish,
        patch.object(
            runner, "_step", side_effect=AssertionError("recovered failure reached provider")
        ) as step,
    ):
        assert runner._steps(claim, job, Mock(), lease) == ("failed" if owned else "refused")
    finish.assert_called_once_with(claim=claim, status="failed", error_code="step_failed")
    record.assert_not_called()
    runner.registry.plan.assert_not_called()
    step.assert_not_called()


def test_lost_lease_cannot_finish_a_recovered_failure() -> None:
    claim = Claim(job_id=uuid4(), fence=2, runner_id="lost")
    runner = object.__new__(Runner)
    lease = Mock()
    lease.is_lost.return_value = True
    with (
        patch("apps.jobs.runner_selectors.step_statuses", return_value={1: "failed"}),
        patch("apps.jobs._runner.finish_job") as finish,
    ):
        assert (
            runner._steps(
                claim, JobContext(claim.job_id, "backup", uuid4(), uuid4()), Mock(), lease
            )
            == "lost"
        )
    finish.assert_not_called()


def test_failed_projection_copies_evidence_and_audits_only_changed_rows() -> None:
    step_id = uuid4()
    job = _claim._Row(uuid4(), "orphaned", True, None, None, None, "backup", uuid4(), uuid4(), 1)
    cursor = Mock()
    cursor.fetchall.side_effect = [[(step_id, 3, "object://synthetic/failure")], []]
    with (
        patch.object(_claim, "connection") as connection,
        patch.object(_claim, "_system_event") as audit,
    ):
        connection.cursor.return_value.__enter__.return_value = cursor
        _claim._recover_failed_class_c(job)
        _claim._recover_failed_class_c(job)
    audit.assert_called_once_with(
        "job.step_failed",
        job,
        {"seq": 3, "step_id": str(step_id), "output_ref": "object://synthetic/failure"},
    )
    statement = cursor.execute.call_args.args[0]
    assert "max(r.decided_at)" in statement
    assert "st.status = 'pending'" in statement
    assert "st.retry_class = 'C'" in statement
    assert "closed_at IS NOT NULL" in statement
    assert "terminal_evidence_ref" in statement
    assert "terminal_outcome = 'failed'" in statement
    # Select latest in the cycle before testing its outcome, never an older failed dispatch.
    assert statement.index("LIMIT 1") < statement.index("terminal_outcome = 'failed'")
    assert "UPDATE jobs_jobdispatch" not in statement
    assert sql.CYCLE_FROM_LATEST == "max"
