"""Owner-claim schema shape first; SQL controls require actual PostgreSQL."""

import importlib
from pathlib import Path

import pytest
from django.db import IntegrityError, transaction
from owner_claim_fixtures import activate_owner_history_fixture, owner_world as owner_world
from test_operator_realm_bootstrap import http_signer as http_signer, w as w

from apps.orgs import models


def claim_models():
    binding = getattr(models, "OwnerBinding", None)
    claim = getattr(models, "OwnerClaim", None)
    assert binding is not None and claim is not None, "specified owner claim tables missing"
    return binding, claim


def test_schema_has_verifier_and_terminal_fields_without_outbox_dependency():
    binding, claim = claim_models()
    assert {field.name for field in binding._meta.fields} == {
        "id",
        "intake",
        "organisation",
        "identity",
        "issuer",
        "realm",
        "recorded_by_identity",
        "recorded_by_realm",
        "recorded_at",
    }
    assert {field.name for field in claim._meta.fields} == {
        "id",
        "organisation",
        "intended_identity",
        "token_hash",
        "expires_at",
        "state",
        "issued_at",
        "delivery_id",
        "consumed_at",
        "consumed_by_identity",
        "membership",
        "revoked_at",
        "revoked_by_identity",
        "revoked_by_realm",
    }
    assert claim._meta.get_field("token_hash").get_internal_type() == "BinaryField"
    assert not claim._meta.get_field("expires_at").has_default()
    assert claim._meta.get_field("delivery_id").get_internal_type() == "UUIDField"
    assert not claim._meta.get_field("delivery_id").is_relation
    migration = importlib.import_module("apps.orgs.migrations.0010_owner_claims")
    assert all(app != "outbox" for app, _ in migration.Migration.dependencies)
    assert "outbox_" not in migration.FORWARD.lower()
    assert "lock_timeout='5s'" in migration.TIMEOUTS
    assert "statement_timeout='30s'" in migration.TIMEOUTS
    assert "owner_claim_change" in migration.REVERSE
    assert "owner_binding_change" in migration.REVERSE


def refused_by(name, operation):
    with pytest.raises(IntegrityError) as caught, transaction.atomic():
        operation()
    assert caught.value.__cause__.diag.constraint_name == name


@pytest.mark.django_db(transaction=True)
def test_storage_has_one_issued_claim_and_retains_terminal_history(owner_world):
    from django.db import connection
    from owner_claim_fixtures import bind

    from apps.orgs.claim_readiness import expire_claims

    _, claims = claim_models()
    outcome = bind(owner_world)
    first = claims.objects.get(id=outcome.claim_id)
    refused_by(
        "owner_claim_one_issued",
        lambda: claims.objects.create(
            organisation_id=first.organisation_id,
            intended_identity_id=first.intended_identity_id,
            token_hash=bytes(first.token_hash),
            issued_at=first.issued_at,
            expires_at=first.expires_at,
            delivery_id=first.id,
        ),
    )
    refused_by(
        "owner_claim_immutable",
        lambda: claims.objects.filter(id=first.id).update(token_hash=b"altered"),
    )
    refused_by("owner_claim_immutable", lambda: claims.objects.filter(id=first.id).delete())
    # Fixture expiry is chosen at issue; immutable stored expiry is never rewritten for a test.
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT expires_at > clock_timestamp() FROM orgs_ownerclaim WHERE id=%s", [first.id]
        )
        assert cursor.fetchone()[0]
    assert expire_claims(organisation_id=first.organisation_id) == 0


def test_migration_path_is_the_allocated_next_number():
    path = Path(models.__file__).parent / "migrations/0010_owner_claims.py"
    assert path.is_file(), "specified bounded claim migration missing"


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "field",
    [
        "id",
        "intake_id",
        "organisation_id",
        "identity_id",
        "issuer",
        "realm",
        "recorded_by_identity_id",
        "recorded_by_realm",
        "recorded_at",
    ],
)
def test_binding_is_immutable_in_every_recorded_field(owner_world, field):
    from datetime import timedelta
    from uuid import uuid4

    from owner_claim_fixtures import bind

    bindings, _ = claim_models()
    binding = bindings.objects.get(id=bind(owner_world).binding_id)
    original = getattr(binding, field)
    changed = (
        original + timedelta(seconds=1)
        if field == "recorded_at"
        else original + "-changed"
        if isinstance(original, str)
        else uuid4()
    )
    refused_by(
        "owner_binding_immutable",
        lambda: bindings.objects.filter(id=binding.id).update(**{field: changed}),
    )
    refused_by("owner_binding_immutable", lambda: bindings.objects.filter(id=binding.id).delete())
    binding.refresh_from_db()
    assert getattr(binding, field) == original


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "field",
    [
        "id",
        "organisation_id",
        "intended_identity_id",
        "token_hash",
        "expires_at",
        "issued_at",
        "delivery_id",
    ],
)
def test_claim_issuance_facts_are_immutable(owner_world, field):
    from datetime import timedelta
    from uuid import uuid4

    from owner_claim_fixtures import bind

    _, claims = claim_models()
    claim = claims.objects.get(id=bind(owner_world).claim_id)
    original = getattr(claim, field)
    changed = (
        original + timedelta(seconds=1)
        if field in {"issued_at", "expires_at"}
        else b"changed"
        if field == "token_hash"
        else uuid4()
    )
    refused_by(
        "owner_claim_immutable",
        lambda: claims.objects.filter(id=claim.id).update(**{field: changed}),
    )
    claim.refresh_from_db()
    assert getattr(claim, field) == original


@pytest.mark.django_db(transaction=True)
def test_claim_verifier_profile_is_a_named_database_constraint(owner_world):
    from owner_claim_fixtures import bind

    from core.db.ids import new_uuid7

    _, claims = claim_models()
    first = claims.objects.get(id=bind(owner_world).claim_id)
    for verifier in (b"plaintext", bytes(first.token_hash).replace(b"m=65536", b"m=2147483647")):
        refused_by(
            "owner_claim_verifier_valid",
            lambda verifier=verifier: claims.objects.create(
                organisation_id=first.organisation_id,
                intended_identity_id=first.intended_identity_id,
                token_hash=verifier,
                issued_at=first.issued_at,
                expires_at=first.expires_at,
                delivery_id=new_uuid7(),
            ),
        )


@pytest.mark.django_db(transaction=True)
def test_terminal_claim_cannot_be_reopened_or_rewritten(owner_world):
    from owner_claim_fixtures import bind

    from apps.identity.command_principal import staff_principal_for_command
    from apps.orgs.owner_claims import revoke_owner_claim

    _, claims = claim_models()
    first = claims.objects.get(id=bind(owner_world).claim_id)
    revoke_owner_claim(
        principal=staff_principal_for_command(owner_world.operator.id),
        organisation_id=first.organisation_id,
        claim_id=first.id,
        request_id="req-revoke-storage",
    )
    refused_by(
        "owner_claim_transition_valid",
        lambda: claims.objects.filter(id=first.id).update(
            state="issued", revoked_at=None, revoked_by_identity_id=None
        ),
    )
    refused_by(
        "owner_claim_transition_valid",
        lambda: claims.objects.filter(id=first.id).update(
            state="expired", revoked_by_identity_id=None
        ),
    )
    first.refresh_from_db()
    assert first.state == "revoked"


@pytest.mark.django_db(transaction=True)
def test_claim_migration_reverses_and_reapplies_in_existing_test_schema(transactional_db):
    from django.db import connection
    from django.db.migrations.executor import MigrationExecutor

    executor = MigrationExecutor(connection)
    try:
        executor.migrate([("orgs", "0009_realm_readiness")])
        assert "orgs_ownerclaim" not in connection.introspection.table_names()
        executor = MigrationExecutor(connection)
        executor.migrate([("orgs", "0010_owner_claims")])
        assert "orgs_ownerclaim" in connection.introspection.table_names()
    finally:
        # The reverse also unapplies every migration that depends on orgs 0010 (other apps'
        # included); the shared test schema is put back whole for the tests that follow.
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
    executor = MigrationExecutor(connection)
    assert executor.migration_plan(executor.loader.graph.leaf_nodes()) == [], "schema left behind"


def test_generated_consumed_check_explicitly_refuses_null_identity():
    from django.db import connection
    from django.db.models.sql import Query

    _, claims = claim_models()
    condition = next(
        item.condition
        for item in claims._meta.constraints
        if item.name == "owner_claim_terminal_fields_valid"
    )
    query = Query(claims)
    sql, _ = query.build_where(condition).as_sql(
        query.get_compiler(connection=connection), connection
    )
    assert '"consumed_by_identity_id" IS NOT NULL' in sql, (
        "SQL NULL equality alone cannot refuse a NULL consumer"
    )


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("consumer_missing", [False, True])
def test_valid_consumed_control_and_null_consumer_refusal(owner_world, consumer_missing):
    from django.utils import timezone
    from owner_claim_fixtures import bind

    from apps.identity.models import Identity
    from apps.orgs.models import Membership

    _, claims = claim_models()
    first = claims.objects.get(id=bind(owner_world).claim_id)
    intended = Identity.objects.get(id=first.intended_identity_id)

    def consume():
        membership = Membership.objects.create(
            user_id=intended.user_id,
            organisation_id=first.organisation_id,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
        activate_owner_history_fixture(first.organisation_id)
        claims.objects.filter(id=first.id).update(
            state="consumed",
            consumed_at=timezone.now(),
            consumed_by_identity_id=None if consumer_missing else intended.id,
            membership_id=membership.id,
        )

    if consumer_missing:
        refused_by("owner_claim_terminal_fields_valid", consume)
        first.refresh_from_db()
        assert first.state == "issued"
        assert not Membership.objects.filter(organisation_id=first.organisation_id).exists()
    else:
        with transaction.atomic():
            consume()
        first.refresh_from_db()
        assert first.state == "consumed" and first.consumed_by_identity_id == intended.id


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "case",
    (
        "expired_missing_time",
        "expired_too_early",
        "revoked_missing_actor",
        "revoked_missing_time",
        "consumed_wrong_actor",
        "consumed_missing_time",
        "consumed_wrong_role",
    ),
)
def test_terminal_null_time_actor_and_owner_membership_guards_refuse(owner_world, case):
    from django.utils import timezone
    from owner_claim_fixtures import bind

    from apps.identity.models import Identity
    from apps.orgs.models import Membership

    _, claims = claim_models()
    first = claims.objects.get(id=bind(owner_world).claim_id)
    expected = "owner_claim_terminal_fields_valid"
    if case == "consumed_wrong_role":
        expected = "owner_claim_consumed_membership_valid"

    def attempt():
        values = {}
        if case.startswith("consumed"):
            intended = Identity.objects.get(id=first.intended_identity_id)
            member = Membership.objects.create(
                user_id=intended.user_id,
                organisation_id=first.organisation_id,
                role="org_admin" if case == "consumed_wrong_role" else "org_owner",
                state="active",
                accepted_at=timezone.now(),
            )
            activate_owner_history_fixture(first.organisation_id)
            values = dict(
                state="consumed",
                consumed_at=None if case == "consumed_missing_time" else timezone.now(),
                consumed_by_identity_id=owner_world.operator.id
                if case == "consumed_wrong_actor"
                else intended.id,
                membership_id=member.id,
            )
        elif case.startswith("expired"):
            values = dict(
                state="expired",
                revoked_at=None if case == "expired_missing_time" else first.issued_at,
            )
        else:
            values = dict(
                state="revoked",
                revoked_at=None if case == "revoked_missing_time" else timezone.now(),
                revoked_by_identity_id=None
                if case == "revoked_missing_actor"
                else owner_world.operator.id,
            )
        claims.objects.filter(id=first.id).update(**values)

    refused_by(expected, attempt)
    first.refresh_from_db()
    assert first.state == "issued"
