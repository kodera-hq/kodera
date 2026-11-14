"""Every new Collections, quota and export migration bounds its own forward/reverse DDL."""

from contextlib import nullcontext
from functools import wraps

import pytest
import sqlparse
from django.db.migrations.executor import MigrationExecutor
from test_customer_persistence_migrations import empty_database, schema_objects

OWNED = {
    ("orgs", "0022_private_export_checkpoints"),
    ("docs", "0005_collection_collectionrow_and_more"),
    ("docs", "0006_collection_scope"),
    ("docs", "0007_materialized_snapshot_quota"),
    ("workspaces", "0011_workspacequota"),
    ("workspaces", "0012_quota_enforcement"),
}


@pytest.mark.parametrize("missing_timeout", [None, "forward", "reverse"])
def test_each_new_migration_bounds_forward_and_reverse_ddl(
    transactional_db, django_db_blocker, monkeypatch, missing_timeout
):
    observed = set()
    active = None

    def isolated(original, direction):
        @wraps(original)
        def run(executor, project_state, migration, *args, **kwargs):
            nonlocal active
            key = (migration.app_label, migration.name)
            if key not in OWNED:
                return original(executor, project_state, migration, *args, **kwargs)
            with executor.connection.cursor() as cursor:
                cursor.execute("SET lock_timeout='0'; SET statement_timeout='0'")
            active = (*key, direction)
            try:
                return original(executor, project_state, migration, *args, **kwargs)
            finally:
                active = None

        return run

    monkeypatch.setattr(
        MigrationExecutor, "apply_migration", isolated(MigrationExecutor.apply_migration, "forward")
    )
    monkeypatch.setattr(
        MigrationExecutor,
        "unapply_migration",
        isolated(MigrationExecutor.unapply_migration, "reverse"),
    )

    def checked(execute, statement, params, many, context):
        if active is None:
            return execute(statement, params, many, context)
        # Run the same SQL statements individually in the same migration transaction.
        # In particular, inspect DDL after the preceding SET LOCAL in RunSQL chunks.
        statements = sqlparse.split(str(statement))
        assert not many and (len(statements) <= 1 or params is None)
        result = None
        for part in statements:
            if active == (
                "orgs",
                "0022_private_export_checkpoints",
                missing_timeout,
            ) and part.lstrip().upper().startswith("SET LOCAL "):
                # Refusal control: omit only this migration's timeout settings. The
                # following real CREATE/DROP TABLE must observe zero and be refused.
                continue
            if part.lstrip().upper().startswith(("CREATE ", "ALTER ", "DROP ")):
                execute(
                    "SELECT current_setting('lock_timeout'), current_setting('statement_timeout')",
                    None,
                    False,
                    context,
                )
                values = context["cursor"].fetchone()
                assert all(value not in ("0", "0ms", "0s") for value in values), (
                    active,
                    "migration DDL lacks finite timeouts",
                    values,
                    part[:100],
                )
                observed.add(active)
            result = execute(part, params, many, context)
        return result

    outcome = (
        nullcontext()
        if missing_timeout is None
        else pytest.raises(AssertionError, match="migration DDL lacks finite timeouts")
    )
    with (
        outcome,
        django_db_blocker.unblock(),
        empty_database() as target,
        target.execute_wrapper(checked),
    ):
        executor = MigrationExecutor(target)
        from historical_lifecycle import HISTORICAL_LIFECYCLE_TARGETS

        targets = list(HISTORICAL_LIFECYCLE_TARGETS)
        executor.migrate(targets)
        first = schema_objects(target)
        MigrationExecutor(target).migrate(
            [
                ("docs", "0004_single_use_tickets"),
                ("workspaces", "0010_moderation_scope_guards"),
                ("orgs", "0021_remove_organisation_organisation_slug_not_reserved_and_more"),
            ]
        )
        MigrationExecutor(target).migrate(targets)
        assert schema_objects(target) == first
    if missing_timeout is not None:
        return
    assert observed == {(*key, direction) for key in OWNED for direction in ("forward", "reverse")}
