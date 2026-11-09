"""Acceptance for work item A3, the Postgres-backed job queue: `docs/specs/JOB_QUEUE.md` §9.

Every test takes a `QueueEnv` and nothing else, so the self-test can run the same function against
the counterexample queues. Every assertion message in a test's own body is a plain string written
once in this module: `acceptance.toml` and `mutants.toml` name them exactly.
"""

import datetime as dt
import uuid
from contextlib import suppress
from typing import Any

from queue_harness import (
    BACKUP_STEPS,
    PRINCIPAL_REFUSED,
    PROBE_TABLE,
    RAISED,
    RECORDED,
    ActorError,
    QueueEnv,
    attempt,
    digest,
    job_queue_acceptance,
    key_digest,
    refusal,
    sql,
    wait_blocked,
)

RUNNING_STATES = {"leased", "running"}


def _kill_at(env: QueueEnv, organisation: str, tenant: str, table: str) -> dict[str, object]:
    """Crash a real process whose enqueue waits at a lock on `table`; report what committed."""
    label = f"killed-{table}"
    child = env.process_actor("killed")
    with env.barrier(table) as barrier:
        pending = child.send(
            "enqueue", request=env.request("backup", organisation, tenant, key=label), probe=label
        )
        assert barrier.reached(child.backend_pid, pending), (
            "an enqueue returned without waiting at the table the test had locked"
        )
        # Read while the child waits: its own writes are uncommitted, so this is the baseline.
        before = {
            "steps": env.observer.count("jobs_jobstep"),
            "audits": env.observer.audit_count("job.created"),
        }
        written = env.observer.written_relations(child.backend_pid)
        child.kill()
        # Still inside the barrier: the killed backend must end while it waits there, so a
        # statement that was in flight can neither finish nor commit.
        env.observer.wait_backend_gone(child.backend_pid)
    return {
        "probe": env.probe_count(label),
        "jobs": env.observer.count("jobs_job", "idempotency_key = %s", [digest(label)]),
        "steps": env.observer.count("jobs_jobstep") - before["steps"],
        "audits": env.observer.audit_count("job.created") - before["audits"],
        "written": written,
    }


def _delivery_decision_row(
    env: QueueEnv,
    delivery: str,
    identity: str,
    *,
    exit_: str = "resume",
    outcome: str = "completed",
    compute_at: dt.datetime | None = None,
    target_at: dt.datetime | None = None,
    decided_at: dt.datetime | None = None,
    blank: str | None = None,
    decided_txid: int | None = None,
) -> tuple[str, str, list[Any]]:
    """A decision row a test session inserts directly, to reach the database's own guards."""
    decision_id = str(uuid.uuid4())
    now = env.observer.now()
    values: dict[str, Any] = {
        "id": decision_id,
        "delivery_id": delivery,
        "exit": exit_,
        "operation_outcome": outcome,
        "compute_terminated_provider": "scaleway",
        "compute_terminated_resource_id": "fr-par-1/instance-7",
        "compute_terminated_request_id": "req-3f9",
        "compute_terminated_observed_at": compute_at or now,
        "target_read_provider": "scaleway",
        "target_read_resource_id": "fr-par-1/instance-7",
        "target_read_request_id": "req-4a1",
        "target_read_observed_at": target_at or now,
        "decided_by_identity_id": identity,
        "decided_by_role": "staff_operator",
    }
    if blank is not None:
        values[blank] = ""
    if decided_at is not None:
        values["decided_at"] = decided_at
    if decided_txid is not None:
        values["decided_txid"] = decided_txid
    columns, markers = ", ".join(values), ", ".join(["%s"] * len(values))
    # The column names are this function's own fixed keys; every value is a bound parameter.
    template = "INSERT INTO {s}.outbox_deliverydecision (" + columns + ") VALUES (" + markers + ")"  # noqa: S608
    return decision_id, template, list(values.values())


def _job_decision_row(
    env: QueueEnv,
    job: str,
    identity: str,
    *,
    exit_: str,
    outcome: str,
    decided_at: dt.datetime | None = None,
    decided_txid: int | None = None,
) -> tuple[str, list[Any]]:
    """A job decision row a test session inserts directly, to reach the database's own guards; its
    id is the first parameter."""
    now = env.observer.now()
    row = env.observer.job(job)
    values: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "job_id": job,
        "exit": exit_,
        "operation_outcome": outcome,
        "compute_terminated_provider": "scaleway",
        "compute_terminated_resource_id": "fr-par-1/instance-7",
        "compute_terminated_request_id": "req-3f9",
        "compute_terminated_observed_at": now,
        "target_read_provider": "scaleway",
        "target_read_resource_id": "fr-par-1/instance-7",
        "target_read_request_id": "req-4a1",
        "target_read_observed_at": now,
        "unresolved_step_id": row["unresolved_step_id"],
        "unresolved_operation_ref": row["unresolved_operation_ref"],
        "decided_by_identity_id": identity,
        "decided_by_role": "staff_operator",
    }
    if decided_at is not None:
        values["decided_at"] = decided_at
    if decided_txid is not None:
        values["decided_txid"] = decided_txid
    columns, markers = ", ".join(values), ", ".join(["%s"] * len(values))
    # The column names are this function's own fixed keys; every value is a bound parameter.
    template = (
        "INSERT INTO {s}.jobs_jobreconciliationdecision (" + columns + ") VALUES (" + markers + ")"  # noqa: S608
    )
    return template, list(values.values())


def _job_insert(
    env: QueueEnv, organisation: str, kind: str, tenant: str | None
) -> tuple[str, list[Any]]:
    """A queued job row a test session inserts directly, to reach the job table's own `CHECK`s."""
    label = str(uuid.uuid4())
    values: list[Any] = [
        label,
        organisation,
        tenant,
        kind,
        key_digest(label),
        digest(label),
        "queued",
        3,
        "system",
    ]
    return (
        "INSERT INTO {s}.jobs_job (id, organisation_id, tenant_id, kind, idempotency_key, "
        "desired_spec_hash, status, max_attempts, actor_type) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
        values,
    )


def _refused_inside(function: str) -> dict[str, str]:
    """What a function of §4 that must run with no transaction open raises inside one."""
    return {
        "raised": f"TransactionManagementError: {function} must be called with no transaction "
        "open (JOB_QUEUE.md §4)"
    }


def _raised_by(actor: Any, method: str, **arguments: Any) -> str | None:
    """What one call raised, as its actor reports it; None when the call returned."""
    try:
        actor.call(method, **arguments)
    except ActorError as error:
        return str(error)
    return None


def _sent_under_key_share(
    env: QueueEnv, actor: Any, held_row: str, method: str, **arguments: Any
) -> tuple[bool, Any]:
    """Send one call while a test session holds the job row FOR KEY SHARE, as the foreign-key check
    of an uncommitted insert naming the job does; report whether it waited on that session, and
    its result once the session ended."""
    with env.row_holder(held_row, key_share=True) as holder:
        pending = actor.send(method, **arguments)
        waited = wait_blocked(env.observer, actor.backend_pid, holder.info.backend_pid, pending)
    return waited, pending.result()


def _parent_with_sub_job(env: QueueEnv, organisation: str, label: str) -> tuple[Any, str, str]:
    """Exercise the generic sub-job queue path from a class C step.

    No production kind currently starts a sub-job. The real test binding injects only the exact
    ``delete.confirm -> export`` relation used by this compact fixture, without widening the empty
    production registry or changing the closed database enum.
    """
    runner = env.thread_actor(label)
    parent = env.enqueue(runner, env.request("delete", organisation, env.tenant()))
    env.claimed(runner, parent)
    assert runner.call("record_step", job_id=parent, seq=1, status="running"), (
        "a parent could not set its first step running"
    )
    sub_job = runner.call(
        "start_sub_job", job_id=parent, seq=1, kind="export", desired_spec_hash=digest(label)
    )
    assert sub_job is not None, "a parent could not start its sub-job"
    return runner, parent, str(sub_job)


@job_queue_acceptance("A3-01")
def test_a3_01_a_process_killed_before_the_audit_row_commits_nothing(queue_env: QueueEnv) -> None:
    env = queue_env
    organisation, tenant = env.organisation(), env.tenant()

    at_change = _kill_at(env, organisation, tenant, PROBE_TABLE)
    assert at_change["probe"] == 0, "killed at the desired-state change, the change was committed"
    assert at_change["jobs"] == 0, "killed at the desired-state change, the job row was committed"
    assert at_change["steps"] == 0 and at_change["audits"] == 0, (
        "killed at the desired-state change, steps or the audit row were committed"
    )

    at_job = _kill_at(env, organisation, tenant, "jobs_job")
    assert (at_job["probe"], at_job["jobs"], at_job["steps"], at_job["audits"]) == (0, 0, 0, 0), (
        "killed at the job row, something was committed"
    )

    at_audit = _kill_at(env, organisation, tenant, "audit_auditevent")
    assert at_audit["probe"] == 0, (
        "killed between the desired-state change and the audit row, the change was committed"
    )
    assert at_audit["jobs"] == 0, (
        "killed between the desired-state change and the audit row, the job row was committed"
    )
    assert at_audit["steps"] == 0 and at_audit["audits"] == 0, (
        "killed between the desired-state change and the audit row, steps were committed"
    )
    assert {"jobs_job", PROBE_TABLE, "jobs_jobstep"} <= at_audit["written"], (  # type: ignore[operator]
        "at the audit row, the job, the change and the steps were not already written by the "
        "transaction being killed"
    )

    runner = env.thread_actor()
    created = runner.call(
        "enqueue", request=env.request("backup", organisation, tenant, key="kept"), probe="kept"
    )
    assert created.get("created") is True, "an uncrashed enqueue reported no created job"
    job = created["job_id"]
    assert env.probe_count("kept") == 1, (
        "an uncrashed enqueue did not commit its desired-state change"
    )
    assert env.observer.status(job) == "queued", "an uncrashed enqueue did not commit a queued job"
    assert env.observer.steps(job) == [
        (seq, name, "pending") for seq, name in enumerate(BACKUP_STEPS, start=1)
    ], "an uncrashed backup job did not commit the catalogue's ordered steps, all pending"
    assert env.observer.audit_count("job.created", job) == 1, (
        "an uncrashed enqueue did not commit exactly one job.created audit row"
    )
    nested = runner.call(
        "in_transaction",
        call="enqueue",
        arguments={
            "request": env.request("backup", organisation, env.tenant(), key="nested"),
            "probe": "nested",
        },
    )
    assert (
        nested.get("returned", {}).get("created"),
        env.probe_count("nested"),
        env.observer.count("jobs_job", "idempotency_key = %s", [digest("nested")]),
    ) == (True, 1, 1), "an enqueue inside its caller's transaction did not commit with it"
    assert env.observer.rows(
        "SELECT target_urn, retention_class, actor_label FROM {s}.audit_auditevent "
        "WHERE action = 'job.created' AND job_id = %s",
        [job],
    ) == [(f"urn:kodera:job:{job}", "standard", "system")], (
        "a job.created audit row did not name the job, the standard retention class and its actor"
    )

    # §3.2: a job's and a step's specification never change, no job, step or audit row is ever
    # deleted, and an audit row never changes. Each write is a test session's own, one column each.
    job_spec = ("23514", "jobs_job_specification_immutable")
    assert (
        env.observer.refused("UPDATE {s}.jobs_job SET id = gen_random_uuid() WHERE id = %s", [job])
        == job_spec
    ), "a job's id changed after insert"
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_job SET organisation_id = gen_random_uuid() WHERE id = %s", [job]
        )
        == job_spec
    ), "a job's organisation_id changed after insert"
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_job SET tenant_id = gen_random_uuid() WHERE id = %s", [job]
        )
        == job_spec
    ), "a job's tenant_id changed after insert"
    assert (
        env.observer.refused("UPDATE {s}.jobs_job SET kind = 'restore' WHERE id = %s", [job])
        == job_spec
    ), "a job's kind changed after insert"
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_job SET idempotency_key = repeat('e', 64) WHERE id = %s", [job]
        )
        == job_spec
    ), "a job's idempotency_key changed after insert"
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_job SET desired_spec_hash = repeat('d', 64) WHERE id = %s", [job]
        )
        == job_spec
    ), "a job's desired_spec_hash changed after insert"
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_job SET max_attempts = max_attempts + 1 WHERE id = %s", [job]
        )
        == job_spec
    ), "a job's max_attempts changed after insert"
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_job SET actor_type = 'system' || actor_type WHERE id = %s", [job]
        )
        == job_spec
    ), "a job's actor_type changed after insert"
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_job SET actor_id = gen_random_uuid() WHERE id = %s", [job]
        )
        == job_spec
    ), "a job's actor_id changed after insert"
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_job SET parent_job_id = gen_random_uuid() WHERE id = %s", [job]
        )
        == job_spec
    ), "a job's parent_job_id changed after insert"
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_job SET depends_on_job_id = gen_random_uuid() WHERE id = %s", [job]
        )
        == job_spec
    ), "a job's depends_on_job_id changed after insert"
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_job SET request_id = coalesce(request_id, '') || 'x' WHERE id = %s",
            [job],
        )
        == job_spec
    ), "a job's request_id changed after insert"
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_job SET created_at = created_at - interval '1 second' WHERE id = %s",
            [job],
        )
        == job_spec
    ), "a job's created_at changed after insert"
    assert env.observer.refused("DELETE FROM {s}.jobs_job WHERE id = %s", [job]) == (
        "23514",
        "jobs_job_delete_refused",
    ), "a job row was deleted"

    step = env.observer.value(
        "SELECT id FROM {s}.jobs_jobstep WHERE job_id = %s AND seq = 1", [job]
    )
    step_spec = ("23514", "jobs_jobstep_specification_immutable")
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_jobstep SET id = gen_random_uuid() WHERE id = %s", [step]
        )
        == step_spec
    ), "a step's id changed after insert"
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_jobstep SET job_id = gen_random_uuid() WHERE id = %s", [step]
        )
        == step_spec
    ), "a step's job_id changed after insert"
    assert (
        env.observer.refused("UPDATE {s}.jobs_jobstep SET seq = seq + 100 WHERE id = %s", [step])
        == step_spec
    ), "a step's seq changed after insert"
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_jobstep SET name = name || '_renamed' WHERE id = %s", [step]
        )
        == step_spec
    ), "a step's name changed after insert"
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_jobstep SET retry_class = CASE retry_class WHEN 'A' THEN 'B' "
            "ELSE 'A' END WHERE id = %s",
            [step],
        )
        == step_spec
    ), "a step's retry_class changed after insert"
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_jobstep SET conditional = NOT conditional WHERE id = %s", [step]
        )
        == step_spec
    ), "a step's conditional flag changed after insert"
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_jobstep SET timeout_s = timeout_s + 1 WHERE id = %s", [step]
        )
        == step_spec
    ), "a step's timeout_s changed after insert"
    assert env.observer.refused("DELETE FROM {s}.jobs_jobstep WHERE id = %s", [step]) == (
        "23514",
        "jobs_jobstep_delete_refused",
    ), "a step row was deleted"

    audit = env.observer.value(
        "SELECT id FROM {s}.audit_auditevent WHERE job_id = %s AND action = 'job.created'", [job]
    )
    audit_immutable = ("23514", "audit_auditevent_immutable")
    assert (
        env.observer.refused(
            "UPDATE {s}.audit_auditevent SET action = 'job.failed' WHERE id = %s", [audit]
        )
        == audit_immutable
    ), "an audit row was changed"
    assert (
        env.observer.refused("DELETE FROM {s}.audit_auditevent WHERE id = %s", [audit])
        == audit_immutable
    ), "an audit row was deleted"


@job_queue_acceptance("A3-02")
def test_a3_02_a_duplicate_idempotency_key_returns_the_original_job(queue_env: QueueEnv) -> None:
    env = queue_env
    organisation, tenant = env.organisation(), env.tenant()
    first_runner, second_runner = env.thread_actor(), env.thread_actor()
    request = env.request("backup", organisation, tenant, key="duplicate", spec="one")
    key = request["idempotency_key"]

    first = first_runner.call("enqueue", request=request, probe="duplicate-1")
    assert env.observer.count("jobs_job", "idempotency_key = %s", [key]) == 1, (
        "the first enqueue under a key committed no job row"
    )
    second = first_runner.call("enqueue", request=request, probe="duplicate-2")
    assert second.get("job_id") == first["job_id"], (
        "a duplicate idempotency key returned a different job"
    )
    assert second.get("created") is False, "a duplicate idempotency key reported a new job"
    assert env.observer.count("jobs_job", "idempotency_key = %s", [key]) == 1, (
        "a duplicate idempotency key committed a second job row"
    )
    assert env.probe_count("duplicate-2") == 0, (
        "a duplicate idempotency key applied its desired-state change again"
    )
    assert env.observer.audit_count("job.created", first["job_id"]) == 1, (
        "a duplicate idempotency key wrote a second job.created audit row"
    )

    env.claimed(second_runner, first["job_id"])
    assert env.observer.job(first["job_id"])["runner_id"] == second_runner.runner_id, (
        "a claim did not record the runner that holds it"
    )
    again = first_runner.call("enqueue", request=request, probe="duplicate-3")
    assert (again.get("job_id"), again.get("created")) == (first["job_id"], False), (
        "a duplicate idempotency key did not return the original job once that job was claimed"
    )
    assert env.observer.status(first["job_id"]) in RUNNING_STATES, (
        "a duplicate idempotency key changed the original job's status"
    )

    reused = first_runner.call(
        "enqueue",
        request=env.request("backup", organisation, tenant, key="duplicate", spec="two"),
        probe="duplicate-4",
    )
    assert reused == {"refused": "idempotency_key_reuse"}, (
        "a key reused with a different desired state was not refused"
    )
    assert env.probe_count("duplicate-4") == 0, (
        "a refused key reuse applied its desired-state change"
    )

    racing = env.request("backup", organisation, tenant, key="race", spec="one")
    with env.barrier("jobs_job") as barrier:
        left = first_runner.send("enqueue", request=racing, probe="race-left")
        right = second_runner.send("enqueue", request=racing, probe="race-right")
        barrier.wait_blocked(first_runner.backend_pid, left)
        barrier.wait_blocked(second_runner.backend_pid, right)
    results = [left.result(), right.result()]
    assert results[0].get("job_id") == results[1].get("job_id"), (
        "two concurrent enqueues under one key returned different jobs"
    )
    assert sorted(bool(result.get("created")) for result in results) == [False, True], (
        "two concurrent enqueues under one key did not create exactly one job"
    )
    assert (
        env.observer.count("jobs_job", "idempotency_key = %s", [racing["idempotency_key"]]) == 1
    ), "two concurrent enqueues under one key committed two job rows"
    assert env.probe_count("race-left") + env.probe_count("race-right") == 1, (
        "two concurrent enqueues under one key applied the desired-state change twice"
    )


@job_queue_acceptance("A3-03")
def test_a3_03_a_superseded_fence_or_an_expired_lease_writes_nothing(queue_env: QueueEnv) -> None:
    env = queue_env
    organisation, tenant = env.organisation(), env.tenant()
    stale, current = env.thread_actor("stale"), env.thread_actor("current")
    job = env.enqueue(current, env.request("rotate_secret", organisation, tenant))
    old_fence = env.claimed(stale, job)
    leased_until = env.observer.job(job)["lease_expires_at"]
    assert stale.call("renew", job_id=job) is True, "a live claim's renewal was refused"
    assert env.observer.job(job)["lease_expires_at"] > leased_until, (
        "a renewal did not move the lease later"
    )
    assert stale.call("record_step", job_id=job, seq=1, status="running"), (
        "the first claim could not set its first step running"
    )
    stale.call("release_live_locks", job_id=job)
    env.end_session(stale)
    env.observer.expire_lease(job)
    current.call("sweep")
    assert env.observer.status(job) == "orphaned", (
        "an expired claim with no open dispatch was not swept to orphaned"
    )
    new_fence = env.claimed(current, job)
    assert new_fence > old_fence, "a new claim did not take a higher fence"
    assert current.call("record_step", job_id=job, seq=1, status="running"), (
        "the current fence could not set its first step running"
    )

    # Every stale write below would be valid under the current claim: only the fence refuses it.
    assert stale.call("record_step", job_id=job, seq=1, status="succeeded") is False, (
        "a superseded fence recorded a step"
    )
    remaining = env.observer.value(
        "SELECT extract(epoch FROM lease_expires_at - clock_timestamp()) FROM {s}.jobs_job "
        "WHERE id = %s",
        [job],
    )
    assert 115 <= remaining <= 125, "a claim's lease did not run for 120 seconds"
    assert stale.call("record_dispatch", job_id=job, seq=1, operation_ref="op-stale") is None, (
        "a superseded fence recorded a dispatch"
    )
    assert (
        stale.call(
            "start_sub_job", job_id=job, seq=1, kind="export", desired_spec_hash=digest("stale")
        )
        is None
    ), "a superseded fence started a sub-job"
    assert stale.call("finish", job_id=job, status="failed", error_code="step_failed") is False, (
        "a superseded fence finished the job"
    )
    assert stale.call("renew", job_id=job) is False, "a superseded fence renewed the lease"
    dispatch = current.call("record_dispatch", job_id=job, seq=1, operation_ref="op-current")
    assert dispatch is not None, "the current fence could not record a dispatch"
    assert (
        stale.call("retarget_dispatch", job_id=job, dispatch_id=dispatch, operation_ref="op-stale")
        is False
    ), "a superseded fence retargeted a dispatch"
    assert (
        stale.call(
            "close_dispatch",
            job_id=job,
            dispatch_id=dispatch,
            outcome="completed",
            evidence_ref="stale-proof",
        )
        is False
    ), "a superseded fence closed a dispatch"
    assert stale.call("hold_for_reconciliation", job_id=job, dispatch_id=dispatch) is False, (
        "a superseded fence held the job for reconciliation"
    )
    row = env.observer.job(job)
    assert (row["status"], row["fence"]) == ("running", new_fence), (
        "a superseded fence changed the job's status or fence"
    )
    assert env.observer.step_status(job, 1) == "running", "a superseded fence changed a step"
    assert env.observer.count("jobs_jobdispatch", "job_id = %s", [job]) == 1, (
        "a superseded fence left a dispatch row"
    )
    assert (
        env.observer.count("jobs_jobdispatch", "id = %s AND closed_at IS NULL", [dispatch]) == 1
    ), "a superseded fence left the current dispatch closed"
    assert len(env.observer.open_reservations(job)) == 2, "a superseded fence ended the reservation"
    assert env.observer.count("jobs_job", "parent_job_id = %s", [job]) == 0, (
        "a superseded fence left a sub-job row"
    )

    assert current.call(
        "close_dispatch", job_id=job, dispatch_id=dispatch, outcome="failed", evidence_ref="proof"
    ), "the current fence could not close its dispatch"
    env.observer.expire_lease(job)
    assert current.call("record_step", job_id=job, seq=1, status="succeeded") is False, (
        "an expired lease recorded a step under the current fence"
    )
    assert current.call("record_dispatch", job_id=job, seq=1, operation_ref="op-late") is None, (
        "an expired lease recorded a dispatch under the current fence"
    )
    assert current.call("renew", job_id=job) is False, "an expired lease was renewed"
    assert (
        current.call(
            "start_sub_job", job_id=job, seq=1, kind="export", desired_spec_hash=digest("late")
        )
        is None
    ), "an expired lease started a sub-job under the current fence"
    assert current.call("finish", job_id=job, status="failed", error_code="step_failed") is False, (
        "an expired lease finished the job under the current fence"
    )

    # The three writes that need an open dispatch, each valid but for the lease.
    lapsed = env.thread_actor("lapsed")
    other = env.enqueue(lapsed, env.request("rotate_secret", env.organisation(), env.tenant()))
    env.claimed(lapsed, other)
    assert lapsed.call("record_step", job_id=other, seq=1, status="running"), (
        "the second job's claim could not set its first step running"
    )
    looked = lapsed.call("record_dispatch", job_id=other, seq=1, operation_ref="op-look")
    assert looked is not None, "the second job's claim could not record a dispatch"
    env.observer.expire_lease(other)
    assert (
        lapsed.call("retarget_dispatch", job_id=other, dispatch_id=looked, operation_ref="op-apply")
        is False
    ), "an expired lease retargeted a dispatch under the current fence"
    assert (
        lapsed.call(
            "close_dispatch",
            job_id=other,
            dispatch_id=looked,
            outcome="completed",
            evidence_ref="late-proof",
        )
        is False
    ), "an expired lease closed a dispatch under the current fence"
    assert lapsed.call("hold_for_reconciliation", job_id=other, dispatch_id=looked) is False, (
        "an expired lease held the job for reconciliation under the current fence"
    )


@job_queue_acceptance("A3-04")
def test_a3_04_a_reservation_outlives_the_session_that_claimed_it(queue_env: QueueEnv) -> None:
    env = queue_env
    organisation, tenant, elsewhere = env.organisation(), env.tenant(), env.tenant()
    runner = env.thread_actor()
    first = env.enqueue(runner, env.request("rotate_secret", organisation, tenant))
    second = env.enqueue(runner, env.request("rotate_secret", organisation, tenant))
    unrelated = env.enqueue(runner, env.request("backup", organisation, elsewhere))

    child = env.process_actor("claimant")
    env.claimed(child, first)
    expected = {
        (*env.observer.advisory_key("organisation", organisation), "ShareLock"),
        (*env.observer.advisory_key("tenant", tenant), "ExclusiveLock"),
    }
    assert env.observer.advisory_locks(child.backend_pid) == expected, (
        "the claim does not hold exactly its live organisation and tenant locks under the spec's keys"
    )
    child.kill()
    env.observer.wait_backend_gone(child.backend_pid)
    assert not env.observer.holders("tenant", tenant), (
        "the killed session's live tenant lock is still held, so this test cannot tell a "
        "reservation from a live lock"
    )

    refused = runner.call("claim", job_id=second)
    assert refused["outcome"] == "refused", (
        "a conflicting job was claimed after the claiming session ended: the reservation did not "
        "outlive the session"
    )
    assert refused["reason"] == "reservation_conflict", (
        "a job blocked only by a reservation was refused for another reason"
    )
    assert (
        env.observer.count(
            "jobs_joblockreservation r JOIN {s}.jobs_job j ON j.id = r.job_id",
            "r.job_id = %s AND r.reserved_at >= j.created_at AND r.reserved_at <= clock_timestamp()",
            [first],
        )
        == 2
    ), "a claim's reservation was not recorded with the instant it was reserved"
    assert len(env.observer.open_reservations(first)) == 2, (
        "the ended session's organisation and tenant reservations did not both stay unended"
    )
    env.claimed(runner, unrelated)

    env.observer.expire_lease(first)
    runner.call("sweep")
    assert env.observer.status(first) == "orphaned", "the dead claim was not swept to orphaned"
    assert env.observer.open_reservations(first) == [], "orphaning did not end the reservation"
    later = env.thread_actor()
    waiting = later.call("claim", job_id=second)
    assert (waiting["outcome"], waiting.get("reason")) == ("refused", "earlier_request"), (
        "a later job was claimed ahead of the orphaned job requested before it"
    )
    assert later.call("claim").get("job_id") == first, (
        "claiming the next job did not serve the orphaned job first"
    )


@job_queue_acceptance("A3-05")
def test_a3_05_a_claim_holds_no_lock_while_any_lock_of_its_set_conflicts(
    queue_env: QueueEnv,
) -> None:
    env = queue_env
    organisation, tenant = env.organisation(), env.tenant()
    claimant = env.thread_actor("claimant")
    job = env.enqueue(claimant, env.request("rotate_secret", organisation, tenant))

    holder = env.session()
    assert holder.execute("SELECT pg_try_advisory_lock(2, hashtext(%s))", [tenant]).fetchone()[0], (
        "the test's own session could not take the tenant lock it holds against the claim"
    )
    refused = claimant.call("claim", job_id=job)
    assert refused["outcome"] == "refused", (
        "a claim succeeded while another session held its tenant lock"
    )
    assert refused["reason"] == "live_lock_busy", (
        "a claim blocked by a held tenant lock was refused for another reason"
    )
    assert env.observer.advisory_locks(claimant.backend_pid) == set(), (
        "a refused claim kept a live lock it had taken"
    )
    assert env.observer.count("jobs_joblockreservation", "job_id = %s", [job]) == 0, (
        "a refused claim wrote a reservation"
    )
    assert env.observer.status(job) == "queued", "a refused claim changed the job's status"
    holder.execute("SELECT pg_advisory_unlock(2, hashtext(%s))", [tenant])
    env.claimed(claimant, job)

    other_organisation, other_tenant = env.organisation(), env.tenant()
    reserving = env.thread_actor("reserving")
    reserved = env.enqueue(
        reserving, env.request("rotate_secret", other_organisation, other_tenant)
    )
    env.claimed(reserving, reserved)
    blocked = env.enqueue(reserving, env.request("rotate_secret", other_organisation, other_tenant))
    # Its session ends, so only the durable reservation stands between the claim and the tenant.
    env.end_session(reserving)
    assert holder.execute(
        "SELECT pg_try_advisory_lock(1, hashtext(%s))", [other_organisation]
    ).fetchone()[0], "the test's own session could not take the organisation lock it holds"
    result = claimant.call("claim", job_id=blocked)
    assert result["outcome"] == "refused", "a claim succeeded against a conflicting reservation"
    assert result["reason"] == "reservation_conflict", (
        "the claim reached a live lock before checking every reservation of its set"
    )
    held = env.observer.advisory_locks(claimant.backend_pid)
    organisation_key = env.observer.advisory_key("organisation", other_organisation)
    assert not {entry for entry in held if entry[:2] == organisation_key}, (
        "a claim refused on a reservation kept a live organisation lock"
    )
    holder.execute("SELECT pg_advisory_unlock(1, hashtext(%s))", [other_organisation])


@job_queue_acceptance("A3-06")
def test_a3_06_claims_are_served_in_request_order(queue_env: QueueEnv) -> None:
    env = queue_env
    waiting_organisation, waiting_tenant = env.organisation(), env.tenant()
    first_come = env.thread_actor("first-come")
    shared_earlier = env.enqueue(
        first_come, env.request("backup", waiting_organisation, waiting_tenant)
    )
    exclusive_later = env.enqueue(
        first_come, env.request("rotate_secret", waiting_organisation, waiting_tenant)
    )
    jumped = first_come.call("claim", job_id=exclusive_later)
    assert jumped["outcome"] == "refused", (
        "a later exclusive request was claimed ahead of an earlier shared request"
    )
    # Claimed, the earlier request stops being one the scan below could serve.
    env.claimed(first_come, shared_earlier)

    organisation, tenant, elsewhere = env.organisation(), env.tenant(), env.tenant()
    holder, contender = env.thread_actor("holder"), env.thread_actor("contender")
    shared_first = env.enqueue(holder, env.request("backup", organisation, tenant))
    exclusive = env.enqueue(holder, env.request("rotate_secret", organisation, tenant))
    shared_later = env.enqueue(holder, env.request("backup", organisation, tenant))
    unrelated = env.enqueue(holder, env.request("backup", organisation, elsewhere))

    env.claimed(holder, shared_first)
    assert contender.call("claim", job_id=exclusive)["outcome"] == "refused", (
        "an exclusive request was claimed beside a held shared reservation"
    )
    later = contender.call("claim", job_id=shared_later)
    assert later["outcome"] == "refused", (
        "a later shared request was claimed ahead of an earlier exclusive request"
    )
    assert later["reason"] == "earlier_request", (
        "a later shared request behind an earlier exclusive one was refused for another reason"
    )
    assert contender.call("claim").get("job_id") == unrelated, (
        "claiming the next job did not pass over the blocked requests to the next claimable one"
    )
    env.run_steps(holder, shared_first, range(1, len(BACKUP_STEPS) + 1))
    assert holder.call("finish", job_id=shared_first, status="succeeded"), (
        "the shared holder could not finish a job whose steps all succeeded"
    )
    assert env.observer.open_reservations(shared_first) == [], (
        "finishing did not end the reservation"
    )
    served = env.thread_actor("served")
    assert served.call("claim").get("job_id") == exclusive, (
        "once the shared holder finished, the earliest request was not served first"
    )
    assert contender.call("claim", job_id=shared_later)["outcome"] == "refused", (
        "a shared request was claimed beside a held exclusive reservation"
    )

    realm_organisation = env.organisation()
    provisioner, realm_contender = env.thread_actor("provisioner"), env.thread_actor("realm")
    running = env.enqueue(provisioner, env.request("provision", realm_organisation, env.tenant()))
    env.claimed(provisioner, running)
    realm_change = env.enqueue(provisioner, env.request("realm_update", realm_organisation))
    assert realm_contender.call("claim", job_id=realm_change)["outcome"] == "refused", (
        "a realm change was claimed beside a held shared organisation reservation"
    )
    other_provision = env.enqueue(
        provisioner, env.request("provision", realm_organisation, env.tenant())
    )
    behind = realm_contender.call("claim", job_id=other_provision)
    assert (behind["outcome"], behind.get("reason")) == ("refused", "earlier_request"), (
        "a later provision was claimed ahead of an earlier realm change on the organisation lock"
    )


@job_queue_acceptance("A3-07")
def test_a3_07_a_job_waits_on_its_realm_job_and_fails_when_that_failed(queue_env: QueueEnv) -> None:
    env = queue_env
    runner = env.thread_actor()
    organisation, tenant = env.organisation(), env.tenant()
    realm = env.enqueue(runner, env.request("realm_create", organisation))
    dependent = env.enqueue(
        runner, env.request("provision", organisation, tenant, depends_on=realm)
    )
    early = runner.call("claim", job_id=dependent)
    assert early["outcome"] == "refused", (
        "a job was claimed before the realm job it depends on was terminal"
    )
    assert early["reason"] == "waiting_on_dependency", (
        "a job waiting on its realm job was refused for another reason"
    )
    assert env.observer.job(dependent)["lock_requested_at"] is None, (
        "a job waiting on its realm job took a place in request order"
    )
    env.claimed(runner, realm)
    assert runner.call("finish", job_id=realm, status="failed", error_code="step_failed"), (
        "the realm job's claim could not fail it"
    )
    late = runner.call("claim", job_id=dependent)
    assert (late["outcome"], late.get("reason")) == ("refused", "prerequisite_failed"), (
        "a job whose realm job failed was not refused as prerequisite_failed"
    )
    row = env.observer.job(dependent)
    assert (row["status"], row["error_code"]) == ("failed", "prerequisite_failed"), (
        "a job whose realm job failed was not failed prerequisite_failed at its claim"
    )
    assert row["lock_requested_at"] is None, (
        "a job whose realm job failed took a place in request order"
    )
    assert env.observer.audit_count("job.failed", dependent) == 1, (
        "a job failed prerequisite_failed emitted no job.failed"
    )
    assert env.observer.count("jobs_joblockreservation", "job_id = %s", [dependent]) == 0, (
        "a job failed prerequisite_failed wrote a reservation"
    )

    second_organisation = env.organisation()
    realm = env.enqueue(runner, env.request("realm_create", second_organisation))
    dependent = env.enqueue(
        runner, env.request("provision", second_organisation, env.tenant(), depends_on=realm)
    )
    env.claimed(runner, realm)
    env.run_steps(runner, realm, range(1, 8))
    assert runner.call("finish", job_id=realm, status="succeeded"), (
        "the realm job could not succeed"
    )
    env.claimed(runner, dependent)
    assert env.observer.job(dependent)["lock_requested_at"] is not None, (
        "a job whose realm job succeeded was claimed without a place in request order"
    )


@job_queue_acceptance("A3-08")
def test_a3_08_a_process_killed_mid_step_resumes_at_its_first_unfinished_step(
    queue_env: QueueEnv,
) -> None:
    env = queue_env
    organisation, tenant = env.organisation(), env.tenant()
    child = env.process_actor("mid-step")
    job = env.enqueue(child, env.request("backup", organisation, tenant))
    old_fence = env.claimed(child, job)
    assert env.observer.audit_count("job.started", job) == 1, (
        "a job's first claim did not emit exactly one job.started"
    )
    env.run_steps(child, job, (1,))
    assert child.call("record_step", job_id=job, seq=2, status="running"), (
        "the claim could not set its second step running"
    )
    child.kill()
    env.observer.wait_backend_gone(child.backend_pid)
    assert env.observer.status(job) == "running", (
        "the process's death alone changed the job's status"
    )
    assert len(env.observer.open_reservations(job)) == 1, (
        "the process's death ended the reservation"
    )

    runner = env.thread_actor()
    runner.call("sweep")
    assert env.observer.status(job) == "running", "the sweep acted on a lease that had not expired"
    env.observer.expire_lease(job)
    runner.call("sweep")
    assert env.observer.status(job) == "orphaned", (
        "an expired job killed mid-step with no open dispatch was not orphaned"
    )
    assert env.observer.audit_count("job.orphaned", job) == 1, "orphaning emitted no job.orphaned"
    assert env.observer.open_reservations(job) == [], "orphaning left the reservation in force"

    new_fence = env.claimed(runner, job)
    assert new_fence > old_fence, "reclaiming an orphaned job did not take a higher fence"
    assert env.observer.job(job)["attempt"] == 2, (
        "reclaiming an orphaned job did not count an attempt"
    )
    assert env.observer.audit_count("job.started", job) == 1, (
        "reclaiming an orphaned job emitted job.started again"
    )
    assert runner.call("record_step", job_id=job, seq=1, status="running") is False, (
        "a resumed job re-ran a step that had already succeeded"
    )
    assert env.observer.step_status(job, 1) == "succeeded", "a resumed job reset a succeeded step"
    assert runner.call("record_step", job_id=job, seq=3, status="running") is False, (
        "a resumed job skipped past its first unfinished step"
    )
    assert runner.call("record_step", job_id=job, seq=2, status="running"), (
        "a resumed job could not resume at its first unfinished step"
    )


@job_queue_acceptance("A3-09")
def test_a3_09_the_sweep_decides_from_dispatch_records_alone(queue_env: QueueEnv) -> None:
    env = queue_env
    organisation = env.organisation()
    tenants = [env.tenant() for _ in range(5)]
    runner, sweeper = env.thread_actor("runner"), env.thread_actor("sweeper")
    silent, open_, closed, live, recorded = (
        env.enqueue(runner, env.request("backup", organisation, tenant)) for tenant in tenants[:5]
    )
    for job in (silent, open_, closed, live):
        env.claimed(runner, job)
        assert runner.call("record_step", job_id=job, seq=1, status="running"), (
            "a claim could not set its first step running"
        )
    env.claimed(runner, recorded)
    env.run_steps(runner, recorded, (1, 2))
    assert runner.call("record_step", job_id=recorded, seq=3, status="running"), (
        "a claim could not set its class C step running"
    )
    open_dispatch = runner.call("record_dispatch", job_id=open_, seq=1, operation_ref="op-open")
    closed_dispatch = runner.call(
        "record_dispatch", job_id=closed, seq=1, operation_ref="op-closed"
    )
    recorded_dispatch = runner.call(
        "record_dispatch", job_id=recorded, seq=3, operation_ref="op-recorded"
    )
    assert open_dispatch and closed_dispatch and recorded_dispatch, (
        "a claim could not record a dispatch"
    )
    for job, dispatch in ((closed, closed_dispatch), (recorded, recorded_dispatch)):
        assert runner.call(
            "close_dispatch",
            job_id=job,
            dispatch_id=dispatch,
            outcome="completed",
            evidence_ref="terminal-proof",
        ), "a dispatch could not be closed with terminal proof"
    for job in (silent, open_, closed, live, recorded):
        runner.call("release_live_locks", job_id=job)
    env.end_session(runner)
    for job in (silent, open_, closed, recorded):
        env.observer.expire_lease(job)
    sweeper.call("sweep")

    assert env.observer.status(silent) == "orphaned", (
        "an expired job that dispatched nothing was not orphaned"
    )
    assert env.observer.step_status(silent, 1) == "pending", (
        "an orphaned job left its unfinished step running"
    )
    assert env.observer.status(closed) == "orphaned", (
        "an expired job whose only dispatch has terminal proof was not orphaned"
    )
    assert (env.observer.step_status(closed, 1), env.observer.step_status(recorded, 3)) == (
        "pending",
        "pending",
    ), "the sweep marked a running step succeeded"
    assert env.observer.status(open_) == "needs_reconciliation", (
        "an expired job with an open dispatch was not swept to needs_reconciliation"
    )
    row = env.observer.job(open_)
    step_one = env.observer.value(
        "SELECT id FROM {s}.jobs_jobstep WHERE job_id = %s AND seq = 1", [open_]
    )
    assert (row["unresolved_step_id"], row["unresolved_operation_ref"]) == (step_one, "op-open"), (
        "needs_reconciliation did not record the open dispatch's step and operation"
    )
    assert env.observer.audit_count("job.reconciliation_required", open_) == 1, (
        "entering needs_reconciliation emitted no job.reconciliation_required"
    )
    assert env.observer.rows(
        "SELECT metadata->>'unresolved_step', metadata->>'unresolved_operation_ref' "
        "FROM {s}.audit_auditevent WHERE action = 'job.reconciliation_required' AND job_id = %s",
        [open_],
    ) == [(str(step_one), "op-open")], (
        "job.reconciliation_required did not carry the unresolved step and operation"
    )
    assert len(env.observer.open_reservations(open_)) == 1, (
        "a job in needs_reconciliation lost its reservation"
    )
    assert env.observer.status(live) in RUNNING_STATES, (
        "the sweep changed a job whose lease had not expired"
    )

    sweeper.call("sweep")
    assert env.observer.status(open_) == "needs_reconciliation", (
        "a second sweep took a job out of needs_reconciliation"
    )
    assert sweeper.call("claim", job_id=open_)["outcome"] == "refused", (
        "a job in needs_reconciliation was claimed"
    )
    conflicting = env.enqueue(sweeper, env.request("rotate_secret", organisation, tenants[1]))
    assert sweeper.call("claim", job_id=conflicting)["outcome"] == "refused", (
        "a conflicting job was claimed while a job in needs_reconciliation held its reservation"
    )

    env.claimed(env.thread_actor("resumer"), closed)
    assert env.observer.step_status(closed, 1) == "pending", (
        "a claim marked a step that is not class C succeeded from its closed dispatch"
    )
    env.claimed(env.thread_actor("class-c"), recorded)
    assert env.observer.step_status(recorded, 3) == "succeeded", (
        "a claim did not mark succeeded a class C step whose dispatch closed completed"
    )

    assert env.observer.audit_count("job.step_succeeded", recorded) == 3, (
        "a claim that completed a class C step emitted no job.step_succeeded for it"
    )

    # The sweep's open-dispatch clause alone, apart from its non-terminal-sub-job clause: the test's
    # session ends the sub-job and leaves the dispatch naming it open (docs/specs/JOB_QUEUE.md §3.2).
    parent_runner, parent, sub_job = _parent_with_sub_job(env, organisation, "ended-sub-job")
    env.observer.rows(
        "UPDATE {s}.jobs_job SET status = 'failed', error_code = 'step_failed' "
        "WHERE id = %s RETURNING id",
        [sub_job],
    )
    parent_runner.call("release_live_locks", job_id=parent)
    env.end_session(parent_runner)
    env.observer.expire_lease(parent)
    sweeper.call("sweep")
    assert env.observer.status(parent) == "needs_reconciliation", (
        "an expired parent whose open dispatch names an ended sub-job was orphaned"
    )


@job_queue_acceptance("A3-10")
def test_a3_10_a_sub_job_runs_under_its_running_parents_dispatch_fence(
    queue_env: QueueEnv,
) -> None:
    env = queue_env
    organisation, tenant = env.organisation(), env.tenant()
    parent_runner, child_runner, other = (
        env.thread_actor("parent"),
        env.thread_actor("child"),
        env.thread_actor("other"),
    )
    parent = env.enqueue(parent_runner, env.request("decommission", organisation, tenant))
    env.claimed(parent_runner, parent)
    assert parent_runner.call("record_step", job_id=parent, seq=1, status="running"), (
        "the parent could not set its first step running"
    )
    frozen = _queue_records(env)
    assert (
        parent_runner.call(
            "start_sub_job",
            job_id=parent,
            seq=1,
            kind="export",
            desired_spec_hash=digest("production-export"),
            test_relation=False,
        )
        is None
    ), "an unlisted production sub-job relation started a job"
    assert _queue_records(env) == frozen, (
        "refusing an unlisted production sub-job relation changed queue or audit records"
    )
    before = env.observer.now()
    sub_job = parent_runner.call(
        "start_sub_job", job_id=parent, seq=1, kind="export", desired_spec_hash=digest("export-1")
    )
    assert sub_job is not None, "the parent could not start its sub-job"
    assert str(env.observer.job(sub_job)["parent_job_id"]) == parent, (
        "the sub-job does not name its parent"
    )
    started_by = str(env.observer.sub_job_dispatch(sub_job)["id"])
    assert env.observer.job(sub_job)["idempotency_key"] == key_digest("sub", parent, started_by), (
        "a sub-job's key was not derived from its parent and the dispatch that started it"
    )
    assert (
        env.observer.count(
            "jobs_jobdispatch",
            "job_id = %s AND sub_job_id = %s AND closed_at IS NULL",
            [parent, sub_job],
        )
        == 1
    ), "starting a sub-job recorded no open dispatch of the parent naming it"
    assert before <= env.observer.job(sub_job)["not_before"] <= env.observer.now(), (
        "a sub-job did not store the instant it was started as its not_before"
    )

    claimed = child_runner.call("claim", job_id=sub_job)
    assert claimed["outcome"] == "claimed", (
        "a sub-job was refused while its parent was running under the fence that started it"
    )
    assert env.observer.advisory_locks(child_runner.backend_pid) == set(), (
        "a sub-job's claim took live locks of its own"
    )
    assert env.observer.count("jobs_joblockreservation", "job_id = %s", [sub_job]) == 0, (
        "a sub-job's claim wrote a reservation of its own"
    )
    conflicting = env.enqueue(other, env.request("backup", organisation, tenant))
    assert other.call("claim", job_id=conflicting)["outcome"] == "refused", (
        "a conflicting job was claimed while the parent's reservation covered its sub-job"
    )

    assert child_runner.call("finish", job_id=sub_job, status="failed", error_code="step_failed"), (
        "a sub-job under its running parent could not finish"
    )
    assert (
        env.observer.count("jobs_jobdispatch", "sub_job_id = %s AND closed_at IS NULL", [sub_job])
        == 0
    ), "the sub-job's terminal write did not close its parent's dispatch"
    assert parent_runner.call("record_step", job_id=parent, seq=1, status="succeeded"), (
        "the parent could not mark its first step succeeded"
    )
    assert parent_runner.call("record_step", job_id=parent, seq=2, status="running"), (
        "the parent could not set its second step running"
    )
    second = parent_runner.call(
        "start_sub_job", job_id=parent, seq=2, kind="export", desired_spec_hash=digest("export-2")
    )
    assert second is not None, "the parent could not start a second sub-job"
    other.call("sweep")
    assert env.observer.status(second) == "queued", (
        "the sweep failed a queued sub-job whose parent was running under its dispatch's fence"
    )
    env.observer.rows(
        "UPDATE {s}.jobs_job SET fence = fence + 1 WHERE id = %s RETURNING id", [parent]
    )
    refused = child_runner.call("claim", job_id=second)
    assert (refused["outcome"], refused.get("reason")) == ("refused", "parent_not_running"), (
        "a sub-job was claimed under a parent fence other than its dispatch's"
    )
    other.call("sweep")
    row = env.observer.job(second)
    assert (row["status"], row["error_code"]) == ("failed", "parent_not_running"), (
        "the sweep left a queued sub-job whose parent runs under another fence than its dispatch's"
    )


@job_queue_acceptance("A3-11")
def test_a3_11_an_orphaning_past_max_attempts_fails_the_job(queue_env: QueueEnv) -> None:
    env = queue_env
    organisation = env.organisation()
    sweeper = env.thread_actor("sweeper")

    def claim_and_lose(job: str, *, step: bool = False, dispatch: bool = False) -> None:
        runner = env.thread_actor("lost")
        env.claimed(runner, job)
        if step or dispatch:
            assert runner.call("record_step", job_id=job, seq=1, status="running"), (
                "the claim could not set its first step running"
            )
        if dispatch:
            assert runner.call("record_dispatch", job_id=job, seq=1, operation_ref="op-lost"), (
                "the claim could not record a dispatch"
            )
        runner.call("release_live_locks", job_id=job)
        env.end_session(runner)
        env.observer.expire_lease(job)
        sweeper.call("sweep")

    once = env.enqueue(sweeper, env.request("restore", organisation, env.tenant()))
    claim_and_lose(once, step=True)
    row = env.observer.job(once)
    assert (row["status"], row["error_code"]) == ("failed", "orphaned_exhausted"), (
        "an orphaning past a budget of one did not fail the job orphaned_exhausted"
    )
    assert env.observer.open_reservations(once) == [], "an exhausted job kept its reservation"
    assert env.observer.audit_count("job.failed", once) == 1, (
        "an exhausted job emitted no job.failed"
    )
    assert sweeper.call("claim", job_id=once)["outcome"] == "refused", (
        "an exhausted job was claimed again"
    )
    assert env.observer.step_status(once, 1) == "running", (
        "the sweep changed a step of a job it failed orphaned_exhausted"
    )

    holding = env.enqueue(sweeper, env.request("restore", organisation, env.tenant()))
    claim_and_lose(holding, dispatch=True)
    assert env.observer.status(holding) == "needs_reconciliation", (
        "an exhausted job holding an open dispatch was failed instead of held for reconciliation"
    )

    thrice = env.enqueue(sweeper, env.request("backup", organisation, env.tenant()))
    claim_and_lose(thrice)
    assert env.observer.status(thrice) == "orphaned", (
        "orphaning the first claim of a budget of three did not leave the job orphaned"
    )
    claim_and_lose(thrice)
    assert env.observer.status(thrice) == "orphaned", (
        "orphaning the second claim of a budget of three did not leave the job orphaned"
    )
    claim_and_lose(thrice)
    assert env.observer.job(thrice)["error_code"] == "orphaned_exhausted", (
        "the third orphaned claim of a budget of three did not fail the job orphaned_exhausted"
    )


@job_queue_acceptance("A3-12")
def test_a3_12_a_decision_leaves_needs_reconciliation_through_its_exits(
    queue_env: QueueEnv,
) -> None:
    env = queue_env
    organisation = env.organisation()
    tenant, other_tenant, third_tenant, fourth_tenant = (env.tenant() for _ in range(4))
    operator = env.staff_principal(organisation)
    deciding = env.thread_actor("operator")
    job, dispatch = env.to_reconciliation(organisation, tenant, "resumed")
    assert env.observer.status(job) == "needs_reconciliation", (
        "holding a job for reconciliation did not put it in needs_reconciliation"
    )

    waiting = env.enqueue(deciding, env.request("rotate_secret", organisation, fourth_tenant))
    assert deciding.try_call(
        "decide", principal=operator, decision=env.decision(waiting)
    ) == refusal("not_in_reconciliation"), (
        "a decision was recorded on a job not in needs_reconciliation"
    )
    assert env.observer.status(waiting) == "queued", "a refused decision changed a queued job"
    assert env.observer.audit_count("job.reconciliation_required", job) == 1, (
        "a runner's hold emitted no job.reconciliation_required"
    )
    support = env.staff_principal(organisation, roles=("staff_support",))
    assert deciding.try_call(
        "decide", principal=support, decision=env.decision(waiting)
    ) == refusal("not_in_reconciliation"), (
        "a decision with two defects was not refused for the job's status before the role"
    )

    assert deciding.call("decide", principal=operator, decision=env.decision(job)) == RECORDED, (
        "a resume carrying both pieces of stop evidence was refused"
    )
    row = env.observer.job(job)
    assert row["status"] == "queued", "a resume did not return the job to queued"
    assert row["reconciliation_decision_ref"] is not None, "a resume recorded no decision reference"
    assert env.observer.step_status(job, 1) == "succeeded", (
        "a resume whose target read shows the operation completed did not mark its step succeeded"
    )
    assert env.observer.audit_count("job.step_succeeded", job) == 1, (
        "a resume that completed a step emitted no job.step_succeeded for it"
    )
    assert (
        env.observer.count("jobs_jobdispatch", "id = %s AND closed_at IS NOT NULL", [dispatch]) == 1
    ), "a resume did not close the unresolved dispatch"
    assert env.observer.record("jobs_jobdispatch", dispatch)["terminal_outcome"] == "completed", (
        "a resume whose operation completed closed its dispatch other than completed"
    )
    assert env.observer.rows(
        "SELECT dispatch_outcome_at_decision FROM {s}.jobs_jobreconciliationdecision "
        "WHERE job_id = %s",
        [job],
    ) == [(None,)], "a decision that closed its dispatch itself recorded an earlier outcome for it"
    assert env.observer.audit_count("job.reconciliation_decided", job) == 1, (
        "a resume emitted no job.reconciliation_decided"
    )
    # A recorded decision is the record the owner's decision requires: no later write touches it.
    immutable = ("23514", "jobs_jobreconciliationdecision_immutable")
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_jobreconciliationdecision SET exit = 'fail', "
            "operation_outcome = 'partial', decided_at = clock_timestamp() WHERE job_id = %s",
            [job],
        )
        == immutable
    ), "a recorded job decision was rewritten"
    assert (
        env.observer.refused(
            "DELETE FROM {s}.jobs_jobreconciliationdecision WHERE job_id = %s", [job]
        )
        == immutable
    ), "a recorded job decision was deleted"
    assert len(env.observer.open_reservations(job)) == 2, (
        "a resumed job gave up its reservation before its next claim"
    )
    contender = env.thread_actor("contender")
    blocked = env.enqueue(contender, env.request("rotate_secret", organisation, tenant))
    assert contender.call("claim", job_id=blocked)["outcome"] == "refused", (
        "a conflicting job was claimed while a resumed job waited for its next claim"
    )
    attempts = env.observer.job(job)["attempt"]
    fence = env.claimed(contender, job)
    assert {entry[2] for entry in env.observer.open_reservations(job)} == {fence}, (
        "the resumed job's next claim did not replace its reservation with its own"
    )
    assert env.observer.job(job)["attempt"] == attempts, (
        "the claim after a resume counted an attempt"
    )
    assert contender.call("record_step", job_id=job, seq=2, status="running"), (
        "the resumed job could not continue at the step after the completed one"
    )

    no_effect, no_effect_dispatch = env.to_reconciliation(organisation, other_tenant, "no-effect")
    no_effect_decision = env.decision(no_effect, outcome="no_effect")
    assert deciding.call("decide", principal=operator, decision=no_effect_decision) == RECORDED, (
        "a resume with no effect, carrying both pieces of evidence, was refused"
    )
    assert env.observer.step_status(no_effect, 1) == "pending", (
        "a resume with no effect did not return its step to pending"
    )
    assert env.observer.audit_count("job.step_succeeded", no_effect) == 0, (
        "a resume with no effect was audited as a step's success"
    )
    assert (
        env.observer.record("jobs_jobdispatch", no_effect_dispatch)["terminal_outcome"]
        == "no_effect"
    ), "a resume with no effect closed its dispatch other than no_effect"

    failing, failing_dispatch = env.to_reconciliation(organisation, third_tenant, "failed")
    failed = env.decision(failing, exit="fail", outcome="partial")
    assert deciding.call("decide", principal=operator, decision=failed) == RECORDED, (
        "a fail carrying both pieces of stop evidence was refused"
    )
    row = env.observer.job(failing)
    assert (row["status"], row["error_code"]) == ("failed", "reconciliation_failed"), (
        "a fail decision did not fail the job reconciliation_failed"
    )
    assert env.observer.open_reservations(failing) == [], "a fail decision kept the reservation"
    assert (
        env.observer.record("jobs_jobdispatch", failing_dispatch)["terminal_outcome"] == "failed"
    ), "a fail decision on a partial effect closed its dispatch other than failed"
    assert env.observer.step_status(failing, 1) == "running", (
        "a fail decision changed a step of the job it failed"
    )

    raced, _ = env.to_reconciliation(organisation, env.tenant(), "raced")
    identity = str(operator["identity_id"])
    competing, competing_parameters = _job_decision_row(
        env, raced, identity, exit_="fail", outcome="partial"
    )
    # The test's session plays another writer that moves the job, with a decision of its own, while
    # the decision is in flight.
    with env.row_holder(raced) as holder:
        racing = env.decision(raced, exit="fail", outcome="no_effect")
        pending = deciding.send("decide", principal=operator, decision=racing)
        waited = wait_blocked(env.observer, deciding.backend_pid, holder.info.backend_pid, pending)
        holder.execute(sql(competing, env.schema), competing_parameters)
        holder.execute(
            sql(
                "UPDATE {s}.jobs_job SET status = 'failed', error_code = 'reconciliation_failed', "
                "reconciliation_decision_ref = %s WHERE id = %s",
                env.schema,
            ),
            [competing_parameters[0], raced],
        )
        holder.execute("COMMIT")
    assert attempt(pending) == refusal("not_in_reconciliation"), (
        "a decision committed after the job left needs_reconciliation"
    )
    assert waited, "a decision did not wait on the job row another transaction held"

    # §3.3: a job in needs_reconciliation names its unresolved step and operation, one CHECK each.
    unresolved, _ = env.to_reconciliation(organisation, env.tenant(), "unresolved")
    assert env.observer.refused(
        "UPDATE {s}.jobs_job SET unresolved_step_id = NULL WHERE id = %s", [unresolved]
    ) == ("23514", "jobs_job_unresolved_step_when_reconciling"), (
        "a job in needs_reconciliation lost its unresolved step"
    )
    assert env.observer.refused(
        "UPDATE {s}.jobs_job SET unresolved_operation_ref = NULL WHERE id = %s", [unresolved]
    ) == ("23514", "jobs_job_unresolved_operation_when_reconciling"), (
        "a job in needs_reconciliation lost its unresolved operation"
    )
    refused_inside = deciding.call(
        "in_transaction",
        call="decide",
        arguments={"principal": operator, "decision": env.decision(waiting)},
    )
    assert (
        refused_inside,
        env.observer.count("jobs_jobreconciliationdecision", "job_id = %s", [waiting]),
        env.observer.audit_count("job.reconciliation_decided", waiting),
        env.observer.status(waiting),
    ) == ({"returned": refusal("not_in_reconciliation")}, 0, 0, "queued"), (
        "a decision refused inside its caller's transaction wrote something once the caller committed"
    )

    # §5.4: a job leaves needs_reconciliation only on a decision of its own, inserted in the same
    # transaction, not the reference it already carried, and mapped to its new status; the insert
    # trigger forces the transaction identifier and keeps decided_at between the job's latest
    # dispatch and the insert.
    no_exit = ("23514", "jobs_job_reconciliation_exit")
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_job SET status = 'queued' WHERE id = %s", [unresolved]
        )
        == no_exit
    ), "a job left needs_reconciliation without a recorded decision"
    leave_queued = (
        "UPDATE {s}.jobs_job SET status = 'queued', reconciliation_decision_ref = %s WHERE id = %s"
    )
    leave_failed = (
        "UPDATE {s}.jobs_job SET status = 'failed', error_code = 'reconciliation_failed', "
        "reconciliation_decision_ref = %s WHERE id = %s"
    )
    template, parameters = _job_decision_row(
        env, unresolved, identity, exit_="resume", outcome="completed"
    )
    assert env.observer.refused(template, parameters) is None, (
        "a valid decision row could not be inserted for a job in needs_reconciliation"
    )
    assert env.observer.refused(leave_queued, [parameters[0], unresolved]) == no_exit, (
        "a job left needs_reconciliation on a decision committed in an earlier transaction"
    )
    foreign_job, _ = env.to_reconciliation(organisation, env.tenant(), "foreign")
    template, parameters = _job_decision_row(
        env, foreign_job, identity, exit_="resume", outcome="completed"
    )
    assert (
        env.observer.refused_together(
            [(template, parameters), (leave_queued, [parameters[0], unresolved])]
        )
        == no_exit
    ), "a job left needs_reconciliation on a decision recorded for another job"
    back_unresolved = "UPDATE {s}.jobs_job SET status = 'needs_reconciliation' WHERE id = %s"
    template, parameters = _job_decision_row(
        env, unresolved, identity, exit_="resume", outcome="completed"
    )
    assert (
        env.observer.refused_together(
            [
                (template, parameters),
                (leave_queued, [parameters[0], unresolved]),
                (back_unresolved, [unresolved]),
            ]
        )
        is None
    ), "a job that left on a decision could not become unresolved again in that transaction"
    template, parameters = _job_decision_row(
        env, unresolved, identity, exit_="resume", outcome="completed"
    )
    assert (
        env.observer.refused_together(
            [
                (template, parameters),
                (leave_queued, [parameters[0], unresolved]),
                (back_unresolved, [unresolved]),
                (leave_queued, [parameters[0], unresolved]),
            ]
        )
        == no_exit
    ), "a job left needs_reconciliation twice on one decision"
    template, parameters = _job_decision_row(
        env, unresolved, identity, exit_="resume", outcome="completed"
    )
    assert (
        env.observer.refused_together(
            [(template, parameters), (leave_failed, [parameters[0], unresolved])]
        )
        == no_exit
    ), "a job whose decision resumes it was failed"
    template, parameters = _job_decision_row(
        env, unresolved, identity, exit_="fail", outcome="partial"
    )
    assert (
        env.observer.refused_together(
            [(template, parameters), (leave_queued, [parameters[0], unresolved])]
        )
        == no_exit
    ), "a job whose decision fails it was returned to queued"
    template, parameters = _job_decision_row(
        env, unresolved, identity, exit_="fail", outcome="partial", decided_txid=1
    )
    assert env.observer.inserted_under(
        template, parameters, "decided_txid", "jobs_jobreconciliationdecision"
    ), "a job decision row kept the transaction identifier its insert supplied"
    invalid = ("23514", "jobs_jobreconciliationdecision_valid")
    template, parameters = _job_decision_row(
        env,
        unresolved,
        identity,
        exit_="fail",
        outcome="partial",
        decided_at=env.observer.now() + dt.timedelta(hours=1),
    )
    assert env.observer.refused(template, parameters) == invalid, (
        "a job decision row decided after its insert was inserted"
    )
    unresolved_dispatched_at = env.observer.value(
        "SELECT max(dispatched_at) FROM {s}.jobs_jobdispatch WHERE job_id = %s", [unresolved]
    )
    template, parameters = _job_decision_row(
        env,
        unresolved,
        identity,
        exit_="fail",
        outcome="partial",
        decided_at=unresolved_dispatched_at - dt.timedelta(minutes=1),
    )
    assert env.observer.refused(template, parameters) == invalid, (
        "a job decision row decided before its job's latest dispatch was inserted"
    )


@job_queue_acceptance("A3-13")
def test_a3_13_realm_jobs_wait_for_deliveries_that_leave_reconciliation_only_by_decision(
    queue_env: QueueEnv,
) -> None:
    env = queue_env
    organisation, other_organisation = env.organisation(), env.organisation()
    operator = env.staff_principal(organisation)
    identity = str(operator["identity_id"])
    runner = env.thread_actor()
    realm_change = env.enqueue(runner, env.request("realm_update", organisation))
    other_change = env.enqueue(runner, env.request("realm_update", other_organisation))
    delivery = str(
        env.observer.value(
            "INSERT INTO {s}.outbox_outboxdelivery (id, organisation_id, category, changes_realm, "
            "status, started_at, created_at, updated_at) VALUES (gen_random_uuid(), %s, "
            "'identity_user_operation', true, 'in_flight', clock_timestamp(), now(), now()) "
            "RETURNING id",
            [organisation],
        )
    )
    refused = runner.call("claim", job_id=realm_change)
    assert refused["outcome"] == "refused", (
        "a realm job was claimed while a realm-changing delivery of its organisation was in flight"
    )
    assert refused["reason"] == "delivery_in_flight", (
        "a realm job behind an in-flight delivery was refused for another reason"
    )
    # Only a delivery that changes the realm holds a realm job back.
    env.observer.rows(
        "INSERT INTO {s}.outbox_outboxdelivery (id, organisation_id, category, changes_realm, "
        "status, started_at, created_at, updated_at) VALUES (gen_random_uuid(), %s, 'message', "
        "false, 'in_flight', clock_timestamp(), now(), now()) RETURNING id",
        [other_organisation],
    )
    assert runner.call("claim", job_id=other_change)["outcome"] == "claimed", (
        "a realm job was refused for a delivery in flight that does not change the realm"
    )
    undeletable = ("23514", "outbox_delivery_delete_refused")
    assert (
        env.observer.refused("DELETE FROM {s}.outbox_outboxdelivery WHERE id = %s", [delivery])
        == undeletable
    ), "a delivery in flight was deleted"
    frozen = ("23514", "outbox_delivery_frozen")
    whole_identity = (
        "UPDATE {s}.outbox_outboxdelivery SET changes_realm = false, category = 'message', "
        "organisation_id = %s, started_at = started_at - interval '1 hour' WHERE id = %s"
    )
    assert env.observer.refused(whole_identity, [other_organisation, delivery]) == frozen, (
        "a delivery in flight changed its whole identity"
    )
    assert (
        env.observer.refused(
            "UPDATE {s}.outbox_outboxdelivery SET changes_realm = false WHERE id = %s", [delivery]
        )
        == frozen
    ), "a realm-changing delivery in flight stopped changing the realm"
    assert (
        env.observer.refused(
            "UPDATE {s}.outbox_outboxdelivery SET category = 'message' WHERE id = %s", [delivery]
        )
        == frozen
    ), "a delivery in flight changed its category"
    assert (
        env.observer.refused(
            "UPDATE {s}.outbox_outboxdelivery SET organisation_id = %s WHERE id = %s",
            [other_organisation, delivery],
        )
        == frozen
    ), "a delivery in flight changed its organisation"
    assert (
        env.observer.refused(
            "UPDATE {s}.outbox_outboxdelivery SET started_at = started_at - interval '1 hour' "
            "WHERE id = %s",
            [delivery],
        )
        == frozen
    ), "a delivery in flight had its start moved earlier"
    in_flight = env.decision(delivery)
    assert runner.try_call("decide_delivery", principal=operator, decision=in_flight) == refusal(
        "not_in_reconciliation"
    ), "a delivery decision was recorded on a delivery in flight"
    invalid = ("23514", "outbox_deliverydecision_valid")
    _, template, parameters = _delivery_decision_row(env, delivery, identity)
    assert env.observer.refused(template, parameters) == invalid, (
        "a decision row was inserted for a delivery not in needs_reconciliation"
    )
    never_started = (
        "INSERT INTO {s}.outbox_outboxdelivery (id, organisation_id, category, changes_realm, "
        "status, created_at, updated_at) VALUES (gen_random_uuid(), %s, 'message', false, %s, "
        "now(), now())"
    )
    unstarted = ("23514", "outbox_delivery_started_when_in_flight")
    assert env.observer.refused(never_started, [other_organisation, "in_flight"]) == unstarted, (
        "a delivery that never started was recorded as in flight"
    )
    assert (
        env.observer.refused(never_started, [other_organisation, "needs_reconciliation"])
        == unstarted
    ), "a delivery that never started was recorded as unresolved"

    assert (
        env.observer.refused(
            "UPDATE {s}.outbox_outboxdelivery SET status = 'needs_reconciliation' WHERE id = %s",
            [delivery],
        )
        is None
    ), "a delivery could not enter needs_reconciliation"
    assert runner.call("claim", job_id=realm_change)["outcome"] == "refused", (
        "a realm job was claimed while a realm-changing delivery of its organisation was unresolved"
    )
    # The delete refusal and the freeze hold in both states, not only in flight.
    assert (
        env.observer.refused("DELETE FROM {s}.outbox_outboxdelivery WHERE id = %s", [delivery])
        == undeletable
    ), "an unresolved delivery was deleted"
    assert env.observer.refused(whole_identity, [other_organisation, delivery]) == frozen, (
        "an unresolved delivery changed its whole identity"
    )
    assert (
        env.observer.refused(
            "UPDATE {s}.outbox_outboxdelivery SET changes_realm = false WHERE id = %s", [delivery]
        )
        == frozen
    ), "a realm-changing unresolved delivery stopped changing the realm"
    assert (
        env.observer.refused(
            "UPDATE {s}.outbox_outboxdelivery SET category = 'message' WHERE id = %s", [delivery]
        )
        == frozen
    ), "an unresolved delivery changed its category"
    assert (
        env.observer.refused(
            "UPDATE {s}.outbox_outboxdelivery SET organisation_id = %s WHERE id = %s",
            [other_organisation, delivery],
        )
        == frozen
    ), "an unresolved delivery changed its organisation"
    assert (
        env.observer.refused(
            "UPDATE {s}.outbox_outboxdelivery SET started_at = started_at - interval '1 hour' "
            "WHERE id = %s",
            [delivery],
        )
        == frozen
    ), "an unresolved delivery had its start moved earlier"
    no_exit = ("23514", "outbox_delivery_reconciliation_exit")
    assert (
        env.observer.refused(
            "UPDATE {s}.outbox_outboxdelivery SET status = 'succeeded' WHERE id = %s", [delivery]
        )
        == no_exit
    ), "a delivery left needs_reconciliation without a recorded decision"
    leave = (
        "UPDATE {s}.outbox_outboxdelivery SET status = %s, reconciliation_decision_ref = %s "
        "WHERE id = %s"
    )
    earlier, template, parameters = _delivery_decision_row(
        env, delivery, identity, exit_="fail", outcome="partial"
    )
    assert env.observer.refused(template, parameters) is None, (
        "a valid decision row could not be inserted for a delivery in needs_reconciliation"
    )
    assert env.observer.refused(leave, ["failed", earlier, delivery]) == no_exit, (
        "a delivery left needs_reconciliation on a decision committed in an earlier transaction"
    )
    # That committed `fail` decision, rewritten into a `resume` of this transaction, would carry
    # the delivery out: a decision row is immutable.
    immutable = ("23514", "outbox_deliverydecision_immutable")
    rewrite = (
        "UPDATE {s}.outbox_deliverydecision SET decided_txid = txid_current(), exit = 'resume', "
        "operation_outcome = 'completed' WHERE id = %s"
    )
    assert (
        env.observer.refused_together(
            [(rewrite, [earlier]), (leave, ["succeeded", earlier, delivery])]
        )
        == immutable
    ), "a delivery left needs_reconciliation on a committed decision rewritten to allow it"
    assert (
        env.observer.refused("DELETE FROM {s}.outbox_deliverydecision WHERE id = %s", [earlier])
        == immutable
    ), "a recorded delivery decision was deleted"
    # §7: the insert trigger's two comparisons with the clock allow its 5 minutes of tolerance, as
    # the function's do; a test session's own inserts reach the trigger alone. Asserted before the
    # early-clock exit below, whose decision sits within both tolerances too.
    unresolved = str(
        env.observer.value(
            "INSERT INTO {s}.outbox_outboxdelivery (id, organisation_id, category, changes_realm, "
            "status, started_at, created_at, updated_at) VALUES (gen_random_uuid(), %s, "
            "'message', false, 'needs_reconciliation', clock_timestamp(), now(), now()) "
            "RETURNING id",
            [other_organisation],
        )
    )
    started = env.observer.record("outbox_outboxdelivery", unresolved)["started_at"]
    _, template, parameters = _delivery_decision_row(
        env, unresolved, identity, compute_at=started - dt.timedelta(minutes=2)
    )
    assert env.observer.refused(template, parameters) is None, (
        "a decision row whose evidence predates the delivery's start within the tolerance was "
        "refused"
    )
    _, template, parameters = _delivery_decision_row(
        env, unresolved, identity, target_at=env.observer.now() + dt.timedelta(minutes=2)
    )
    assert env.observer.refused(template, parameters) is None, (
        "a decision row whose target read is observed within the tolerance after the decision "
        "was refused"
    )
    started_at = env.observer.record("outbox_outboxdelivery", delivery)["started_at"]
    # `decided_at` is forced to the database clock, so a decision made before its delivery started
    # exists only for a delivery whose writer's clock ran ahead: one started a few minutes from now.
    early_clock = str(
        env.observer.value(
            "INSERT INTO {s}.outbox_outboxdelivery (id, organisation_id, category, changes_realm, "
            "status, started_at, created_at, updated_at) VALUES (gen_random_uuid(), %s, "
            "'message', false, 'needs_reconciliation', clock_timestamp() + interval '8 minutes', "
            "now(), now()) RETURNING id",
            [other_organisation],
        )
    )
    observed = env.observer.record("outbox_outboxdelivery", early_clock)[
        "started_at"
    ] - dt.timedelta(minutes=4)
    hasty, template, parameters = _delivery_decision_row(
        env, early_clock, identity, compute_at=observed, target_at=observed
    )
    assert (
        env.observer.refused_together(
            [(template, parameters), (leave, ["succeeded", hasty, early_clock])]
        )
        == no_exit
    ), "a delivery left needs_reconciliation on a decision made before it started"
    failing, template, parameters = _delivery_decision_row(
        env, delivery, identity, exit_="fail", outcome="partial"
    )
    assert (
        env.observer.refused_together(
            [(template, parameters), (leave, ["pending", failing, delivery])]
        )
        == no_exit
    ), "a delivery left needs_reconciliation for a status its decision does not map to"
    done, template, parameters = _delivery_decision_row(env, delivery, identity)
    assert (
        env.observer.refused_together(
            [(template, parameters), (leave, ["pending", done, delivery])]
        )
        == no_exit
    ), "a delivery whose decision says its operation completed was returned to pending"
    undone, template, parameters = _delivery_decision_row(
        env, delivery, identity, outcome="no_effect"
    )
    assert (
        env.observer.refused_together(
            [(template, parameters), (leave, ["succeeded", undone, delivery])]
        )
        == no_exit
    ), "a delivery whose decision says its operation had no effect was marked succeeded"
    unresolved = (
        "INSERT INTO {s}.outbox_outboxdelivery (id, organisation_id, category, changes_realm, "
        "status, started_at, created_at, updated_at) VALUES (gen_random_uuid(), %s, 'message', "
        "false, 'needs_reconciliation', clock_timestamp(), now(), now()) RETURNING id"
    )
    nested = str(env.observer.value(unresolved, [other_organisation]))
    foreign, template, parameters = _delivery_decision_row(env, nested, identity)
    assert (
        env.observer.refused_together(
            [(template, parameters), (leave, ["succeeded", foreign, delivery])]
        )
        == no_exit
    ), "a delivery left needs_reconciliation on a decision recorded for another delivery"
    _, template, parameters = _delivery_decision_row(env, delivery, identity, decided_txid=1)
    assert env.observer.inserted_under(
        template, parameters, "decided_txid", "outbox_deliverydecision"
    ), "a decision row kept the transaction identifier its insert supplied"
    _, template, parameters = _delivery_decision_row(env, delivery, identity, outcome="partial")
    assert env.observer.refused(template, parameters) == (
        "23514",
        "outbox_deliverydecision_partial_only_fails",
    ), "a decision row that resumes a partial effect was inserted"

    absent = ("23514", "outbox_deliverydecision_evidence_present")
    _, template, parameters = _delivery_decision_row(
        env, delivery, identity, blank="compute_terminated_provider"
    )
    assert env.observer.refused(template, parameters) == absent, (
        "a decision row whose compute evidence names no provider was inserted"
    )
    _, template, parameters = _delivery_decision_row(
        env, delivery, identity, blank="compute_terminated_resource_id"
    )
    assert env.observer.refused(template, parameters) == absent, (
        "a decision row whose compute evidence names no resource was inserted"
    )
    _, template, parameters = _delivery_decision_row(
        env, delivery, identity, blank="compute_terminated_request_id"
    )
    assert env.observer.refused(template, parameters) == absent, (
        "a decision row whose compute evidence names no request was inserted"
    )
    _, template, parameters = _delivery_decision_row(
        env, delivery, identity, blank="target_read_provider"
    )
    assert env.observer.refused(template, parameters) == absent, (
        "a decision row whose target read names no provider was inserted"
    )
    _, template, parameters = _delivery_decision_row(
        env, delivery, identity, blank="target_read_resource_id"
    )
    assert env.observer.refused(template, parameters) == absent, (
        "a decision row whose target read names no resource was inserted"
    )
    _, template, parameters = _delivery_decision_row(
        env, delivery, identity, blank="target_read_request_id"
    )
    assert env.observer.refused(template, parameters) == absent, (
        "a decision row whose target read names no request was inserted"
    )

    now = env.observer.now()
    between = started_at + (now - started_at) / 2
    _, template, parameters = _delivery_decision_row(
        env, delivery, identity, compute_at=started_at - dt.timedelta(minutes=10)
    )
    assert env.observer.refused(template, parameters) == invalid, (
        "a decision row whose evidence predates the delivery's start was inserted"
    )
    _, template, parameters = _delivery_decision_row(
        env, delivery, identity, compute_at=now, target_at=between
    )
    assert env.observer.refused(template, parameters) == invalid, (
        "a decision row whose target read predates its compute evidence was inserted"
    )
    _, template, parameters = _delivery_decision_row(
        env, delivery, identity, compute_at=now, target_at=now + dt.timedelta(hours=1)
    )
    assert env.observer.refused(template, parameters) == invalid, (
        "a decision row whose target read is observed after the decision was inserted"
    )
    # The insert trigger measures that order against a `decided_at` of its own, not the writer's.
    next_year = env.observer.now() + dt.timedelta(days=365)
    _, template, parameters = _delivery_decision_row(
        env, delivery, identity, compute_at=next_year, target_at=next_year, decided_at=next_year
    )
    assert env.observer.refused(template, parameters) == invalid, (
        "a decision row's evidence was checked against the decided_at its insert supplied"
    )

    missing = env.decision(delivery)
    missing["target_read"]["resource_id"] = ""
    assert runner.try_call("decide_delivery", principal=operator, decision=missing) == refusal(
        "evidence_missing"
    ), "a delivery decision without a complete target read was accepted"
    no_request = env.decision(delivery)
    no_request["compute_terminated"]["request_id"] = ""
    assert runner.try_call("decide_delivery", principal=operator, decision=no_request) == refusal(
        "evidence_missing"
    ), "a delivery decision without the compute's request identifier was accepted"
    disordered = refusal("evidence_out_of_order")
    early = env.decision(delivery, compute=env.evidence(started_at - dt.timedelta(minutes=10)))
    assert runner.try_call("decide_delivery", principal=operator, decision=early) == disordered, (
        "a delivery decision whose evidence predates the delivery's start was accepted"
    )
    backwards = env.decision(delivery, compute=env.evidence(now), target=env.evidence(between))
    assert (
        runner.try_call("decide_delivery", principal=operator, decision=backwards) == disordered
    ), "a delivery decision whose target read predates its compute evidence was accepted"
    ahead = env.decision(
        delivery, compute=env.evidence(now), target=env.evidence(now + dt.timedelta(hours=1))
    )
    assert runner.try_call("decide_delivery", principal=operator, decision=ahead) == disordered, (
        "a delivery decision with evidence observed after the decision was accepted"
    )
    support = env.staff_principal(organisation, roles=("staff_support",))
    by_support = env.decision(delivery)
    assert runner.try_call("decide_delivery", principal=support, decision=by_support) == refusal(
        "role_missing"
    ), "a delivery decision by a role other than staff_operator was accepted"
    partly = env.decision(delivery, outcome="partial")
    assert runner.try_call("decide_delivery", principal=operator, decision=partly) == refusal(
        "partial_resume"
    ), "a delivery decision that resumes a partial effect was accepted"
    # Two defects at once: the refusal names the first in the order the specification fixes.
    roleless = env.decision(delivery)
    roleless["compute_terminated"]["provider"] = ""
    assert runner.try_call("decide_delivery", principal=support, decision=roleless) == refusal(
        "role_missing"
    ), (
        "a delivery decision with two defects was not refused for the role before the missing evidence"
    )
    incomplete = env.decision(delivery, compute=env.evidence(started_at - dt.timedelta(minutes=10)))
    incomplete["target_read"]["resource_id"] = ""
    assert runner.try_call("decide_delivery", principal=operator, decision=incomplete) == refusal(
        "evidence_missing"
    ), (
        "a delivery decision with two defects was not refused for the missing evidence before "
        "its order"
    )
    early_partial = env.decision(
        delivery, outcome="partial", compute=env.evidence(started_at - dt.timedelta(minutes=10))
    )
    assert runner.try_call(
        "decide_delivery", principal=operator, decision=early_partial
    ) == refusal("evidence_out_of_order"), (
        "a delivery decision with two defects was not refused for the evidence order before the "
        "partial resume"
    )
    assert runner.call("claim", job_id=realm_change)["outcome"] == "refused", (
        "a realm job was claimed after a refused delivery decision"
    )

    # A delivery writer's clock may be ahead while both evidence times still fit the tolerance.
    # The function must refuse before inserting a decision or attempting the guarded exit.
    future_start = str(
        env.observer.value(
            "INSERT INTO {s}.outbox_outboxdelivery (id, organisation_id, category, changes_realm, "
            "status, started_at, created_at, updated_at) VALUES (gen_random_uuid(), %s, "
            "'message', false, 'needs_reconciliation', clock_timestamp() + interval '4 minutes', "
            "now(), now()) RETURNING id",
            [other_organisation],
        )
    )
    future_before = env.observer.record("outbox_outboxdelivery", future_start)
    decisions_before = env.observer.value("SELECT count(*) FROM {s}.outbox_deliverydecision")
    future_decision = env.decision(future_start)
    assert runner.try_call(
        "decide_delivery", principal=operator, decision=future_decision
    ) == refusal("evidence_out_of_order"), (
        "a delivery whose start is in the future did not return the evidence-order refusal"
    )
    assert runner.try_call(
        "decide_delivery", principal=support, decision=future_decision
    ) == refusal("role_missing"), "a future delivery start took precedence over the missing role"
    missing_future = env.decision(future_start)
    missing_future["compute_terminated"]["provider"] = ""
    assert runner.try_call(
        "decide_delivery", principal=operator, decision=missing_future
    ) == refusal("evidence_missing"), (
        "a future delivery start took precedence over missing evidence"
    )
    assert runner.try_call(
        "decide_delivery",
        principal=operator,
        decision=env.decision(future_start, outcome="partial"),
    ) == refusal("evidence_out_of_order"), (
        "partial resume took precedence over a future delivery start"
    )
    assert runner.call(
        "in_transaction",
        call="decide_delivery",
        arguments={"principal": operator, "decision": future_decision},
        probe="future-delivery-refusal",
    ) == {"returned": refusal("evidence_out_of_order")}, (
        "a future delivery start did not return its refusal inside the caller's transaction"
    )
    assert env.probe_count("future-delivery-refusal") == 1, (
        "a future-start delivery refusal prevented its caller from committing an unrelated write"
    )
    assert env.observer.record("outbox_outboxdelivery", future_start) == future_before, (
        "a future-start delivery refusal changed the delivery"
    )
    assert (
        env.observer.value("SELECT count(*) FROM {s}.outbox_deliverydecision") == decisions_before
    ), "a future-start delivery refusal inserted a decision"

    # One decision serves one exit, even inside one transaction: a delivery that left on it and
    # became unresolved again cannot leave on it a second time.
    back_in_flight = "UPDATE {s}.outbox_outboxdelivery SET status = 'in_flight' WHERE id = %s"
    back_unresolved = (
        "UPDATE {s}.outbox_outboxdelivery SET status = 'needs_reconciliation' WHERE id = %s"
    )
    once = str(env.observer.value(unresolved, [other_organisation]))
    spent, template, parameters = _delivery_decision_row(env, once, identity, outcome="no_effect")
    assert (
        env.observer.refused_together(
            [
                (template, parameters),
                (leave, ["pending", spent, once]),
                (back_in_flight, [once]),
                (back_unresolved, [once]),
            ]
        )
        is None
    ), "a delivery that left on a decision could not become unresolved again in that transaction"
    twice = str(env.observer.value(unresolved, [other_organisation]))
    reused, template, parameters = _delivery_decision_row(env, twice, identity, outcome="no_effect")
    assert (
        env.observer.refused_together(
            [
                (template, parameters),
                (leave, ["pending", reused, twice]),
                (back_in_flight, [twice]),
                (back_unresolved, [twice]),
                (leave, ["pending", reused, twice]),
            ]
        )
        == no_exit
    ), "a delivery left needs_reconciliation twice on one decision"

    # A decision function called inside its caller's transaction inserts under a savepoint.
    inner, template, parameters = _delivery_decision_row(env, nested, identity)
    assert (
        env.observer.refused_together(
            [(template, parameters), (leave, ["succeeded", inner, nested])], savepoint_first=True
        )
        is None
    ), "a delivery could not leave on a decision inserted under a savepoint of its transaction"

    within = env.decision(
        delivery,
        compute=env.evidence(started_at - dt.timedelta(minutes=2)),
        target=env.evidence(env.observer.now() + dt.timedelta(minutes=2)),
    )
    assert runner.call("decide_delivery", principal=operator, decision=within) == RECORDED, (
        "a delivery decision with both pieces of evidence within the clock tolerance was refused"
    )
    decided = env.observer.record("outbox_outboxdelivery", delivery)
    assert (decided["status"], decided["reconciliation_decision_ref"] is not None) == (
        "succeeded",
        True,
    ), "a delivery decision did not move the delivery with its decision reference"
    # §7: the decision's audit row, written with it, and by no refused decision before it.
    audited = env.observer.rows(
        "SELECT actor_type, actor_id, organisation_id, metadata->>'exit', "
        "metadata->>'reconciliation_decision_ref' FROM {s}.audit_auditevent "
        "WHERE action = 'outbox_delivery.reconciliation_decided' AND target_urn = %s",
        ["urn:kodera:outbox_delivery:" + delivery],
    )
    assert [tuple(str(column) for column in row) for row in audited] == [
        ("staff", identity, organisation, "resume", str(decided["reconciliation_decision_ref"]))
    ], (
        "a delivery decision did not leave one outbox_delivery.reconciliation_decided audit row "
        "naming its staff identity, organisation, exit and decision"
    )

    # The function's two other exits: a resume with no effect returns the delivery to `pending`,
    # a fail marks it `failed`, each with its decision reference.
    exited: list[str] = []

    def exit_through_function(exit_: str, outcome: str) -> tuple[Any, str, bool]:
        exiting = str(env.observer.value(unresolved, [other_organisation]))
        exited.append(exiting)
        result = runner.try_call(
            "decide_delivery",
            principal=operator,
            decision=env.decision(exiting, exit=exit_, outcome=outcome),
        )
        left = env.observer.record("outbox_outboxdelivery", exiting)
        return result, left["status"], left["reconciliation_decision_ref"] is not None

    assert exit_through_function("resume", "no_effect") == (RECORDED, "pending", True), (
        "a delivery decision with no effect did not return the delivery to pending"
    )
    assert exit_through_function("fail", "partial") == (RECORDED, "failed", True), (
        "a delivery decision that fails the delivery did not mark it failed"
    )
    failed = env.observer.record("outbox_outboxdelivery", exited[-1])
    audited = env.observer.rows(
        "SELECT actor_type, actor_id, organisation_id, metadata->>'exit', "
        "metadata->>'reconciliation_decision_ref' FROM {s}.audit_auditevent "
        "WHERE action = 'outbox_delivery.reconciliation_decided' AND target_urn = %s",
        ["urn:kodera:outbox_delivery:" + exited[-1]],
    )
    assert [tuple(str(column) for column in row) for row in audited] == [
        ("staff", identity, other_organisation, "fail", str(failed["reconciliation_decision_ref"]))
    ], "a delivery decision that failed the delivery did not leave one audit row naming its exit"

    # §7: the audit row is written in the decision's transaction. A process killed while it waits
    # to write that row commits nothing of the decision: the delivery stays unresolved.
    killed_delivery = str(env.observer.value(unresolved, [other_organisation]))
    child = env.process_actor("killed-decision")
    with env.barrier("audit_auditevent") as barrier:
        pending = child.send(
            "decide_delivery", principal=operator, decision=env.decision(killed_delivery)
        )
        assert barrier.reached(child.backend_pid, pending), (
            "a delivery decision returned without waiting at the audit table the test had locked"
        )
        child.kill()
        env.observer.wait_backend_gone(child.backend_pid)
    killed = env.observer.record("outbox_outboxdelivery", killed_delivery)
    assert (killed["status"], killed["reconciliation_decision_ref"]) == (
        "needs_reconciliation",
        None,
    ), "killed at a delivery decision's audit row, the delivery left needs_reconciliation"
    assert (
        env.observer.count("outbox_deliverydecision", "delivery_id = %s", [killed_delivery]) == 0
    ), "killed at a delivery decision's audit row, its decision was committed"
    env.claimed(runner, realm_change)

    # §3.1: tenant_id is null exactly for the two realm kinds, one named CHECK per direction.
    template, parameters = _job_insert(env, organisation, "realm_update", env.tenant())
    assert env.observer.refused(template, parameters) == (
        "23514",
        "jobs_job_tenant_null_for_realm_kinds",
    ), "a realm job was stored with a tenant"
    template, parameters = _job_insert(env, organisation, "backup", None)
    assert env.observer.refused(template, parameters) == (
        "23514",
        "jobs_job_tenant_set_for_tenant_kinds",
    ), "a tenant job was stored without a tenant"

    # §7: the decision locks the delivery row FOR NO KEY UPDATE, and waits on it. Another writer
    # holding the row moves the delivery out with a decision of its own; one uncommitted insert
    # naming the delivery holds it FOR KEY SHARE, which is no reason to wait.
    unresolved_insert = (
        "INSERT INTO {s}.outbox_outboxdelivery (id, organisation_id, category, changes_realm, "
        "status, started_at, created_at, updated_at) VALUES (gen_random_uuid(), %s, 'message', "
        "false, 'needs_reconciliation', clock_timestamp(), now(), now()) RETURNING id"
    )
    raced = str(env.observer.value(unresolved_insert, [other_organisation]))
    with env.delivery_holder(raced) as holder:
        pending = runner.send("decide_delivery", principal=operator, decision=env.decision(raced))
        waited = wait_blocked(env.observer, runner.backend_pid, holder.info.backend_pid, pending)
        competing, template, parameters = _delivery_decision_row(env, raced, identity)
        holder.execute(sql(template, env.schema), parameters)
        holder.execute(sql(leave, env.schema), ["succeeded", competing, raced])
        holder.execute("COMMIT")
    assert attempt(pending) == refusal("not_in_reconciliation"), (
        "a delivery decision committed after the delivery left needs_reconciliation"
    )
    assert waited, "a delivery decision did not wait on the delivery row another transaction held"
    referenced = str(env.observer.value(unresolved_insert, [other_organisation]))
    with env.delivery_holder(referenced, key_share=True) as holder:
        pending = runner.send(
            "decide_delivery", principal=operator, decision=env.decision(referenced)
        )
        waited = wait_blocked(env.observer, runner.backend_pid, holder.info.backend_pid, pending)
    assert attempt(pending) == RECORDED, (
        "a delivery decision on a delivery an uncommitted insert referenced was refused"
    )
    assert not waited, (
        "a delivery decision waited on its delivery row because an uncommitted insert referenced it"
    )


@job_queue_acceptance("A3-14")
def test_a3_14_a_job_finishes_only_when_its_steps_and_dispatches_allow(
    queue_env: QueueEnv,
) -> None:
    env = queue_env
    organisation, tenant = env.organisation(), env.tenant()
    runner = env.thread_actor()
    job = env.enqueue(runner, env.request("backup", organisation, tenant))
    env.claimed(runner, job)
    env.run_steps(runner, job, (1,))
    assert runner.call("finish", job_id=job, status="succeeded") is False, (
        "a job finished succeeded with a step unfinished"
    )
    env.run_steps(runner, job, (2, 3))
    assert env.observer.audit_count("job.step_succeeded", job) == 3, (
        "a step that succeeded was not audited as job.step_succeeded"
    )
    assert runner.call("record_step", job_id=job, seq=4, status="running"), (
        "the claim could not set its last step running"
    )
    dispatch = runner.call("record_dispatch", job_id=job, seq=4, operation_ref="op-verify")
    assert dispatch is not None, "the claim could not record a dispatch"
    assert runner.call(
        "record_step",
        job_id=job,
        seq=4,
        status="succeeded",
        output_ref="object://synthetic/verify-age",
    ), "the claim could not mark its last step succeeded"
    assert (
        env.observer.value(
            "SELECT output_ref FROM {s}.jobs_jobstep WHERE job_id = %s AND seq = 4", [job]
        )
        == "object://synthetic/verify-age"
    ), "a step's output reference was not recorded with its success"
    assert runner.call("finish", job_id=job, status="succeeded") is False, (
        "a job finished succeeded with a dispatch open"
    )
    assert runner.call("finish", job_id=job, status="failed", error_code="step_failed") is False, (
        "a job finished failed with a dispatch open"
    )
    assert env.observer.status(job) == "running", "a refused finish changed the job's status"
    blank = runner.try_call(
        "close_dispatch", job_id=job, dispatch_id=dispatch, outcome="completed", evidence_ref=" "
    )
    closed_blank = env.observer.value(
        "SELECT closed_at IS NOT NULL FROM {s}.jobs_jobdispatch WHERE id = %s", [dispatch]
    )
    assert blank == RAISED and closed_blank is False, (
        "a dispatch was closed without a reference to its terminal proof"
    )
    # `partial` is an operation's outcome a decision may state, never a dispatch's (§5.4). The
    # function refuses it itself, as a programming error, before the table's `CHECK` could.
    outside = _raised_by(
        runner,
        "close_dispatch",
        job_id=job,
        dispatch_id=dispatch,
        outcome="partial",
        evidence_ref="proof",
    )
    assert outside == "close_dispatch raised ValueError: 'partial' is not a dispatch outcome", (
        "close_dispatch did not itself refuse an outcome outside a dispatch's closed set"
    )
    assert runner.call(
        "close_dispatch",
        job_id=job,
        dispatch_id=dispatch,
        outcome="completed",
        evidence_ref="proof",
    ), "the claim could not close its dispatch"
    # Nothing but every step done now stands between this claim and a finish: a status or an error
    # code finish_job never writes is a programming error, raised before any statement, so a
    # returned False keeps one meaning (§4.4). `cancelled` is a status of the enum, which no `CHECK`
    # of the table refuses; the two error codes would each meet one.
    assert (
        _raised_by(runner, "finish", job_id=job, status="cancelled"),
        env.observer.status(job),
    ) == ("finish raised ValueError: 'cancelled' is not a status finish_job writes", "running"), (
        "finish_job did not itself refuse a status other than succeeded or failed"
    )
    assert (
        _raised_by(runner, "finish", job_id=job, status="succeeded", error_code="step_failed"),
        env.observer.status(job),
    ) == ("finish raised ValueError: finish_job(succeeded) takes no error_code", "running"), (
        "finish_job did not itself refuse succeeded with an error code"
    )
    assert (
        _raised_by(runner, "finish", job_id=job, status="failed", error_code="no_such_code"),
        _raised_by(runner, "finish", job_id=job, status="failed"),
        env.observer.status(job),
    ) == (
        "finish raised ValueError: finish_job(failed) needs an error code of models.ERROR_CODES, "
        "not 'no_such_code'",
        "finish raised ValueError: finish_job(failed) needs an error code of models.ERROR_CODES, "
        "not None",
        "running",
    ), "finish_job did not itself refuse failed with an error code outside its closed set"
    assert runner.call("finish", job_id=job, status="succeeded"), (
        "a job with every step done and no dispatch open could not finish"
    )
    assert env.observer.status(job) == "succeeded", "a finished job is not succeeded"
    assert env.observer.audit_count("job.succeeded", job) == 1, (
        "a finished job emitted no job.succeeded"
    )
    assert env.observer.open_reservations(job) == [], "a finished job kept its reservation"

    failing_runner = env.thread_actor("failing")
    failing = env.enqueue(failing_runner, env.request("backup", organisation, env.tenant()))
    env.claimed(failing_runner, failing)
    assert failing_runner.call("record_step", job_id=failing, seq=1, status="running"), (
        "the second claim could not set its first step running"
    )
    assert failing_runner.call(
        "record_step", job_id=failing, seq=1, status="failed", error_code="step_failed"
    ), "the claim could not mark its first step failed"
    assert env.observer.audit_count("job.step_failed", failing) == 1, (
        "a step that failed was not audited as job.step_failed"
    )

    # §3.3: a lease exactly while leased or running, an error code exactly when failed; one named
    # CHECK per direction, each reached by a test session's own write.
    assert env.observer.refused(
        "UPDATE {s}.jobs_job SET lease_expires_at = NULL WHERE id = %s", [failing]
    ) == ("23514", "jobs_job_lease_while_claimed"), "a running job was left without a lease"
    assert env.observer.refused(
        "UPDATE {s}.jobs_job SET lease_expires_at = clock_timestamp() WHERE id = %s", [job]
    ) == ("23514", "jobs_job_no_lease_unless_claimed"), "a succeeded job was given a lease"
    assert env.observer.refused(
        "UPDATE {s}.jobs_job SET error_code = 'step_failed' WHERE id = %s", [job]
    ) == ("23514", "jobs_job_no_error_code_unless_failed"), (
        "a succeeded job was given an error code"
    )
    assert failing_runner.call(
        "finish", job_id=failing, status="failed", error_code="step_failed"
    ), "a job whose step failed could not finish failed"
    assert env.observer.advisory_locks(failing_runner.backend_pid) == set(), (
        "a top-level job that finished failed kept its live locks"
    )
    assert env.observer.refused(
        "UPDATE {s}.jobs_job SET error_code = NULL WHERE id = %s", [failing]
    ) == ("23514", "jobs_job_error_code_when_failed"), "a failed job was left without an error code"

    # §3.2: a dispatch is closed once and a reservation ends once, whoever writes them.
    close_once = ("23514", "jobs_jobdispatch_close_once")
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_jobdispatch SET closed_at = closed_at + interval '1 second' "
            "WHERE id = %s",
            [dispatch],
        )
        == close_once
    ), "a closed dispatch's closed_at was rewritten"
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_jobdispatch SET terminal_outcome = 'failed' WHERE id = %s",
            [dispatch],
        )
        == close_once
    ), "a closed dispatch's outcome was rewritten"
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_jobdispatch SET terminal_evidence_ref = 'rewritten' WHERE id = %s",
            [dispatch],
        )
        == close_once
    ), "a closed dispatch's evidence reference was rewritten"
    assert env.observer.refused(
        "UPDATE {s}.jobs_joblockreservation SET ended_at = ended_at + interval '1 second' "
        "WHERE job_id = %s",
        [job],
    ) == ("23514", "jobs_joblockreservation_end_once"), "an ended reservation's end was rewritten"

    # §4.4: an output reference goes with a step's end, never with `running`; a failed attempt's
    # reference stays in its job.step_failed metadata once the step ran again and succeeded. An
    # argument record_step never accepts is a programming error: it raises before any statement.
    retrying = env.thread_actor("retrying")
    retried = env.enqueue(retrying, env.request("backup", organisation, env.tenant()))
    env.claimed(retrying, retried)
    assert (
        _raised_by(
            retrying,
            "record_step",
            job_id=retried,
            seq=1,
            status="running",
            output_ref="object://synthetic/too-early",
        ),
        env.observer.step_status(retried, 1),
    ) == (
        "record_step raised ValueError: an output_ref goes with succeeded or failed, never with "
        "running",
        "pending",
    ), "a step was set running with an output reference"
    assert retrying.call("record_step", job_id=retried, seq=1, status="running"), (
        "the retrying claim could not set its first step running"
    )
    assert (
        _raised_by(
            retrying,
            "record_step",
            job_id=retried,
            seq=1,
            status="succeeded",
            error_code="step_failed",
        ),
        _raised_by(
            retrying,
            "record_step",
            job_id=retried,
            seq=1,
            status="running",
            error_code="step_failed",
        ),
        env.observer.step_status(retried, 1),
    ) == (
        "record_step raised ValueError: an error_code goes with failed, never with succeeded",
        "record_step raised ValueError: an error_code goes with failed, never with running",
        "running",
    ), "a step was recorded succeeded with an error code"
    assert retrying.call(
        "record_step",
        job_id=retried,
        seq=1,
        status="failed",
        error_code="step_failed",
        output_ref="object://synthetic/failed-attempt",
    ), "the retrying claim could not mark its first step failed with an output reference"
    assert retrying.call("record_step", job_id=retried, seq=1, status="running"), (
        "the retrying claim could not run its failed step again"
    )
    assert retrying.call(
        "record_step",
        job_id=retried,
        seq=1,
        status="succeeded",
        output_ref="object://synthetic/second-attempt",
    ), "the retrying claim could not mark its step succeeded on the second attempt"
    assert env.observer.rows(
        "SELECT metadata->>'output_ref' FROM {s}.audit_auditevent "
        "WHERE action = 'job.step_failed' AND job_id = %s",
        [retried],
    ) == [("object://synthetic/failed-attempt",)], (
        "a failed attempt's output reference was not kept in its job.step_failed metadata"
    )


@job_queue_acceptance("A3-15")
def test_a3_15_a_class_c_step_is_dispatched_once_per_resolution_cycle(
    queue_env: QueueEnv,
) -> None:
    env = queue_env
    organisation = env.organisation()
    operator = env.staff_principal(organisation)
    runner = env.thread_actor()
    job = env.enqueue(runner, env.request("backup", organisation, env.tenant()))
    env.claimed(runner, job)
    env.run_steps(runner, job, (1,))
    assert runner.call("record_step", job_id=job, seq=2, status="running"), (
        "the claim could not set its second step running"
    )
    snapshot = runner.call("record_dispatch", job_id=job, seq=2, operation_ref="op-snapshot-1")
    assert snapshot is not None, "the claim could not dispatch its second step"
    assert (
        runner.call("record_dispatch", job_id=job, seq=2, operation_ref="op-snapshot-2") is None
    ), "a second open dispatch was recorded on one job"
    # start_sub_job records a dispatch too (§4.4), and is held to each rule record_dispatch is.
    assert (
        runner.call(
            "start_sub_job",
            job_id=job,
            seq=2,
            kind="export",
            desired_spec_hash=digest("second-open"),
        )
        is None
    ), "a sub-job was started while a dispatch was open on the job"
    assert runner.call(
        "retarget_dispatch", job_id=job, dispatch_id=snapshot, operation_ref="op-snapshot-apply"
    ), "the claim could not retarget its open dispatch"
    assert env.observer.record("jobs_jobdispatch", snapshot)["operation_ref"] == (
        "op-snapshot-apply"
    ), "retargeting a dispatch did not replace its operation reference"
    assert env.observer.count("jobs_jobdispatch", "job_id = %s", [job]) == 1, (
        "retargeting a dispatch recorded another dispatch"
    )
    assert runner.call(
        "close_dispatch",
        job_id=job,
        dispatch_id=snapshot,
        outcome="completed",
        evidence_ref="proof",
    ), "the claim could not close its first dispatch"
    assert (
        runner.call("retarget_dispatch", job_id=job, dispatch_id=snapshot, operation_ref="op-late")
        is False
    ), "a closed dispatch was retargeted"
    assert runner.call("record_step", job_id=job, seq=2, status="succeeded"), (
        "the claim could not mark its second step succeeded"
    )
    assert runner.call("record_step", job_id=job, seq=3, status="running"), (
        "the claim could not set its class C step running"
    )
    first = runner.call("record_dispatch", job_id=job, seq=3, operation_ref="op-record-1")
    assert first is not None, "the claim could not dispatch its class C step once"
    assert runner.call(
        "close_dispatch", job_id=job, dispatch_id=first, outcome="failed", evidence_ref="proof"
    ), "the claim could not close its dispatch"
    assert runner.call("record_dispatch", job_id=job, seq=3, operation_ref="op-record-3") is None, (
        "a class C step was dispatched twice in one resolution cycle"
    )
    assert (
        runner.call(
            "start_sub_job", job_id=job, seq=3, kind="export", desired_spec_hash=digest("twice")
        )
        is None
    ), "a class C step started a sub-job after its dispatch in the same resolution cycle"

    cycle_runner = env.thread_actor("cycle")
    cycled = env.enqueue(cycle_runner, env.request("backup", organisation, env.tenant()))
    env.claimed(cycle_runner, cycled)
    env.run_steps(cycle_runner, cycled, (1, 2))
    assert cycle_runner.call("record_step", job_id=cycled, seq=3, status="running"), (
        "the cycled claim could not set its class C step running"
    )
    held = cycle_runner.call("record_dispatch", job_id=cycled, seq=3, operation_ref="op-cycle-1")
    assert held is not None, "the cycled claim could not dispatch its class C step"
    assert cycle_runner.call("hold_for_reconciliation", job_id=cycled, dispatch_id=held), (
        "the runner could not hold its class C step for reconciliation"
    )
    cycle_runner.call("release_live_locks", job_id=cycled)
    cycle_decision = env.decision(cycled, outcome="no_effect")
    assert cycle_runner.call("decide", principal=operator, decision=cycle_decision) == RECORDED, (
        "a no-effect resume of a class C step was refused"
    )
    resumed_runner = env.thread_actor("resumed")
    env.claimed(resumed_runner, cycled)
    assert resumed_runner.call("record_step", job_id=cycled, seq=3, status="running"), (
        "the resumed claim could not set its class C step running"
    )
    again = resumed_runner.call("record_dispatch", job_id=cycled, seq=3, operation_ref="op-cycle-2")
    assert again is not None, (
        "a class C step could not be dispatched again after a no-effect resume"
    )
    assert resumed_runner.call(
        "close_dispatch", job_id=cycled, dispatch_id=again, outcome="failed", evidence_ref="proof"
    ), "the resumed claim could not close its dispatch"
    assert (
        resumed_runner.call("record_dispatch", job_id=cycled, seq=3, operation_ref="op-cycle-3")
        is None
    ), "a class C step was dispatched twice after a no-effect resume"

    # The cycle survives a new claim: dispatched, closed no_effect, orphaned by an expired lease and
    # claimed again, the step is not dispatched a second time without a no-effect resume.
    orphan_runner = env.thread_actor("orphaned")
    orphaned = env.enqueue(orphan_runner, env.request("backup", organisation, env.tenant()))
    env.claimed(orphan_runner, orphaned)
    env.run_steps(orphan_runner, orphaned, (1, 2))
    assert orphan_runner.call("record_step", job_id=orphaned, seq=3, status="running"), (
        "the claim to be orphaned could not set its class C step running"
    )
    before = orphan_runner.call(
        "record_dispatch", job_id=orphaned, seq=3, operation_ref="op-orphan-1"
    )
    assert before is not None, "the claim to be orphaned could not dispatch its class C step"
    assert orphan_runner.call(
        "close_dispatch",
        job_id=orphaned,
        dispatch_id=before,
        outcome="no_effect",
        evidence_ref="proof",
    ), "the claim to be orphaned could not close its dispatch no_effect"
    orphan_runner.call("release_live_locks", job_id=orphaned)
    env.observer.expire_lease(orphaned)
    orphan_runner.call("sweep")
    assert env.observer.status(orphaned) == "orphaned", (
        "an expired claim whose class C dispatch was closed was not orphaned"
    )
    reclaiming = env.thread_actor("reclaiming")
    env.claimed(reclaiming, orphaned)
    assert reclaiming.call("record_step", job_id=orphaned, seq=3, status="running"), (
        "the new claim could not set its class C step running"
    )
    assert (
        reclaiming.call("record_dispatch", job_id=orphaned, seq=3, operation_ref="op-orphan-2")
        is None
    ), "a class C step was dispatched again by a new claim in the same resolution cycle"
    assert (
        reclaiming.call(
            "start_sub_job",
            job_id=orphaned,
            seq=3,
            kind="export",
            desired_spec_hash=digest("reclaimed"),
        )
        is None
    ), "a class C step started a sub-job under a new claim in the same resolution cycle"


@job_queue_acceptance("A3-16")
def test_a3_16_a_runner_write_waits_on_the_job_row_and_is_refused_once_it_moved(
    queue_env: QueueEnv,
) -> None:
    env = queue_env
    organisation, tenant = env.organisation(), env.tenant()
    runner = env.thread_actor()
    job = env.enqueue(runner, env.request("rotate_secret", organisation, tenant))
    env.claimed(runner, job)
    assert runner.call("record_step", job_id=job, seq=1, status="running"), (
        "the claim could not set its first step running"
    )
    # The test's session plays a sweep's transaction at the lease's last instant: it holds the row,
    # moves the job off the runner's claim, and commits while the runner's write is in flight.
    with env.row_holder(job) as holder:
        pending = runner.send("record_dispatch", job_id=job, seq=1, operation_ref="op-racing")
        waited = wait_blocked(env.observer, runner.backend_pid, holder.info.backend_pid, pending)
        holder.execute(
            sql(
                "UPDATE {s}.jobs_job SET status = 'orphaned', lease_expires_at = NULL "
                "WHERE id = %s",
                env.schema,
            ),
            [job],
        )
        holder.execute("COMMIT")
    result = pending.result()
    assert result is None, "a dispatch committed after the job left the runner's claim"
    assert env.observer.count("jobs_jobdispatch", "job_id = %s", [job]) == 0, (
        "a write that raced a status change left a dispatch row"
    )
    assert waited, "the runner's write did not wait on the job row a status change held"

    late = env.thread_actor("late")
    expiring = env.enqueue(late, env.request("rotate_secret", env.organisation(), env.tenant()))
    env.claimed(late, expiring)
    assert late.call("record_step", job_id=expiring, seq=1, status="running"), (
        "the second claim could not set its first step running"
    )
    # The lease ends at the instant the holder commits, after the runner's transaction began.
    with env.row_holder(expiring) as holder:
        racing = late.send("record_dispatch", job_id=expiring, seq=1, operation_ref="op-expiring")
        racing_waited = wait_blocked(
            env.observer, late.backend_pid, holder.info.backend_pid, racing
        )
        holder.execute(
            sql(
                "UPDATE {s}.jobs_job SET lease_expires_at = clock_timestamp() WHERE id = %s",
                env.schema,
            ),
            [expiring],
        )
        holder.execute("COMMIT")
    assert racing.result() is None, (
        "a write committed under a lease that expired while it waited on the job row"
    )
    assert racing_waited, "the runner's write did not wait on the job row whose lease was ended"

    # The blocker releases the rows unchanged: PostgreSQL does not evaluate the first statement's
    # predicate again, so only a re-check under the lock refuses the write. Each of the eight runner
    # writes waits here at once, on a job of its own, behind one session that holds all eight rows.
    quiet_organisation = env.organisation()
    names = ("renew", "step", "dispatch", "retarget", "sub-job", "close", "hold", "finish")
    writers = {name: env.thread_actor(name) for name in names}
    jobs = {
        name: env.enqueue(
            writers[name],
            env.request(
                "decommission" if name == "sub-job" else "rotate_secret",
                quiet_organisation,
                env.tenant(),
            ),
        )
        for name in names
    }
    for name in names:
        env.claimed(writers[name], jobs[name])
        assert writers[name].call("record_step", job_id=jobs[name], seq=1, status="running"), (
            "a claim could not set its first step running"
        )
    opened = {
        name: writers[name].call(
            "record_dispatch", job_id=jobs[name], seq=1, operation_ref="op-" + name
        )
        for name in ("retarget", "close", "hold")
    }
    assert all(opened.values()), "a claim could not record the dispatch its late write needs"
    env.observer.shorten_leases(list(jobs.values()), 3)
    with env.rows_holder(list(jobs.values())) as holder:
        outlasting = {
            "renew": writers["renew"].send("renew", job_id=jobs["renew"]),
            "step": writers["step"].send(
                "record_step", job_id=jobs["step"], seq=1, status="succeeded"
            ),
            "dispatch": writers["dispatch"].send(
                "record_dispatch", job_id=jobs["dispatch"], seq=1, operation_ref="op-outlasted"
            ),
            "retarget": writers["retarget"].send(
                "retarget_dispatch",
                job_id=jobs["retarget"],
                dispatch_id=opened["retarget"],
                operation_ref="op-apply",
            ),
            "sub-job": writers["sub-job"].send(
                "start_sub_job",
                job_id=jobs["sub-job"],
                seq=1,
                kind="export",
                desired_spec_hash=digest("outlasted"),
            ),
            "close": writers["close"].send(
                "close_dispatch",
                job_id=jobs["close"],
                dispatch_id=opened["close"],
                outcome="completed",
                evidence_ref="late-proof",
            ),
            "hold": writers["hold"].send(
                "hold_for_reconciliation", job_id=jobs["hold"], dispatch_id=opened["hold"]
            ),
            "finish": writers["finish"].send(
                "finish", job_id=jobs["finish"], status="failed", error_code="step_failed"
            ),
        }
        outlasted_waited = [
            wait_blocked(
                env.observer, writers[name].backend_pid, holder.info.backend_pid, outlasting[name]
            )
            for name in names
        ]
        env.observer.wait_leases_passed(list(jobs.values()))
        holder.execute("COMMIT")
    assert outlasting["dispatch"].result() is None, (
        "a write committed under a lease that expired while it waited on a row released unchanged"
    )
    assert outlasting["renew"].result() is False, (
        "a renewal succeeded under a lease that expired while it waited on a row released unchanged"
    )
    assert outlasting["step"].result() is False, (
        "a step was recorded under a lease that expired while it waited on a row released unchanged"
    )
    assert outlasting["retarget"].result() is False, (
        "a dispatch was retargeted under a lease that expired while it waited on a row released "
        "unchanged"
    )
    assert outlasting["sub-job"].result() is None, (
        "a sub-job was started under a lease that expired while it waited on a row released "
        "unchanged"
    )
    assert outlasting["close"].result() is False, (
        "a dispatch was closed under a lease that expired while it waited on a row released "
        "unchanged"
    )
    assert outlasting["hold"].result() is False, (
        "a job was held under a lease that expired while it waited on a row released unchanged"
    )
    assert outlasting["finish"].result() is False, (
        "a job was finished under a lease that expired while it waited on a row released unchanged"
    )
    assert all(outlasted_waited), "a runner write did not wait on the job row held past its lease"


@job_queue_acceptance("A3-17")
def test_a3_17_sub_jobs_hold_their_parents_decision_and_close_its_dispatch_when_they_end(
    queue_env: QueueEnv,
) -> None:
    env = queue_env
    organisation = env.organisation()
    operator = env.staff_principal(organisation)
    child_runner, sweeper = env.thread_actor("child"), env.thread_actor("sweeper")
    parent_runner, parent, sub_job = _parent_with_sub_job(env, organisation, "swept-parent")
    assert env.observer.job(sub_job)["lock_requested_at"] is None, (
        "a sub-job took a place in request order"
    )
    env.claimed(child_runner, sub_job)
    assert child_runner.call("record_step", job_id=sub_job, seq=1, status="running"), (
        "a sub-job could not set a step running under its running parent"
    )
    look = child_runner.call("record_dispatch", job_id=sub_job, seq=1, operation_ref="op-look")
    assert look is not None, "a sub-job could not record a dispatch under its running parent"
    parent_runner.call("release_live_locks", job_id=parent)
    env.end_session(parent_runner)
    env.observer.expire_lease(parent)
    sweeper.call("sweep")
    assert env.observer.status(parent) == "needs_reconciliation", (
        "an expired parent with a live sub-job was not held for reconciliation"
    )
    decision = env.decision(parent, exit="fail", outcome="no_effect")
    assert sweeper.call("decide", principal=operator, decision=decision) == refusal(
        "sub_job_not_terminal"
    ), "a decision was recorded while a sub-job of the job was not terminal"
    support = env.staff_principal(organisation, roles=("staff_support",))
    assert sweeper.call("decide", principal=support, decision=decision) == refusal(
        "sub_job_not_terminal"
    ), "a decision with two defects was not refused for the live sub-job before the role"
    # The parent stopped between the sub-job's look and its apply (§4.4): none of the four writes
    # that start an effect passes any more, and each report still does. The look's dispatch is
    # closed `no_effect`, with the look itself as the evidence, before the next dispatch is tried,
    # so that one is refused for the parent and not for a dispatch still open.
    assert (
        child_runner.call(
            "retarget_dispatch", job_id=sub_job, dispatch_id=look, operation_ref="op-apply"
        )
        is False
    ), "a sub-job retargeted a dispatch while its parent was not running"
    assert child_runner.call("renew", job_id=sub_job), (
        "a sub-job could not renew its lease while its parent was not running"
    )
    assert child_runner.call(
        "close_dispatch",
        job_id=sub_job,
        dispatch_id=look,
        outcome="no_effect",
        evidence_ref="op-look",
    ), "a sub-job could not close its dispatch while its parent was not running"
    assert (
        child_runner.call("record_dispatch", job_id=sub_job, seq=1, operation_ref="op-late") is None
    ), "a sub-job recorded a dispatch while its parent was not running"
    assert (
        child_runner.call(
            "start_sub_job",
            job_id=sub_job,
            seq=1,
            kind="export",
            desired_spec_hash=digest("grandchild"),
        )
        is None
    ), "a sub-job started a sub-job of its own while its parent was not running"
    assert child_runner.call("record_step", job_id=sub_job, seq=1, status="succeeded"), (
        "a sub-job could not report a step's end while its parent was not running"
    )
    assert child_runner.call("record_step", job_id=sub_job, seq=2, status="running") is False, (
        "a sub-job started a step while its parent was not running"
    )
    env.observer.expire_lease(sub_job)
    sweeper.call("sweep")
    row = env.observer.job(sub_job)
    assert (row["status"], row["error_code"]) == ("failed", "parent_not_running"), (
        "a stranded sub-job was not failed parent_not_running"
    )
    stranded_dispatch = env.observer.sub_job_dispatch(sub_job)
    assert stranded_dispatch["closed_at"] is not None, (
        "a terminal sub-job left its parent's dispatch open"
    )
    assert stranded_dispatch["terminal_outcome"] == "failed", (
        "the stranding pass closed a parent's dispatch other than failed"
    )
    assert stranded_dispatch["terminal_evidence_ref"] == stranded_dispatch["operation_ref"], (
        "the stranding pass closed a parent's dispatch without the reference to the sub-job"
    )
    assert env.observer.step_status(sub_job, 1) == "succeeded", (
        "the stranding pass changed a step of the sub-job it failed"
    )
    decision = env.decision(parent, exit="fail", outcome="no_effect")
    assert sweeper.call("decide", principal=operator, decision=decision) == RECORDED, (
        "a parent's decision was refused after its sub-jobs ended"
    )

    queued_runner, queued_parent, stranded = _parent_with_sub_job(
        env, organisation, "queued-parent"
    )
    queued_runner.call("release_live_locks", job_id=queued_parent)
    env.end_session(queued_runner)
    env.observer.expire_lease(queued_parent)
    sweeper.call("sweep")
    assert env.observer.job(stranded)["error_code"] == "parent_not_running", (
        "a queued sub-job stranded by its parent was not failed parent_not_running"
    )

    # Every other writer that ends a sub-job, each under a running parent of its own: the class C
    # step that starts the sub-job is dispatched once.
    worker = env.thread_actor("worker")
    _, _, failing = _parent_with_sub_job(env, organisation, "failing-sub-job")
    env.claimed(worker, failing)
    assert worker.call("finish", job_id=failing, status="failed", error_code="step_failed"), (
        "a sub-job under its running parent could not finish failed"
    )
    closed = env.observer.sub_job_dispatch(failing)
    assert closed["closed_at"] is not None, (
        "a sub-job's own terminal write left its parent's dispatch open"
    )
    assert closed["terminal_outcome"] == "failed", (
        "a failed sub-job closed its parent's dispatch other than failed"
    )
    assert closed["terminal_evidence_ref"] == closed["operation_ref"], (
        "a sub-job's own terminal write closed its parent's dispatch without the reference to it"
    )

    _, _, succeeding = _parent_with_sub_job(env, organisation, "succeeding-sub-job")
    env.claimed(worker, succeeding)
    env.run_steps(worker, succeeding, range(1, 9))
    assert worker.call("finish", job_id=succeeding, status="succeeded"), (
        "a sub-job whose steps all succeeded could not finish under its running parent"
    )
    succeeded_dispatch = env.observer.sub_job_dispatch(succeeding)
    assert succeeded_dispatch["terminal_outcome"] == "completed", (
        "a succeeded sub-job closed its parent's dispatch other than completed"
    )
    assert succeeded_dispatch["terminal_evidence_ref"] == succeeded_dispatch["operation_ref"], (
        "a succeeded sub-job closed its parent's dispatch without the reference to it"
    )

    _, _, exhausted = _parent_with_sub_job(env, organisation, "exhausted-sub-job")
    for _ in range(2):
        env.claimed(worker, exhausted)
        env.observer.expire_lease(exhausted)
        sweeper.call("sweep")
    row = env.observer.job(exhausted)
    assert (row["status"], row["error_code"]) == ("failed", "orphaned_exhausted"), (
        "a sub-job orphaned past its budget was not failed orphaned_exhausted"
    )
    exhausted_dispatch = env.observer.sub_job_dispatch(exhausted)
    assert exhausted_dispatch["closed_at"] is not None, (
        "a sub-job failed orphaned_exhausted left its parent's dispatch open"
    )
    assert exhausted_dispatch["terminal_outcome"] == "failed", (
        "a sub-job failed orphaned_exhausted closed its parent's dispatch other than failed"
    )
    assert exhausted_dispatch["terminal_evidence_ref"] == exhausted_dispatch["operation_ref"], (
        "a sub-job failed orphaned_exhausted closed its parent's dispatch without the reference "
        "to it"
    )

    _, _, held = _parent_with_sub_job(env, organisation, "held-sub-job")
    env.claimed(worker, held)
    assert worker.call("record_step", job_id=held, seq=1, status="running"), (
        "a sub-job could not set its first step running"
    )
    held_dispatch = worker.call("record_dispatch", job_id=held, seq=1, operation_ref="op-held")
    assert held_dispatch is not None, "a sub-job could not record a dispatch"
    assert worker.call("hold_for_reconciliation", job_id=held, dispatch_id=held_dispatch), (
        "a sub-job could not hold its own operation for reconciliation"
    )
    decision = env.decision(held, exit="fail", outcome="no_effect")
    assert sweeper.call("decide", principal=operator, decision=decision) == RECORDED, (
        "a fail decision on a sub-job with both pieces of evidence was refused"
    )
    decided_dispatch = env.observer.sub_job_dispatch(held)
    assert decided_dispatch["closed_at"] is not None, (
        "a fail decision on a sub-job left its parent's dispatch open"
    )
    assert decided_dispatch["terminal_outcome"] == "failed", (
        "a fail decision on a sub-job closed its parent's dispatch other than failed"
    )
    assert decided_dispatch["terminal_evidence_ref"] == decided_dispatch["operation_ref"], (
        "a fail decision on a sub-job closed its parent's dispatch without the reference to it"
    )

    # The two reports that end a sub-job's claim, each under a parent that stopped while its
    # sub-job was claimed: one holds its own open dispatch for reconciliation, the other finishes.
    holding_runner, holding_parent, holding = _parent_with_sub_job(
        env, organisation, "holding-sub-job"
    )
    env.claimed(worker, holding)
    assert worker.call("record_step", job_id=holding, seq=1, status="running"), (
        "the sub-job that will hold could not set its first step running"
    )
    unresolved = worker.call("record_dispatch", job_id=holding, seq=1, operation_ref="op-unknown")
    assert unresolved is not None, "the sub-job that will hold could not record its dispatch"
    finishing_runner, finishing_parent, finishing = _parent_with_sub_job(
        env, organisation, "finishing-sub-job"
    )
    env.claimed(worker, finishing)
    holding_runner.call("release_live_locks", job_id=holding_parent)
    finishing_runner.call("release_live_locks", job_id=finishing_parent)
    env.end_session(holding_runner)
    env.end_session(finishing_runner)
    env.observer.expire_lease(holding_parent)
    env.observer.expire_lease(finishing_parent)
    sweeper.call("sweep")
    assert (env.observer.status(holding_parent), env.observer.status(finishing_parent)) == (
        "needs_reconciliation",
        "needs_reconciliation",
    ), "two expired parents with a claimed sub-job each were not both held for reconciliation"
    assert worker.call("hold_for_reconciliation", job_id=holding, dispatch_id=unresolved), (
        "a sub-job could not hold its open dispatch for reconciliation while its parent was not "
        "running"
    )
    assert worker.call("finish", job_id=finishing, status="failed", error_code="step_failed"), (
        "a sub-job could not finish while its parent was not running"
    )


@job_queue_acceptance("A3-18")
def test_a3_18_a_due_scheduled_job_is_promoted_into_request_order(queue_env: QueueEnv) -> None:
    env = queue_env
    organisation, tenant = env.organisation(), env.tenant()
    holder, contender, sweeper = (
        env.thread_actor("holder"),
        env.thread_actor("contender"),
        env.thread_actor("sweeper"),
    )
    before = env.observer.now()
    later = before + dt.timedelta(hours=1)
    shared = env.enqueue(holder, env.request("backup", organisation, tenant))
    stored = env.observer.job(shared)["not_before"]
    assert stored is not None and before <= stored <= env.observer.now(), (
        "a job enqueued with no not_before did not store the instant it was created"
    )
    env.claimed(holder, shared)
    scheduled = env.enqueue(
        holder, env.request("rotate_secret", organisation, tenant, not_before=later)
    )
    assert env.observer.job(scheduled)["lock_requested_at"] is None, (
        "a job scheduled for later took a place in request order"
    )
    assert contender.call("claim", job_id=scheduled)["outcome"] == "refused", (
        "a job was claimed before its not_before"
    )
    assert env.observer.job(scheduled)["lock_requested_at"] is None, (
        "a claim promoted a scheduled job before it was due"
    )
    env.observer.make_due(scheduled)
    sweeper.call("sweep")
    assert env.observer.job(scheduled)["lock_requested_at"] is not None, (
        "a scheduled job that became due was not promoted into request order by the sweep"
    )
    # A later item's backoff moves `not_before` of a job that already holds a place: a claim by id
    # must refuse it for that, whatever else would have refused it.
    env.observer.defer(scheduled, later)
    deferred = contender.call("claim", job_id=scheduled)
    assert (deferred["outcome"], deferred.get("reason")) == ("refused", "not_claimable"), (
        "a placed job whose not_before was moved later was not refused not_claimable"
    )
    env.observer.make_due(scheduled)
    shared_later = env.enqueue(holder, env.request("backup", organisation, tenant))
    behind = contender.call("claim", job_id=shared_later)
    assert (behind["outcome"], behind.get("reason")) == ("refused", "earlier_request"), (
        "a later shared request was claimed ahead of a due scheduled exclusive request"
    )

    other_tenant = env.tenant()
    by_claim = env.enqueue(
        holder, env.request("rotate_secret", organisation, other_tenant, not_before=later)
    )
    env.observer.make_due(by_claim)
    contender.call("claim", job_id=scheduled)
    assert env.observer.job(by_claim)["lock_requested_at"] is not None, (
        "a claim did not promote a due scheduled job before deciding"
    )

    together = [
        env.enqueue(
            holder, env.request("rotate_secret", organisation, env.tenant(), not_before=later)
        )
        for _ in range(3)
    ]
    for job in together:
        env.observer.make_due(job)
    sweeper.call("sweep")
    places = {env.observer.job(job)["lock_requested_at"] for job in together}
    assert None not in places and len(places) == 1, (
        "three jobs one promotion statement promoted did not share one instant"
    )

    # §3.2: a place in request order is never cleared or moved earlier, whoever writes it.
    place_kept = ("23514", "jobs_job_place_kept")
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_job SET lock_requested_at = NULL WHERE id = %s", [scheduled]
        )
        == place_kept
    ), "a job's place in request order was cleared"
    assert (
        env.observer.refused(
            "UPDATE {s}.jobs_job SET lock_requested_at = lock_requested_at - interval '1 second' "
            "WHERE id = %s",
            [scheduled],
        )
        == place_kept
    ), "a job's place in request order moved earlier"


@job_queue_acceptance("A3-19")
def test_a3_19_a_decision_needs_the_role_and_both_pieces_of_evidence_in_order(
    queue_env: QueueEnv,
) -> None:
    env = queue_env
    organisation = env.organisation()
    operator = env.staff_principal(organisation)
    deciding = env.thread_actor("operator")
    job, dispatch = env.to_reconciliation(organisation, env.tenant(), "evidence")
    dispatched_at = env.observer.value(
        "SELECT dispatched_at FROM {s}.jobs_jobdispatch WHERE id = %s", [dispatch]
    )
    now = env.observer.now()
    between = dispatched_at + (now - dispatched_at) / 2

    no_compute = env.decision(job)
    no_compute["compute_terminated"]["provider"] = ""
    assert deciding.call("decide", principal=operator, decision=no_compute) == refusal(
        "evidence_missing"
    ), "a decision without evidence that the compute terminated was accepted"
    no_resource = env.decision(job)
    no_resource["target_read"]["resource_id"] = ""
    assert deciding.call("decide", principal=operator, decision=no_resource) == refusal(
        "evidence_missing"
    ), "a decision whose target read names no resource was accepted"
    too_early = env.decision(job, compute=env.evidence(dispatched_at - dt.timedelta(minutes=10)))
    assert deciding.call("decide", principal=operator, decision=too_early) == refusal(
        "evidence_out_of_order"
    ), (
        "a decision whose compute evidence predates the dispatch by more than the tolerance "
        "was accepted"
    )
    reversed_order = env.decision(job, compute=env.evidence(now), target=env.evidence(between))
    assert deciding.call("decide", principal=operator, decision=reversed_order) == refusal(
        "evidence_out_of_order"
    ), "a decision whose target read predates the compute evidence was accepted"
    future = env.decision(
        job, compute=env.evidence(now), target=env.evidence(now + dt.timedelta(hours=1))
    )
    assert deciding.call("decide", principal=operator, decision=future) == refusal(
        "evidence_out_of_order"
    ), "a decision with evidence observed after the decision was accepted"
    support = env.staff_principal(organisation, roles=("staff_support",))
    assert deciding.call("decide", principal=support, decision=env.decision(job)) == refusal(
        "role_missing"
    ), "a decision by a role other than staff_operator was accepted"
    partial = env.decision(job, outcome="partial")
    # A refusal is a returned refusal: the table's own `CHECK` raising through the call is not one.
    assert deciding.try_call("decide", principal=operator, decision=partial) == refusal(
        "partial_resume"
    ), "a resume with a partial outcome was accepted"
    # Two defects at once: the refusal names the first in the order the specification fixes.
    roleless = env.decision(job)
    roleless["compute_terminated"]["provider"] = ""
    assert deciding.call("decide", principal=support, decision=roleless) == refusal(
        "role_missing"
    ), "a decision with two defects was not refused for the role before the missing evidence"
    incomplete = env.decision(job, compute=env.evidence(dispatched_at - dt.timedelta(minutes=10)))
    incomplete["target_read"]["resource_id"] = ""
    assert deciding.call("decide", principal=operator, decision=incomplete) == refusal(
        "evidence_missing"
    ), "a decision with two defects was not refused for the missing evidence before its order"
    early_partial = env.decision(
        job, outcome="partial", compute=env.evidence(dispatched_at - dt.timedelta(minutes=10))
    )
    assert deciding.call("decide", principal=operator, decision=early_partial) == refusal(
        "evidence_out_of_order"
    ), (
        "a decision with two defects was not refused for the evidence order before the partial resume"
    )
    template, parameters = _job_decision_row(
        env, job, str(operator["identity_id"]), exit_="resume", outcome="partial"
    )
    assert env.observer.refused(template, parameters) == (
        "23514",
        "jobs_jobreconciliationdecision_partial_only_fails",
    ), "a job decision row that resumes a partial effect was inserted"
    assert env.observer.status(job) == "needs_reconciliation", (
        "a refused decision took the job out of needs_reconciliation"
    )
    assert env.observer.count("jobs_jobreconciliationdecision", "job_id = %s", [job]) == 0, (
        "a refused decision left a decision record"
    )
    assert env.observer.audit_count("job.reconciliation_decided", job) == 0, (
        "a refused decision was audited as decided"
    )
    within = env.decision(
        job,
        exit="fail",
        outcome="partial",
        compute=env.evidence(dispatched_at - dt.timedelta(minutes=2)),
        target=env.evidence(now + dt.timedelta(minutes=2)),
    )
    assert deciding.call("decide", principal=operator, decision=within) == RECORDED, (
        "a fail with a partial outcome and evidence within the clock tolerance was refused"
    )


@job_queue_acceptance("A3-20")
def test_a3_20_live_locks_are_released_on_demand_never_stacked_and_not_kept_on_cancel(
    queue_env: QueueEnv,
) -> None:
    env = queue_env
    organisation, tenant = env.organisation(), env.tenant()
    runner = env.thread_actor()
    job = env.enqueue(runner, env.request("rotate_secret", organisation, tenant))
    env.claimed(runner, job)
    env.observer.expire_lease(job)
    assert runner.call("renew", job_id=job) is False, (
        "the claim's expired lease was renewed before its locks were released"
    )
    runner.call("release_live_locks", job_id=job)
    assert env.observer.advisory_locks(runner.backend_pid) == set(), (
        "a released claim kept its live locks"
    )

    stacking = env.thread_actor("stacking")
    shared_tenant = env.tenant()
    first = env.enqueue(stacking, env.request("backup", organisation, shared_tenant))
    second = env.enqueue(stacking, env.request("backup", organisation, shared_tenant))
    env.claimed(stacking, first)
    refused = stacking.call("claim", job_id=second)
    assert refused["outcome"] == "refused", (
        "a claim succeeded on a session already holding a lock of its set"
    )
    assert refused["reason"] == "session_holds_lock", (
        "a claim on a session holding its lock was refused for another reason"
    )
    spread = env.thread_actor("spread")
    one = env.enqueue(spread, env.request("rotate_secret", organisation, env.tenant()))
    two = env.enqueue(spread, env.request("rotate_secret", organisation, env.tenant()))
    env.claimed(spread, one)
    beside = spread.call("claim", job_id=two)
    assert (beside["outcome"], beside.get("reason")) == ("refused", "session_holds_lock"), (
        "a claim succeeded on a session already holding its organisation lock"
    )

    cancelled_organisation, cancelled_tenant = env.organisation(), env.tenant()
    cancelled = env.thread_actor("cancelled")
    target = env.enqueue(
        cancelled, env.request("rotate_secret", cancelled_organisation, cancelled_tenant)
    )
    with env.barrier("jobs_joblockreservation") as barrier:
        pending = cancelled.send("claim", job_id=target)
        barrier.wait_blocked(cancelled.backend_pid, pending)
        assert len(env.observer.advisory_locks(cancelled.backend_pid)) == 2, (
            "the claim had not taken its live locks when it wrote its reservation"
        )
        env.observer.cancel(cancelled.backend_pid)
        with suppress(ActorError):
            pending.result()
    assert env.observer.advisory_locks(cancelled.backend_pid) == set(), (
        "a claim cancelled after taking its live locks kept them"
    )
    assert env.observer.status(target) == "queued", "a cancelled claim changed the job's status"

    # §4: the claim, the sweep and the eight runner writes refuse to run inside a transaction their
    # caller opened, before any statement: their locks and leases would outlive what they report.
    inside = env.thread_actor("inside")
    queued = env.enqueue(inside, env.request("rotate_secret", organisation, env.tenant()))
    assert inside.call(
        "in_transaction", call="claim", arguments={"job_id": queued}
    ) == _refused_inside("claim_job"), "claim_job ran inside a transaction its caller opened"
    assert inside.call("in_transaction", call="sweep", arguments={}) == _refused_inside(
        "sweep_expired_leases"
    ), "sweep_expired_leases ran inside a transaction its caller opened"
    env.claimed(inside, queued)
    unknown = str(uuid.uuid4())
    assert inside.call(
        "in_transaction", call="renew", arguments={"job_id": queued}
    ) == _refused_inside("renew_lease"), "renew_lease ran inside a transaction its caller opened"
    assert inside.call(
        "in_transaction",
        call="record_step",
        arguments={"job_id": queued, "seq": 1, "status": "running"},
    ) == _refused_inside("record_step"), "record_step ran inside a transaction its caller opened"
    assert inside.call(
        "in_transaction",
        call="record_dispatch",
        arguments={"job_id": queued, "seq": 1, "operation_ref": "op-inside"},
    ) == _refused_inside("record_dispatch"), (
        "record_dispatch ran inside a transaction its caller opened"
    )
    assert inside.call(
        "in_transaction",
        call="retarget_dispatch",
        arguments={"job_id": queued, "dispatch_id": unknown, "operation_ref": "op-inside-2"},
    ) == _refused_inside("retarget_dispatch"), (
        "retarget_dispatch ran inside a transaction its caller opened"
    )
    assert inside.call(
        "in_transaction",
        call="start_sub_job",
        arguments={
            "job_id": queued,
            "seq": 1,
            "kind": "export",
            "desired_spec_hash": digest("inside"),
        },
    ) == _refused_inside("start_sub_job"), (
        "start_sub_job ran inside a transaction its caller opened"
    )
    assert inside.call(
        "in_transaction",
        call="close_dispatch",
        arguments={
            "job_id": queued,
            "dispatch_id": unknown,
            "outcome": "completed",
            "evidence_ref": "proof-inside",
        },
    ) == _refused_inside("close_dispatch"), (
        "close_dispatch ran inside a transaction its caller opened"
    )
    assert inside.call(
        "in_transaction",
        call="hold_for_reconciliation",
        arguments={"job_id": queued, "dispatch_id": unknown},
    ) == _refused_inside("hold_for_reconciliation"), (
        "hold_for_reconciliation ran inside a transaction its caller opened"
    )
    assert inside.call(
        "in_transaction",
        call="finish",
        arguments={"job_id": queued, "status": "failed", "error_code": "step_failed"},
    ) == _refused_inside("finish_job"), "finish_job ran inside a transaction its caller opened"


@job_queue_acceptance("A3-21")
def test_a3_21_only_a_step_the_kind_marks_conditional_is_skipped(queue_env: QueueEnv) -> None:
    env = queue_env
    organisation, tenant = env.organisation(), env.tenant()
    runner = env.thread_actor()
    job = env.enqueue(runner, env.request("add_domain", organisation, tenant))
    assert env.observer.value(
        "SELECT conditional FROM {s}.jobs_jobstep WHERE job_id = %s AND seq = 7", [job]
    ), "the step the kind marks conditional was not recorded conditional"
    env.claimed(runner, job)
    assert runner.call("record_step", job_id=job, seq=1, status="skipped") is False, (
        "a step the kind does not mark conditional was skipped"
    )
    env.run_steps(runner, job, range(1, 6))
    assert runner.call("record_step", job_id=job, seq=7, status="skipped") is False, (
        "a conditional step was skipped before every lower step finished"
    )
    env.run_steps(runner, job, (6,))
    assert (
        _raised_by(
            runner,
            "record_step",
            job_id=job,
            seq=7,
            status="skipped",
            output_ref="object://synthetic/none",
        ),
        env.observer.step_status(job, 7),
    ) == (
        "record_step raised ValueError: an output_ref goes with succeeded or failed, never with "
        "skipped",
        "pending",
    ), "a conditional step was skipped with an output reference"
    assert runner.call("record_step", job_id=job, seq=7, status="skipped"), (
        "the claim could not skip a conditional step once every lower step finished"
    )
    assert env.observer.step_status(job, 7) == "skipped", "a skipped step was not recorded skipped"
    assert (
        runner.call("record_step", job_id=job, seq=7, status="running"),
        env.observer.step_status(job, 7),
    ) == (False, "skipped"), "a skipped step was set running"
    assert runner.call("record_step", job_id=job, seq=8, status="running"), (
        "the step after a skipped step could not run"
    )

    started = env.thread_actor("started")
    running = env.enqueue(started, env.request("add_domain", organisation, env.tenant()))
    env.claimed(started, running)
    env.run_steps(started, running, range(1, 7))
    assert started.call("record_step", job_id=running, seq=7, status="running"), (
        "the claim could not set its conditional step running"
    )
    assert started.call("record_step", job_id=running, seq=7, status="skipped") is False, (
        "a conditional step that was already running was skipped"
    )
    # A status record_step never writes is a programming error, raised before any statement.
    assert (
        _raised_by(started, "record_step", job_id=running, seq=7, status="compensated"),
        env.observer.step_status(running, 7),
    ) == (
        "record_step raised ValueError: record_step does not write compensated, which has no "
        "writer in A3",
        "running",
    ), "a step was recorded compensated, which nothing in this item may write"
    assert (
        _raised_by(started, "record_step", job_id=running, seq=7, status="cancelled"),
        env.observer.step_status(running, 7),
    ) == (
        "record_step raised ValueError: 'cancelled' is not a status record_step writes",
        "running",
    ), "record_step did not itself refuse a status it never writes"
    # A step ends only from `running` (§4.4): the next one never ran, and is recorded neither way.
    assert (
        started.call("record_step", job_id=running, seq=8, status="succeeded"),
        env.observer.step_status(running, 8),
    ) == (False, "pending"), "a step that was not running was recorded succeeded"
    assert (
        started.call(
            "record_step", job_id=running, seq=8, status="failed", error_code="step_failed"
        ),
        env.observer.step_status(running, 8),
    ) == (False, "pending"), "a step that was not running was recorded failed"


@job_queue_acceptance("A3-22")
def test_a3_22_a_parent_cannot_close_finish_or_be_orphaned_past_a_live_sub_job(
    queue_env: QueueEnv,
) -> None:
    env = queue_env
    organisation = env.organisation()
    parent_runner, sweeper = env.thread_actor("parent"), env.thread_actor("sweeper")
    parent = env.enqueue(parent_runner, env.request("decommission", organisation, env.tenant()))
    env.claimed(parent_runner, parent)
    assert parent_runner.call("record_step", job_id=parent, seq=1, status="running"), (
        "the parent could not set its first step running"
    )
    sub_job = parent_runner.call(
        "start_sub_job", job_id=parent, seq=1, kind="export", desired_spec_hash=digest("live")
    )
    assert sub_job is not None, "the parent could not start its sub-job"
    dispatch = str(env.observer.sub_job_dispatch(sub_job)["id"])
    assert (
        parent_runner.call(
            "close_dispatch",
            job_id=parent,
            dispatch_id=dispatch,
            outcome="completed",
            evidence_ref="the-parent-says-so",
        )
        is False
    ), "a parent closed the dispatch naming its live sub-job"
    assert (
        parent_runner.call(
            "retarget_dispatch", job_id=parent, dispatch_id=dispatch, operation_ref="op-parent"
        )
        is False
    ), "a parent retargeted the dispatch naming its sub-job"

    # The state a parent that closed that dispatch would leave, reached from the test's own session
    # (docs/specs/JOB_QUEUE.md §3.2): every later guard must still see the live sub-job.
    env.observer.rows(
        "UPDATE {s}.jobs_jobdispatch SET closed_at = clock_timestamp(), "
        "terminal_outcome = 'completed', terminal_evidence_ref = 'test-session' "
        "WHERE id = %s RETURNING id",
        [dispatch],
    )
    assert parent_runner.call("record_step", job_id=parent, seq=1, status="succeeded"), (
        "the parent could not mark its first step succeeded"
    )
    env.run_steps(parent_runner, parent, range(2, 6))
    assert parent_runner.call("finish", job_id=parent, status="succeeded") is False, (
        "a parent finished succeeded while its sub-job was not terminal"
    )
    assert (
        parent_runner.call("finish", job_id=parent, status="failed", error_code="step_failed")
        is False
    ), "a parent finished failed while its sub-job was not terminal"
    parent_runner.call("release_live_locks", job_id=parent)
    env.end_session(parent_runner)
    env.observer.expire_lease(parent)
    sweeper.call("sweep")
    assert env.observer.status(parent) == "needs_reconciliation", (
        "an expired parent was orphaned past its live sub-job because its dispatch was closed"
    )


@job_queue_acceptance("A3-23")
def test_a3_23_a_class_c_step_completed_in_an_earlier_cycle_runs_again_when_the_operator_says_so(
    queue_env: QueueEnv,
) -> None:
    env = queue_env
    organisation = env.organisation()
    operator = env.staff_principal(organisation)
    child_runner, deciding = env.thread_actor("child"), env.thread_actor("operator")
    parent_runner, parent, sub_job = _parent_with_sub_job(env, organisation, "held-parent")
    dispatch = str(env.observer.sub_job_dispatch(sub_job)["id"])
    assert child_runner.call("claim", job_id=sub_job)["outcome"] == "claimed", (
        "the sub-job of a running parent could not be claimed"
    )
    env.run_steps(child_runner, sub_job, range(1, 8))
    assert child_runner.call("record_step", job_id=sub_job, seq=8, status="running"), (
        "the sub-job could not set its last step running"
    )
    assert parent_runner.call("hold_for_reconciliation", job_id=parent, dispatch_id=dispatch), (
        "a parent could not hold the dispatch naming its sub-job for reconciliation"
    )
    parent_runner.call("release_live_locks", job_id=parent)
    # The operator's target read finds the sub-job's result gone: resume, with no effect. The
    # decision is called first and waits on the parent's row, which the test's session holds; the
    # sub-job ends during that wait, and its terminal write closes the parent's dispatch. A
    # `decided_at` read before the wait would date the decision before that closing.
    gone = env.decision(parent, outcome="no_effect")
    with env.row_holder(parent) as holder:
        deciding_gone = deciding.send("decide", principal=operator, decision=gone)
        decision_waited = wait_blocked(
            env.observer, deciding.backend_pid, holder.info.backend_pid, deciding_gone
        )
        assert child_runner.call("record_step", job_id=sub_job, seq=8, status="succeeded"), (
            "the sub-job could not report its last step's end under a held parent"
        )
        assert child_runner.call("finish", job_id=sub_job, status="succeeded"), (
            "the sub-job could not finish under a held parent"
        )
        # Read while the parent's row is still held: once released, the decision may commit.
        closed = env.observer.sub_job_dispatch(sub_job)
    assert closed["terminal_outcome"] == "completed", (
        "the sub-job that succeeded under a held parent did not close its dispatch completed"
    )
    assert deciding_gone.result() == RECORDED, (
        "a no-effect resume of a parent whose sub-job had ended was refused"
    )
    assert decision_waited, "a parent's decision did not wait on the job row the test held"
    decided_at = env.observer.value(
        "SELECT decided_at FROM {s}.jobs_jobreconciliationdecision WHERE job_id = %s", [parent]
    )
    assert decided_at > closed["closed_at"], (
        "a decision dated itself before a dispatch that closed while it waited for the job row"
    )
    assert env.observer.step_status(parent, 1) == "pending", (
        "a decision that contradicted the outcome its dispatch was closed with did not govern "
        "the step"
    )
    assert env.observer.sub_job_dispatch(sub_job)["terminal_outcome"] == "completed", (
        "a decision rewrote the outcome a sub-job's terminal write had closed the dispatch with"
    )
    recorded = env.observer.rows(
        "SELECT operation_outcome, dispatch_outcome_at_decision "
        "FROM {s}.jobs_jobreconciliationdecision WHERE job_id = %s",
        [parent],
    )
    assert recorded == [("no_effect", "completed")], (
        "a decision did not record the outcome its dispatch had already been closed with"
    )

    resumed = env.thread_actor("resumed")
    env.claimed(resumed, parent)
    assert env.observer.step_status(parent, 1) == "pending", (
        "a claim completed a class C step from a dispatch closed completed in an earlier cycle"
    )
    assert resumed.call("record_step", job_id=parent, seq=1, status="running"), (
        "the resumed parent could not set its class C step running again"
    )
    again = resumed.call(
        "start_sub_job", job_id=parent, seq=1, kind="export", desired_spec_hash=digest("again")
    )
    assert again is not None, "a class C step could not start its sub-job again in a new cycle"

    # A second cycle, closed `completed` and resumed `no_effect` like the first. The cycle a claim
    # reads starts at the step's latest such decision: a claim that bounded it by the first would
    # still count this cycle's dispatch, closed `completed` after that first decision, and
    # complete the step the operator has just said had no effect.
    second_child = env.thread_actor("second-child")
    second_dispatch = str(env.observer.sub_job_dispatch(again)["id"])
    env.claimed(second_child, again)
    env.run_steps(second_child, again, range(1, 9))
    assert resumed.call("hold_for_reconciliation", job_id=parent, dispatch_id=second_dispatch), (
        "the resumed parent could not hold its second sub-job's dispatch for reconciliation"
    )
    resumed.call("release_live_locks", job_id=parent)
    assert second_child.call("finish", job_id=again, status="succeeded"), (
        "the second sub-job could not finish under a held parent"
    )
    assert env.observer.sub_job_dispatch(again)["terminal_outcome"] == "completed", (
        "the second sub-job that succeeded under a held parent did not close its dispatch completed"
    )
    gone_again = env.decision(parent, outcome="no_effect")
    assert deciding.call("decide", principal=operator, decision=gone_again) == RECORDED, (
        "a second no-effect resume of a parent whose sub-job had ended was refused"
    )
    env.claimed(resumed, parent)
    assert env.observer.step_status(parent, 1) == "pending", (
        "a claim completed a class C step from a dispatch closed completed before its latest "
        "no-effect resume"
    )
    assert resumed.call("record_step", job_id=parent, seq=1, status="running"), (
        "the parent resumed a second time could not set its class C step running again"
    )
    third = resumed.call(
        "start_sub_job", job_id=parent, seq=1, kind="export", desired_spec_hash=digest("third")
    )
    assert third is not None, (
        "a class C step could not start its sub-job in the cycle its latest no-effect resume opened"
    )


@job_queue_acceptance("A3-24")
def test_a3_24_a_scanning_claim_reads_sub_jobs_then_unplaced_jobs_then_request_order(
    queue_env: QueueEnv,
) -> None:
    env = queue_env
    organisation = env.organisation()
    scanner, maker = env.thread_actor("scanner"), env.thread_actor("maker")
    _, _, first_sub_job = _parent_with_sub_job(env, organisation, "first-parent")
    first = scanner.call("claim")
    assert (first.get("outcome"), first.get("job_id")) == ("claimed", first_sub_job), (
        "a scanning claim never read a claimable sub-job"
    )

    placed = env.enqueue(maker, env.request("backup", organisation, env.tenant()))
    _, _, second_sub_job = _parent_with_sub_job(env, organisation, "second-parent")
    second = scanner.call("claim")
    assert (second.get("outcome"), second.get("job_id")) == ("claimed", second_sub_job), (
        "a scanning claim served a placed job ahead of a claimable sub-job"
    )

    failed_organisation, waiting_organisation = env.organisation(), env.organisation()
    realm = env.enqueue(maker, env.request("realm_create", failed_organisation))
    orphan = env.enqueue(
        maker, env.request("provision", failed_organisation, env.tenant(), depends_on=realm)
    )
    env.claimed(maker, realm)
    assert maker.call("finish", job_id=realm, status="failed", error_code="step_failed"), (
        "the realm job's claim could not fail it"
    )
    pending_realm = env.enqueue(maker, env.request("realm_create", waiting_organisation))
    waiting = env.enqueue(
        maker,
        env.request("provision", waiting_organisation, env.tenant(), depends_on=pending_realm),
    )
    served = scanner.call("claim")
    row = env.observer.job(orphan)
    assert (row["status"], row["error_code"]) == ("failed", "prerequisite_failed"), (
        "a scanning claim never read a job whose dependency had failed"
    )
    assert env.observer.audit_count("job.failed", orphan) == 1, (
        "a job a scanning claim failed prerequisite_failed emitted no job.failed"
    )
    assert env.observer.status(waiting) == "queued", (
        "a scanning claim changed a job still waiting on its dependency"
    )
    assert (served.get("outcome"), served.get("job_id")) == ("claimed", placed), (
        "a scanning claim stopped at a job it refused or failed instead of serving the next request"
    )


@job_queue_acceptance("A3-25")
def test_a3_25_no_claim_promotion_or_sweep_waits_on_a_held_row_or_skips_a_referenced_one(
    queue_env: QueueEnv,
) -> None:
    env = queue_env
    organisation = env.organisation()
    runner, sweeper, claimer = (
        env.thread_actor("runner"),
        env.thread_actor("sweeper"),
        env.thread_actor("claimer"),
    )
    later = env.observer.now() + dt.timedelta(hours=1)

    held, free, named_lease = (
        env.enqueue(runner, env.request("backup", organisation, env.tenant())) for _ in range(3)
    )
    for job in (held, free, named_lease):
        env.claimed(runner, job)
        runner.call("release_live_locks", job_id=job)
    env.end_session(runner)
    for job in (held, free):
        env.observer.expire_lease(job)
    with env.row_holder(held) as holder:
        sweeping = sweeper.send("sweep")
        sweep_waited = wait_blocked(
            env.observer, sweeper.backend_pid, holder.info.backend_pid, sweeping
        )
        during = None if sweep_waited else (env.observer.status(held), env.observer.status(free))
    sweeping.result()
    assert not sweep_waited, "the sweep waited on a job row another transaction held"
    assert during == ("leased", "orphaned"), (
        "the sweep did not pass over the held row and orphan the other expired job"
    )
    sweeper.call("sweep")
    assert env.observer.status(held) == "orphaned", (
        "the sweep after the row was released did not orphan it"
    )

    scheduled = env.enqueue(
        runner, env.request("rotate_secret", organisation, env.tenant(), not_before=later)
    )
    other = env.enqueue(runner, env.request("backup", organisation, env.tenant()))
    env.observer.make_due(scheduled)
    with env.row_holder(scheduled) as holder:
        claiming = claimer.send("claim", job_id=other)
        promotion_waited = wait_blocked(
            env.observer, claimer.backend_pid, holder.info.backend_pid, claiming
        )
    claimed = claiming.result()
    assert not promotion_waited, "a claim's promotion waited on a job row another transaction held"
    assert claimed["outcome"] == "claimed", (
        "a claim was refused because its promotion passed over an unrelated held row"
    )
    assert env.observer.job(scheduled)["lock_requested_at"] is None, (
        "the promotion wrote a job row another transaction held"
    )
    with env.row_holder(scheduled) as holder:
        sweeping = sweeper.send("sweep")
        sweep_promotion_waited = wait_blocked(
            env.observer, sweeper.backend_pid, holder.info.backend_pid, sweeping
        )
    sweeping.result()
    assert not sweep_promotion_waited, (
        "a sweep's promotion waited on a job row another transaction held"
    )
    sweeper.call("sweep")
    assert env.observer.job(scheduled)["lock_requested_at"] is not None, (
        "the promotion after the row was released did not promote the job it had passed over"
    )

    own_runner = env.thread_actor("own-row")
    own = env.enqueue(own_runner, env.request("backup", organisation, env.tenant()))
    with env.row_holder(own) as holder:
        claiming = own_runner.send("claim", job_id=own)
        claim_waited = wait_blocked(
            env.observer, own_runner.backend_pid, holder.info.backend_pid, claiming
        )
    denied = claiming.result()
    assert not claim_waited, "a claim waited on its job row another transaction held"
    assert (denied["outcome"], denied.get("reason")) == ("refused", "not_claimable"), (
        "a claim of a job row another transaction held was not refused not_claimable"
    )

    parent_runner, parent, sub_job = _parent_with_sub_job(env, organisation, "stranding")
    parent_runner.call("release_live_locks", job_id=parent)
    env.end_session(parent_runner)
    env.observer.expire_lease(parent)
    with env.row_holder(sub_job) as holder:
        sweeping = sweeper.send("sweep")
        stranding_waited = wait_blocked(
            env.observer, sweeper.backend_pid, holder.info.backend_pid, sweeping
        )
        stranded_during = None if stranding_waited else env.observer.status(sub_job)
    sweeping.result()
    assert not stranding_waited, (
        "the stranding pass waited on a sub-job row another transaction held"
    )
    assert (env.observer.status(parent), stranded_during) == ("needs_reconciliation", "queued"), (
        "the sweep did not hold the parent and pass over its held sub-job"
    )

    # An uncommitted insert that names a job holds FOR KEY SHARE on its row: that is no reason to
    # pass the job over, which FOR UPDATE SKIP LOCKED would do, nor to wait for it, which FOR UPDATE
    # would do. A claim, a runner's write, the promotion, the sweep, the stranding pass and a
    # decision each meet such a row here.
    with env.row_holder(own, key_share=True) as holder:
        referenced = own_runner.call("claim", job_id=own)
        assert referenced["outcome"] == "claimed", (
            "a claim was refused because an uncommitted insert referenced its job"
        )
        renewing = own_runner.send("renew", job_id=own)
        renewal_waited = wait_blocked(
            env.observer, own_runner.backend_pid, holder.info.backend_pid, renewing
        )
    renewed = renewing.result()
    assert not renewal_waited, (
        "a runner's renewal waited on its job row because an uncommitted insert referenced it"
    )
    # Neither waiting nor passing over: a renewal that skipped the row would refuse without a wait.
    assert renewed is True, (
        "a runner's renewal was refused because an uncommitted insert referenced its job"
    )
    with env.row_holder(sub_job, key_share=True):
        sweeper.call("sweep")
        stranded = env.observer.job(sub_job)["error_code"]
    assert stranded == "parent_not_running", (
        "the stranding pass passed over a sub-job because an uncommitted insert referenced it"
    )
    env.observer.expire_lease(named_lease)
    with env.row_holder(named_lease, key_share=True):
        sweeper.call("sweep")
        swept = env.observer.status(named_lease)
    assert swept == "orphaned", (
        "the sweep passed over an expired job because an uncommitted insert referenced it"
    )
    operator = env.staff_principal(organisation)
    unresolved, _ = env.to_reconciliation(organisation, env.tenant(), "referenced")
    verdict = env.decision(unresolved, exit="fail", outcome="no_effect")
    with env.row_holder(unresolved, key_share=True) as holder:
        deciding = claimer.send("decide", principal=operator, decision=verdict)
        decision_waited = wait_blocked(
            env.observer, claimer.backend_pid, holder.info.backend_pid, deciding
        )
    assert deciding.result() == RECORDED, (
        "a decision on a job an uncommitted insert referenced was refused"
    )
    assert not decision_waited, (
        "a decision waited on its job row because an uncommitted insert referenced it"
    )
    named = env.enqueue(
        runner, env.request("rotate_secret", organisation, env.tenant(), not_before=later)
    )
    env.observer.make_due(named)
    with env.row_holder(named, key_share=True):
        sweeper.call("sweep")
        promoted = env.observer.job(named)["lock_requested_at"]
    assert promoted is not None, (
        "the promotion passed over a job because an uncommitted insert referenced it"
    )

    # The seven other runner writes lock the job row FOR NO KEY UPDATE too: each is sent under a
    # live claim while a test session holds that row FOR KEY SHARE, and none of them waits.
    writer = env.thread_actor("key-share")
    written = env.enqueue(writer, env.request("backup", organisation, env.tenant()))
    env.claimed(writer, written)
    waited, stepped = _sent_under_key_share(
        env, writer, written, "record_step", job_id=written, seq=1, status="running"
    )
    assert not waited, (
        "a step write waited on its job row because an uncommitted insert referenced it"
    )
    waited, dispatch = _sent_under_key_share(
        env, writer, written, "record_dispatch", job_id=written, seq=1, operation_ref="op-share"
    )
    assert not waited, (
        "a dispatch write waited on its job row because an uncommitted insert referenced it"
    )
    waited, retargeted = _sent_under_key_share(
        env,
        writer,
        written,
        "retarget_dispatch",
        job_id=written,
        dispatch_id=dispatch,
        operation_ref="op-share-2",
    )
    assert not waited, (
        "a retarget waited on its job row because an uncommitted insert referenced it"
    )
    waited, closed = _sent_under_key_share(
        env,
        writer,
        written,
        "close_dispatch",
        job_id=written,
        dispatch_id=dispatch,
        outcome="completed",
        evidence_ref="proof-share",
    )
    assert not waited, (
        "a dispatch close waited on its job row because an uncommitted insert referenced it"
    )
    waited, finished = _sent_under_key_share(
        env, writer, written, "finish", job_id=written, status="failed", error_code="step_failed"
    )
    assert not waited, "a finish waited on its job row because an uncommitted insert referenced it"
    assert (stepped, dispatch is not None, retargeted, closed, finished) == (
        True,
        True,
        True,
        True,
        True,
    ), "a runner write was refused because an uncommitted insert referenced its job"
    parent_writer = env.thread_actor("key-share-parent")
    held_parent = env.enqueue(
        parent_writer, env.request("decommission", organisation, env.tenant())
    )
    env.claimed(parent_writer, held_parent)
    assert parent_writer.call("record_step", job_id=held_parent, seq=1, status="running"), (
        "a second parent could not set its first step running"
    )
    waited, started = _sent_under_key_share(
        env,
        parent_writer,
        held_parent,
        "start_sub_job",
        job_id=held_parent,
        seq=1,
        kind="export",
        desired_spec_hash=digest("key-share-sub-job"),
    )
    assert not waited, (
        "a sub-job start waited on its parent's job row because an uncommitted insert referenced it"
    )
    held_dispatch = env.observer.sub_job_dispatch(str(started))["id"]
    waited, held = _sent_under_key_share(
        env,
        parent_writer,
        held_parent,
        "hold_for_reconciliation",
        job_id=held_parent,
        dispatch_id=str(held_dispatch),
    )
    assert not waited, (
        "a hold for reconciliation waited on its job row because an uncommitted insert referenced it"
    )
    assert (started is not None, held) == (True, True), (
        "a parent's write was refused because an uncommitted insert referenced its job"
    )


@job_queue_acceptance("A3-26")
def test_a3_26_a_claim_checks_reservations_again_once_it_holds_its_live_locks(
    queue_env: QueueEnv,
) -> None:
    env = queue_env
    organisation = env.organisation()
    tenant_runner, realm_runner = env.thread_actor("tenant"), env.thread_actor("realm")
    earlier = env.enqueue(tenant_runner, env.request("rotate_secret", organisation, env.tenant()))
    realm_change = env.enqueue(tenant_runner, env.request("realm_update", organisation))
    # A realm job's first check reads reservations, then deliveries: the test's session stops it at
    # the delivery read, after the reservation read, and lets an earlier job be claimed meanwhile.
    with env.barrier("outbox_outboxdelivery", reads=True) as barrier:
        pending = realm_runner.send("claim", job_id=realm_change)
        assert barrier.reached(realm_runner.backend_pid, pending), (
            "a realm job's claim never waited at its read of the organisation's deliveries"
        )
        # Reservations first: a claim that read the deliveries first would see the reservation
        # written below in its first check, and pass this test with no second check at all.
        reads = env.observer.read_relations(realm_runner.backend_pid)
        assert "jobs_joblockreservation" in reads, (
            "a realm job's claim reached its delivery read before it had read the reservations"
        )
        env.claimed(tenant_runner, earlier)
        # Its live locks released, only the reservation it wrote stands against the realm job.
        tenant_runner.call("release_live_locks", job_id=earlier)
    result = pending.result()
    assert (result["outcome"], result.get("reason")) == ("refused", "reservation_conflict"), (
        "a realm job was claimed past a reservation written after its first check"
    )
    assert env.observer.advisory_locks(realm_runner.backend_pid) == set(), (
        "a claim refused at its second reservation check kept its live locks"
    )
    assert env.observer.status(realm_change) == "queued", (
        "a claim refused at its second reservation check changed the job's status"
    )


@job_queue_acceptance("A3-27")
def test_a3_27_a_class_c_step_resolution_cycle_starts_at_its_latest_no_effect_resume(
    queue_env: QueueEnv,
) -> None:
    env = queue_env
    organisation = env.organisation()
    operator = env.staff_principal(organisation)
    # One runner claims each cycle: the claim stays with it, and only the resolution cycle moves.
    runner = env.thread_actor()
    job = env.enqueue(runner, env.request("backup", organisation, env.tenant()))
    env.claimed(runner, job)
    env.run_steps(runner, job, (1, 2))
    assert runner.call("record_step", job_id=job, seq=3, status="running"), (
        "the claim could not set its class C step running in its first cycle"
    )
    first = runner.call("record_dispatch", job_id=job, seq=3, operation_ref="op-first")
    assert first is not None, "the claim could not dispatch its class C step in its first cycle"
    assert runner.call("hold_for_reconciliation", job_id=job, dispatch_id=first), (
        "the runner could not hold its class C step for reconciliation in its first cycle"
    )
    runner.call("release_live_locks", job_id=job)
    assert (
        runner.call("decide", principal=operator, decision=env.decision(job, outcome="no_effect"))
        == RECORDED
    ), "a first no-effect resume of a class C step was refused"

    env.claimed(runner, job)
    assert runner.call("record_step", job_id=job, seq=3, status="running"), (
        "the claim could not set its class C step running after its first no-effect resume"
    )
    second = runner.call("record_dispatch", job_id=job, seq=3, operation_ref="op-second")
    assert second is not None, (
        "a class C step could not be dispatched after its first no-effect resume"
    )
    assert runner.call("hold_for_reconciliation", job_id=job, dispatch_id=second), (
        "the runner could not hold its class C step for reconciliation in its second cycle"
    )
    runner.call("release_live_locks", job_id=job)
    assert (
        runner.call("decide", principal=operator, decision=env.decision(job, outcome="no_effect"))
        == RECORDED
    ), "a second no-effect resume of the same class C step was refused"
    # The second cycle's dispatch lies after the first decision and before the latest: a cycle
    # bounded by the first decision still holds it, and refuses the third cycle's dispatch below.
    decided = env.observer.rows(
        "SELECT operation_outcome, decided_at FROM {s}.jobs_jobreconciliationdecision "
        "WHERE job_id = %s ORDER BY decided_at",
        [job],
    )
    assert [outcome for outcome, _ in decided] == ["no_effect", "no_effect"], (
        "the two no-effect resumes of one class C step were not both recorded"
    )
    dispatched_at = env.observer.record("jobs_jobdispatch", second)["dispatched_at"]
    assert decided[0][1] < dispatched_at < decided[1][1], (
        "the second cycle's dispatch was not recorded between the two no-effect resumes"
    )

    env.claimed(runner, job)
    assert runner.call("record_step", job_id=job, seq=3, status="running"), (
        "the claim could not set its class C step running after its latest no-effect resume"
    )
    third = runner.call("record_dispatch", job_id=job, seq=3, operation_ref="op-third")
    assert third is not None, (
        "a class C step's resolution cycle started at its first no-effect resume, not its latest"
    )
    assert runner.call(
        "close_dispatch", job_id=job, dispatch_id=third, outcome="failed", evidence_ref="proof"
    ), "the claim could not close its dispatch after its latest no-effect resume"
    assert runner.call("record_dispatch", job_id=job, seq=3, operation_ref="op-fourth") is None, (
        "a class C step was dispatched twice in the cycle its latest no-effect resume opened"
    )


@job_queue_acceptance("A3-28")
def test_a3_28_subjob_effects_recheck_lease_after_waiting_for_the_parent(
    queue_env: QueueEnv,
) -> None:
    env = queue_env
    organisation = env.organisation()
    names = ("step", "dispatch", "retarget", "subjob_start")
    parents, children, writers, calls = {}, {}, {}, {}
    for name in names:
        writer, parent, child = _parent_with_sub_job(env, organisation, "parent-wait-" + name)
        parents[name], children[name] = parent, child
        writers[name] = writer
        env.claimed(writer, child)
        if name != "step":
            assert writer.call("record_step", job_id=child, seq=1, status="running"), (
                "the parent-wait fixture could not start its child step"
            )
        if name == "step":
            calls[name] = ("record_step", {"seq": 1, "status": "running"})
        elif name == "dispatch":
            calls[name] = ("record_dispatch", {"seq": 1, "operation_ref": "late-effect"})
        elif name == "retarget":
            dispatch = writer.call(
                "record_dispatch", job_id=child, seq=1, operation_ref="before-wait"
            )
            assert dispatch is not None, "the parent-wait fixture has no dispatch to retarget"
            calls[name] = (
                "retarget_dispatch",
                {"dispatch_id": dispatch, "operation_ref": "late-effect"},
            )
        else:
            calls[name] = (
                "start_sub_job",
                {"seq": 1, "kind": "export", "desired_spec_hash": digest(name)},
            )

    # Four separate child rows are already held by their writers by the time they wait on
    # these parent rows. The holder changes none of them: PostgreSQL cannot supply the
    # missing lease re-check by evaluating a changed row's predicate again.
    with env.rows_holder(list(parents.values())) as holder:
        env.observer.shorten_leases(list(children.values()), 3)
        before = _queue_records(env)
        pending = {
            name: writers[name].send(calls[name][0], job_id=children[name], **calls[name][1])
            for name in names
        }
        waited = [
            wait_blocked(
                env.observer, writers[name].backend_pid, holder.info.backend_pid, pending[name]
            )
            for name in names
        ]
        live_at_barrier = env.observer.value(
            "SELECT bool_and(lease_expires_at > clock_timestamp()) FROM {s}.jobs_job "
            "WHERE id = ANY(%s::uuid[])",
            [list(children.values())],
        )
        env.observer.wait_leases_passed(list(children.values()))
    assert pending["step"].result() is False, (
        "a sub-job started a step after its lease expired while waiting for its parent"
    )
    assert pending["dispatch"].result() is None, (
        "a sub-job recorded a dispatch after its lease expired while waiting for its parent"
    )
    assert pending["retarget"].result() is False, (
        "a sub-job retargeted a dispatch after its lease expired while waiting for its parent"
    )
    assert pending["subjob_start"].result() is None, (
        "a sub-job started another sub-job after its lease expired while waiting for its parent"
    )
    assert all(waited) and live_at_barrier, (
        "a child write did not reach its held parent while its own lease was live"
    )
    assert _queue_records(env) == before, (
        "a child write refused after its parent wait changed queue or audit records"
    )

    # Renewed live leases on these same otherwise unchanged fixtures make every effect legal.
    # This catches blanket refusal and proves no other dispatch/step precondition masked expiry.
    env.observer.shorten_leases(list(children.values()), 120)
    for name in names:
        result = writers[name].call(calls[name][0], job_id=children[name], **calls[name][1])
        assert result, "a child effect with a live lease was refused after the parent wait ended"


def _queue_records(env: QueueEnv) -> dict[str, Any]:
    """Independent state oracle, including every queue/audit field, not the writer's reply."""
    tables = (
        "jobs_job",
        "jobs_jobstep",
        "jobs_jobdispatch",
        "jobs_joblockreservation",
        "jobs_jobreconciliationdecision",
        "audit_auditevent",
    )
    return {
        table: env.observer.rows("SELECT to_jsonb(t) FROM {s}." + table + " t ORDER BY id")  # noqa: S608 - fixed tables
        for table in tables
    }


def _parent_clause_fixture(
    env: QueueEnv, organisation: str, name: str, case: str
) -> tuple[Any, str, str, str, tuple[str, dict[str, Any]]]:
    """Prepare one legal writer before changing its parent's evidence, never a schema guard."""
    writer, parent, child = _parent_with_sub_job(env, organisation, f"parent-{case}-{name}")
    env.claimed(writer, child)
    if name != "step":
        assert writer.call("record_step", job_id=child, seq=1, status="running"), (
            "the parent-clause fixture could not prepare its child step"
        )
    if name == "step":
        call = ("record_step", {"seq": 1, "status": "running"})
    elif name == "dispatch":
        call = ("record_dispatch", {"seq": 1, "operation_ref": "parent-clause-effect"})
    elif name == "retarget":
        dispatch = writer.call(
            "record_dispatch", job_id=child, seq=1, operation_ref="before-clause"
        )
        assert dispatch is not None, "the parent-clause fixture has no ordinary dispatch"
        call = (
            "retarget_dispatch",
            {"dispatch_id": dispatch, "operation_ref": "parent-clause-effect"},
        )
    else:
        call = (
            "start_sub_job",
            {"seq": 1, "kind": "export", "desired_spec_hash": digest(f"grandchild-{case}")},
        )
    dispatch_id = str(
        env.observer.value(
            "SELECT id FROM {s}.jobs_jobdispatch WHERE job_id = %s AND sub_job_id = %s",
            [parent, child],
        )
    )
    return writer, parent, child, dispatch_id, call


def _change_parent_clause(
    env: QueueEnv, writer: Any, parent: str, child: str, dispatch: str, case: str
) -> None:
    """One isolated false predicate (or NULL association), using retained rows and valid FKs."""
    if case == "status":
        env.observer.rows(
            "UPDATE {s}.jobs_job SET status = 'leased' WHERE id = %s RETURNING id", [parent]
        )
    elif case == "owner":
        other_writer = env.thread_actor("alternate-parent")
        try:
            other = env.enqueue(
                other_writer,
                env.request(
                    "decommission",
                    str(env.observer.record("jobs_job", parent)["organisation_id"]),
                    env.tenant(),
                ),
            )
            env.claimed(other_writer, other)
            assert other_writer.call("record_step", job_id=other, seq=1, status="running"), (
                "the alternate dispatch owner could not start its valid step"
            )
            step = env.observer.value(
                "SELECT id FROM {s}.jobs_jobstep WHERE job_id = %s AND seq = 1", [other]
            )
            assert (
                env.observer.record("jobs_job", other)["fence"]
                == env.observer.record("jobs_job", parent)["fence"]
            ), "the alternate dispatch owner did not have the same fence"
            env.observer.rows(
                "UPDATE {s}.jobs_jobdispatch SET job_id = %s, step_id = %s WHERE id = %s RETURNING id",
                [other, step, dispatch],
            )
        finally:
            other_writer.close()
    elif case in {"child", "missing"}:
        other_child = (
            env.enqueue(
                writer,
                env.request(
                    "export",
                    str(env.observer.record("jobs_job", parent)["organisation_id"]),
                    env.tenant(),
                ),
            )
            if case == "child"
            else None
        )
        env.observer.rows(
            "UPDATE {s}.jobs_jobdispatch SET sub_job_id = %s WHERE id = %s RETURNING id",
            [other_child, dispatch],
        )
    elif case == "open":
        env.observer.rows(
            "UPDATE {s}.jobs_jobdispatch SET closed_at = clock_timestamp(), "
            "terminal_outcome = 'completed', terminal_evidence_ref = 'parent-clause-proof' "
            "WHERE id = %s RETURNING id",
            [dispatch],
        )
    elif case == "fence":
        env.observer.rows(
            "UPDATE {s}.jobs_job SET fence = fence + 1 WHERE id = %s RETURNING id", [parent]
        )
    expected = {
        "status": (False, True, True, True, True),
        "owner": (True, False, True, True, True),
        "child": (True, True, False, True, True),
        "missing": (True, True, False, True, True),
        "open": (True, True, True, False, True),
        "fence": (True, True, True, True, False),
        "valid": (True, True, True, True, True),
    }
    observed = env.observer.rows(
        "SELECT p.status = 'running', d.job_id = p.id, "
        "coalesce(d.sub_job_id = %s::uuid, false), d.closed_at IS NULL, d.fence = p.fence "
        "FROM {s}.jobs_job p CROSS JOIN {s}.jobs_jobdispatch d WHERE p.id = %s AND d.id = %s",
        [child, parent, dispatch],
    )
    assert observed == [expected[case]], "the parent-clause fixture changed another predicate"


def _parent_clause_results(env: QueueEnv, case: str) -> tuple[tuple[Any, ...], bool]:
    results, unchanged = [], True
    organisation = env.organisation()
    for name in ("step", "dispatch", "retarget", "subjob_start"):
        writer, parent, child, dispatch, call = _parent_clause_fixture(
            env, organisation, name, case
        )
        try:
            _change_parent_clause(env, writer, parent, child, dispatch, case)
            original_child = env.observer.record("jobs_job", child)
            live_before = env.observer.value(
                "SELECT lease_expires_at > clock_timestamp() FROM {s}.jobs_job WHERE id = %s",
                [child],
            )
            before = _queue_records(env)
            result = writer.call(call[0], job_id=child, **call[1])
            after_child = env.observer.record("jobs_job", child)
            live_after = env.observer.value(
                "SELECT lease_expires_at > clock_timestamp() FROM {s}.jobs_job WHERE id = %s",
                [child],
            )
            assert live_before and live_after and original_child["fence"] == after_child["fence"], (
                "the parent-clause call did not retain a live child lease and fence"
            )
            results.append(result)
            unchanged = unchanged and _queue_records(env) == before
            if case == "valid":
                assert result, "a valid parent-clause positive control refused its effect"
                if name == "step":
                    persisted = (
                        env.observer.value(
                            "SELECT status FROM {s}.jobs_jobstep WHERE job_id = %s AND seq = 1",
                            [child],
                        )
                        == "running"
                    )
                elif name in {"dispatch", "retarget"}:
                    effect_id = result if name == "dispatch" else call[1]["dispatch_id"]
                    effect = env.observer.record("jobs_jobdispatch", effect_id)
                    persisted = (
                        str(effect["job_id"]) == child
                        and effect["operation_ref"] == "parent-clause-effect"
                    )
                else:
                    grandchild = env.observer.record("jobs_job", result)
                    persisted = (
                        str(grandchild["parent_job_id"]) == child
                        and env.observer.count(
                            "jobs_jobdispatch",
                            "job_id = %s AND sub_job_id = %s AND closed_at IS NULL",
                            [child, result],
                        )
                        == 1
                    )
                assert persisted, (
                    "a valid parent-clause positive control did not persist its effect"
                )
        finally:
            # Close each actor now to bound concurrent sessions; QueueEnv's final close is safe.
            writer.close()
    return tuple(results), unchanged


@job_queue_acceptance("A3-29")
def test_a3_29_subjob_effects_require_each_parent_dispatch_clause(queue_env: QueueEnv) -> None:
    status, status_unchanged = _parent_clause_results(queue_env, "status")
    assert status == (False, None, False, None), (
        "a sub-job effect was accepted under a parent whose status was not running"
    )
    owner, owner_unchanged = _parent_clause_results(queue_env, "owner")
    assert owner == (False, None, False, None), (
        "a sub-job effect was accepted under a dispatch owned by another parent"
    )
    child, child_unchanged = _parent_clause_results(queue_env, "child")
    assert child == (False, None, False, None), (
        "a sub-job effect was accepted under a parent dispatch naming another child"
    )
    missing, missing_unchanged = _parent_clause_results(queue_env, "missing")
    assert missing == (False, None, False, None), (
        "a sub-job effect was accepted without a matching parent dispatch association"
    )
    closed, closed_unchanged = _parent_clause_results(queue_env, "open")
    assert closed == (False, None, False, None), (
        "a sub-job effect was accepted under a closed parent dispatch"
    )
    fence, fence_unchanged = _parent_clause_results(queue_env, "fence")
    assert fence == (False, None, False, None), (
        "a sub-job effect was accepted under a dispatch outside its parent's current fence"
    )
    assert all(
        (
            status_unchanged,
            owner_unchanged,
            child_unchanged,
            missing_unchanged,
            closed_unchanged,
            fence_unchanged,
        )
    ), "a parent-clause refusal changed queue or audit records"
    _parent_clause_results(queue_env, "valid")


@job_queue_acceptance("A3-30")
def test_a3_30_unsupported_isolation_is_refused_before_queue_work(queue_env: QueueEnv) -> None:
    env = queue_env
    actor = env.thread_actor("isolation")
    request = env.request("backup", env.organisation(), env.tenant())
    result = actor.call(
        "under_isolation",
        level="repeatable read",
        call="enqueue",
        arguments={"request": request, "probe": "isolation-refused"},
    )
    assert result == {
        "raised": "TransactionManagementError: enqueue_job requires READ COMMITTED (JOB_QUEUE.md §4); actual=repeatable read"
    }, "a queue call accepted unsupported transaction isolation"
    assert (
        env.observer.count("jobs_job", "idempotency_key = %s", [request["idempotency_key"]]) == 0
    ), "an isolation refusal left a job row"
    assert env.probe_count("isolation-refused") == 0, "an isolation refusal called desired state"
    env.enqueue(actor, request, probe="isolation-positive")
    assert env.probe_count("isolation-positive") == 1, "read committed enqueue lost desired state"


@job_queue_acceptance("A3-31")
def test_a3_31_a_decision_needs_a_staff_principal_holding_a_current_operator_grant(
    queue_env: QueueEnv,
) -> None:
    env = queue_env
    organisation = env.organisation()
    deciding = env.thread_actor("operator")
    job, _ = env.to_reconciliation(organisation, env.tenant(), "principal")
    delivery = str(
        env.observer.value(
            "INSERT INTO {s}.outbox_outboxdelivery (id, organisation_id, category, changes_realm, "
            "status, started_at, created_at, updated_at) VALUES (gen_random_uuid(), %s, "
            "'message', false, 'needs_reconciliation', clock_timestamp(), now(), now()) "
            "RETURNING id",
            [organisation],
        )
    )
    operator = env.staff_principal(organisation)

    # A staff principal comes only from the staff lane's exact issuer, with a second factor, for a
    # stored staff identity: whatever a token's roles say, they are never read.
    customer = env.customer_principal(organisation)
    assert (
        deciding.call("decide", principal=customer, decision=env.decision(job)) == PRINCIPAL_REFUSED
    ), "a customer-realm token was resolved into a staff principal"
    assert (
        deciding.call("decide", principal={**customer, "lane": "staff"}, decision=env.decision(job))
        == PRINCIPAL_REFUSED
    ), "a customer-realm issuer was admitted on the staff lane"
    assert (
        deciding.call(
            "decide", principal={**operator, "lane": "customer"}, decision=env.decision(job)
        )
        == PRINCIPAL_REFUSED
    ), "a staff-realm token was resolved from another lane"
    assert (
        deciding.call("decide", principal={**operator, "amr": None}, decision=env.decision(job))
        == PRINCIPAL_REFUSED
    ), "a staff token naming no authentication method was resolved into a staff principal"
    assert (
        deciding.call("decide", principal={**operator, "amr": ["pwd"]}, decision=env.decision(job))
        == PRINCIPAL_REFUSED
    ), "a staff token without a second factor was resolved into a staff principal"
    unknown = {**operator, "subject": "synthetic-unknown-" + uuid.uuid4().hex[:8]}
    assert (
        deciding.call("decide", principal=unknown, decision=env.decision(job)) == PRINCIPAL_REFUSED
    ), "a staff token for no stored staff identity was resolved into a staff principal"
    assert (
        deciding.call("decide_delivery", principal=customer, decision=env.decision(delivery))
        == PRINCIPAL_REFUSED
    ), "a customer-realm token was resolved into a staff principal for a delivery decision"

    # The decision reads the grant itself, in its own transaction, and locks it: one of this
    # identity's, of staff_operator, not revoked, of an enabled identity and person, at the moment
    # it decides. A grant another identity holds decides nothing, and a principal resolved while it
    # was current decides nothing once its grant is revoked or its identity or person retired.
    ungranted = env.staff_principal(organisation, roles=())
    retiring = {
        part: env.staff_principal(organisation)
        for part in (
            "revoked",
            "identity-disabled",
            "identity-deleted",
            "person-disabled",
            "person-deleted",
        )
    }
    resolved = {part: deciding.call("resolve", principal=p) for part, p in retiring.items()}
    assert all(handle is not None for handle in resolved.values()), (
        "a current staff operator's token was not resolved into a staff principal"
    )
    for part, principal in retiring.items():
        if part == "revoked":
            env.revoke_staff_role(principal, "staff_operator")
        else:
            env.retire_staff(principal, part)
    later = {part: {"resolved": handle} for part, handle in resolved.items()}
    assert deciding.call("decide", principal=ungranted, decision=env.decision(job)) == refusal(
        "role_missing"
    ), (
        "a decision by a staff identity holding no grant was accepted while another identity "
        "held staff_operator"
    )
    assert deciding.call(
        "decide", principal=later["revoked"], decision=env.decision(job)
    ) == refusal("role_missing"), (
        "a decision by a staff identity whose staff_operator grant was revoked was accepted"
    )
    assert deciding.call(
        "decide", principal=later["identity-disabled"], decision=env.decision(job)
    ) == refusal("role_missing"), (
        "a decision by a resolved staff principal whose identity was disabled was accepted"
    )
    assert deciding.call(
        "decide", principal=later["identity-deleted"], decision=env.decision(job)
    ) == refusal("role_missing"), (
        "a decision by a resolved staff principal whose identity was deleted was accepted"
    )
    assert deciding.call(
        "decide", principal=later["person-disabled"], decision=env.decision(job)
    ) == refusal("role_missing"), (
        "a decision by a resolved staff principal whose person was disabled was accepted"
    )
    assert deciding.call(
        "decide", principal=later["person-deleted"], decision=env.decision(job)
    ) == refusal("role_missing"), (
        "a decision by a resolved staff principal whose person was deleted was accepted"
    )
    assert deciding.call(
        "decide_delivery", principal=ungranted, decision=env.decision(delivery)
    ) == refusal("role_missing"), (
        "a delivery decision by a staff identity holding no grant was accepted while another "
        "identity held staff_operator"
    )
    assert deciding.call(
        "decide_delivery", principal=later["revoked"], decision=env.decision(delivery)
    ) == refusal("role_missing"), (
        "a delivery decision by a staff identity whose staff_operator grant was revoked was "
        "accepted"
    )
    assert deciding.call(
        "decide_delivery", principal=later["identity-disabled"], decision=env.decision(delivery)
    ) == refusal("role_missing"), (
        "a delivery decision by a resolved staff principal whose identity was disabled was accepted"
    )
    assert deciding.call(
        "decide_delivery", principal=later["identity-deleted"], decision=env.decision(delivery)
    ) == refusal("role_missing"), (
        "a delivery decision by a resolved staff principal whose identity was deleted was accepted"
    )
    assert deciding.call(
        "decide_delivery", principal=later["person-disabled"], decision=env.decision(delivery)
    ) == refusal("role_missing"), (
        "a delivery decision by a resolved staff principal whose person was disabled was accepted"
    )
    assert deciding.call(
        "decide_delivery", principal=later["person-deleted"], decision=env.decision(delivery)
    ) == refusal("role_missing"), (
        "a delivery decision by a resolved staff principal whose person was deleted was accepted"
    )
    assert env.observer.status(job) == "needs_reconciliation", (
        "a decision by a refused principal took the job out of needs_reconciliation"
    )
    assert env.observer.count("jobs_jobreconciliationdecision", "job_id = %s", [job]) == 0, (
        "a decision by a refused principal left a decision record"
    )
    assert (
        env.observer.record("outbox_outboxdelivery", delivery)["status"] == "needs_reconciliation"
    ), "a decision by a refused principal took the delivery out of needs_reconciliation"

    for_delivery = env.decision(delivery, exit="fail", outcome="no_effect")
    assert (
        deciding.call("decide_delivery", principal=operator, decision=for_delivery) == RECORDED
    ), "a delivery decision by a staff operator holding a current grant was refused"
    for_job = env.decision(job, exit="fail", outcome="no_effect")
    assert deciding.call("decide", principal=operator, decision=for_job) == RECORDED, (
        "a decision by a staff operator holding a current grant was refused"
    )
    decided_by = env.observer.value(
        "SELECT decided_by_identity_id FROM {s}.jobs_jobreconciliationdecision WHERE job_id = %s",
        [job],
    )
    assert str(decided_by) == operator["identity_id"], (
        "a decision did not name the resolved staff identity as the one that decided"
    )
    relied_on = env.observer.value(
        "SELECT metadata->>'staff_role_grant_ref' FROM {s}.audit_auditevent "
        "WHERE action = 'job.reconciliation_decided' AND job_id = %s",
        [job],
    )
    assert relied_on == env.staff_grant(operator, "staff_operator"), (
        "a decision's audit row did not name the staff_operator grant it relied on"
    )
    delivery_relied_on = env.observer.value(
        "SELECT metadata->>'staff_role_grant_ref' FROM {s}.audit_auditevent "
        "WHERE action = 'outbox_delivery.reconciliation_decided' AND target_urn = %s",
        ["urn:kodera:outbox_delivery:" + delivery],
    )
    assert delivery_relied_on == env.staff_grant(operator, "staff_operator"), (
        "a delivery decision's audit row did not name the staff_operator grant it relied on"
    )
