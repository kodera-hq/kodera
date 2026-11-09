"""Forward/reverse/reapply on one uniquely created empty acceptance database."""

import copy
import uuid
from contextlib import contextmanager
from pathlib import Path

import pytest
from django.db import IntegrityError, connections, transaction
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone
from psycopg import sql
from test_customer_persistence_concurrency import session
from test_customer_persistence_models import anchor_models


def test_anchor_migration_files_exist():
    root = Path(__file__).resolve().parents[1]
    missing = [
        app
        for app in ("identity", "orgs")
        if not list((root / "apps" / app / "migrations").glob("0*.py"))
    ]
    assert not missing, "customer anchor migrations are absent: " + ", ".join(missing)


@pytest.fixture(name="models")
def registered_models(transactional_db):
    return anchor_models()


@contextmanager
def empty_database():
    name = "test_customer_migration_" + uuid.uuid4().hex
    alias = name
    settings = copy.deepcopy(connections["default"].settings_dict)
    settings["NAME"] = name
    with session() as coordinator:
        coordinator.execute("SET lock_timeout='5s'")
        coordinator.execute("SET statement_timeout='30s'")
        assert coordinator.execute("SHOW lock_timeout").fetchone() == ("5s",)
        assert coordinator.execute("SHOW statement_timeout").fetchone() == ("30s",)
        coordinator.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
        connections.databases[alias] = settings
        try:
            target = connections[alias]
            assert target.settings_dict["NAME"] == name
            yield target
        finally:
            try:
                connections[alias].close()
            finally:
                # The generated identifier belongs only to this invocation. No
                # FORCE option, broad teardown, or shared test-database mutation.
                coordinator.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(name)))
                del connections[alias]
                del connections.databases[alias]


def schema_objects(target):
    with target.cursor() as cursor:
        cursor.execute("SELECT tablename FROM pg_tables WHERE schemaname=current_schema()")
        tables = {row[0] for row in cursor.fetchall()}
        cursor.execute(
            "SELECT p.proname, pg_get_function_identity_arguments(p.oid) FROM pg_proc p "
            "JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema()"
        )
        functions = set(cursor.fetchall())
        cursor.execute(
            "SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid "
            "JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() "
            "AND NOT t.tgisinternal"
        )
        return tables, functions, set(cursor.fetchall())


def test_empty_forward_reverse_reapply_migrations(models, record_property, django_db_blocker):
    expected = {model._meta.db_table for model in vars(models).values()}
    with django_db_blocker.unblock(), empty_database() as target:
        baseline = schema_objects(target)
        observed_timeouts = []

        def checked_ddl(execute, statement, params, many, context):
            text = str(statement).lstrip().upper()
            if (
                text.startswith(
                    (
                        "CREATE TABLE",
                        "ALTER TABLE",
                        "CREATE CONSTRAINT TRIGGER",
                        "CREATE TRIGGER",
                        "CREATE FUNCTION",
                        "CREATE OR REPLACE FUNCTION",
                        "DROP TABLE",
                        "DROP FUNCTION",
                    )
                )
                and "DJANGO_MIGRATIONS" not in text
            ):
                execute(
                    "SELECT current_setting('lock_timeout'), current_setting('statement_timeout')",
                    None,
                    False,
                    context,
                )
                values = context["cursor"].fetchone()
                assert all(value not in ("0", "0ms", "0s") for value in values), (
                    "migration DDL lacks finite timeouts"
                )
                observed_timeouts.append(values)
            return execute(statement, params, many, context)

        with target.execute_wrapper(checked_ddl):
            executor = MigrationExecutor(target)
            targets = [
                node
                for node in executor.loader.graph.leaf_nodes()
                if node[0] in ("identity", "orgs")
            ]
            assert {node[0] for node in targets} == {"identity", "orgs"}, "anchor migrations absent"
            executor.migrate(targets)
            first = schema_objects(target)
            assert expected <= first[0]
            assert first[1] - baseline[1], "constraint function definitions absent"
            assert first[2] - baseline[2], "actual constraint triggers absent"
            with target.cursor() as cursor:
                cursor.execute(
                    "SELECT conname FROM pg_constraint WHERE conrelid=ANY(%s::regclass[]) "
                    "AND NOT convalidated",
                    [sorted(expected)],
                )
                assert cursor.fetchall() == [], "forward migration left unvalidated constraints"
            # The real executor resolves the staged circular dependency order.
            executor = MigrationExecutor(target)
            executor.migrate([("identity", None), ("orgs", None)])
            reversed_objects = schema_objects(target)
            assert not expected & reversed_objects[0]
            assert reversed_objects[1] == baseline[1], "reverse left application functions behind"
            assert reversed_objects[2] == baseline[2], "reverse left application triggers behind"
            executor = MigrationExecutor(target)
            executor.migrate(targets)
            assert schema_objects(target) == first, "reapply changed application schema objects"
            historical = executor.loader.project_state(targets).apps
            User = historical.get_model("identity", "User")
            Organisation = historical.get_model("orgs", "Organisation")
            Membership = historical.get_model("orgs", "Membership")
            reservation_model = historical.get_model("orgs", "SlugReservation")
            Identity = historical.get_model("identity", "Identity")
            with transaction.atomic(using=target.alias):
                org = Organisation.objects.using(target.alias).create(
                    slug="alpha",
                    realm="alpha",
                    issuer="https://identity.customer.test/realms/alpha",
                    name="Synthetic",
                    state="active",
                )
                reservation_model.objects.using(target.alias).create(
                    organisation=org,
                    namespace="organisation",
                    slug="alpha",
                    state="permanent",
                    protected_at=timezone.now(),
                )
                user = User.objects.using(target.alias).create(email="owner@customer.test")
                Membership.objects.using(target.alias).create(
                    user=user,
                    organisation=org,
                    role="org_owner",
                    state="active",
                    accepted_at=timezone.now(),
                )
                Identity.objects.using(target.alias).create(
                    user=user,
                    organisation=org,
                    issuer=org.issuer,
                    realm=org.realm,
                    subject="Provider-Subject",
                    email="owner@customer.test",
                )
            assert Membership.objects.using(target.alias).count() == 1
        assert observed_timeouts, "no actual migration DDL timeout observations"
        record_property("migration_timeouts", observed_timeouts)


def authority_schema_definitions(target):
    """Logical definitions, never OIDs that necessarily change on recreation."""
    tables = [
        "identity_user",
        "identity_identity",
        "orgs_organisation",
        "orgs_membership",
        "orgs_slugreservation",
    ]
    with target.cursor() as cursor:
        cursor.execute(
            "SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod),"
            "a.attnotnull,pg_get_expr(d.adbin,d.adrelid) FROM pg_attribute a "
            "JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d "
            "ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE c.relname=ANY(%s) "
            "AND c.relnamespace=current_schema()::regnamespace AND a.attnum>0 AND NOT a.attisdropped "
            "ORDER BY c.relname,a.attname",
            [tables],
        )
        columns = cursor.fetchall()
        cursor.execute(
            "SELECT c.relname,x.conname,x.convalidated,pg_get_constraintdef(x.oid) "
            "FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid WHERE c.relname=ANY(%s) "
            "AND c.relnamespace=current_schema()::regnamespace ORDER BY c.relname,x.conname",
            [tables],
        )
        constraints = cursor.fetchall()
        cursor.execute(
            "SELECT p.proname,pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid) "
            "FROM pg_proc p WHERE p.pronamespace=current_schema()::regnamespace AND p.prorettype='trigger'::regtype "
            "ORDER BY p.proname"
        )
        functions = cursor.fetchall()
        cursor.execute(
            "SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) "
            "FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname=ANY(%s) "
            "AND c.relnamespace=current_schema()::regnamespace AND NOT t.tgisinternal "
            "ORDER BY c.relname,t.tgname",
            [tables],
        )
        triggers = cursor.fetchall()
        cursor.execute(
            "SELECT tablename,indexname,indexdef FROM pg_indexes "
            "WHERE schemaname=current_schema() AND tablename=ANY(%s) ORDER BY tablename,indexname",
            [tables],
        )
        indexes = cursor.fetchall()
    return dict(
        columns=columns,
        constraints=constraints,
        functions=functions,
        triggers=triggers,
        indexes=indexes,
    )


def test_authority_partial_reverse_reapply_preserves_prior_guards(models, django_db_blocker):
    with django_db_blocker.unblock(), empty_database() as target:
        old = [("orgs", "0003_organisation_slug_minimum_five")]
        new = [("orgs", "0005_authority_revision_guards")]
        executor = MigrationExecutor(target)
        executor.migrate(old)
        before = authority_schema_definitions(target)
        historical = executor.loader.project_state(old).apps
        Organisation = historical.get_model("orgs", "Organisation")
        reservation_model = historical.get_model("orgs", "SlugReservation")
        with transaction.atomic(using=target.alias):
            org = Organisation.objects.using(target.alias).create(
                slug="alpha",
                realm="alpha",
                issuer="https://identity.customer.test/realms/alpha",
                name="Backfill",
            )
            reservation_model.objects.using(target.alias).create(
                organisation=org, namespace="organisation", slug="alpha", state="provisional"
            )
        MigrationExecutor(target).migrate(new)
        first = authority_schema_definitions(target)
        assert set(first["columns"]) - set(before["columns"]) == {
            ("orgs_organisation", "authority_revision", "bigint", True, None)
        }
        assert set(before["columns"]) <= set(first["columns"])
        assert first["indexes"] == before["indexes"]
        assert {row[1] for row in first["constraints"]} - {
            row[1] for row in before["constraints"]
        } == {"organisation_authority_revision_valid"}
        assert set(before["constraints"]) <= set(first["constraints"])
        assert set(before["functions"]) <= set(first["functions"])
        assert set(before["triggers"]) <= set(first["triggers"])
        assert len(first["functions"]) - len(before["functions"]) == 4
        assert len(first["triggers"]) - len(before["triggers"]) == 6
        with target.cursor() as cursor:
            cursor.execute("SELECT authority_revision FROM orgs_organisation WHERE id=%s", [org.pk])
            assert cursor.fetchone() == (1,), "existing rows were not assigned baseline one"
            cursor.execute(
                "UPDATE orgs_organisation SET authority_revision=0 WHERE id=%s", [org.pk]
            )
            cursor.execute("SELECT authority_revision FROM orgs_organisation WHERE id=%s", [org.pk])
            assert cursor.fetchone() == (2,), "live guard did not override attempted reset"
        MigrationExecutor(target).migrate(old)
        assert authority_schema_definitions(target) == before
        MigrationExecutor(target).migrate(new)
        assert authority_schema_definitions(target) == first
        with target.cursor() as cursor:
            cursor.execute(
                "UPDATE orgs_organisation SET authority_revision=0 WHERE id=%s", [org.pk]
            )
            cursor.execute("SELECT authority_revision FROM orgs_organisation WHERE id=%s", [org.pk])
            assert cursor.fetchone() == (2,), "reapplied live guard is missing"


def _check(target, name):
    with target.cursor() as cursor:
        cursor.execute(
            "SELECT pg_get_constraintdef(oid), convalidated FROM pg_constraint WHERE conname=%s",
            [name],
        )
        return cursor.fetchall()


def test_the_subject_shape_migrations_reverse_and_reapply(django_db_blocker):
    # identity 0004/0005 and engine_intents 0002/0003: forward, back to before them, forward again.
    identity_rule = ("identity", "0005_validate_subject_contract_shape")
    engine_rule = ("engine_intents", "0003_validate_known_subject")
    with django_db_blocker.unblock(), empty_database() as target:
        for _ in range(2):
            MigrationExecutor(target).migrate([identity_rule, engine_rule])
            [(definition, valid)] = _check(target, "identity_subject_valid")
            assert "x21-" in definition and "x7e" in definition and valid
            [(definition, valid)] = _check(target, "engine_known_subject_valid")
            assert "x21-" in definition and valid

            MigrationExecutor(target).migrate(
                [("identity", "0003_staff_identity"), ("engine_intents", "0001_initial")]
            )
            [(definition, valid)] = _check(target, "identity_subject_valid")
            assert "x01-" in definition and "x7f" in definition and valid
            assert _check(target, "engine_known_subject_valid") == []


def test_synthetic_prefix_migrations_reverse_and_reapply(django_db_blocker):
    old = [("orgs", "0014_validate_reserved_platform_slugs")]
    added = [("orgs", "0015_reserved_synthetic_prefix")]
    validated = [("orgs", "0016_validate_synthetic_prefix")]
    name = "organisation_slug_not_synthetic"
    with django_db_blocker.unblock(), empty_database() as target:
        for _ in range(2):
            MigrationExecutor(target).migrate(old)
            assert _check(target, name) == []
            MigrationExecutor(target).migrate(added)
            [(definition, valid)] = _check(target, name)
            assert "synth-%" in definition and not valid
            MigrationExecutor(target).migrate(validated)
            [(definition, valid)] = _check(target, name)
            assert "synth-%" in definition and valid


def _historical_held_prefix_organisation(historical, alias, name):
    organisation_model = historical.get_model("orgs", "Organisation")
    reservation_model = historical.get_model("orgs", "SlugReservation")
    with transaction.atomic(using=alias):
        with connections[alias].cursor() as cursor:
            cursor.execute("SET LOCAL lock_timeout='5s'")
            cursor.execute("SET LOCAL statement_timeout='30s'")
        org = organisation_model.objects.using(alias).create(
            slug="synth-apps-01",
            realm="synth-apps-01",
            issuer="https://namespace.test/realms/synth-apps-01",
            name=name,
        )
        reservation_model.objects.using(alias).create(
            organisation=org, namespace="organisation", slug=org.slug, state="provisional"
        )
    return org


@contextmanager
def _prefix_race_connection(target):
    # A second session on this invocation's disposable database, never a second database.
    assert target.settings_dict["NAME"].startswith("test_customer_migration_")
    alias = "prefix_race_" + uuid.uuid4().hex
    connections.databases[alias] = copy.deepcopy(target.settings_dict)
    try:
        yield connections[alias]
    finally:
        connections[alias].close()
        del connections[alias]
        del connections.databases[alias]


def test_synthetic_prefix_collision_stops_migration_without_rewriting_the_slug(django_db_blocker):
    old = [("orgs", "0014_validate_reserved_platform_slugs")]
    new = [("orgs", "0015_reserved_synthetic_prefix")]
    with django_db_blocker.unblock(), empty_database() as target:
        executor = MigrationExecutor(target)
        executor.migrate(old)
        historical = executor.loader.project_state(old).apps
        org = _historical_held_prefix_organisation(
            historical, target.alias, "Migration collision probe"
        )
        with pytest.raises(RuntimeError, match="synth-apps-01.*resolve them first"):
            MigrationExecutor(target).migrate(new)
        assert _check(target, "organisation_slug_not_synthetic") == []
        assert (
            historical.get_model("orgs", "Organisation")
            .objects.using(target.alias)
            .get(pk=org.pk)
            .slug
        ) == "synth-apps-01"


def test_validation_refuses_a_holder_created_after_the_prefix_precheck(django_db_blocker):
    old = [("orgs", "0014_validate_reserved_platform_slugs")]
    added = [("orgs", "0015_reserved_synthetic_prefix")]
    validated = [("orgs", "0016_validate_synthetic_prefix")]
    with django_db_blocker.unblock(), empty_database() as target:
        executor = MigrationExecutor(target)
        executor.migrate(old)
        historical = executor.loader.project_state(old).apps
        inserted = False
        with _prefix_race_connection(target) as racer:

            def insert_between_precheck_and_constraint(execute, statement, params, many, context):
                nonlocal inserted
                if "ADD CONSTRAINT organisation_slug_not_synthetic" in str(statement):
                    # Commit the holder and its reservation before DDL on the other session;
                    # pending deferred events on the DDL connection would prevent ALTER TABLE.
                    _historical_held_prefix_organisation(
                        historical, racer.alias, "Post-precheck collision probe"
                    )
                    inserted = True
                return execute(statement, params, many, context)

            with target.execute_wrapper(insert_between_precheck_and_constraint):
                MigrationExecutor(target).migrate(added)
        assert inserted
        with pytest.raises(IntegrityError) as refusal:
            MigrationExecutor(target).migrate(validated)
        assert refusal.value.__cause__.diag.constraint_name == "organisation_slug_not_synthetic"
        [(definition, valid)] = _check(target, "organisation_slug_not_synthetic")
        assert "synth-%" in definition and not valid
        assert (
            historical.get_model("orgs", "Organisation")
            .objects.using(target.alias)
            .get(slug="synth-apps-01")
            .name
        ) == "Post-precheck collision probe"
