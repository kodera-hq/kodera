"""Synthetic realms stay outside Core's ordinary organisation namespace (contract 0.29.0)."""

import copy
import importlib
from pathlib import Path
from types import SimpleNamespace

import jsonschema_rs
import pytest
import yaml
from django.db import IntegrityError, connection, transaction

from apps.orgs import intake_services
from apps.orgs.api import intake_serializers
from apps.orgs.models import Organisation, SlugReservation

ROOT = Path(__file__).resolve().parents[1]
SYNTHETIC = ("synth-apps-01", "synth-" + "a" * 14)
ORDINARY = ("synth", "synth0-a", "synthesis", "acme-pilot")
CONSTRAINT = "organisation_slug_not_synthetic"


def request(slug):
    return {
        "slug": slug,
        "name": "Namespace probe",
        "instruction_ref": "SUP-0418",
        "intended_owner": {"email": "owner@namespace.test"},
    }


def assert_reserved(slug):
    errors = intake_serializers.validate(request(slug))
    assert errors == [intake_serializers.FieldError("/slug", "reserved")], "reserved-prefix"


@pytest.mark.parametrize("slug", SYNTHETIC)
def test_synthetic_prefix_is_reserved_at_intake(slug):
    assert_reserved(slug)


@pytest.mark.parametrize("slug", ORDINARY)
def test_neighbouring_names_stay_ordinary(slug):
    assert isinstance(intake_serializers.validate(request(slug)), intake_services.IntakeRequest)


@pytest.mark.parametrize(
    ("slug", "code"),
    [
        ("synth-", "pattern"),
        ("SYNTH-apps-01", "pattern"),
        ("synth-apps-01\n", "pattern"),
        ("synth-" + "a" * 15, "max_length"),
    ],
)
def test_format_refusal_precedes_prefix_reservation(slug, code):
    assert intake_serializers.validate(request(slug)) == [
        intake_serializers.FieldError("/slug", code)
    ]


def test_intake_prefix_predicate_mutation_is_detected(monkeypatch):
    monkeypatch.setattr(
        intake_serializers,
        "is_reserved_slug",
        lambda slug: slug in intake_services.RESERVED_SLUGS,
        raising=False,
    )
    with pytest.raises(AssertionError, match="reserved-prefix"):
        assert_reserved(SYNTHETIC[0])


def input_slug_schema():
    document = yaml.safe_load((ROOT / "contracts/core-api.openapi.yaml").read_text())
    return document["components"]["schemas"]["OrganisationCreateRequest"]["properties"]["slug"]


def assert_contract_prefix(schema):
    for slug in SYNTHETIC:
        assert not jsonschema_rs.is_valid(schema, slug), "contract-prefix"
    for slug in ORDINARY:
        assert jsonschema_rs.is_valid(schema, slug), "contract-neighbour"


def test_contract_validates_the_prefix_exclusion_without_changing_neighbours():
    assert_contract_prefix(input_slug_schema())


def test_removing_the_contract_exclusion_is_detected():
    schema = copy.deepcopy(input_slug_schema())
    schema.pop("allOf", None)
    with pytest.raises(AssertionError, match="contract-prefix"):
        assert_contract_prefix(schema)


def migration(name):
    return importlib.import_module(f"apps.orgs.migrations.{name}")


def test_migration_precheck_is_bounded_alias_aware_and_refuses_collisions_without_writes():
    module = migration("0015_reserved_synthetic_prefix")
    statements = []

    cursor_aliases = []

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def execute(self, statement, parameters):
            assert statements and "statement_timeout" in statements[0]
            assert statement == (
                "SELECT slug FROM orgs_organisation WHERE slug LIKE %s ORDER BY slug"
            )
            assert parameters == ["synth-%"]
            statements.append(statement)

        def fetchall(self):
            return [("synth-apps-01",)]

    class Connection:
        alias = "acceptance"

        def cursor(self):
            cursor_aliases.append(self.alias)
            return Cursor()

    apps = None
    editor = SimpleNamespace(connection=Connection(), execute=statements.append)
    with pytest.raises(RuntimeError, match="synth-apps-01.*resolve them first"):
        module.refuse_held_prefix(apps, editor)
    assert cursor_aliases == ["acceptance"]
    assert all("UPDATE" not in statement.upper() for statement in statements)


def test_migration_adds_not_valid_then_validates_separately_with_finite_timeouts():
    add = migration("0015_reserved_synthetic_prefix")
    validate = migration("0016_validate_synthetic_prefix")
    assert "NOT VALID" in add.FORWARD
    assert "slug NOT LIKE 'synth-%'" in add.FORWARD
    assert "VALIDATE CONSTRAINT" not in add.FORWARD
    assert f"VALIDATE CONSTRAINT {CONSTRAINT}" in validate.FORWARD
    for statement in (add.FORWARD, add.REVERSE, validate.FORWARD):
        assert "lock_timeout='5s'" in statement and "statement_timeout='30s'" in statement
    assert validate.Migration.dependencies == [("orgs", "0015_reserved_synthetic_prefix")]
    state_constraint = add.Migration.operations[1].state_operations[0].constraint
    model_constraint = next(c for c in Organisation._meta.constraints if c.name == CONSTRAINT)
    assert state_constraint == model_constraint


def assert_database_refuses(slug, *, bulk=False):
    org = Organisation(
        slug=slug, realm=slug, issuer=f"https://namespace.test/realms/{slug}", name="Probe"
    )
    try:
        with transaction.atomic():
            if bulk:
                Organisation.objects.bulk_create([org])
            else:
                org.save(force_insert=True)
    except IntegrityError as error:
        assert error.__cause__.diag.constraint_name == CONSTRAINT
        return
    raise AssertionError("database accepted synthetic organisation")


@pytest.mark.django_db
@pytest.mark.parametrize("bulk", [False, True])
@pytest.mark.parametrize("slug", SYNTHETIC)
def test_direct_persistence_refuses_the_synthetic_prefix(slug, bulk):
    assert_database_refuses(slug, bulk=bulk)


@pytest.mark.django_db
def test_dropped_database_constraint_mutation_is_detected_and_rolled_back():
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL lock_timeout='5s'")
            cursor.execute(f"ALTER TABLE orgs_organisation DROP CONSTRAINT {CONSTRAINT}")
        with pytest.raises(AssertionError, match="database accepted synthetic organisation"):
            assert_database_refuses(SYNTHETIC[0])
        transaction.set_rollback(True)
    assert_database_refuses(SYNTHETIC[0])


@pytest.mark.django_db
@pytest.mark.parametrize("slug", ORDINARY)
def test_direct_persistence_keeps_neighbouring_names(slug):
    with transaction.atomic():
        org = Organisation.objects.create(
            slug=slug, realm=slug, issuer=f"https://namespace.test/realms/{slug}", name="Probe"
        )
        SlugReservation.objects.create(
            organisation=org, namespace="organisation", slug=slug, state="provisional"
        )


def test_model_and_migration_state_match_without_database_access():
    from django.apps import apps
    from django.db.migrations.autodetector import MigrationAutodetector
    from django.db.migrations.loader import MigrationLoader
    from django.db.migrations.state import ProjectState

    loader = MigrationLoader(None)
    changes = MigrationAutodetector(loader.project_state(), ProjectState.from_apps(apps)).changes(
        graph=loader.graph
    )
    assert "orgs" not in changes, "organisation migration state drift"
