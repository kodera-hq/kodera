"""Explicit reversible lifecycle history, independent of current forward-only erasure leaves."""

from contextlib import contextmanager

from django.db.migrations.executor import MigrationExecutor
from test_customer_persistence_migrations import empty_database

HISTORICAL_ANCHOR_TARGETS = (
    ("identity", "0006_discovery_quotas"),
    ("orgs", "0022_private_export_checkpoints"),
)
HISTORICAL_LIFECYCLE_TARGETS = (
    *HISTORICAL_ANCHOR_TARGETS,
    ("workspaces", "0012_quota_enforcement"),
    ("docs", "0007_materialized_snapshot_quota"),
    ("media", "0002_attachment_scope"),
)


@contextmanager
def historical_lifecycle_database(django_db_blocker):
    with django_db_blocker.unblock(), empty_database() as database:
        assert database.vendor == "postgresql" and database.pg_version // 10000 == 16
        executor = MigrationExecutor(database)
        plan = executor.migration_plan(HISTORICAL_LIFECYCLE_TARGETS)
        assert plan and all(not backwards for _, backwards in plan)
        assert all(
            operation.reversible for migration, _ in plan for operation in migration.operations
        ), "historical lifecycle dependency closure unexpectedly includes forward-only operations"
        executor.migrate(HISTORICAL_LIFECYCLE_TARGETS)
        historical = executor.loader.project_state(HISTORICAL_LIFECYCLE_TARGETS).apps
        yield database, historical
