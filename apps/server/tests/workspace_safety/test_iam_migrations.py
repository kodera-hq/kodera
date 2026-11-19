"""Both IAM migrations bound forward/reverse DDL and restore their exact definitions."""

import pytest
from django.db.migrations.executor import MigrationExecutor
from test_customer_persistence_migrations import empty_database
from test_workspace_metadata_schema import schema_objects
from workspace_quotas.test_retention_migration_timeouts import finite_ddl

pytestmark = pytest.mark.django_db(transaction=True)


def test_iam_migrations_round_trip_with_finite_ddl(django_db_blocker, monkeypatch):
    with django_db_blocker.unblock(), empty_database() as database:
        with finite_ddl(database, monkeypatch, None) as observed:
            MigrationExecutor(database).migrate([("workspaces", "0014_iam_scope_guards")])
            before = schema_objects(database)
            MigrationExecutor(database).migrate([("workspaces", "0012_quota_enforcement")])
            MigrationExecutor(database).migrate([("workspaces", "0014_iam_scope_guards")])
            assert schema_objects(database) == before
        assert {
            ("workspaces", migration, direction)
            for migration in ["0013_granular_iam", "0014_iam_scope_guards"]
            for direction in ["forward", "reverse"]
        } <= observed
