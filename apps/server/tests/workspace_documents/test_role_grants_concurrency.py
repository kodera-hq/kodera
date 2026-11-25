"""A role kind change cannot race a new grant, including at snapshot isolation."""

import threading
from uuid import uuid4

import psycopg
import pytest
from test_customer_persistence_concurrency import begin, blocked_by, cleanup, session
from workspace_safety.test_moderation import world as world

from apps.docs.models import DocumentRoleGrant
from workspace_documents.test_role_grants import grants as grants

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.mark.parametrize("isolation", ["READ COMMITTED", "REPEATABLE READ"])
@pytest.mark.parametrize("grant_first", [True, False])
def test_grant_insert_and_kind_change_serialize(world, grants, isolation, grant_first):
    document, subteam = grants
    clients = []
    thread = None
    result = {}
    grant_sql = (
        "INSERT INTO docs_documentrolegrant "
        "(id,created_at,updated_at,document_id,workspace_role_id,role) "
        "VALUES(%s,clock_timestamp(),clock_timestamp(),%s,%s,'editor')",
        [uuid4(), document.id, subteam.id],
    )
    kind_sql = ("UPDATE workspaces_workspacerole SET kind='tag' WHERE id=%s", [subteam.id])
    holder_sql, waiter_sql = (grant_sql, kind_sql) if grant_first else (kind_sql, grant_sql)
    try:
        clients = [session(), session(), session()]
        holder, waiter, observer = clients
        begin(holder, isolation)
        begin(waiter, isolation)
        # Take the waiter's repeatable-read snapshot before the other transaction writes.
        waiter.execute("SELECT count(*) FROM docs_documentrolegrant").fetchone()
        holder.execute(*holder_sql)

        def contend():
            try:
                waiter.execute(*waiter_sql)
                waiter.execute("COMMIT")
                result["state"] = "committed"
            except psycopg.Error as error:
                result["state"] = error.sqlstate
                waiter.execute("ROLLBACK")

        thread = threading.Thread(target=contend)
        thread.start()
        blocked_by(observer, waiter.info.backend_pid, holder.info.backend_pid)
        holder.execute("COMMIT")
        thread.join(9)
        assert not thread.is_alive()
        assert result["state"] in {"23514", "40001"}
        assert DocumentRoleGrant.objects.filter(document=document).exists() is grant_first
    finally:
        cleanup(clients, thread)


def test_list_snapshot_does_not_wait_for_workspace_write_lock(world, grants):
    from workspace_documents.test_role_grants import read

    _, workspace, _, _ = world
    document, _ = grants
    with session() as holder:
        begin(holder, "READ COMMITTED")
        holder.execute("SELECT id FROM workspaces_workspace WHERE id=%s FOR UPDATE", [workspace.id])
        try:
            assert read(world, document)["revision"] == document.revision
        finally:
            holder.execute("ROLLBACK")


def test_list_revision_and_grants_share_a_snapshot(world, grants, monkeypatch):
    from apps.docs import services
    from workspace_documents.test_role_grants import put, read

    document, subteam = grants
    before = put(world, document, subteam)
    original = services.resource

    def concurrent_change(**kwargs):
        row, permission = original(**kwargs)
        with session() as writer:
            begin(writer, "READ COMMITTED")
            writer.execute(
                "UPDATE docs_document SET revision=revision+1 WHERE id=%s", [document.id]
            )
            writer.execute(
                "UPDATE docs_documentrolegrant SET role='viewer' WHERE document_id=%s",
                [document.id],
            )
            writer.execute("COMMIT")
        return row, permission

    with monkeypatch.context() as scoped:
        scoped.setattr(services, "resource", concurrent_change)
        assert read(world, document) == before
    after = read(world, document)
    assert after["revision"] == before["revision"] + 1
    assert after["data"][0]["role"] == "viewer"


def test_grant_permission_update_does_not_lock_subteam_row(world, grants):
    from workspace_documents.test_role_grants import put

    document, subteam = grants
    put(world, document, subteam)
    with session() as holder, session() as writer:
        begin(holder, "READ COMMITTED")
        begin(writer, "READ COMMITTED")
        holder.execute(
            "SELECT id FROM workspaces_workspacerole WHERE id=%s FOR UPDATE", [subteam.id]
        )
        try:
            writer.execute(
                "UPDATE docs_documentrolegrant SET role='viewer' WHERE document_id=%s",
                [document.id],
            )
            writer.execute("COMMIT")
        finally:
            writer.execute("ROLLBACK")
            holder.execute("ROLLBACK")


def test_competing_puts_accept_exactly_one_snapshot(world, grants):
    from concurrent.futures import ThreadPoolExecutor

    from django.db import close_old_connections

    from apps.docs.errors import RefusalError
    from apps.docs.role_grants import etag as grant_etag
    from workspace_documents.test_role_grants import put, read

    document, subteam = grants
    etag = grant_etag(document.id, read(world, document))
    barrier = threading.Barrier(2)

    def compete(permission):
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            put(world, document, subteam, permission, etag=etag)
            return 200
        except RefusalError as failure:
            return failure.status
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(compete, ["editor", "viewer"])) == [200, 412]


def test_mutation_locks_document_before_grant_dml(world, grants):
    from django.db import close_old_connections

    from apps.docs.role_grants import etag as grant_etag
    from workspace_documents.test_role_grants import put

    document, subteam = grants
    current = put(world, document, subteam)
    clients = [session(), session(), session()]
    holder, observer, probe = clients
    thread = None
    result = {}
    try:
        begin(holder, "READ COMMITTED")
        holder.execute("SELECT id FROM docs_document WHERE id=%s FOR UPDATE", [document.id])

        def update():
            from django.db import connection

            close_old_connections()
            try:
                connection.ensure_connection()
                result["pid"] = connection.connection.info.backend_pid
                put(world, document, subteam, "viewer", etag=grant_etag(document.id, current))
                result["done"] = True
            except BaseException as error:
                result["error"] = error
            finally:
                close_old_connections()

        thread = threading.Thread(target=update)
        thread.start()
        # The observer barrier waits on the API backend's lock, without sleeps in the writer.
        import time

        deadline = time.monotonic() + 5
        while "pid" not in result and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.01)
        blocked_by(observer, result["pid"], holder.info.backend_pid)
        begin(probe, "READ COMMITTED")
        # A grant-first writer would already hold this row while waiting for the document.
        probe.execute(
            "SELECT id FROM docs_documentrolegrant WHERE document_id=%s FOR UPDATE NOWAIT",
            [document.id],
        )
        probe.execute("ROLLBACK")
        holder.execute("COMMIT")
        thread.join(9)
        assert not thread.is_alive()
        assert result.get("done"), result.get("error")
    finally:
        # Release the holder before waiting for the API thread on every exit path.
        holder.execute("ROLLBACK")
        probe.execute("ROLLBACK")
        if thread is not None:
            thread.join(9)
        for client in clients:
            client.close()
