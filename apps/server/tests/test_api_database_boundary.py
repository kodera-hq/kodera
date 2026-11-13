"""The actual WSGI entry rejects database owners on every new connection."""

import json
import os
import secrets
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError, connection
from psycopg import sql

ROOT = Path(__file__).resolve().parents[1]
pytestmark = pytest.mark.django_db(transaction=True)


def runtime(url, options=""):
    program = """
import json,os
from config.deploy_wsgi import application
from django.db import connection,DatabaseError
from django.test import Client
if os.environ.get('KODERA_TEST_DB_OPTIONS'):
 connection.settings_dict['OPTIONS']['options'] += ' ' + os.environ['KODERA_TEST_DB_OPTIONS']
result=[]
client=Client()
for _ in range(2):
 response=client.get('/health/ready',HTTP_HOST='api.synthetic.test')
 result.append({'status':response.status_code,'closed':connection.connection is None})
print(json.dumps(result))
"""
    result = subprocess.run(  # noqa: S603 - owned WSGI proof, disposable database only
        [sys.executable, "-c", program],
        cwd=ROOT,
        env={
            "PATH": os.environ["PATH"],
            "PYTHONDONTWRITEBYTECODE": "1",
            "DJANGO_SECRET_KEY": "synthetic-deployment-only-" + "abc0123456789" * 5,
            "DJANGO_ALLOWED_HOSTS": "api.synthetic.test",
            "DATABASE_URL": url,
            "KODERA_TEST_DB_OPTIONS": options,
        },
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, "owned WSGI boundary proof failed"
    return json.loads(result.stdout)


def database_url(user=None, password=None):
    database = connection.settings_dict
    return (
        "postgresql://"
        + quote(user or database["USER"], safe="")
        + ":"
        + quote(password or database["PASSWORD"], safe="")
        + "@"
        + database["HOST"]
        + ":"
        + str(database["PORT"])
        + "/"
        + quote(database["NAME"], safe="")
    )


def test_actual_wsgi_repeatedly_refuses_the_migration_owner():
    assert runtime(database_url()) == [{"status": 503, "closed": True}] * 2


@pytest.fixture
def reader():
    name, password = "api_reader_" + uuid4().hex[:12], secrets.token_urlsafe(32)
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL(
                "CREATE ROLE {} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {}"
            ).format(sql.Identifier(name), sql.Literal(password))
        )
        cursor.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(sql.Identifier(name)))
        cursor.execute(
            sql.SQL(
                "GRANT SELECT ON identity_user,identity_identity,identity_staffrole,orgs_organisation,orgs_membership TO {}"
            ).format(sql.Identifier(name))
        )
    try:
        yield name, password
    finally:
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(name)))
            cursor.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(name)))


def test_actual_wsgi_accepts_the_existing_read_only_profile(reader):
    assert runtime(database_url(*reader)) == [{"status": 200, "closed": False}] * 2


@pytest.mark.parametrize(
    "privilege",
    [
        "SELECT ON pg_catalog.pg_authid",
        "SELECT (rolpassword) ON pg_catalog.pg_authid",
        "EXECUTE ON FUNCTION pg_catalog.pg_read_file(text)",
    ],
)
@pytest.mark.parametrize("boundary", ["installer", "runtime"])
def test_api_refuses_explicit_catalog_grants_but_preserves_public_metadata(
    reader, privilege, boundary
):
    from test_intake_writer_role import acting_as

    from core.db.api_database_boundary import assert_writer_grants

    with acting_as(reader[0]), connection.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM pg_catalog.pg_roles")
        assert cursor.fetchone()[0] >= 1
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("GRANT {} TO {}").format(sql.SQL(privilege), sql.Identifier(reader[0]))
        )
    try:
        if boundary == "installer":
            with (
                connection.cursor() as cursor,
                pytest.raises(DatabaseError, match="API database role refused"),
            ):
                assert_writer_grants(cursor, reader[0])
        else:
            assert runtime(database_url(*reader)) == [{"status": 503, "closed": True}] * 2
    finally:
        with connection.cursor() as cursor:
            cursor.execute(
                sql.SQL("REVOKE {} FROM {}").format(sql.SQL(privilege), sql.Identifier(reader[0]))
            )
    assert runtime(database_url(*reader)) == [{"status": 200, "closed": False}] * 2


@pytest.mark.parametrize(
    "table,column",
    [
        ("pg_authid", "rolpassword"),
        ("pg_user_mapping", "umoptions"),
        ("pg_subscription", "subconninfo"),
    ],
)
def test_api_refuses_public_access_to_secret_catalog_columns(reader, table, column):
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT has_column_privilege(%s,%s,%s,'SELECT')",
            [reader[0], "pg_catalog." + table, column],
        )
        assert cursor.fetchone() == (False,), "secret catalog column is already public"
        cursor.execute(
            sql.SQL("GRANT SELECT ({}) ON pg_catalog.{} TO PUBLIC").format(
                sql.Identifier(column), sql.Identifier(table)
            )
        )
    try:
        assert runtime(database_url(*reader)) == [{"status": 503, "closed": True}] * 2
    finally:
        with connection.cursor() as cursor:
            cursor.execute(
                sql.SQL("REVOKE SELECT ({}) ON pg_catalog.{} FROM PUBLIC").format(
                    sql.Identifier(column), sql.Identifier(table)
                )
            )
    assert runtime(database_url(*reader)) == [{"status": 200, "closed": False}] * 2


@pytest.mark.parametrize("setting", ["role", "session_authorization"])
def test_actual_wsgi_refuses_a_masked_owner_on_every_connection(reader, setting):
    assert (
        runtime(database_url(), f"-c {setting}={reader[0]}")
        == [{"status": 503, "closed": True}] * 2
    )


def test_operator_configures_independent_writer_and_refuses_excess_grants(monkeypatch):
    from io import StringIO

    password = secrets.token_urlsafe(32)
    url = database_url("kodera_api", password)
    monkeypatch.setenv("KODERA_API_DATABASE_URL", url)
    monkeypatch.setenv(
        "KODERA_COLLAB_DATABASE_URL", database_url("kodera_collab", secrets.token_urlsafe(32))
    )
    try:
        for _ in range(2):
            output = StringIO()
            call_command("configure_api_role", stdout=output)
            assert "Independent API database role configured" in output.getvalue()
        assert runtime(url) == [{"status": 200, "closed": False}] * 2
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT rolconnlimit,rolsuper,rolinherit,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname='kodera_api'"
            )
            assert cursor.fetchone() == (16, False, False, False, False)
        for privilege in (
            "UPDATE(state) ON orgs_organisation",
            "DELETE ON audit_auditevent",
            "SELECT ON docs_collaborationticket",
            "TRUNCATE ON docs_document",
        ):
            with connection.cursor() as cursor:
                cursor.execute("GRANT " + privilege + " TO kodera_api")
            try:
                with pytest.raises(CommandError, match="API database role provisioning refused"):
                    call_command("configure_api_role", stdout=StringIO())
            finally:
                with connection.cursor() as cursor:
                    cursor.execute("REVOKE " + privilege + " FROM kodera_api")
        privileges = [
            "SELECT ON identity_user",
            "EXECUTE ON FUNCTION audit_workspace_resource_event(uuid,text,uuid,uuid,uuid,text)",
            "USAGE ON SCHEMA public",
            'CONNECT ON DATABASE "' + connection.settings_dict["NAME"].replace('"', '""') + '"',
        ]
        for privilege in privileges:
            with connection.cursor() as cursor:
                cursor.execute(
                    sql.SQL("GRANT {} TO kodera_api WITH GRANT OPTION").format(sql.SQL(privilege))
                )
            try:
                with pytest.raises(CommandError, match="API database role provisioning refused"):
                    call_command("configure_api_role", stdout=StringIO())
                assert runtime(url) == [{"status": 503, "closed": True}] * 2
            finally:
                with connection.cursor() as cursor:
                    cursor.execute(
                        sql.SQL("REVOKE GRANT OPTION FOR {} FROM kodera_api").format(
                            sql.SQL(privilege)
                        )
                    )
            assert runtime(url) == [{"status": 200, "closed": False}] * 2
    finally:
        with connection.cursor() as cursor:
            cursor.execute("DROP OWNED BY kodera_api")
            cursor.execute("DROP ROLE kodera_api")


@pytest.mark.parametrize("change", ["owner", "password", "host", "database", "options"])
def test_api_role_credential_refuses_reuse_or_destination_changes(change):
    from django.core.exceptions import ImproperlyConfigured

    from core.db.api_database_boundary import credentials

    database = {
        "USER": "owner",
        "PASSWORD": "synthetic-owner-password-long-enough",
        "HOST": "db",
        "PORT": 5432,
        "NAME": "kodera",
    }
    values = {
        "role": "kodera_api",
        "password": "synthetic-api-password-long-enough",
        "host": "db",
        "database": "kodera",
        "query": "",
    }
    if change == "owner":
        values["role"] = "owner"
    elif change == "password":
        values["password"] = database["PASSWORD"]
    elif change == "host":
        values["host"] = "other"
    elif change == "database":
        values["database"] = "other"
    else:
        values["query"] = "?options=-c%20role=owner"
    url = "postgresql://{role}:{password}@{host}:5432/{database}{query}".format(**values)
    with pytest.raises(ImproperlyConfigured, match="independent login on the migrated database"):
        credentials(url, database)


@pytest.mark.parametrize(
    "command,role,own,peer,peer_role",
    [
        (
            "configure_api_role",
            "kodera_api",
            "KODERA_API_DATABASE_URL",
            "KODERA_COLLAB_DATABASE_URL",
            "kodera_collab",
        ),
        (
            "configure_collab_role",
            "kodera_collab",
            "KODERA_COLLAB_DATABASE_URL",
            "KODERA_API_DATABASE_URL",
            "kodera_api",
        ),
    ],
)
def test_installer_refuses_peer_password_reuse_before_creating_a_login(
    monkeypatch, command, role, own, peer, peer_role
):
    from io import StringIO

    password = "synthetic-shared-" + secrets.token_urlsafe(32) + ":@"
    monkeypatch.setenv(own, database_url(role, password))
    monkeypatch.setenv(peer, database_url(peer_role, password))
    refusal = (
        "API database role provisioning refused"
        if role == "kodera_api"
        else "collaboration database must use its dedicated login on the migrated database"
    )
    try:
        with pytest.raises(CommandError, match=refusal):
            call_command(command, stdout=StringIO())
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", [role])
            assert cursor.fetchone() is None, "refused credentials created a database login"
    finally:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", [role])
            if cursor.fetchone() is not None:
                cursor.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(role)))
                cursor.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(role)))
