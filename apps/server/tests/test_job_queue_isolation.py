"""Actual transaction isolation, refusal order and caller boundaries with intact queue guards."""

from __future__ import annotations

import datetime as dt
import importlib
import re
import types
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from django.db import connection, transaction
from django.db.transaction import TransactionManagementError
from django.utils import timezone
from psycopg import IsolationLevel

from apps.jobs import _claim, _runner, _sweep, services, sql
from apps.jobs.kinds import sub_job_relation
from apps.jobs.models import Job
from apps.outbox.models import OutboxDelivery

pytestmark = pytest.mark.django_db(transaction=True)
LEVELS = ("read uncommitted", "repeatable read", "serializable")
NESTABLE = (
    "enqueue_job",
    "record_reconciliation_decision",
    "record_delivery_reconciliation_decision",
)
RUNNERS = (
    "renew_lease",
    "record_step",
    "record_dispatch",
    "retarget_dispatch",
    "start_sub_job",
    "close_dispatch",
    "hold_for_reconciliation",
    "finish_job",
)
FUNCTIONS = (*NESTABLE, "claim_job", "sweep_expired_leases", *RUNNERS)
TABLES = (
    "jobs_job",
    "jobs_jobstep",
    "jobs_jobdispatch",
    "jobs_joblockreservation",
    "jobs_jobreconciliationdecision",
    "outbox_outboxdelivery",
    "outbox_deliverydecision",
    "audit_auditevent",
    "a3_desired_state_probe",
)


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    monkeypatch.syspath_prepend(str(Path(__file__).parent / "job_queue"))
    harness = importlib.import_module("queue_harness")
    with harness.open_queue_env("real") as env:
        try:
            yield env
        finally:
            if connection.connection is not None:
                connection.rollback()
                connection.set_autocommit(True)
                connection.connection.isolation_level = None
                with connection.cursor() as cursor:
                    cursor.execute("SET default_transaction_isolation = 'read committed'")
                    cursor.execute("SELECT pg_advisory_unlock_all()")


def snapshot(env: Any) -> dict[str, Any]:
    return {
        table: env.observer.value(
            "SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM {s}." + table + " t"  # noqa: S608 - closed table list
        )
        for table in TABLES
    }


def current_level() -> str:
    with connection.cursor() as cursor:
        cursor.execute("SHOW transaction_isolation")
        return str(cursor.fetchone()[0])


@contextmanager
def isolation(level: str, source: str = "session") -> Iterator[None]:
    connection.ensure_connection()
    raw = connection.connection
    previous = raw.isolation_level
    with connection.cursor() as cursor:
        cursor.execute("SHOW default_transaction_isolation")
        default = cursor.fetchone()[0]
    try:
        if source == "driver":
            raw.isolation_level = IsolationLevel[level.upper().replace(" ", "_")]
        else:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT set_config('default_transaction_isolation', %s, false)", [level]
                )
        yield
    finally:
        raw.isolation_level = previous
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT set_config('default_transaction_isolation', %s, false)", [default]
            )


@contextmanager
def trace() -> Iterator[list[str]]:
    statements: list[str] = []

    def capture(execute: Any, sql: str, params: Any, many: bool, context: Any) -> Any:
        statements.append(" ".join(sql.split()))
        return execute(sql, params, many, context)

    with connection.execute_wrapper(capture):
        yield statements


def error_for(name: str, level: str) -> str:
    return f"{name} requires READ COMMITTED (JOB_QUEUE.md §4); actual={level}"


def assert_refused(call: Callable[[], Any], name: str, level: str) -> None:
    try:
        call()
    except TransactionManagementError as error:
        assert str(error) == error_for(name, level), "isolation error identity changed"
    else:
        raise AssertionError("unsupported isolation reached queue work at " + name)


def prepare(env: Any, name: str) -> tuple[Callable[[], Any], dict[str, Any]]:
    """Each operation is otherwise valid and has an intact successful control."""
    binding = importlib.import_module("queue_harness").RealBinding()
    organisation, tenant = env.organisation(), env.tenant()
    request = binding._request(env.request("rotate_secret", organisation, tenant))
    state: dict[str, Any] = {"callback": [], "request": request}

    def callback() -> None:
        state["callback"].append(True)
        importlib.import_module("queue_harness").insert_probe("public", "desired")

    if name == "enqueue_job":
        state["kwargs"] = {"request": request, "apply_desired_state": callback}
    elif name == "record_delivery_reconciliation_decision":
        now = timezone.now()
        delivery = OutboxDelivery.objects.create(
            organisation_id=organisation,
            category="identity_user_operation",
            changes_realm=True,
            status="needs_reconciliation",
            operation_ref="synthetic-op",
            started_at=now,
            created_at=now,
            updated_at=now,
        )
        state["kwargs"] = {
            "principal": binding._principal(env.staff_principal(organisation)),
            "decision": binding._decision(
                env.decision(str(delivery.pk), exit="fail", outcome="no_effect")
            ),
        }
    else:
        if name in ("claim_job", "sweep_expired_leases"):
            request = replace(request, not_before=timezone.now() + dt.timedelta(hours=1))
        job = services.enqueue_job(request=request, apply_desired_state=lambda: None).job_id
        state["job"] = job
        if name in ("claim_job", "sweep_expired_leases"):
            # A scheduled job becomes due without ever clearing its retained place.
            env.observer.make_due(str(job))
            state["kwargs"] = (
                {"runner_id": "isolation", "job_id": job} if name == "claim_job" else {}
            )
        else:
            claim = services.claim_job(runner_id="isolation", job_id=job)
            assert isinstance(claim, services.Claim)
            state["claim"] = claim
            kwargs: dict[str, Any] = {"claim": claim}
            if name not in ("renew_lease", "record_step", "finish_job"):
                assert services.record_step(claim=claim, seq=1, status="running")
            if name in (
                "retarget_dispatch",
                "close_dispatch",
                "hold_for_reconciliation",
                "record_reconciliation_decision",
            ):
                dispatch = services.record_dispatch(
                    claim=claim, seq=1, operation_ref="synthetic-op"
                )
                assert dispatch is not None
                kwargs["dispatch_id"] = dispatch
            if name == "record_step":
                kwargs.update(seq=1, status="running")
            elif name == "record_dispatch":
                kwargs.update(seq=1, operation_ref="new-op")
            elif name == "retarget_dispatch":
                kwargs["operation_ref"] = "replacement-op"
            elif name == "start_sub_job":
                kwargs.update(seq=1, kind="export", desired_spec_hash="a" * 64)
                relation = sub_job_relation(request.kind, kwargs["seq"], kwargs["kind"])
                assert relation is not None
                state["allowed_relations"] = frozenset({relation})
            elif name == "close_dispatch":
                kwargs.update(outcome="completed", evidence_ref="synthetic-proof")
            elif name == "finish_job":
                kwargs.update(status="failed", error_code="step_failed")
            elif name == "record_reconciliation_decision":
                assert dispatch is not None
                assert services.hold_for_reconciliation(claim=claim, dispatch_id=dispatch)
                services.release_live_locks(claim=claim)
                kwargs = {
                    "principal": binding._principal(env.staff_principal(organisation)),
                    "decision": binding._decision(
                        env.decision(str(job), exit="fail", outcome="no_effect")
                    ),
                }
            state["kwargs"] = kwargs
    if name == "start_sub_job":
        return (
            lambda: _runner._start_sub_job(
                **state["kwargs"], allowed_relations=state["allowed_relations"]
            ),
            state,
        )
    return lambda: getattr(services, name)(**state["kwargs"]), state


@pytest.mark.parametrize("name", FUNCTIONS)
@pytest.mark.parametrize("level", LEVELS)
@pytest.mark.parametrize("source", ("session", "driver"))
def test_unsupported_isolation_refuses_before_queue_work(
    world: Any, name: str, level: str, source: str
) -> None:
    call, state = prepare(world, name)
    before = snapshot(world)
    pid = connection.connection.info.backend_pid
    holds = world.observer.advisory_locks(pid)
    with isolation(level, source), trace() as statements:
        assert_refused(call, name, level)
    assert not any(re.search(r"\b(?:jobs_|outbox_|audit_)", sql) for sql in statements), (
        "unsupported isolation reached queue work at " + name
    )
    assert snapshot(world) == before, "isolation refusal changed queue evidence"
    assert state["callback"] == [], "isolation refusal called desired-state callback"
    assert world.observer.advisory_locks(pid) == holds, "isolation refusal acquired live locks"


@pytest.mark.parametrize("name", FUNCTIONS)
def test_read_committed_positive_and_first_queue_statement(world: Any, name: str) -> None:
    call, state = prepare(world, name)
    before = snapshot(world)
    with trace() as statements:
        result = call()
    assert result is not False and (result is not None or name == "sweep_expired_leases")
    assert not isinstance(result, (services.ClaimRefused, services.DecisionRefused))
    assert snapshot(world) != before, "valid operation did not persist its intended change"
    first_queue = next(
        i for i, sql in enumerate(statements) if re.search(r"\b(?:jobs_|outbox_|audit_)", sql)
    )
    assert "SHOW transaction_isolation" in statements[:first_queue], (
        "queue statement preceded isolation preflight"
    )
    if name in RUNNERS:
        assert "FOR NO KEY UPDATE" in statements[first_queue], (
            "runner's first queue statement was not its row lock"
        )
    if name == "enqueue_job":
        assert state["callback"] == [True]


@pytest.mark.parametrize("name", NESTABLE)
@pytest.mark.parametrize("level", LEVELS)
def test_nested_actual_level_and_caller_survives_refusal(world: Any, name: str, level: str) -> None:
    call, _ = prepare(world, name)
    before = snapshot(world)
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL " + level)  # noqa: S608 - closed level list
        assert current_level() == level
        with pytest.raises(TransactionManagementError, match=re.escape(error_for(name, level))):
            call()
        assert current_level() == level, "caller isolation was rewritten"
        importlib.import_module("queue_harness").insert_probe("public", "caller-survives")
    after = snapshot(world)
    assert after.pop("a3_desired_state_probe") == [{"label": "caller-survives"}]
    before.pop("a3_desired_state_probe")
    assert after == before, "refused savepoint changed queue evidence"


@pytest.mark.parametrize("name", NESTABLE)
@pytest.mark.parametrize("commit", (False, True))
def test_nested_rc_uses_actual_level_and_caller_commit(world: Any, name: str, commit: bool) -> None:
    call, _ = prepare(world, name)
    before = snapshot(world)
    with isolation("repeatable read"), transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        result = call()
        assert not isinstance(result, services.DecisionRefused)
        assert current_level() == "read committed"
        assert snapshot(world) == before, "caller transaction boundary changed"
        if not commit:
            transaction.set_rollback(True)
    assert (snapshot(world) != before) is commit, "caller commit/rollback was not respected"


@pytest.mark.parametrize("name", ("claim_job", "sweep_expired_leases"))
def test_invalid_isolation_never_commits_promotion(world: Any, name: str) -> None:
    call, state = prepare(world, name)
    with isolation("repeatable read"):
        with pytest.raises(TransactionManagementError):
            call()
    assert world.observer.job(str(state["job"]))["lock_requested_at"] is None, (
        "isolation refusal committed promotion"
    )


@pytest.mark.parametrize("name", (*RUNNERS, "claim_job", "sweep_expired_leases"))
@pytest.mark.parametrize("mode", ("atomic", "manual"))
def test_forbidden_nesting_still_precedes_all_statements(world: Any, name: str, mode: str) -> None:
    call, _ = prepare(world, name)
    expected = f"{name} must be called with no transaction open (JOB_QUEUE.md §4)"

    def check() -> None:
        with (
            trace() as statements,
            pytest.raises(TransactionManagementError, match=re.escape(expected)),
        ):
            call()
        assert statements == [], "isolation preflight displaced a zero-query programming error"

    if mode == "atomic":
        with transaction.atomic():
            check()
    else:
        connection.set_autocommit(False)
        try:
            check()
        finally:
            connection.rollback()
            connection.set_autocommit(True)


@pytest.mark.parametrize(
    "name",
    ("enqueue_job", "record_step", "finish_job", "close_dispatch", "start_sub_job", *NESTABLE[1:]),
)
def test_invalid_arguments_still_precede_all_statements(world: Any, name: str) -> None:
    call, state = prepare(world, name)
    kwargs = state["kwargs"]
    if name == "enqueue_job":
        kwargs["request"] = replace(kwargs["request"], kind="invalid")
    elif name in NESTABLE[1:]:
        kwargs["decision"] = replace(kwargs["decision"], exit="invalid")
    else:
        kwargs[
            {
                "record_step": "status",
                "finish_job": "status",
                "close_dispatch": "outcome",
                "start_sub_job": "kind",
            }[name]
        ] = "invalid"
    try:
        with isolation("repeatable read"), trace() as statements, pytest.raises(ValueError):
            call()
    except TransactionManagementError as error:
        raise AssertionError(
            "isolation preflight displaced a zero-query programming error"
        ) from error
    assert statements == [], "isolation preflight displaced a zero-query programming error"


def test_cleanup_is_exempt_from_isolation_refusal(world: Any) -> None:
    _, state = prepare(world, "renew_lease")
    pid = connection.connection.info.backend_pid
    assert world.observer.advisory_locks(pid)
    with isolation("serializable"):
        try:
            services.release_live_locks(claim=state["claim"])
        except TransactionManagementError as error:
            raise AssertionError("isolation error prevented cleanup") from error
    assert world.observer.advisory_locks(pid) == set(), "isolation error prevented cleanup"


def test_replacement_connection_checks_its_actual_isolation(world: Any) -> None:
    first, _ = prepare(world, "enqueue_job")
    assert first().created
    connection.close()
    connection.ensure_connection()
    second, _ = prepare(world, "enqueue_job")
    with isolation("serializable", "driver"):
        with pytest.raises(TransactionManagementError, match="actual=serializable"):
            second()
    assert second().created


LATER_BOUNDARIES = (
    "scan",
    "claim_one",
    "sweep_one",
    "strand_one",
    "sweep_candidates",
    "stranding_candidates",
)


def later_operation(world: Any, boundary: str) -> tuple[Callable[[], Any], str, Any]:
    if boundary in ("sweep_one", "sweep_candidates"):
        _, state = prepare(world, "renew_lease")
        job = state["job"]
        world.observer.expire_lease(str(job))
        services.release_live_locks(claim=state["claim"])
        fence = state["claim"].fence
    elif boundary in ("strand_one", "stranding_candidates"):
        start, state = prepare(world, "start_sub_job")
        job = start()
        assert job is not None
        # Existing R33 guarded fixture: retain parent lease/fence, change running to leased.
        Job.objects.filter(pk=state["job"]).update(status="leased")
        fence = 0
    else:
        _, state = prepare(world, "claim_job")
        job, fence = state["job"], 0
    _claim.promote()
    calls = {
        "scan": _claim._scan,
        "claim_one": lambda: _claim._claim_one(job, "later"),
        "sweep_one": lambda: _sweep._sweep_one(job, fence, True),
        "strand_one": lambda: _sweep._strand_one(job),
        "sweep_candidates": lambda: _sweep._all(
            sql.SWEEP_CANDIDATES.format(expired=sql.SWEEP_EXPIRED)
        ),
        "stranding_candidates": lambda: _sweep._all(sql.STRANDING_CANDIDATES),
    }
    name = "claim_job" if boundary in ("scan", "claim_one") else "sweep_expired_leases"
    return calls[boundary], name, job


@pytest.mark.parametrize("boundary", LATER_BOUNDARIES)
def test_each_later_transaction_checks_isolation(world: Any, boundary: str) -> None:
    call, name, _ = later_operation(world, boundary)
    before = snapshot(world)
    with isolation("serializable"), trace() as statements:
        assert_refused(call, name, "serializable")
    assert not any(re.search(r"\bjobs_", sql) for sql in statements), (
        "later transaction reused an earlier isolation approval"
    )
    assert snapshot(world) == before, "unsupported later transaction changed queue evidence"


@pytest.mark.parametrize("boundary", LATER_BOUNDARIES)
def test_each_later_transaction_has_a_valid_control(world: Any, boundary: str) -> None:
    call, _, job = later_operation(world, boundary)
    result = call()
    if boundary in ("scan", "sweep_candidates", "stranding_candidates"):
        assert any((row[0] if isinstance(row, tuple) else row) == job for row in result)
    else:
        expected = {"claim_one": "leased", "sweep_one": "orphaned", "strand_one": "failed"}[
            boundary
        ]
        assert world.observer.job(str(job))["status"] == expected


@pytest.mark.parametrize("name", ("claim_job", "sweep_expired_leases"))
def test_after_promotion_new_transaction_is_rechecked(
    world: Any, name: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    call, state = prepare(world, name)
    original = _claim.promote

    def changed(function: str = "claim_job") -> None:
        original(function)
        assert world.observer.job(str(state["job"]))["lock_requested_at"] is not None
        with connection.cursor() as cursor:
            cursor.execute("SET default_transaction_isolation = 'repeatable read'")

    monkeypatch.setattr(_claim if name == "claim_job" else _sweep, "promote", changed)
    with pytest.raises(TransactionManagementError, match="actual=repeatable read"):
        call()
    assert world.observer.job(str(state["job"]))["status"] == "queued"


@pytest.mark.parametrize("change", (False, True))
def test_second_claim_transaction_is_checked(
    world: Any, monkeypatch: pytest.MonkeyPatch, change: bool
) -> None:
    prepare(world, "claim_job")
    prepare(world, "claim_job")
    _claim.promote()
    first, second = _claim._scan()
    original = _claim._claim_one
    visited: list[Any] = []

    def after_first(job: Any, runner: str) -> Any:
        result = original(job, runner)
        visited.append(job)
        if len(visited) == 1 and change:
            with connection.cursor() as cursor:
                cursor.execute("SET default_transaction_isolation = 'serializable'")
        return result

    monkeypatch.setattr(_claim, "_claim_one", after_first)
    with world.row_holder(str(first)):
        if change:
            assert_refused(
                lambda: services.claim_job(runner_id="second"), "claim_job", "serializable"
            )
            assert visited == [first]
            assert world.observer.job(str(second))["status"] == "queued"
        else:
            result = services.claim_job(runner_id="second")
            assert isinstance(result, services.Claim) and result.job_id == second
            assert visited == [first, second]


@pytest.mark.parametrize("change", (False, True))
def test_stranding_scan_after_committed_sweep_is_checked(
    world: Any, monkeypatch: pytest.MonkeyPatch, change: bool
) -> None:
    _, state = prepare(world, "renew_lease")
    world.observer.expire_lease(str(state["job"]))
    services.release_live_locks(claim=state["claim"])
    original = _sweep._sweep_one

    def after_sweep(*args: Any) -> None:
        original(*args)
        assert world.observer.job(str(state["job"]))["status"] == "orphaned"
        if change:
            with connection.cursor() as cursor:
                cursor.execute("SET default_transaction_isolation = 'serializable'")

    monkeypatch.setattr(_sweep, "_sweep_one", after_sweep)
    if change:
        assert_refused(services.sweep_expired_leases, "sweep_expired_leases", "serializable")
    else:
        services.sweep_expired_leases()
    assert world.observer.job(str(state["job"]))["status"] == "orphaned"


def test_valid_promotion_commits_before_claim_wait(world: Any) -> None:
    actor = world.thread_actor("promotion")
    request = world.request(
        "rotate_secret",
        world.organisation(),
        world.tenant(),
        not_before=timezone.now() + dt.timedelta(hours=1),
    )
    job = world.enqueue(actor, request)
    world.observer.make_due(job)
    with world.barrier("jobs_joblockreservation") as barrier:
        pending = actor.send("claim", job_id=job)
        barrier.wait_blocked(actor.backend_pid, pending)
        assert world.observer.job(job)["lock_requested_at"] is not None, (
            "promotion was not committed before claim"
        )
        assert world.observer.job(job)["status"] == "queued"
    assert pending.result()["outcome"] == "claimed"


def _without_preflight(function: Any) -> Any:
    """One function's context entry is omitted; callees retain their original checks."""
    namespace = {**function.__globals__, "queue_atomic": lambda name: transaction.atomic()}
    changed = types.FunctionType(
        function.__code__, namespace, function.__name__, function.__defaults__
    )
    changed.__kwdefaults__ = function.__kwdefaults__
    return changed


def test_each_transaction_omission_is_caught(world: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    # Each queue transaction entry has its own valid fixture; shared helper-only proof is insufficient.
    for name in (*NESTABLE, *RUNNERS):
        module, function_name = (
            (_runner, "_start_sub_job") if name == "start_sub_job" else (services, name)
        )
        function = getattr(module, function_name)
        with monkeypatch.context() as patch:
            patch.setattr(module, function_name, _without_preflight(function))
            with pytest.raises(
                AssertionError, match="unsupported isolation reached queue work at " + name
            ):
                test_unsupported_isolation_refuses_before_queue_work(
                    world, name, "serializable", "session"
                )
    for module, function_name, boundary in (
        (_claim, "_scan", "scan"),
        (_claim, "_claim_one", "claim_one"),
        (_sweep, "_sweep_one", "sweep_one"),
        (_sweep, "_strand_one", "strand_one"),
        (_sweep, "_all", "sweep_candidates"),
        (_sweep, "_all", "stranding_candidates"),
    ):
        with monkeypatch.context() as patch:
            patch.setattr(module, function_name, _without_preflight(getattr(module, function_name)))
            with pytest.raises(AssertionError, match="unsupported isolation reached queue work"):
                test_each_later_transaction_checks_isolation(world, boundary)
    for name in ("claim_job", "sweep_expired_leases"):
        module = _claim if name == "claim_job" else _sweep
        with monkeypatch.context() as patch:
            patch.setattr(module, "promote", _without_preflight(_claim.promote))
            with pytest.raises(AssertionError, match="isolation refusal committed promotion"):
                test_invalid_isolation_never_commits_promotion(world, name)


def _mutate_preflight(patch: pytest.MonkeyPatch, transform: Callable[[str], str]) -> None:
    """Compile only the local helper with one semantic change; restore imported references."""
    from apps.jobs import _decisions, _enqueue, _runner, transactions

    source = Path(transactions.__file__).read_text()
    changed = transform(source)
    assert changed != source, "preflight mutation changed nothing"
    namespace: dict[str, Any] = {"__name__": "apps.jobs.transactions", "__package__": "apps.jobs"}
    exec(compile(changed, transactions.__file__, "exec"), namespace)  # noqa: S102 - owned helper mutation
    for module in (_claim, _decisions, _enqueue, _runner, _sweep):
        patch.setattr(module, "queue_atomic", namespace["queue_atomic"])


def test_default_setting_substitution_is_caught(
    world: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in NESTABLE:
        call, _ = prepare(world, name)
        with monkeypatch.context() as patch:
            _mutate_preflight(
                patch,
                lambda text: text.replace(
                    'cursor.execute("SHOW transaction_isolation")',
                    'cursor.execute("SHOW default_transaction_isolation")',
                ),
            )
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
                with pytest.raises(
                    AssertionError, match="unsupported isolation reached queue work"
                ):
                    assert_refused(call, name, "repeatable read")
                transaction.set_rollback(True)


def test_cached_preflight_substitution_is_caught(
    world: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    first, _ = prepare(world, "enqueue_job")
    second, _ = prepare(world, "enqueue_job")

    def cache(text: str) -> str:
        text = text.replace("@contextmanager\n", "_checked = False\n\n\n@contextmanager\n")
        text = text.replace(
            "    with transaction.atomic():", "    global _checked\n    with transaction.atomic():"
        )
        text = text.replace(
            'if not mutants.on("isolation_unchecked"):',
            'if not _checked and not mutants.on("isolation_unchecked"):',
        )
        return text.replace("        yield", "        _checked = True\n        yield")

    with monkeypatch.context() as patch:
        _mutate_preflight(patch, cache)
        assert first().created
        connection.close()
        connection.ensure_connection()
        with isolation("serializable", "driver"):
            with pytest.raises(AssertionError, match="unsupported isolation reached queue work"):
                assert_refused(second, "enqueue_job", "serializable")


def test_isolation_rewrite_substitution_is_caught(
    world: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    call, _ = prepare(world, "enqueue_job")
    with monkeypatch.context() as patch:
        _mutate_preflight(
            patch,
            lambda text: text.replace(
                "    with transaction.atomic():",
                '    with connection.cursor() as cursor:\n        cursor.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")\n    with transaction.atomic():',
            ),
        )
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            with pytest.raises(AssertionError, match="unsupported isolation reached queue work"):
                assert_refused(call, "enqueue_job", "repeatable read")
            assert current_level() == "read committed", "rewrite mutation was not exercised"
            transaction.set_rollback(True)


def test_validation_and_cleanup_reordering_are_caught(
    world: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from apps.jobs.transactions import queue_atomic

    original = services.record_step

    def preflight_first(**kwargs: Any) -> Any:
        with queue_atomic("record_step"):
            return original(**kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(services, "record_step", preflight_first)
        with pytest.raises(
            AssertionError, match="isolation preflight displaced a zero-query programming error"
        ):
            test_invalid_arguments_still_precede_all_statements(world, "record_step")
    release = services.release_live_locks

    def guarded_cleanup(**kwargs: Any) -> None:
        with queue_atomic("release_live_locks"):
            release(**kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(services, "release_live_locks", guarded_cleanup)
        with pytest.raises(AssertionError, match="isolation error prevented cleanup"):
            test_cleanup_is_exempt_from_isolation_refusal(world)


def test_failed_isolation_read_never_assumes_read_committed(world: Any) -> None:
    from django.db import OperationalError

    call, _ = prepare(world, "enqueue_job")
    before = snapshot(world)

    def broken(execute: Any, sql: str, params: Any, many: bool, context: Any) -> Any:
        if sql == "SHOW transaction_isolation":
            raise OperationalError("synthetic isolation read failure")
        return execute(sql, params, many, context)

    with (
        connection.execute_wrapper(broken),
        pytest.raises(OperationalError, match="synthetic isolation read failure"),
    ):
        call()
    assert snapshot(world) == before
