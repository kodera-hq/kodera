"""Completion regressions that run without a database or a provider process."""

import re
from contextlib import nullcontext
from dataclasses import replace
from datetime import UTC, datetime
from unittest.mock import Mock, patch
from uuid import uuid4

import pytest

from apps.jobs import _claim, _runner, sql
from apps.jobs.runner_selectors import CompletionRead, CompletionRow, classify_completion
from apps.jobs.types import Claim
from worker.registry import JobContext
from worker.runner import Runner

# Independent contract, not imported from the implementation: exactly Python's whitespace class.
WHITESPACE_POINTS = (
    *range(0x09, 0x0E),
    *range(0x1C, 0x20),
    0x20,
    0x85,
    0xA0,
    0x1680,
    *range(0x2000, 0x200B),
    0x2028,
    0x2029,
    0x202F,
    0x205F,
    0x3000,
)
WHITESPACE = "".join(map(chr, WHITESPACE_POINTS))


def claim_evidence_trim_characters():
    job = _claim._Row(uuid4(), "orphaned", True, None, None, None, "backup", uuid4(), uuid4(), 1)
    cursor = Mock()
    cursor.fetchall.return_value = []
    with patch.object(_claim, "connection") as connection:
        connection.cursor.return_value.__enter__.return_value = cursor
        _claim._complete_class_c(job)
    statement, parameters = cursor.execute.call_args.args
    argument = re.search(
        r"btrim\(latest\.terminal_evidence_ref,\s*(E'([^']*)'|%\(evidence_whitespace\)s)\)",
        statement,
    )
    assert argument is not None, "claim has no exact evidence trim predicate"
    if argument[2] is not None:
        # Preserve the predecessor's actual literal btrim semantics as a named red/mutant,
        # rather than failing because the new shared constant or binding does not exist.
        return argument[2].encode("ascii").decode("unicode_escape")
    return parameters["evidence_whitespace"]


@pytest.mark.parametrize("point", WHITESPACE_POINTS, ids=lambda point: f"U{point:04X}")
def test_claim_nonblank_contract_matches_python_for_every_whitespace(point):
    proof = chr(point) * 2
    assert not proof.strip()
    assert not proof.strip(claim_evidence_trim_characters()), "claim admitted whitespace-only proof"
    job_id = uuid4()
    row = replace(retained_row(job_id), evidence_ref=proof)
    assert classify_completion(job_id, row).kind == "ineligible"
    with (
        patch.object(_runner, "require_no_transaction"),
        patch.object(
            _runner, "queue_atomic", side_effect=AssertionError("blank proof reached transaction")
        ),
    ):
        assert not _runner._acknowledge_completed_dispatch(
            claim=Claim(job_id, 1, "blank-proof"),
            seq=3,
            dispatch_id=row.dispatch_id,
            operation_ref=row.operation_ref,
            evidence_ref=proof,
        )


def test_claim_nonblank_full_class_and_raw_surrounding_proof_controls():
    trim = claim_evidence_trim_characters()
    assert not WHITESPACE.strip(trim), "claim admitted full whitespace class"
    raw = WHITESPACE + "object://synthetic/raw-proof" + WHITESPACE[::-1]
    job_id = uuid4()
    row = replace(retained_row(job_id), evidence_ref=raw)
    assert raw.strip(trim) == raw.strip() == "object://synthetic/raw-proof"
    assert classify_completion(job_id, row).row.evidence_ref == raw


def test_shared_evidence_whitespace_is_exact_python_strip_contract():
    assert tuple(point for point in range(0x110000) if not chr(point).strip()) == WHITESPACE_POINTS
    assert sql.EVIDENCE_WHITESPACE == WHITESPACE
    assert claim_evidence_trim_characters() == WHITESPACE


@pytest.mark.parametrize(
    "point", [0x0B, 0xA0, 0x1C, 0x2003], ids=["VT", "NBSP", "U001C", "EMSPACE"]
)
def test_narrowed_sql_trim_mutation_fails_nonblank_owner_with_raw_positive(point):
    statement = sql.COMPLETE_CLASS_C
    assert statement.count("%(evidence_whitespace)s") == 1
    narrowed = statement.replace("%(evidence_whitespace)s", "E' \\t\\n\\r\\f'")
    with patch.object(sql, "COMPLETE_CLASS_C", narrowed):
        with pytest.raises(AssertionError, match="claim admitted whitespace-only proof"):
            test_claim_nonblank_contract_matches_python_for_every_whitespace(point)
        raw = WHITESPACE + "object://synthetic/raw-proof" + WHITESPACE[::-1]
        assert raw.strip(claim_evidence_trim_characters())
        job_id = uuid4()
        assert (
            classify_completion(
                job_id, replace(retained_row(job_id), evidence_ref=raw)
            ).row.evidence_ref
            == raw
        )
    test_claim_nonblank_contract_matches_python_for_every_whitespace(point)


def test_claim_completion_copies_retained_proof_before_success_audit() -> None:
    job = _claim._Row(uuid4(), "orphaned", True, None, None, None, "backup", uuid4(), uuid4(), 1)
    cursor = Mock()
    cursor.fetchall.return_value = []
    with patch.object(_claim, "connection") as connection:
        connection.cursor.return_value.__enter__.return_value = cursor
        _claim._complete_class_c(job)
    statement = cursor.execute.call_args.args[0]
    assert "output_ref = recoverable.terminal_evidence_ref" in statement
    assert "error_code = NULL" in statement
    assert "closed_at IS NOT NULL" in statement
    assert "btrim" in statement
    assert "st.retry_class = 'C'" in statement
    assert "max(r.decided_at)" in statement
    assert statement.index("LIMIT 1") < statement.index("terminal_outcome = 'completed'")
    assert "sub_job_id IS NULL" not in statement


def test_retained_completion_never_reaches_running_or_provider() -> None:
    check_retained_completion("completed")


def check_retained_completion(kind):
    claim = Claim(job_id=uuid4(), fence=2, runner_id="completion")
    job = JobContext(claim.job_id, "backup", uuid4(), uuid4())
    runner = object.__new__(Runner)
    runner.registry = Mock()
    runner.emit = Mock()
    lease = Mock()
    lease.is_lost.return_value = False
    retained = Mock(kind=kind, row=Mock(), reason=None)
    # This seam supplies the retained row even on the old runner: the red is an actual call to
    # running/provider rather than a missing import or new private writer.
    with (
        patch(
            "apps.jobs.runner_selectors.step_statuses",
            return_value={1: "pending", 2: "succeeded", 3: "succeeded", 4: "succeeded"},
        ),
        patch("apps.jobs.runner_selectors.completion_read", return_value=retained, create=True),
        patch("apps.jobs._runner._acknowledge_completed_dispatch", return_value=True, create=True),
        patch(
            "apps.jobs._runner.record_step",
            side_effect=AssertionError("retained completion started an effect"),
        ),
        patch("apps.jobs._runner.finish_job", return_value=True),
    ):
        assert runner._steps(claim, job, Mock(), lease) == "succeeded"
    runner.registry.plan.assert_not_called()


def retained_row(job_id):
    step_id = uuid4()
    return CompletionRow(
        step_id,
        "pending",
        None,
        "step_failed",
        uuid4(),
        job_id,
        step_id,
        1,
        "synthetic-operation",
        None,
        datetime.now(UTC),
        "completed",
        "object://synthetic/proof",
    )


@pytest.mark.parametrize(
    "changes,expected",
    [
        ({}, "completed"),
        ({"dispatch_id": None}, "absent"),
        ({"closed_at": None, "outcome": None, "evidence_ref": None}, "not_completed"),
        ({"outcome": "failed"}, "not_completed"),
        ({"outcome": "no_effect"}, "not_completed"),
        ({"job_id": uuid4()}, "ineligible"),
        ({"dispatch_step_id": uuid4()}, "ineligible"),
        ({"sub_job_id": uuid4()}, "ineligible"),
        ({"evidence_ref": None}, "ineligible"),
        ({"evidence_ref": " \t\n"}, "ineligible"),
        ({"outcome": None}, "ineligible"),
        ({"closed_at": None}, "ineligible"),
    ],
)
def test_latest_row_classifier_never_hides_bad_completion(changes, expected):
    job_id = uuid4()
    assert classify_completion(job_id, replace(retained_row(job_id), **changes)).kind == expected
    assert classify_completion(job_id, None).kind == "ineligible"


@pytest.mark.parametrize(
    "changes,accepted,writes",
    [
        ({}, True, 1),
        ({"status": "running"}, True, 1),
        (
            {"status": "succeeded", "output_ref": "object://synthetic/proof", "error_code": None},
            True,
            0,
        ),
        ({"status": "succeeded"}, False, 0),
        ({"status": "failed"}, False, 0),
        ({"status": "skipped"}, False, 0),
        ({"status": "compensated"}, False, 0),
        ({"evidence_ref": "object://different"}, False, 0),
        ({"dispatch_id": uuid4()}, False, 0),
        ({"operation_ref": "different"}, False, 0),
        (
            {
                "closed_at": None,
                "outcome": None,
                "evidence_ref": None,
                "status": "running",
                "fence": 2,
            },
            True,
            1,
        ),
        ({"closed_at": None, "outcome": None, "evidence_ref": None, "status": "running"}, False, 0),
    ],
)
def test_ack_rechecks_identity_status_evidence_and_live_author_fence(changes, accepted, writes):
    claim = Claim(uuid4(), 2, "new-owner")
    original = retained_row(claim.job_id)
    row = replace(original, **changes)
    with (
        patch.object(_runner, "require_no_transaction"),
        patch.object(_runner, "queue_atomic", return_value=nullcontext()),
        patch.object(_runner, "_owned", return_value=Mock(id=claim.job_id)) as own,
        patch(
            "apps.jobs.runner_selectors.completion_read",
            return_value=classify_completion(claim.job_id, row),
        ),
        patch.object(_runner, "_one", return_value=(original.dispatch_id,)) as close,
        patch.object(_runner, "_end_step") as end,
    ):
        assert (
            _runner._acknowledge_completed_dispatch(
                claim=claim,
                seq=1,
                dispatch_id=original.dispatch_id,
                operation_ref=original.operation_ref,
                evidence_ref=original.evidence_ref,
            )
            is accepted
        )
    own.assert_called_once_with(claim, writer="completed_ack")
    assert end.call_count == writes
    if writes:
        assert end.call_args.args[3:] == ("succeeded", None, original.evidence_ref)
    assert close.call_count == int(accepted and row.closed_at is None)


def test_completed_ack_report_authority_has_fixed_guards_and_no_parent_requirement():
    assert _runner._row_lock("completed_ack") == sql.NO_KEY_UPDATE
    assert _runner._lock_condition("completed_ack") == _runner._LockCondition(True, True, True)
    assert not _runner._needs_parent("completed_ack", False)


@pytest.mark.parametrize("kind,owned", [("ineligible", True), ("completed", False)])
def test_ambiguous_or_changed_completion_refuses_without_fallback(kind, owned):
    claim = Claim(uuid4(), 2, "new-owner")
    runner = object.__new__(Runner)
    runner.registry = Mock()
    runner.emit = Mock()
    lease = Mock()
    lease.is_lost.return_value = False
    row = retained_row(claim.job_id)
    with (
        patch("apps.jobs.runner_selectors.step_statuses", return_value={1: "pending"}),
        patch(
            "apps.jobs.runner_selectors.completion_read",
            return_value=CompletionRead(kind, row, "test"),
        ),
        patch.object(_runner, "_acknowledge_completed_dispatch", return_value=owned),
        patch.object(_runner, "record_step") as start,
        patch.object(runner, "_step") as provider,
    ):
        assert (
            runner._steps(
                claim, JobContext(claim.job_id, "backup", uuid4(), uuid4()), Mock(), lease
            )
            == "refused"
        )
    start.assert_not_called()
    provider.assert_not_called()
    runner.registry.plan.assert_not_called()


def test_latest_current_cycle_query_does_not_filter_completion_before_limit():
    statement = sql.COMPLETION_READ.format(cycle=sql.CYCLE.format(bound="max"))
    assert "LEFT JOIN LATERAL" in statement
    assert "ORDER BY d.dispatched_at DESC, d.id DESC LIMIT 1" in statement
    assert "d.dispatched_at > COALESCE" in statement
    assert "max(r.decided_at)" in statement and "r.unresolved_step_id = st.id" in statement
    assert "terminal_outcome =" not in statement
    assert "d.job_id =" not in statement


def test_completed_ack_owns_first_and_rechecks_lease_before_reading_evidence():
    claim = Claim(uuid4(), 2, "expired-under-lock")
    job = (claim.job_id, uuid4(), uuid4(), "backup", None, claim.fence, "running")
    with (
        patch.object(_runner, "require_no_transaction") as require,
        patch.object(_runner, "queue_atomic", return_value=nullcontext()),
        patch.object(_runner, "_one", side_effect=[job, (False,)]) as read,
        patch("apps.jobs.runner_selectors.completion_read") as candidate,
        patch.object(_runner, "_end_step") as end,
    ):
        assert not _runner._acknowledge_completed_dispatch(
            claim=claim,
            seq=1,
            dispatch_id=uuid4(),
            operation_ref="synthetic",
            evidence_ref="object://synthetic/proof",
        )
    require.assert_called_once_with("completed_ack", allowed=False)
    assert read.call_count == 2
    own, recheck = [call.args[0] for call in read.call_args_list]
    assert "fence = %(fence)s" in own
    assert "lease_expires_at > clock_timestamp()" in own
    assert "FOR NO KEY UPDATE" in own
    assert "clock_timestamp()" in recheck
    candidate.assert_not_called()
    end.assert_not_called()


def test_owned_recovery_removal_counterexample_reaches_forbidden_effect():
    with pytest.raises(AssertionError, match="retained completion started an effect"):
        check_retained_completion("absent")
    check_retained_completion("completed")


@pytest.mark.parametrize(
    "old,new",
    [
        ("output_ref = recoverable.terminal_evidence_ref", "output_ref = st.output_ref"),
        ("error_code = NULL", "error_code = st.error_code"),
        ("latest.closed_at IS NOT NULL", "TRUE"),
        ("btrim", "rtrim"),
        ("{class_c}", ""),
        ("{cycle}", ""),
    ],
)
def test_owned_claim_projection_mutations_fail_their_owner(old, new):
    statement = sql.COMPLETE_CLASS_C
    assert statement.count(old) == 1
    with patch.object(sql, "COMPLETE_CLASS_C", statement.replace(old, new)):
        with pytest.raises(AssertionError):
            test_claim_completion_copies_retained_proof_before_success_audit()
    test_claim_completion_copies_retained_proof_before_success_audit()


def test_owned_after_lock_recheck_removal_fails_its_owner():
    with patch.object(
        _runner, "_lock_condition", return_value=_runner._LockCondition(True, True, False)
    ):
        with pytest.raises(AssertionError):
            test_completed_ack_owns_first_and_rechecks_lease_before_reading_evidence()
    test_completed_ack_owns_first_and_rechecks_lease_before_reading_evidence()
