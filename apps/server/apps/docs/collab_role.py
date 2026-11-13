"""A document-only PostgreSQL login; owner credentials stay in migration tooling."""

import re
from urllib.parse import unquote, urlsplit

from django.core.exceptions import ImproperlyConfigured

from core.db.role_acl import has_catalog_grants, has_delegation

ROLE = re.compile(r"[a-z_][a-z0-9_]{0,62}\Z")
SELECT = ("docs_document", "docs_documentlink", "docs_documentsnapshot", "docs_documentupdate")
INSERT = ("docs_documentlink", "docs_documentupdate")
UPDATE = {
    "docs_document": ("markdown", "revision", "updated_at"),
    "docs_documentsnapshot": ("sequence", "head_sequence", "state", "updated_at"),
}
DELETE = ("docs_documentlink", "docs_documentupdate")
FUNCTIONS = (
    "docs_collab_fence(uuid,uuid,uuid,uuid,text,text,text)",
    "docs_collab_audit(uuid,text,uuid,uuid,uuid,text)",
    "docs_redeem_collaboration_ticket(uuid,bigint)",
)


def grant_statements(role: str) -> list[str]:
    if not isinstance(role, str) or ROLE.fullmatch(role) is None:
        raise ValueError("a role name is a lower-case identifier")
    statements = [f'GRANT USAGE ON SCHEMA public TO "{role}"']
    for privilege, tables in (("SELECT", SELECT), ("INSERT", INSERT), ("DELETE", DELETE)):
        statements.extend(f'GRANT {privilege} ON TABLE "{table}" TO "{role}"' for table in tables)
    for table, columns in UPDATE.items():
        names = ",".join(f'"{column}"' for column in columns)
        statements.append(f'GRANT UPDATE ({names}) ON TABLE "{table}" TO "{role}"')
    statements.extend(
        f'GRANT EXECUTE ON FUNCTION {signature} TO "{role}"' for signature in FUNCTIONS
    )
    return statements


def credentials(value: str, database: dict, peer_url: str | None = None) -> tuple[str, str]:
    """Accept only the dedicated login for the very database being migrated."""
    try:
        parsed = urlsplit(value)
        role, password = unquote(parsed.username or ""), unquote(parsed.password or "")
        peer_password = unquote(urlsplit(peer_url).password or "") if peer_url else None
        if (
            parsed.scheme not in {"postgres", "postgresql"}
            or role != "kodera_collab"
            or len(password) < 32
            or password == database.get("PASSWORD")
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
            "collaboration database must use its dedicated login on the migrated database"
        ) from None
    return role, password


def assert_unprivileged(cursor, role: str) -> None:
    """Refuse pre-existing authority instead of silently normalizing an unsafe login."""
    cursor.execute(
        "SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit "
        "FROM pg_roles WHERE rolname=%s",
        [role],
    )
    found = cursor.fetchone()
    if found is None:
        return
    oid, *flags = found
    cursor.execute("SELECT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=%s)", [oid])
    memberships = cursor.fetchone()[0]
    cursor.execute(
        "SELECT EXISTS(SELECT 1 FROM pg_class WHERE relowner=%s UNION ALL "
        "SELECT 1 FROM pg_proc WHERE proowner=%s UNION ALL "
        "SELECT 1 FROM pg_namespace WHERE nspowner=%s UNION ALL "
        "SELECT 1 FROM pg_database WHERE datdba=%s)",
        [oid, oid, oid, oid],
    )
    owned = cursor.fetchone()[0]
    cursor.execute(
        "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema') "
        "AND nspname !~ '^pg_toast' AND has_schema_privilege(%s,oid,'CREATE')) "
        "OR has_database_privilege(%s,current_database(),'CREATE')",
        [role, role],
    )
    creates = cursor.fetchone()[0]
    if any(flags) or memberships or owned or creates:
        raise ImproperlyConfigured("collaboration database role has forbidden authority")
    if has_delegation(cursor, role):
        raise ImproperlyConfigured("collaboration database role has forbidden grant options")
    if has_catalog_grants(cursor, role):
        raise ImproperlyConfigured("collaboration database role has forbidden catalog grants")
    cursor.execute(
        "SELECT n.nspname,c.relname,a.attname,has_column_privilege(%s,c.oid,a.attnum,'SELECT'),"
        "has_column_privilege(%s,c.oid,a.attnum,'INSERT'),has_column_privilege(%s,c.oid,a.attnum,'UPDATE'),"
        "has_column_privilege(%s,c.oid,a.attnum,'REFERENCES') "
        "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid "
        "WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' "
        "AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped",
        [role, role, role, role],
    )
    for schema, table, column, reads, inserts, updates, references in cursor.fetchall():
        if (
            references
            or (reads and (schema != "public" or table not in SELECT))
            or (inserts and (schema != "public" or table not in INSERT))
            or (updates and (schema != "public" or column not in UPDATE.get(table, ())))
        ):
            raise ImproperlyConfigured("collaboration database role has forbidden table grants")
    cursor.execute(
        "SELECT n.nspname,c.relname,has_table_privilege(%s,c.oid,'DELETE'),"
        "has_table_privilege(%s,c.oid,'TRUNCATE,REFERENCES,TRIGGER') "
        "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
        "WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND c.relkind IN ('r','p','v','m','f')",
        [role, role],
    )
    if any(
        extra or (deletes and (schema != "public" or table not in DELETE))
        for schema, table, deletes, extra in cursor.fetchall()
    ):
        raise ImproperlyConfigured("collaboration database role has forbidden table grants")
    cursor.execute(
        "SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
        "WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' "
        "AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(%s,c.oid,'USAGE,SELECT,UPDATE') ELSE false END)",
        [role],
    )
    if cursor.fetchone()[0]:
        raise ImproperlyConfigured("collaboration database role has forbidden sequence grants")
