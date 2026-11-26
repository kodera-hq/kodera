"""The additive grant migration bounds every DDL statement and restores the previous policy."""

from uuid import uuid4

import pytest
from django.db import IntegrityError, connection
from django.db.migrations.executor import MigrationExecutor
from psycopg import sql
from test_customer_persistence_migrations import empty_database
from test_workspace_metadata_schema import schema_objects
from workspace_quotas.test_retention_migration_timeouts import finite_ddl
from workspace_safety.test_moderation import world as world

from workspace_documents.test_role_grants import grants as grants

pytestmark = pytest.mark.django_db(transaction=True)


def test_role_grant_migration_round_trip_with_finite_ddl(django_db_blocker, monkeypatch):
    old = ("docs", "0012_confidential_collab_admission")
    new = ("docs", "0013_document_role_grants")
    with django_db_blocker.unblock(), empty_database() as database:
        MigrationExecutor(database).migrate([old, ("e2ee", "0002_scope_and_privacy")])
        reader = "document_migration_reader_" + uuid4().hex
        signatures = (
            "public.docs_document_role(uuid,uuid,uuid,uuid,text,text)",
            "public.docs_collab_fence(uuid,uuid,uuid,uuid,text,text,text,boolean,bigint)",
        )
        with database.cursor() as cursor:
            cursor.execute(sql.SQL("CREATE ROLE {} NOLOGIN").format(sql.Identifier(reader)))
        try:
            with database.cursor() as cursor:
                for signature in signatures:
                    cursor.execute(
                        sql.SQL("GRANT EXECUTE ON FUNCTION {} TO {}").format(
                            sql.SQL(signature), sql.Identifier(reader)
                        )
                    )
                    cursor.execute(
                        sql.SQL("COMMENT ON FUNCTION {} IS 'retained migration metadata'").format(
                            sql.SQL(signature)
                        )
                    )
            before = schema_objects(database)
            metadata = function_metadata(database, signatures)
            with finite_ddl(database, monkeypatch, None) as observed:
                MigrationExecutor(database).migrate([new])
                applied = schema_objects(database)
                MigrationExecutor(database).migrate([old])
                assert schema_objects(database) == before
                assert function_metadata(database, signatures) == metadata
                MigrationExecutor(database).migrate([new])
                assert schema_objects(database) == applied
            assert {("docs", new[1], direction) for direction in ("forward", "reverse")} <= observed
        finally:
            with database.cursor() as cursor:
                cursor.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(reader)))
                cursor.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(reader)))


def function_metadata(database, signatures):
    with database.cursor() as cursor:
        cursor.execute(
            """SELECT p.oid,p.proowner,p.proacl,p.proconfig,p.prosecdef,
                      obj_description(p.oid,'pg_proc')
               FROM pg_proc p WHERE p.oid IN (%s::regprocedure,%s::regprocedure)
               ORDER BY p.oid""",
            signatures,
        )
        rows = cursor.fetchall()
        assert len(rows) == len(signatures)
        return rows


def test_populated_rollback_refuses_viewer_privilege_promotion(world, grants):
    from apps.docs import services
    from apps.docs.models import Document
    from workspace_documents.test_role_grants import put

    org, _, _, tokens = world
    document, subteam = grants
    Document.objects.filter(pk=document.id).update(visibility="workspace")
    put(world, document, subteam, "viewer")
    with pytest.raises(IntegrityError, match="rollback refuses retained grants") as refused:
        MigrationExecutor(connection).migrate([("docs", "0012_confidential_collab_admission")])
    assert refused.value.__cause__.sqlstate == "23514"
    assert (
        services.read(verified=tokens[2], organisation_id=org.id, document_id=document.id)["role"]
        == "viewer"
    )
