"""The command's current authorization outlives its preamble without a caller queue transaction."""

import threading
import time
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.db import connection, connections, transaction
from django.utils import timezone
from test_operator_realm_bootstrap import start, w as w, written

from apps.identity.models import Identity, StaffRole, User
from apps.identity.staff import _principal
from apps.orgs import realm_bootstrap as rb


def test_authorization_uses_a_private_connection_and_closes_it(monkeypatch):
    guard = Mock(connection=object())
    original = SimpleNamespace(copy=Mock(return_value=guard))
    read_grant = Mock(return_value=uuid4())
    monkeypatch.setattr(rb, "connection", original, raising=False)
    monkeypatch.setattr(rb, "current_staff_grant", read_grant)
    principal = _principal(uuid4(), "https://identity.staff.test/realms/kodera-staff")
    with rb.operator_authorization(principal):
        guard.close.assert_not_called()
        guard.commit.assert_not_called()
    original.copy.assert_called_once()
    guard.set_autocommit.assert_called_once_with(False)
    read_grant.assert_called_once_with(
        identity_id=principal.identity_id,
        role="staff_operator",
        database=guard,
        lock_principal=True,
    )
    guard.commit.assert_called_once()
    guard.close.assert_called_once()


@pytest.mark.parametrize("missing", [True, False])
def test_authorization_rolls_back_and_closes_on_refusal_or_body_failure(monkeypatch, missing):
    guard = Mock(connection=object())
    monkeypatch.setattr(rb, "connection", SimpleNamespace(copy=lambda **kw: guard), raising=False)
    monkeypatch.setattr(rb, "current_staff_grant", lambda **kw: None if missing else uuid4())
    principal = _principal(uuid4(), "https://identity.staff.test/realms/kodera-staff")
    expected = rb.Refused if missing else RuntimeError
    message = "current staff_operator" if missing else "synthetic body failure"
    with pytest.raises(expected, match=message), rb.operator_authorization(principal):
        raise RuntimeError("synthetic body failure")
    guard.commit.assert_not_called()
    guard.rollback.assert_called_once()
    guard.close.assert_called_once()


def change_authorization(w, what):
    if what == "grant":
        StaffRole.objects.filter(identity=w.operator).update(revoked_at=timezone.now())
    elif what == "identity":
        Identity.objects.filter(pk=w.operator.pk).update(enabled=False)
    elif what == "person":
        User.objects.filter(pk=w.operator.user_id).update(enabled=False)
    elif what == "deleted_identity":
        deleted = timezone.now()
        Identity.objects.filter(pk=w.operator.pk).update(
            deleted_at=deleted, purge_after=deleted + timedelta(days=1)
        )
    else:
        assert what == "deleted_person"
        deleted = timezone.now()
        User.objects.filter(pk=w.operator.user_id).update(
            deleted_at=deleted, purge_after=deleted + timedelta(days=1)
        )


@pytest.mark.parametrize(
    "what", ["grant", "identity", "person", "deleted_identity", "deleted_person"]
)
@pytest.mark.parametrize("operation", ["start", "complete", "requeue"])
def test_a_stale_principal_cannot_start_operator_effects(w, what, operation):
    principal = rb.staff_principal_for_command(w.operator.id)
    change_authorization(w, what)
    before = written()
    record = rb.Record(f"{operation}_realm_bootstrap", w.organisation.slug, w.operator.id)
    arguments = {"record": record, "principal": principal, "organisation": w.organisation}
    if operation == "start":
        arguments.update(tooling_run="synthetic-run", outcome=None)
    elif operation == "complete":
        arguments.update(
            sign_in_result="ok", sign_in_evidence="synthetic-sign-in", compute_terminated=None
        )
    with pytest.raises(rb.Refused, match="current staff_operator"):
        getattr(rb, operation)(**arguments)
    assert written() == before
    assert w.realm.fetches == 0


@pytest.mark.parametrize("what", ["grant", "identity", "person"])
def test_queued_authorization_change_waits_without_blocking_queue_or_fact_writes(capsys, w, what):
    assert start(capsys, w, "--tooling-run", "synthetic-run")[0] == 0
    principal = rb.staff_principal_for_command(w.operator.id)
    ready, done = threading.Event(), threading.Event()
    state = {}

    def writer():
        try:
            with connection.cursor() as cursor:
                cursor.execute("SET statement_timeout = '8s'")
                cursor.execute("SELECT pg_backend_pid()")
                state["pid"] = cursor.fetchone()[0]
            ready.set()
            change_authorization(w, what)
        except BaseException as error:  # noqa: BLE001 - returned to the assertion
            state["error"] = error
        finally:
            done.set()
            connections.close_all()

    worker = threading.Thread(target=writer, daemon=True)
    try:
        with rb.operator_authorization(principal):
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_backend_pid()")
                default_pid = cursor.fetchone()[0]
                cursor.execute(
                    "SELECT pid FROM pg_locks WHERE locktype = 'relation' "
                    "AND relation = 'identity_staffrole'::regclass AND mode = 'RowShareLock' "
                    "AND granted AND pid <> %s",
                    [default_pid],
                )
                assert cursor.fetchone(), "the guard did not hold its own PostgreSQL session"
            worker.start()
            assert ready.wait(5), "the authorization writer did not connect"
            waiting = False
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and not done.is_set():
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT wait_event_type FROM pg_stat_activity WHERE pid = %s",
                        [state["pid"]],
                    )
                    row = cursor.fetchone()
                if row and row[0] == "Lock":
                    waiting = True
                    break
                time.sleep(0.02)
            assert waiting, "the authorization change did not wait for the command guard"
            with connection.cursor() as cursor:
                cursor.execute("SET lock_timeout = '2s'")
            if what == "grant":
                evidence = rb.Evidence("tooling", "synthetic-run", "read-1", timezone.now())
                rb.decide(
                    principal, w.job_id, "resume", rb.Outcome("completed", evidence, evidence)
                )
            else:
                rb.record_realm_ready(
                    organisation_id=w.organisation.id,
                    job_id=w.job_id,
                    recorded_by=w.operator.id,
                )
                with transaction.atomic():
                    rb.record_realm_event(
                        action="realm.created",
                        organisation_id=w.organisation.id,
                        realm=w.organisation.realm,
                        job_id=w.job_id,
                        actor_id=w.operator.id,
                        metadata={},
                    )
            assert not done.is_set(), "the authorization writer committed before guard release"
    finally:
        with connection.cursor() as cursor:
            cursor.execute("SET lock_timeout = '0'")
        if worker.ident is not None:
            worker.join(10)
    assert not worker.is_alive(), "the authorization writer was not joined"
    assert done.is_set() and "error" not in state, state
    with transaction.atomic():
        assert rb.current_staff_grant(identity_id=w.operator.id, role="staff_operator") is None
