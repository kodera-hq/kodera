"""Real migrated-table barriers; no toy owner schema or timeout-as-refusal."""

import threading
import time

import psycopg
import pytest
from django.db import connection
from psycopg import sql
from test_customer_persistence_models import anchor, anchor_models


@pytest.fixture(name="models")
def registered_models(transactional_db):
    assert connection.vendor == "postgresql"
    return anchor_models()


def session():
    assert connection.vendor == "postgresql"
    assert str(connection.settings_dict["NAME"]).startswith("test_"), (
        "owned pytest database required"
    )
    return psycopg.connect(**connection.get_connection_params(), autocommit=True)


def begin(client, isolation):
    client.execute(sql.SQL("BEGIN ISOLATION LEVEL {} ").format(sql.SQL(isolation)))
    client.execute("SET LOCAL statement_timeout = '8s'")
    client.execute("SET LOCAL lock_timeout = '6s'")
    assert client.execute("SHOW transaction_isolation").fetchone()[0] == isolation.lower()


def table(model):
    return sql.Identifier(model._meta.db_table)


def owner_count(client, models, organisation):
    return client.execute(
        sql.SQL(
            "SELECT count(*) FROM {} WHERE organisation_id=%s AND role='org_owner' "
            "AND state='active' AND accepted_at IS NOT NULL AND deleted_at IS NULL"
        ).format(table(models.Membership)),
        [organisation.pk],
    ).fetchone()[0]


def remove(client, models, member):
    client.execute(
        sql.SQL("DELETE FROM {} WHERE id=%s").format(table(models.Membership)), [member.pk]
    )


def blocked_by(observer, blocked, blocker):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        pids = observer.execute("SELECT pg_blocking_pids(%s)", [blocked]).fetchone()[0]
        if blocker in pids:
            return
        time.sleep(0.02)
    raise AssertionError("contender never reached the expected database lock barrier")


def finish_thread(thread, client):
    if thread is None:
        return
    thread.join(9)
    if thread.is_alive():
        client.cancel()
        thread.join(3)
    assert not thread.is_alive(), "owned database worker did not finish after cancellation"


def cleanup(clients, thread):
    errors = []
    if clients:
        try:
            clients[0].execute("ROLLBACK")
        except Exception as error:
            errors.append(error)
    if thread is not None and len(clients) > 1:
        try:
            finish_thread(thread, clients[1])
        except Exception as error:
            errors.append(error)
    for client in clients:
        try:
            client.close()
        except Exception as error:
            errors.append(error)
    if errors:
        raise ExceptionGroup("owned database worker cleanup failed", errors)


@pytest.mark.parametrize("isolation", ["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"])
def test_competing_owner_removals_preserve_a_committed_owner(models, isolation, record_property):
    organisation, _, owners = anchor(models, owners=2)
    clients = []
    thread = None
    result = {}
    history = []
    try:
        for _ in range(3):
            clients.append(session())
        first, second, observer = clients
        for name, client in (("first", first), ("second", second)):
            begin(client, isolation)
            assert owner_count(client, models, organisation) == 2
            history.append(name + "-early-snapshot")
        assert first.info.backend_pid != second.info.backend_pid
        remove(first, models, owners[0])
        history.append("first-removal-uncommitted")

        def contender():
            try:
                remove(second, models, owners[1])
                second.execute("COMMIT")
                result["outcome"] = "committed"
            except psycopg.Error as error:
                result.update(
                    outcome="refused",
                    sqlstate=error.sqlstate,
                    constraint=error.diag.constraint_name,
                )
                second.execute("ROLLBACK")
            except Exception as error:
                result.update(outcome="unexpected", category=type(error).__name__)

        thread = threading.Thread(target=contender)
        thread.start()
        blocked_by(observer, second.info.backend_pid, first.info.backend_pid)
        history.append("second-blocked-by-first")
        first.execute("COMMIT")
        history.append("first-committed")
        finish_thread(thread, second)
        final_count = owner_count(observer, models, organisation)
        rows = observer.execute(
            sql.SQL("SELECT id FROM {} WHERE organisation_id=%s").format(table(models.Membership)),
            [organisation.pk],
        ).fetchall()
        record_property(
            "owner_barrier",
            {
                "isolation": isolation,
                "history": history,
                "result": result,
                "final_owner_count": final_count,
                "retained_member_ids": [str(row[0]) for row in rows],
            },
        )
        assert result.get("outcome") == "refused", "both competing owner removals committed"
        assert (result.get("sqlstate"), result.get("constraint")) == (
            "23514",
            "organisation_owner_required",
        ) or result.get("sqlstate") == "40001", result
        # No deadlock is deliberately staged here; 40P01 and timeouts cannot pass.
        assert final_count == 1
        assert rows == [(owners[1].pk,)], "failed contender did not roll back its removal"
    finally:
        cleanup(clients, thread)


def test_different_organisations_allow_valid_concurrent_removals(models):
    isolation = "READ COMMITTED"
    first_org, _, first_owners = anchor(models, owners=2)
    second_org, _, second_owners = anchor(models, slug="bravo", owners=2)
    with session() as first, session() as second, session() as observer:
        begin(first, isolation)
        begin(second, isolation)
        assert owner_count(first, models, first_org) == 2
        assert owner_count(second, models, second_org) == 2
        remove(first, models, first_owners[0])
        remove(second, models, second_owners[0])
        second.execute("COMMIT")  # First still owns its row locks.
        first.execute("COMMIT")
        assert (
            owner_count(observer, models, first_org)
            == owner_count(observer, models, second_org)
            == 1
        )


def test_other_organisation_progresses_while_owner_guard_is_blocked(models):
    blocked_org, _, blocked_owners = anchor(models, owners=2)
    free_org, _, free_owners = anchor(models, slug="bravo", owners=2)
    clients = []
    thread = None
    result = {}
    try:
        for _ in range(3):
            clients.append(session())
        holder, worker, observer = clients
        begin(holder, "READ COMMITTED")
        holder.execute(
            sql.SQL("SELECT id FROM {} WHERE id=%s FOR UPDATE").format(table(models.Organisation)),
            [blocked_org.pk],
        )
        begin(worker, "READ COMMITTED")

        def blocked_remove():
            try:
                remove(worker, models, blocked_owners[0])
                worker.execute("COMMIT")
                result["outcome"] = "committed"
            except Exception as error:
                result.update(outcome="failed", category=type(error).__name__)

        thread = threading.Thread(target=blocked_remove)
        thread.start()
        blocked_by(observer, worker.info.backend_pid, holder.info.backend_pid)
        begin(observer, "READ COMMITTED")
        remove(observer, models, free_owners[0])
        observer.execute("COMMIT")
        assert thread.is_alive(), "blocked organisation was released before other progress proof"
        assert owner_count(observer, models, free_org) == 1
        holder.execute("COMMIT")
        finish_thread(thread, worker)
        assert result == {"outcome": "committed"}
        assert owner_count(observer, models, blocked_org) == 1
    finally:
        cleanup(clients, thread)


def test_cleanup_attempts_all_owned_closes_after_rollback_failure():
    calls = []

    class FakeClient:
        def __init__(self, label):
            self.label = label

        def execute(self, _statement):
            raise RuntimeError("synthetic rollback failure")

        def close(self):
            calls.append(self.label)

    with pytest.raises(ExceptionGroup, match="owned database worker cleanup failed"):
        cleanup([FakeClient("first"), FakeClient("second"), FakeClient("third")], None)
    assert calls == ["first", "second", "third"]


def test_cleanup_closes_partially_created_session_set():
    calls = []

    class FakeClient:
        def execute(self, _statement):
            calls.append("rollback")

        def close(self):
            calls.append("close")

    cleanup([FakeClient()], None)
    assert calls == ["rollback", "close"]


def test_activation_and_reservation_retirement_cannot_both_commit(models, record_property):
    org, held, _ = anchor(models, state="closed")
    clients = []
    thread = None
    result = {}
    barrier = None
    try:
        for _ in range(3):
            clients.append(session())
        first, second, observer = clients
        begin(first, "REPEATABLE READ")
        begin(second, "REPEATABLE READ")
        assert first.execute(
            sql.SQL("SELECT state FROM {} WHERE id=%s").format(table(models.SlugReservation)),
            [held.pk],
        ).fetchone() == ("permanent",)
        assert second.execute(
            sql.SQL("SELECT state FROM {} WHERE id=%s").format(table(models.Organisation)), [org.pk]
        ).fetchone() == ("closed",)
        first.execute(
            sql.SQL("UPDATE {} SET state='active' WHERE id=%s").format(table(models.Organisation)),
            [org.pk],
        )

        def retire():
            try:
                second.execute(
                    sql.SQL("UPDATE {} SET state='retired' WHERE id=%s").format(
                        table(models.SlugReservation)
                    ),
                    [held.pk],
                )
                second.execute("COMMIT")
                result["outcome"] = "committed"
            except psycopg.Error as error:
                result.update(
                    outcome="refused",
                    sqlstate=error.sqlstate,
                    constraint=error.diag.constraint_name,
                )
                second.execute("ROLLBACK")
            except Exception as error:
                result.update(outcome="unexpected", category=type(error).__name__)

        thread = threading.Thread(target=retire)
        thread.start()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if not thread.is_alive():
                barrier = "retirement-completed-before-activation-commit"
                break
            if (
                first.info.backend_pid
                in observer.execute(
                    "SELECT pg_blocking_pids(%s)", [second.info.backend_pid]
                ).fetchone()[0]
            ):
                barrier = "retirement-blocked-by-activation"
                break
            time.sleep(0.02)
        assert barrier is not None, "retirement reached neither completion nor expected row lock"
        first.execute("COMMIT")
        finish_thread(thread, second)
        final = observer.execute(
            sql.SQL(
                "SELECT o.state,r.state FROM {} o JOIN {} r ON r.organisation_id=o.id WHERE o.id=%s"
            ).format(table(models.Organisation), table(models.SlugReservation)),
            [org.pk],
        ).fetchone()
        record_property("reservation_race", {"barrier": barrier, "result": result, "final": final})
        assert result.get("outcome") == "refused", (
            "activation and reservation retirement both committed"
        )
        assert result.get("sqlstate") == "40001" or (
            result.get("sqlstate"),
            result.get("constraint"),
        ) == ("23514", "organisation_reservation_required")
        assert final == ("active", "permanent")
    finally:
        cleanup(clients, thread)
