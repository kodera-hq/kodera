"""Actual PostgreSQL snapshot barriers and least-privilege reader probes."""

import copy
import threading
from contextlib import contextmanager
from uuid import uuid4

import psycopg
import pytest
from customer_http_fixtures import http_signer as http_signer, http_world as http_world
from django.db import connection, connections, transaction
from django.test import Client
from psycopg import sql
from test_access_tokens import frozen_clock as frozen_clock
from test_customer_persistence_models import raw_update
from test_organisation_detail import detail


def observed_request(w, phase, reader):
    entered, release = threading.Event(), threading.Event()
    result = {}

    def run():
        local = connections["default"]
        local.settings_dict = reader
        seen = False

        def observe(execute, statement, params, many, context):
            nonlocal seen
            normalized = " ".join(statement.lower().split())
            if seen or not normalized.startswith("select"):
                return execute(statement, params, many, context)
            seen = True
            result["identity_first"] = w.models.Identity._meta.db_table in normalized
            result["atomic"] = local.in_atomic_block
            result["driver"] = local.connection
            if phase == "before":
                entered.set()
                assert release.wait(8), "authority barrier was not released"
            value = execute(statement, params, many, context)
            with local.connection.cursor() as cursor:
                cursor.execute("SHOW transaction_isolation")
                result["isolation"] = cursor.fetchone()[0]
                cursor.execute("SHOW transaction_read_only")
                result["read_only"] = cursor.fetchone()[0]
            if phase == "after":
                entered.set()
                assert release.wait(8), "projection barrier was not released"
            return value

        try:
            client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
            with local.execute_wrapper(observe):
                result["response"] = client.get(
                    f"/api/v1/organisations/{w.first.id}",
                    HTTP_AUTHORIZATION="Bearer " + w.credential,
                )
        finally:
            local.close()

    thread = threading.Thread(target=run)
    thread.start()
    return entered, release, thread, result


def finish(release, thread, result):
    release.set()
    thread.join(10)
    if thread.is_alive() and result.get("driver"):
        result["driver"].cancel()
        thread.join(3)
    assert not thread.is_alive(), "owned organisation request thread did not stop"


def assert_snapshot(result):
    assert result["identity_first"] and result["atomic"]
    assert result["isolation"] == "repeatable read", "organisation snapshot isolation was weakened"
    assert result["read_only"] == "on", "organisation transaction permits writes"


def test_revocation_before_snapshot_denies(http_world, reader_role):
    w = http_world
    assert detail(w).status_code == 200
    entered, release, thread, result = observed_request(w, "before", reader_role)
    try:
        assert entered.wait(8), "request never reached authority SELECT"
        with transaction.atomic():
            raw_update(w.member, state="removed")
        assert connection.connection is not result["driver"]
        finish(release, thread, result)
        assert_snapshot(result)
        assert result["response"].status_code == 403, "committed revocation missed first snapshot"
    finally:
        finish(release, thread, result)


def test_coherent_snapshot_across_revocation_and_data_change(http_world, reader_role):
    w = http_world
    before = detail(w)
    assert before.status_code == 200
    entered, release, thread, result = observed_request(w, "after", reader_role)
    try:
        assert entered.wait(8), "request never reached projection barrier"
        with transaction.atomic():
            raw_update(w.first, name="Changed after snapshot")
            raw_update(w.member, state="removed")
        finish(release, thread, result)
        response = result["response"]
        assert response.status_code == 200, "organisation projection mixed database snapshots"
        assert response.content == before.content, (
            "organisation projection mixed database snapshots"
        )
        assert response.headers["ETag"] == before.headers["ETag"]
        assert_snapshot(result)
        assert detail(w).status_code == 403
    finally:
        finish(release, thread, result)


@pytest.fixture
def reader_role(http_world):
    """Own a fresh login and connection; restore owner for synthetic fixture cleanup."""
    w = http_world
    original = connection.settings_dict
    name = "org_reader_" + uuid4().hex
    password = "synthetic-reader-only"
    tables = [
        w.models.User._meta.db_table,
        w.models.Identity._meta.db_table,
        w.models.Organisation._meta.db_table,
        w.models.Membership._meta.db_table,
    ]
    with connection.cursor() as cursor:
        # Only this disposable pytest database is changed; preserve its original PUBLIC grants.
        cursor.execute(
            "SELECT EXISTS (SELECT 1 FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a WHERE d.datname=current_database() AND a.grantee=0 AND a.privilege_type='TEMPORARY'), EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a WHERE n.nspname='public' AND a.grantee=0 AND a.privilege_type='CREATE')"
        )
        public_temp, public_create = cursor.fetchone()
        cursor.execute(
            "SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')"
        )
        public_functions = [row[0] for row in cursor.fetchall()]
        cursor.execute(
            sql.SQL("REVOKE TEMPORARY ON DATABASE {} FROM PUBLIC").format(
                sql.Identifier(original["NAME"])
            )
        )
        cursor.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")
        cursor.execute("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC")
        cursor.execute(
            sql.SQL(
                "CREATE ROLE {} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {}"
            ).format(sql.Identifier(name), sql.Literal(password))
        )
        cursor.execute(
            sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(
                sql.Identifier(original["NAME"]), sql.Identifier(name)
            )
        )
        cursor.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(sql.Identifier(name)))
        for table in tables:
            cursor.execute(
                sql.SQL("GRANT SELECT ON {} TO {}").format(
                    sql.Identifier(table), sql.Identifier(name)
                )
            )
    reader = copy.deepcopy(original)
    reader.update(USER=name, PASSWORD=password)
    try:
        yield reader
    finally:
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(name)))
            cursor.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(name)))
            if public_temp:
                cursor.execute(
                    sql.SQL("GRANT TEMPORARY ON DATABASE {} TO PUBLIC").format(
                        sql.Identifier(original["NAME"])
                    )
                )
            if public_create:
                cursor.execute("GRANT CREATE ON SCHEMA public TO PUBLIC")
            for function in public_functions:
                # regprocedure is database-owned schema/name/signature, never caller input.
                cursor.execute(
                    sql.SQL("GRANT EXECUTE ON FUNCTION {} TO PUBLIC").format(sql.SQL(function))
                )


@contextmanager
def reader_connection(reader):
    original = connection.settings_dict
    connection.close()
    connection.settings_dict = reader
    try:
        connection.ensure_connection()
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT current_user, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=current_user"
            )
            assert cursor.fetchone() == (reader["USER"], False, False, False, False, False)
            cursor.execute(
                "SELECT has_database_privilege(current_database(), 'TEMP'), has_schema_privilege('public', 'CREATE')"
            )
            assert cursor.fetchone() == (False, False)
        yield
    finally:
        connection.close()
        connection.settings_dict = original


def test_reader_get_and_read_write_42501_refusals(http_world, reader_role):
    w = http_world
    before = detail(w)
    assert before.status_code == 200
    with reader_connection(reader_role):
        response = detail(w)
        assert response.status_code == 200, "SELECT-only reader cannot serve organisation GET"
        assert response.content == before.content
        statements = [
            statement
            for table in (
                "orgs_organisation",
                "orgs_membership",
                "identity_user",
                "identity_identity",
            )
            for statement in (
                sql.SQL("UPDATE {} SET id=id").format(sql.Identifier(table)),
                sql.SQL("DELETE FROM {} WHERE false").format(sql.Identifier(table)),
                sql.SQL("INSERT INTO {} (id) VALUES (NULL)").format(sql.Identifier(table)),
                sql.SQL("TRUNCATE {}").format(sql.Identifier(table)),
            )
        ] + [
            "CREATE TEMP TABLE org_detail_temporary (value integer)",
            "CREATE TABLE public.org_detail_forbidden (value integer)",
        ]
        for statement in statements:
            with pytest.raises(psycopg.errors.InsufficientPrivilege) as error:
                with connection.connection.transaction():
                    with connection.connection.cursor() as cursor:
                        cursor.execute("SET TRANSACTION READ WRITE")
                        cursor.execute("SHOW transaction_read_only")
                        assert cursor.fetchone() == ("off",)
                        cursor.execute(statement)
            assert error.value.sqlstate == "42501", "reader did not prove privilege refusal42501"
