"""Workspace structure schema against the real migrations on PostgreSQL 16, in the normal suite."""

from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from django.apps import apps
from django.core.management import call_command
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone

from core.db.ids import new_uuid7

pytestmark = pytest.mark.django_db(transaction=True)

TABLE_CONSTRAINTS = {
    "workspaces_workspace": {
        "workspaces_workspace_pkey": "p",
        "workspace_organisation_unique": "u",
        "workspace_organisation_fk": "f",
        "workspace_revision_valid": "c",
    },
    "workspaces_category": {
        "workspaces_category_pkey": "p",
        "category_workspace_fk": "f",
        "category_name_valid": "c",
        "category_position_valid": "c",
        "category_version_valid": "c",
        "category_position_unique": "u",
        "category_id_workspace_unique": "u",
    },
    "workspaces_channel": {
        "workspaces_channel_pkey": "p",
        "channel_workspace_fk": "f",
        "channel_category_workspace_fk": "f",
        "channel_kind_valid": "c",
        "channel_name_valid": "c",
        "channel_topic_valid": "c",
        "channel_position_valid": "c",
        "channel_version_valid": "c",
        "channel_position_unique": "u",
    },
}
BASE_TABLE_CONSTRAINTS = TABLE_CONSTRAINTS

GUARD_FUNCTIONS = {"workspace_structure_immutable", "workspace_channel_delete"}
GUARD_TRIGGERS = {
    ("workspaces_workspace", "workspace_binding_immutable"),
    ("workspaces_category", "category_binding_immutable"),
    ("workspaces_channel", "channel_binding_immutable"),
    ("workspaces_channel", "channel_delete_refused"),
}


def schema_objects():
    """Stable schema definitions, excluding OIDs, row data and sequence positions."""
    queries = {
        "relation": """
            SELECT c.relname, c.relname, c.relkind, c.relpersistence,
                   c.relrowsecurity, c.relforcerowsecurity
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v','m','S')
        """,
        "column": """
            SELECT c.relname, a.attname, format_type(a.atttypid,a.atttypmod),
                   a.attnotnull, a.attidentity, a.attgenerated,
                   pg_get_expr(d.adbin,d.adrelid), co.collname
            FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
            LEFT JOIN pg_collation co ON co.oid=a.attcollation
            WHERE n.nspname=current_schema() AND a.attnum>0 AND NOT a.attisdropped
              AND c.relkind IN ('r','p','v','m')
        """,
        "constraint": """
            SELECT c.relname, x.conname, x.contype, pg_get_constraintdef(x.oid),
                   x.condeferrable, x.condeferred, x.convalidated
            FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=current_schema()
        """,
        "index": """
            SELECT c.relname, i.relname, pg_get_indexdef(i.oid),
                   x.indisvalid, x.indisready, x.indisunique
            FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid
            JOIN pg_class i ON i.oid=x.indexrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=current_schema()
        """,
        "trigger": """
            SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid), t.tgenabled
            FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=current_schema() AND NOT t.tgisinternal
        """,
        "function": """
            SELECT p.proname, pg_get_function_identity_arguments(p.oid),
                   pg_get_functiondef(p.oid)
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname=current_schema() AND p.prokind IN ('f','p')
        """,
    }
    result = {}
    with connection.cursor() as cursor:
        for kind, query in queries.items():
            cursor.execute(query)
            for row in cursor.fetchall():
                key = (kind, row[0], row[1])
                assert key not in result
                result[key] = tuple(row[2:])
    return result


def existing_schema(objects):
    return {
        key: value
        for key, value in objects.items()
        if key[1] not in TABLE_CONSTRAINTS
        and not (key[0] == "function" and key[1] in GUARD_FUNCTIONS)
    }


@pytest.fixture
def schema():
    assert connection.vendor == "postgresql", "D05-2 requires actual PostgreSQL, not SQLite"
    assert connection.pg_version // 10000 == 16, (
        "D05-2 allocation requires exactly PostgreSQL major 16"
    )
    return SimpleNamespace(
        Workspace=apps.get_model("workspaces", "Workspace"),
        Category=apps.get_model("workspaces", "Category"),
        Channel=apps.get_model("workspaces", "Channel"),
        Organisation=apps.get_model("orgs", "Organisation"),
        SlugReservation=apps.get_model("orgs", "SlugReservation"),
    )


def workspace(schema, slug="alpha"):
    with transaction.atomic():
        organisation = schema.Organisation.objects.create(
            slug=slug,
            realm=slug,
            issuer=f"https://identity.synthetic.test/realms/{slug}",
            name="Synthetic structure authority",
            state="prospect",
        )
        schema.SlugReservation.objects.create(
            organisation=organisation,
            slug=slug,
            state="provisional",
        )
        return schema.Workspace.objects.create(organisation=organisation)


def category(schema, owner, **changes):
    values = {"workspace_id": owner.pk, "name": "General", "position": 0}
    values.update(changes)
    return schema.Category.objects.create(**values)


def channel(schema, owner, **changes):
    values = {
        "workspace_id": owner.pk,
        "category_id": None,
        "name": "Discussion",
        "topic": "",
        "kind": "text",
        "position": 0,
    }
    values.update(changes)
    return schema.Channel.objects.create(**values)


@contextmanager
def refused(sqlstate, constraint):
    with pytest.raises(IntegrityError) as error:
        with transaction.atomic():
            yield
    assert error.value.__cause__.sqlstate == sqlstate
    assert error.value.__cause__.diag.constraint_name == constraint


def test_registered_schema_matches_migrations(schema):
    call_command("makemigrations", "workspaces", check=True, dry_run=True, verbosity=0)
    with connection.cursor() as cursor:
        cursor.execute("SELECT name FROM django_migrations WHERE app='workspaces'")
        assert {row[0] for row in cursor.fetchall()} == {
            "0001_initial",
            "0002_integrity",
            "0003_policy_state",
            "0004_policy_integrity",
            "0005_template_key",
            "0006_espace_structure",
            "0007_room_state_revision",
            "0008_warmpoolallocation",
            "0009_workspace_moderation",
            "0010_moderation_scope_guards",
        }


def test_exact_integrity_inventory_has_no_implicit_duplicate_guards(schema):
    from test_workspace_parent_policy import catalog_contract, metadata_baseline_objects

    objects = metadata_baseline_objects(catalog_contract())
    for table, expected in TABLE_CONSTRAINTS.items():
        observed = {
            key[2]: value[0]
            for key, value in objects.items()
            if key[0] == "constraint" and key[1] == table
        }
        assert observed == expected
        assert {
            key[2]
            for key, value in objects.items()
            if key[0] == "index" and key[1] == table and value[3]
        } == {name for name, kind in expected.items() if kind in {"p", "u"}}
    assert {
        (key[1], key[2]) for key in objects if key[0] == "trigger" and key[1] in TABLE_CONSTRAINTS
    } == GUARD_TRIGGERS
    assert {
        (key[1], key[2])
        for key in objects
        if key[0] == "function" and key[1].startswith("workspace_")
    } == {(name, "") for name in GUARD_FUNCTIONS}
    for model, fields in (
        (schema.Workspace, ("organisation",)),
        (schema.Category, ("workspace",)),
        (schema.Channel, ("workspace", "category")),
    ):
        for name in fields:
            field = model._meta.get_field(name)
            assert not field.db_constraint and not field.unique
    for model, names in ((schema.Category, ("name",)), (schema.Channel, ("name", "topic", "kind"))):
        for name in names:
            assert model._meta.get_field(name).db_type(connection) == "text"


def test_committed_structure_survives_connection_reopen(schema):
    owner = workspace(schema)
    group = category(schema, owner)
    text = channel(schema, owner, category_id=group.pk, topic="Retained topic")
    audio = channel(schema, owner, kind="audio")
    ids = owner.pk, group.pk, text.pk, audio.pk
    for row in (owner, group, text, audio):
        assert row.pk.version == 7 and row._meta.pk.default is new_uuid7
        assert timezone.is_aware(row.created_at) and timezone.is_aware(row.updated_at)
    connection.close()
    assert schema.Workspace.objects.get(pk=ids[0]).structure_revision == 1
    assert schema.Category.objects.get(pk=ids[1]).version == 1
    assert schema.Channel.objects.get(pk=ids[2]).topic == "Retained topic"
    assert schema.Channel.objects.get(pk=ids[3]).kind == "audio"


def test_one_workspace_per_organisation(schema):
    owner = workspace(schema)
    with refused("23505", "workspace_organisation_unique"):
        schema.Workspace.objects.create(organisation_id=owner.organisation_id)


def test_category_binding_never_crosses_workspaces(schema):
    first, second = workspace(schema), workspace(schema, "bravo")
    own, foreign = category(schema, first), category(schema, second)
    with refused("23503", "channel_category_workspace_fk"):
        channel(schema, first, category_id=foreign.pk)
    item = channel(schema, first, category_id=own.pk)
    with refused("23503", "channel_category_workspace_fk"):
        schema.Channel.objects.filter(pk=item.pk).update(category_id=foreign.pk)
    item.refresh_from_db()
    assert item.category_id == own.pk


def test_category_move_and_uncategorised_are_real_persisted_structure(schema):
    owner = workspace(schema)
    first, second = category(schema, owner), category(schema, owner, position=1)
    item = channel(schema, owner, category_id=first.pk)
    schema.Channel.objects.filter(pk=item.pk).update(category_id=second.pk, version=2)
    item.refresh_from_db()
    assert item.category_id == second.pk and item.version == 2
    schema.Channel.objects.filter(pk=item.pk).update(category_id=None, version=3)
    item.refresh_from_db()
    assert item.category_id is None and item.version == 3


def test_sibling_positions_include_uncategorised_null(schema):
    owner = workspace(schema)
    first, second = category(schema, owner), category(schema, owner, position=1)
    with refused("23505", "category_position_unique"):
        category(schema, owner)
    channel(schema, owner, category_id=first.pk)
    channel(schema, owner, category_id=second.pk)
    channel(schema, owner)
    with refused("23505", "channel_position_unique"):
        channel(schema, owner)
    with refused("23505", "channel_position_unique"):
        channel(schema, owner, category_id=first.pk)


def test_scalar_constraints_refuse_raw_queryset_updates(schema):
    owner = workspace(schema)
    group = category(schema, owner)
    item = channel(schema, owner, category_id=group.pk)
    cases = [
        (owner, "structure_revision", 0, "workspace_revision_valid"),
        (group, "name", "x" * 101, "category_name_valid"),
        (group, "position", -1, "category_position_valid"),
        (group, "version", 0, "category_version_valid"),
        (item, "kind", "meeting", "channel_kind_valid"),
        (item, "name", "x" * 101, "channel_name_valid"),
        (item, "topic", "x" * 1025, "channel_topic_valid"),
        (item, "position", -1, "channel_position_valid"),
        (item, "version", 0, "channel_version_valid"),
    ]
    for row, expected in ((group, "category_name_valid"), (item, "channel_name_valid")):
        for blank in ("", " ", "   ", "\t", "\n", "\r", " \t\r\n "):
            cases.append((row, "name", blank, expected))
    for row, field, value, expected in cases:
        # Type mutation has its own immutable guard; check invalid kind on INSERT below.
        if field == "kind":
            with refused("23514", expected):
                channel(schema, owner, kind=value, position=10)
        else:
            with refused("23514", expected):
                type(row).objects.filter(pk=row.pk).update(**{field: value})
    # Length is PostgreSQL character count, not encoded bytes. Only SP/HT/LF/CR
    # count as blank for this bounded predicate; NBSP is deliberately nonblank.
    for row in (group, item):
        for valid in ("x", "é" * 100, " \tX\r\n ", "\u00a0"):
            type(row).objects.filter(pk=row.pk).update(name=valid)
            row.refresh_from_db()
            assert row.name == valid
    for valid in ("", "é" * 1024):
        schema.Channel.objects.filter(pk=item.pk).update(topic=valid)
        item.refresh_from_db()
        assert item.topic == valid


def test_resource_identity_and_channel_type_are_immutable(schema):
    first, second = workspace(schema), workspace(schema, "bravo")
    group = category(schema, first)
    item = channel(schema, first, category_id=group.pk)
    for row, changes, expected in (
        (first, {"id": new_uuid7()}, "workspace_binding_immutable"),
        (first, {"organisation_id": second.organisation_id}, "workspace_binding_immutable"),
        (group, {"id": new_uuid7()}, "category_binding_immutable"),
        (group, {"workspace_id": second.pk}, "category_binding_immutable"),
        (item, {"id": new_uuid7()}, "channel_binding_immutable"),
        (item, {"workspace_id": second.pk}, "channel_binding_immutable"),
        (item, {"kind": "audio"}, "channel_binding_immutable"),
    ):
        with refused("23514", expected):
            type(row).objects.filter(pk=row.pk).update(**changes)


def test_raw_deletion_cannot_cascade_structure_or_erase_channels(schema):
    owner = workspace(schema)
    group = category(schema, owner)
    item = channel(schema, owner, category_id=group.pk)
    with refused("23503", "channel_category_workspace_fk"):
        with connection.cursor() as cursor:
            cursor.execute("DELETE FROM workspaces_category WHERE id=%s", [group.pk])
    with refused("23514", "channel_delete_refused"):
        with connection.cursor() as cursor:
            cursor.execute("DELETE FROM workspaces_channel WHERE id=%s", [item.pk])
    schema.Channel.objects.filter(pk=item.pk).update(category_id=None)
    with connection.cursor() as cursor:
        cursor.execute("DELETE FROM workspaces_category WHERE id=%s", [group.pk])
    assert not schema.Category.objects.filter(pk=group.pk).exists()
    assert schema.Channel.objects.filter(pk=item.pk).exists()


def test_failed_batch_rolls_back_structure(schema):
    owner = workspace(schema)
    with refused("23505", "category_position_unique"):
        category(schema, owner)
        category(schema, owner)
    assert not schema.Category.objects.filter(workspace=owner).exists()


def test_missing_parents_and_nonempty_workspace_deletion_are_refused(schema):
    first, second = workspace(schema), workspace(schema, "bravo")
    with refused("23503", "workspace_organisation_fk"):
        schema.Workspace.objects.create(organisation_id=new_uuid7())
    with refused("23503", "category_workspace_fk"):
        category(schema, first, workspace_id=new_uuid7())
    with refused("23503", "channel_workspace_fk"):
        channel(schema, first, workspace_id=new_uuid7())
    with refused("23503", "channel_category_workspace_fk"):
        channel(schema, first, category_id=new_uuid7())
    category(schema, first)
    channel(schema, second)
    for owner, expected in (
        (first, "category_workspace_fk"),
        (second, "channel_workspace_fk"),
    ):
        with refused("23503", expected):
            with connection.cursor() as cursor:
                cursor.execute("DELETE FROM workspaces_workspace WHERE id=%s", [owner.pk])
    assert schema.Workspace.objects.count() == 2


def test_composite_scope_constraint_mutation_is_detected_and_rolled_back(schema):
    class RollbackSpecimenError(Exception):
        pass

    first, second = workspace(schema), workspace(schema, "bravo")
    foreign = category(schema, second)
    with pytest.raises(RollbackSpecimenError):
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(
                    "ALTER TABLE workspaces_channel DROP CONSTRAINT channel_category_workspace_fk"
                )
            wrong = channel(schema, first, category_id=foreign.pk)
            assert wrong.category.workspace_id != wrong.workspace_id
            raise RollbackSpecimenError
    with refused("23503", "channel_category_workspace_fk"):
        channel(schema, first, category_id=foreign.pk)
    assert not schema.Channel.objects.exists()


def test_new_app_migrations_reverse_on_empty_disposable_database(schema):
    from test_workspace_parent_policy import LEAF, metadata_baseline_objects

    assert not schema.Workspace.objects.exists()
    complete = schema_objects()
    before = metadata_baseline_objects(complete)
    original_existing = existing_schema(before)
    assert {("relation", name, name) for name in TABLE_CONSTRAINTS} <= before.keys()
    try:
        MigrationExecutor(connection).migrate([("workspaces", "0001_initial")])
        initial = schema_objects()
        assert existing_schema(initial) == original_existing
        assert not any(key[0] == "function" and key[1] in GUARD_FUNCTIONS for key in initial)
        assert not any(key[0] == "trigger" and key[1] in TABLE_CONSTRAINTS for key in initial)
        for table, expected in TABLE_CONSTRAINTS.items():
            observed = {
                key[2]: value[0]
                for key, value in initial.items()
                if key[0] == "constraint" and key[1] == table
            }
            assert observed == {name: kind for name, kind in expected.items() if kind != "f"}
        MigrationExecutor(connection).migrate([("workspaces", None)])
        assert schema_objects() == original_existing
    finally:
        MigrationExecutor(connection).migrate([("workspaces", LEAF)])
    assert schema_objects() == complete
    # Exercise the reapplied guard, not just its catalogue spelling.
    first, second = workspace(schema), workspace(schema, "bravo")
    foreign = category(schema, second)
    with refused("23503", "channel_category_workspace_fk"):
        channel(schema, first, category_id=foreign.pk)


def test_transactional_flush_cleans_rows_without_disabling_delete_guard(schema):
    owner = workspace(schema)
    item = channel(schema, owner)
    with refused("23514", "channel_delete_refused"):
        with connection.cursor() as cursor:
            cursor.execute("DELETE FROM workspaces_channel WHERE id=%s", [item.pk])
    before = schema_objects()
    call_command("flush", interactive=False, verbosity=0)
    assert schema_objects() == before
    for model in (
        schema.Workspace,
        schema.Category,
        schema.Channel,
        schema.Organisation,
        schema.SlugReservation,
    ):
        assert not model.objects.exists()
    fresh = channel(schema, workspace(schema))
    with refused("23514", "channel_delete_refused"):
        with connection.cursor() as cursor:
            cursor.execute("DELETE FROM workspaces_channel WHERE id=%s", [fresh.pk])
