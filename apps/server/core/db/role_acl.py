"""Inspect delegation and catalog grants without reading protected data."""

from typing import Any


def has_delegation(cursor: Any, role: str) -> bool:
    # Default owner privileges cannot apply: callers separately refuse ownership.
    # Ordinary PUBLIC defaults carry no grant option. Inspect explicit ACLs,
    # including column ACLs and functions whose EXECUTE has been narrowed.
    cursor.execute(
        """SELECT EXISTS(
        SELECT 1 FROM (
          SELECT c.relacl AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          UNION ALL SELECT a.attacl FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_'
            AND n.nspname<>'information_schema' AND a.attnum>0 AND NOT a.attisdropped
          UNION ALL SELECT p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          UNION ALL SELECT nspacl FROM pg_namespace WHERE nspname !~ '^pg_'
            AND nspname<>'information_schema'
          UNION ALL SELECT datacl FROM pg_database
        ) objects CROSS JOIN LATERAL aclexplode(objects.acl) privilege
        WHERE privilege.is_grantable AND (privilege.grantee=0 OR privilege.grantee=
          (SELECT oid FROM pg_roles WHERE rolname=%s)))""",
        [role],
    )
    return bool(cursor.fetchone()[0])


def has_catalog_grants(cursor: Any, role: str) -> bool:
    # Ordinary PUBLIC catalog metadata remains readable. Neither runtime grant
    # policy authorizes explicit privileges on system objects, and these three
    # secret-bearing columns must remain inaccessible even through PUBLIC.
    cursor.execute(
        """SELECT EXISTS(
        SELECT 1 FROM (
          SELECT c.relacl AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname ~ '^pg_' OR n.nspname='information_schema'
          UNION ALL SELECT a.attacl FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace WHERE (n.nspname ~ '^pg_'
            OR n.nspname='information_schema') AND a.attnum>0 AND NOT a.attisdropped
          UNION ALL SELECT p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname ~ '^pg_' OR n.nspname='information_schema'
          UNION ALL SELECT nspacl FROM pg_namespace WHERE nspname ~ '^pg_'
            OR nspname='information_schema'
        ) objects CROSS JOIN LATERAL aclexplode(objects.acl) privilege
        WHERE privilege.grantee=(SELECT oid FROM pg_roles WHERE rolname=%s))
        OR EXISTS(SELECT 1 FROM (VALUES
          ('pg_catalog.pg_authid','rolpassword'),
          ('pg_catalog.pg_user_mapping','umoptions'),
          ('pg_catalog.pg_subscription','subconninfo')
        ) sensitive(relation_name,column_name)
        WHERE has_column_privilege(%s,sensitive.relation_name,sensitive.column_name,'SELECT'))""",
        [role, role],
    )
    return bool(cursor.fetchone()[0])
