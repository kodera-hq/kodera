"""Current leaves only move forward; reversible model DDL is separately qualified in order."""

from contextlib import contextmanager, nullcontext
from functools import wraps

import pytest
import sqlparse
from django.db.migrations.executor import MigrationExecutor
from test_customer_persistence_migrations import empty_database
from test_workspace_metadata_schema import schema_objects

MODEL_MIGRATIONS = {
    ("billing", "0017_creditnote_accounting_event_at_and_more"),
    ("orgs", "0024_privacyerasure_erasurereceipt"),
    ("orgs", "0028_accounterasure"),
    ("legal", "0005_acceptance_close_evidence_ref_and_more"),
    ("extensions", "0001_extension_delivery_import_digest"),
    ("extensions", "0003_observed_delivery_decisions"),
    ("extensions", "0005_nonstatutory_payload_expiry"),
    ("extensions", "0007_workspace_cutoff"),
    ("extensions", "0009_approved_erasure_admission"),
}
CURRENT_DDL_MIGRATIONS = MODEL_MIGRATIONS | {
    ("billing", "0013_billing_documents_vies"),
    ("billing", "0014_explicit_issuer_country"),
    ("billing", "0015_dunning_checkpoints"),
    ("billing", "0016_dunning_evidence_guards"),
    ("billing", "0020_fiscal_guard_relation_binding"),
    ("docs", "0001_initial"),
    ("docs", "0002_policy_and_scope"),
    ("engine_intents", "0001_initial"),
    ("engine_intents", "0012_workspace_moderation"),
    ("extensions", "0002_scope_evidence_guards"),
    ("extensions", "0004_decision_scope_guard"),
    ("extensions", "0006_expiry_purge_guard"),
    ("extensions", "0008_scoped_metadata_erasure"),
    ("media", "0001_initial"),
    ("notifications", "0001_initial"),
    ("orgs", "0030_erasure_resource_binding"),
    ("workspaces", "0008_warmpoolallocation"),
    ("workspaces", "0009_workspace_moderation"),
}
FAULT_MIGRATION = ("orgs", "0024_privacyerasure_erasurereceipt")


@contextmanager
def finite_ddl(database, monkeypatch, missing_timeout):
    observed = set()
    active = None

    def scoped(original, direction):
        @wraps(original)
        def execute(executor, state, migration, *args, **kwargs):
            nonlocal active
            with database.cursor() as cursor:
                cursor.execute("SET lock_timeout='0'; SET statement_timeout='0'")
            active = (migration.app_label, migration.name, direction)
            try:
                return original(executor, state, migration, *args, **kwargs)
            finally:
                active = None

        return execute

    def check(execute, statement, params, many, context):
        if active is None:
            return execute(statement, params, many, context)
        parts = sqlparse.split(str(statement))
        assert not many and (len(parts) <= 1 or params is None)
        result = None
        for part in parts:
            head = sqlparse.format(part, strip_comments=True).lstrip().upper()
            if active == (*FAULT_MIGRATION, missing_timeout) and head.startswith("SET LOCAL "):
                continue
            if head.startswith(("CREATE ", "ALTER ", "DROP ")) and not head.startswith(
                'CREATE TABLE "DJANGO_MIGRATIONS"'
            ):
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

    with monkeypatch.context() as patch:
        patch.setattr(
            MigrationExecutor,
            "apply_migration",
            scoped(MigrationExecutor.apply_migration, "forward"),
        )
        patch.setattr(
            MigrationExecutor,
            "unapply_migration",
            scoped(MigrationExecutor.unapply_migration, "reverse"),
        )
        with database.execute_wrapper(check):
            yield observed


def current_targets(executor):
    targets = [
        node
        for node in executor.loader.graph.leaf_nodes()
        if node[0] in {"identity", "orgs", "extensions", "billing", "legal"}
    ]
    assert {node[0] for node in targets} == {"identity", "orgs", "extensions", "billing", "legal"}
    return targets


@pytest.mark.parametrize("missing_timeout", [None, "forward"])
def test_current_leaves_bound_each_forward_migration_ddl(
    transactional_db, django_db_blocker, monkeypatch, missing_timeout
):
    outcome = (
        nullcontext()
        if missing_timeout is None
        else pytest.raises(AssertionError, match="migration DDL lacks finite timeouts")
    )
    with outcome as failure, django_db_blocker.unblock(), empty_database() as database:
        with finite_ddl(database, monkeypatch, missing_timeout) as observed:
            executor = MigrationExecutor(database)
            targets = current_targets(executor)
            executor.migrate(targets)
            assert {(*key, "forward") for key in CURRENT_DDL_MIGRATIONS} <= observed
            assert set(targets) <= MigrationExecutor(database).loader.applied_migrations.keys()
    if missing_timeout is not None:
        assert repr((*FAULT_MIGRATION, "forward")) in str(failure.value)


@pytest.mark.parametrize("missing_timeout", [None, "reverse"])
def test_each_model_only_migration_bounds_its_reversible_ddl_before_descendants(
    transactional_db, django_db_blocker, monkeypatch, missing_timeout
):
    outcome = (
        nullcontext()
        if missing_timeout is None
        else pytest.raises(AssertionError, match="migration DDL lacks finite timeouts")
    )
    with outcome as failure, django_db_blocker.unblock(), empty_database() as database:
        with finite_ddl(database, monkeypatch, missing_timeout) as observed:
            initial = MigrationExecutor(database)
            targets = current_targets(initial)
            plan = initial.migration_plan(targets)
            assert all(not backwards for _, backwards in plan)
            for migration, _ in plan:
                key = (migration.app_label, migration.name)
                executor = MigrationExecutor(database)
                assert [
                    (m.app_label, m.name, back) for m, back in executor.migration_plan([key])
                ] == [(*key, False)]
                executor.migrate([key])
                if key not in MODEL_MIGRATIONS:
                    continue
                assert all(operation.reversible for operation in migration.operations)
                before = schema_objects(database)
                parents = [
                    name for app, name in migration.dependencies if app == migration.app_label
                ]
                assert len(parents) <= 1
                previous = [(migration.app_label, parents[0] if parents else None)]
                executor = MigrationExecutor(database)
                reverse_plan = executor.migration_plan(previous)
                assert [(m.app_label, m.name, back) for m, back in reverse_plan] == [
                    (*key, True)
                ], "model-only roundtrip must not reverse statutory operations or descendants"
                executor.migrate(previous)
                MigrationExecutor(database).migrate([key])
                assert schema_objects(database) == before
            assert {
                (*key, direction)
                for key in MODEL_MIGRATIONS
                for direction in ("forward", "reverse")
            } <= observed
    if missing_timeout is not None:
        assert repr((*FAULT_MIGRATION, "reverse")) in str(failure.value)


def test_historical_database_refuses_current_forward_only_history_before_migration(
    transactional_db, django_db_blocker, monkeypatch
):
    import historical_lifecycle
    from django.db.migrations.loader import MigrationLoader

    current = [node for node in MigrationLoader(None).graph.leaf_nodes() if node[0] == "orgs"]
    assert len(current) == 1 and current[0] != ("orgs", "0022_private_export_checkpoints")
    targets = tuple(
        current[0] if node[0] == "orgs" else node
        for node in historical_lifecycle.HISTORICAL_LIFECYCLE_TARGETS
    )
    monkeypatch.setattr(historical_lifecycle, "HISTORICAL_LIFECYCLE_TARGETS", targets)
    reached = []

    def forbidden_execution(*args, **kwargs):
        reached.append(True)
        pytest.fail("historical migration execution must not start")

    monkeypatch.setattr(MigrationExecutor, "migrate", forbidden_execution)
    with pytest.raises(
        AssertionError,
        match="historical lifecycle dependency closure unexpectedly includes forward-only operations",
    ):
        with historical_lifecycle.historical_lifecycle_database(django_db_blocker):
            pytest.fail("forward-only current history was admitted")
    assert reached == []
