"""Real authority-query barriers and unavailable-connection acceptance."""

import copy
import socket
import threading

import pytest
from customer_http_fixtures import (
    http_signer as http_signer,
    http_world as http_world,
    request,
    safe_problem,
)
from django.db import connection, connections, transaction
from django.test import Client
from test_access_tokens import frozen_clock as frozen_clock
from test_customer_persistence_models import raw_update


def start_observed_request(world, phase):
    entered = threading.Event()
    release = threading.Event()
    result = {}

    def run():
        local = connections["default"]
        seen = False

        def observe(execute, statement, params, many, context):
            nonlocal seen
            normalized = " ".join(statement.split()).lower()
            if seen or not normalized.startswith("select"):
                return execute(statement, params, many, context)
            seen = True
            result["authority_first"] = world.models.Identity._meta.db_table in normalized
            result["in_atomic"] = local.in_atomic_block
            result["driver"] = local.connection
            if phase == "before":
                entered.set()
                assert release.wait(5), "first authority SELECT barrier was not released"
            value = execute(statement, params, many, context)
            # Inspect only after the first authority statement acquired its snapshot.
            # These extra real SHOW statements neither replace nor fabricate query results.
            with local.connection.cursor() as cursor:
                cursor.execute("SHOW transaction_isolation")
                result["isolation"] = cursor.fetchone()[0]
                cursor.execute("SHOW transaction_read_only")
                result["read_only"] = cursor.fetchone()[0]
            if phase == "after":
                entered.set()
                assert release.wait(5), "coherent projection barrier was not released"
            return value

        try:
            with local.execute_wrapper(observe):
                result["response"] = request(
                    Client(raise_request_exception=False, HTTP_HOST="127.0.0.1"), world.credential
                )
        except Exception as error:
            result["failure_category"] = type(error).__name__
        finally:
            local.close()

    thread = threading.Thread(target=run)
    thread.start()
    return entered, release, thread, result


def finish_request(release, thread, result):
    release.set()
    thread.join(8)
    if thread.is_alive() and result.get("driver") is not None:
        result["driver"].cancel()
        thread.join(4)
    assert not thread.is_alive(), "owned customer request thread did not finish"


def assert_snapshot_boundary(result):
    assert result.get("authority_first"), "snapshot was acquired before actual authority read"
    assert result.get("in_atomic"), "authority read escaped the explicit transaction"
    assert result.get("isolation") == "repeatable read"
    assert result.get("read_only") == "on"
    assert "failure_category" not in result, "owned customer request failed outside HTTP mapping"


def test_revocation_after_begin_before_first_authority_select_denies(http_world):
    w = http_world
    assert request(w.client, w.credential).status_code == 200
    entered, release, thread, result = start_observed_request(w, "before")
    try:
        assert entered.wait(5), "request never reached first authority SELECT barrier"
        assert result.get("in_atomic"), "request did not BEGIN before revocation"
        with transaction.atomic():
            raw_update(w.member, state="removed")
        # Commit completed on a different connection before the first request SELECT.
        assert connection.connection is not result["driver"]
        finish_request(release, thread, result)
        assert_snapshot_boundary(result)
        assert result["response"].status_code == 403, (
            "first authority query ignored previously committed revocation"
        )
        safe_problem(result["response"], 403, "forbidden")
    finally:
        finish_request(release, thread, result)


def test_concurrent_changes_never_mix_the_authorized_projection(http_world):
    w = http_world
    before = request(w.client, w.credential)
    assert before.status_code == 200
    previous = before.json()
    entered, release, thread, result = start_observed_request(w, "after")
    try:
        assert entered.wait(5), "request never reached authorized snapshot barrier"
        with transaction.atomic():
            raw_update(w.member, role="org_admin")
            raw_update(w.person, display_name="Changed after first authority query")
        finish_request(release, thread, result)
        assert_snapshot_boundary(result)
        assert result["response"].status_code == 200
        assert result["response"].json() == previous, "customer projection mixed database snapshots"
        next_response = request(w.client, w.credential)
        assert next_response.status_code == 200
        assert next_response.json()["display_name"] == "Changed after first authority query"
        assert next_response.json()["organisations"][0]["role"] == "org_admin"
    finally:
        finish_request(release, thread, result)


def test_ar16_actual_unavailable_postgres_connection_is_safe_internal_error(http_world, caplog):
    w = http_world
    assert request(w.client, w.credential).status_code == 200
    stop = threading.Event()
    touched = threading.Event()
    listener = socket.socket()

    def drop_connection():
        while not stop.is_set():
            try:
                client, _ = listener.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            touched.set()
            client.close()

    thread = threading.Thread(target=drop_connection)
    original = connection.settings_dict
    started = False
    password_sentinel = "owned-http-outage-password-sentinel"
    try:
        listener.bind(("127.0.0.1", 0))
        listener.listen(4)
        listener.settimeout(0.1)
        thread.start()
        started = True
        connection.close()
        local = copy.deepcopy(original)
        local["HOST"] = "127.0.0.1"
        local["PASSWORD"] = password_sentinel
        local["PORT"] = listener.getsockname()[1]
        local["OPTIONS"] = {"connect_timeout": 2, "options": "-c statement_timeout=2000"}
        connection.settings_dict = local
        response = request(w.client, w.credential)
        assert touched.is_set(), "outage test never attempted the actual database connection"
        safe_problem(
            response,
            500,
            "internal-error",
            sentinels=(w.credential, w.current.subject, w.person.email, password_sentinel),
        )
        for value in (w.credential, w.current.subject, w.person.email, password_sentinel):
            if value and value in caplog.text:
                pytest.fail("sensitive input or database credential appeared in outage logs")
    finally:
        connection.close()
        connection.settings_dict = original
        stop.set()
        listener.close()
        if started:
            thread.join(3)
            assert not thread.is_alive(), "owned unavailable-database listener did not finish"
    assert request(w.client, w.credential).status_code == 200
