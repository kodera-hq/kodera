"""Reject elevated HTTP database identities without changing command-only profiles."""

from contextlib import suppress
from typing import Any
from urllib.parse import unquote, urlsplit

from django.core.exceptions import ImproperlyConfigured
from django.db import DatabaseError
from django.db.backends.base.base import BaseDatabaseWrapper
from django.db.backends.signals import connection_created

from . import api_writer_role as policy
from .role_acl import has_catalog_grants, has_delegation

REFUSAL = "API database role refused"


def credentials(
    value: str, database: dict[str, Any], peer_url: str | None = None
) -> tuple[str, str]:
    try:
        parsed = urlsplit(value)
        role, password = unquote(parsed.username or ""), unquote(parsed.password or "")
        peer_password = unquote(urlsplit(peer_url).password or "") if peer_url else None
        if (
            parsed.scheme not in {"postgres", "postgresql"}
            or role != "kodera_api"
            or len(password) < 32
            or password == database["PASSWORD"]
            or password == peer_password
            or parsed.hostname != database["HOST"]
            or (parsed.port if parsed.port is not None else 5432)
            != int(database.get("PORT") or 5432)
            or unquote(parsed.path.removeprefix("/")) != database["NAME"]
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError
    except (AttributeError, KeyError, TypeError, ValueError):
        raise ImproperlyConfigured(
            "API database must use its independent login on the migrated database"
        ) from None
    return role, password


def assert_authority(cursor: Any, role: str) -> None:
    """Common upper boundary for writer, reader and existing scoped claim profiles."""
    cursor.execute(
        "SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=%s",
        [role],
    )
    found = cursor.fetchone()
    if found is None or any(found[1:]):
        raise DatabaseError(REFUSAL)
    oid = found[0]
    cursor.execute("SELECT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=%s)", [oid])
    if cursor.fetchone()[0]:
        raise DatabaseError(REFUSAL)
    if has_delegation(cursor, role) or has_catalog_grants(cursor, role):
        raise DatabaseError(REFUSAL)
    cursor.execute(
        "SELECT EXISTS(SELECT 1 FROM pg_class WHERE relowner=%s UNION ALL SELECT 1 FROM pg_proc WHERE proowner=%s UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner=%s UNION ALL SELECT 1 FROM pg_database WHERE datdba=%s)",
        [oid, oid, oid, oid],
    )
    if cursor.fetchone()[0]:
        raise DatabaseError(REFUSAL)
    cursor.execute(
        "SELECT has_database_privilege(%s,current_database(),'CREATE') OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema' AND has_schema_privilege(%s,oid,'CREATE'))",
        [role, role],
    )
    if cursor.fetchone()[0]:
        raise DatabaseError(REFUSAL)
    cursor.execute(
        "SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(%s,c.oid,'TRUNCATE,REFERENCES,TRIGGER')) OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(%s,c.oid,a.attnum,'REFERENCES'))",
        [role, role],
    )
    if cursor.fetchone()[0]:
        raise DatabaseError(REFUSAL)


def assert_writer_grants(cursor: Any, role: str) -> None:
    """Installer refuses any effective privilege outside the existing writer policy."""
    assert_authority(cursor, role)
    cursor.execute(
        "SELECT n.nspname,c.relname,a.attname,has_column_privilege(%s,c.oid,a.attnum,'SELECT'),has_column_privilege(%s,c.oid,a.attnum,'INSERT'),has_column_privilege(%s,c.oid,a.attnum,'UPDATE') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped",
        [role, role, role],
    )
    for schema, table, column, reads, inserts, updates in cursor.fetchall():
        if (
            (schema != "public" and (reads or inserts or updates))
            or (
                reads
                and table not in policy.SELECT
                and (table, column) not in policy.SELECT_COLUMNS
            )
            or (inserts and table not in policy.INSERT)
            or (updates and (table, column) not in policy.UPDATE_COLUMNS)
        ):
            raise DatabaseError(REFUSAL)
    cursor.execute(
        "SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(%s,c.oid,'DELETE')",
        [role],
    )
    if any(schema != "public" or table not in policy.DELETE for schema, table in cursor.fetchall()):
        raise DatabaseError(REFUSAL)
    cursor.execute(
        "SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(%s,c.oid,'USAGE,SELECT,UPDATE') ELSE false END)",
        [role],
    )
    if cursor.fetchone()[0]:
        raise DatabaseError(REFUSAL)
    cursor.execute(
        "SELECT n.nspname,p.proname,oidvectortypes(p.proargtypes) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND (p.prorettype<>'trigger'::regtype OR p.prosecdef) AND has_function_privilege(%s,p.oid,'EXECUTE')",
        [role],
    )
    permitted = {value.replace(" ", "") for value in policy.EXECUTE_FUNCTIONS}
    if any(
        schema != "public" or name + "(" + arguments.replace(" ", "") + ")" not in permitted
        for schema, name, arguments in cursor.fetchall()
    ):
        raise DatabaseError(REFUSAL)


def guard_connection(
    sender: type[BaseDatabaseWrapper], connection: BaseDatabaseWrapper, **kwargs: object
) -> None:
    try:
        with connection.connection.cursor() as cursor:
            cursor.execute("SELECT current_user,session_user")
            current, session = cursor.fetchone()
            # The credential identity must agree too: startup session_authorization
            # can change both SQL identity fields on an owner-authenticated session.
            if current != session or session != connection.settings_dict["USER"]:
                raise DatabaseError(REFUSAL)
            assert_authority(cursor, current)
    except Exception:
        try:
            # Closing must not reveal driver diagnostics or retain the handle.
            with suppress(Exception):
                connection.close()
        finally:
            connection.connection = None
        raise DatabaseError(REFUSAL) from None


def install() -> None:
    """Register only from the production WSGI entry, without opening a database."""
    connection_created.connect(guard_connection, dispatch_uid="api_database_boundary", weak=False)
