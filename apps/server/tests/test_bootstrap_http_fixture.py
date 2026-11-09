"""Real PostgreSQL proof uses the actual operator seed and scoped runtime factory."""

from contextlib import contextmanager
from uuid import uuid4

import pytest
from django.db import DatabaseError, connection


@contextmanager
def scoped(role):
    from psycopg import sql

    with connection.cursor() as cursor:
        cursor.execute(sql.SQL("SET ROLE {}").format(sql.Identifier(role)))
    try:
        yield
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")


@pytest.fixture
def bootstrap_db(settings):
    from psycopg import sql

    from dev import accept_bootstrap_http as c
    from services.identity.trusted_issuers import load_trust

    world = c.seed_bootstrap_fixture()
    trust, tokens = c.signatures()
    settings.KODERA_AUTH_TRUST = load_trust(trust)
    settings.KODERA_STAFF_ISSUER = c.STAFF_ISSUER
    settings.ROOT_URLCONF = "config.customer_urls"
    role = "synthetic_bootstrap_" + uuid4().hex[:12]
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_database()")
        database = cursor.fetchone()[0]
        cursor.execute(
            "SELECT privilege_type FROM pg_database d, LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database() AND a.grantee=0"
        )
        prior = {r[0] for r in cursor.fetchall()}
        c.install_bootstrap_role(cursor, role, database, "synthetic-bootstrap-test-only")
        c.assert_bootstrap_role_policy(cursor, role, database)
    try:
        yield c, world, role, tokens
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")
            cursor.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(role)))
            cursor.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(role)))
            for privilege in ("CREATE", "TEMPORARY"):
                if privilege in prior:
                    cursor.execute(
                        sql.SQL("GRANT {} ON DATABASE {} TO PUBLIC").format(
                            sql.SQL(privilege), sql.Identifier(database)
                        )
                    )


def get(world, token, state="past"):
    from django.test import Client

    return Client().get(
        f"/api/v1/organisations/{world[state]['organisation_id']}/bootstrap",
        HTTP_AUTHORIZATION="Bearer " + token,
    )


@pytest.mark.django_db(transaction=True)
def test_actual_scoped_role_expiry_trigger_permission_experiment(bootstrap_db, settings):
    from apps.audit.models import AuditEvent
    from apps.orgs.models import OwnerClaim

    c, world, role, tokens = bootstrap_db
    with scoped(role):
        with connection.cursor() as cursor:
            cursor.execute("SELECT has_table_privilege(current_user,'orgs_membership','SELECT')")
            assert cursor.fetchone() == (False,)
        from uuid import UUID

        from apps.orgs.bootstrap_services import read_bootstrap
        from services.identity.trusted_issuers import verify_configured_token

        verified, lane = verify_configured_token(tokens["past"], trusted=settings.KODERA_AUTH_TRUST)
        # Invoke the real service as well as GET: driver permission evidence remains captured.
        raw = read_bootstrap(
            verified=verified,
            lane=lane,
            target_id=UUID(world["past"]["organisation_id"]),
            request_id="synthetic-scoped-expiry",
        )
        c.public_bytes(raw, c.PRIVATE)
        response = get(world, tokens["past"])
    assert response.status_code == 200, "actual scoped expiry must pass without Membership SELECT"
    assert response.json()["claim"]["state"] == "expired"
    assert OwnerClaim.objects.get(id=world["past"]["claim_id"]).state == "expired"
    assert (
        AuditEvent.objects.filter(
            action="owner_claim.expired",
            organisation_id=world["past"]["organisation_id"],
            actor_type="system",
            actor_id__isnull=True,
        ).count()
        == 1
    )
    with scoped(role):
        assert get(world, tokens["past"]).status_code == 200
    assert (
        AuditEvent.objects.filter(
            action="owner_claim.expired", organisation_id=world["past"]["organisation_id"]
        ).count()
        == 1
    )


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "table,key,constraint",
    [
        ("identity_user", "customer_user_id", "user_id_immutable"),
        ("identity_identity", "customer_identity_id", "identity_id_immutable"),
        ("identity_staffrole", "operator_grant_id", "staffrole_immutable_grant"),
    ],
)
def test_actual_granted_lock_id_changes_refuse(bootstrap_db, table, key, constraint):
    from django.db import transaction
    from psycopg import sql

    _, world, role, _ = bootstrap_db
    target = world["past"][key] if key.startswith("customer") else world[key]
    with scoped(role), pytest.raises(DatabaseError) as refused, transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                sql.SQL("UPDATE {} SET id=%s WHERE id=%s").format(sql.Identifier(table)),
                [uuid4(), target],
            )
    assert refused.value.__cause__.sqlstate == "23514"
    assert refused.value.__cause__.diag.constraint_name == constraint


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "table,column",
    [
        ("identity_user", "enabled"),
        ("identity_identity", "subject"),
        ("identity_staffrole", "revoked_at"),
        ("orgs_ownerclaim", "token_hash"),
        ("orgs_ownerbinding", "identity_id"),
        ("orgs_organisation", "state"),
        ("jobs_job", "status"),
    ],
)
def test_actual_semantic_authority_columns_deny(bootstrap_db, table, column):
    from django.db import transaction
    from psycopg import sql

    _, _, role, _ = bootstrap_db
    with scoped(role), pytest.raises(DatabaseError) as refused, transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                sql.SQL("UPDATE {} SET {}={} WHERE false").format(
                    sql.Identifier(table), sql.Identifier(column), sql.Identifier(column)
                )
            )
    assert refused.value.__cause__.sqlstate == "42501"


@pytest.mark.django_db(transaction=True)
def test_actual_broad_grant_mutation_refuses(bootstrap_db):
    from psycopg import sql

    c, _, role, _ = bootstrap_db
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("GRANT SELECT ON orgs_membership TO {}").format(sql.Identifier(role))
        )
        cursor.execute("SELECT current_database()")
        database = cursor.fetchone()[0]
        with pytest.raises(AssertionError, match="bootstrap role policy refused"):
            c.assert_bootstrap_role_policy(cursor, role, database)


@pytest.mark.django_db(transaction=True)
def test_actual_audit_insert_denial_rolls_back_expiry(bootstrap_db):
    from psycopg import sql

    from apps.audit.models import AuditEvent
    from apps.orgs.models import OwnerClaim

    _, world, role, tokens = bootstrap_db
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("REVOKE INSERT ON audit_auditevent FROM {}").format(sql.Identifier(role))
        )
        cursor.execute(
            sql.SQL("REVOKE INSERT ({}) ON audit_auditevent FROM {}").format(
                sql.SQL(",").join(
                    map(
                        sql.Identifier, bootstrap_db[0].BOOTSTRAP_INSERT_COLUMNS["audit_auditevent"]
                    )
                ),
                sql.Identifier(role),
            )
        )
    with scoped(role):
        response = get(world, tokens["past"])
    assert response.status_code == 500
    assert OwnerClaim.objects.get(id=world["past"]["claim_id"]).state == "issued"
    assert not AuditEvent.objects.filter(
        action="owner_claim.expired", organisation_id=world["past"]["organisation_id"]
    ).exists()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("state", ["future", "expired", "revoked", "consumed"])
def test_actual_scoped_terminal_and_future_history_preserved(bootstrap_db, state):
    from apps.audit.models import AuditEvent
    from apps.orgs.models import OwnerClaim

    _, world, role, tokens = bootstrap_db
    claim = OwnerClaim.objects.get(id=world[state]["claim_id"])
    before = tuple(
        AuditEvent.objects.filter(organisation_id=claim.organisation_id).values_list(
            "id", flat=True
        )
    )
    with scoped(role):
        response = get(world, tokens[state], state)
    assert response.status_code == 200
    assert response.json()["claim"]["state"] == claim.state
    claim.refresh_from_db()
    assert claim.state == ("issued" if state == "future" else state)
    assert (
        tuple(
            AuditEvent.objects.filter(organisation_id=claim.organisation_id).values_list(
                "id", flat=True
            )
        )
        == before
    )


@pytest.mark.django_db(transaction=True)
def test_actual_executable_security_definer_mutation_refuses(bootstrap_db):
    c, _, role, _ = bootstrap_db
    with connection.cursor() as cursor:
        cursor.execute(
            "CREATE FUNCTION public.synthetic_bootstrap_definer() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NEW; END $$"
        )
        try:
            cursor.execute("SELECT current_database()")
            database = cursor.fetchone()[0]
            with pytest.raises(AssertionError, match="bootstrap role policy refused"):
                c.assert_bootstrap_role_policy(cursor, role, database)
        finally:
            cursor.execute("DROP FUNCTION public.synthetic_bootstrap_definer()")


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "name,status",
    [
        ("operator", 200),
        ("support", 200),
        ("security", 403),
        ("no_mfa", 403),
        ("disabled", 403),
        ("revoked_staff", 403),
        ("unknown_customer", 403),
    ],
)
def test_actual_scoped_staff_customer_authority(bootstrap_db, name, status):
    _, world, role, tokens = bootstrap_db
    with scoped(role):
        assert get(world, tokens[name], "future").status_code == status


@pytest.mark.django_db(transaction=True)
def test_actual_column_lock_permission_omission_refuses(bootstrap_db):
    from psycopg import sql

    c, world, role, tokens = bootstrap_db
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("REVOKE UPDATE (id) ON identity_user FROM {}").format(sql.Identifier(role))
        )
        cursor.execute("SELECT current_database()")
        with pytest.raises(AssertionError, match="bootstrap role policy refused"):
            c.assert_bootstrap_role_policy(cursor, role, cursor.fetchone()[0])
    with scoped(role):
        assert get(world, tokens["future"], "future").status_code == 500


@pytest.mark.django_db(transaction=True)
def test_actual_private_select_mutation_refuses(bootstrap_db):
    from psycopg import sql

    c, _, role, _ = bootstrap_db
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("GRANT SELECT (token_hash) ON orgs_ownerclaim TO {}").format(
                sql.Identifier(role)
            )
        )
        cursor.execute("SELECT current_database()")
        with pytest.raises(AssertionError, match="bootstrap role policy refused"):
            c.assert_bootstrap_role_policy(cursor, role, cursor.fetchone()[0])


@pytest.mark.django_db(transaction=True)
def test_actual_seed_consumed_confirmation_names_staff_recorder(bootstrap_db):
    from apps.audit.models import AuditEvent
    from apps.identity.models import Identity

    _, world, _, _ = bootstrap_db
    event = AuditEvent.objects.get(
        organisation_id=world["consumed"]["organisation_id"], action="owner_claim.confirmed"
    )
    assert event.actor_type == "staff"
    assert str(event.actor_id) == world["recorder_identity_id"]
    identity = Identity.objects.get(id=event.actor_id)
    assert identity.organisation_id is None and identity.realm == "kodera-staff"


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "privilege,table,column",
    [
        ("SELECT", "identity_identity", "email"),
        ("UPDATE", "identity_user", "enabled"),
        ("INSERT", "orgs_ownerclaim", "id"),
    ],
)
def test_actual_paired_manifest_and_catalog_grant_widening_refuses(
    bootstrap_db, monkeypatch, privilege, table, column
):
    from copy import deepcopy

    from psycopg import sql

    c, _, role, _ = bootstrap_db
    name = "BOOTSTRAP_" + privilege + "_COLUMNS"
    changed = deepcopy(getattr(c, name))
    changed[table] = (*changed.get(table, ()), column)
    monkeypatch.setattr(c, name, changed)
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("GRANT {} ({}) ON {} TO {}").format(
                sql.SQL(privilege),
                sql.Identifier(column),
                sql.Identifier(table),
                sql.Identifier(role),
            )
        )
        cursor.execute("SELECT current_database()")
        with pytest.raises(AssertionError, match="bootstrap role policy refused"):
            c.assert_bootstrap_role_policy(cursor, role, cursor.fetchone()[0])


@pytest.mark.django_db(transaction=True)
def test_actual_seed_required_job_fields(bootstrap_db):
    from apps.jobs.models import Job

    _, world, _, _ = bootstrap_db
    organisation_ids = [
        world[state]["organisation_id"]
        for state in ("future", "past", "expired", "revoked", "consumed")
    ]
    jobs = list(
        Job.objects.filter(organisation_id__in=organisation_ids).values_list(
            "kind", "status", "max_attempts"
        )
    )
    assert len(jobs) == 5
    assert jobs == [("realm_create", "succeeded", 1)] * 5


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("namespace", ["public", "synthetic"])
@pytest.mark.parametrize("privilege", ["USAGE", "SELECT", "UPDATE"])
def test_actual_sequence_catalog_grant_refusal_and_recovery(bootstrap_db, namespace, privilege):
    from psycopg import sql

    c, _, role, _ = bootstrap_db
    name = "synthetic_bootstrap_sequence_" + uuid4().hex[:12]
    schema = "public" if namespace == "public" else "synthetic_bootstrap_schema_" + uuid4().hex[:12]
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_database()")
        database = cursor.fetchone()[0]
        if namespace == "synthetic":
            cursor.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        created = False
        try:
            cursor.execute(
                sql.SQL("CREATE SEQUENCE {}.{}").format(
                    sql.Identifier(schema), sql.Identifier(name)
                )
            )
            created = True
            # The actual catalog includes ordinary tables, internal relations and this sequence.
            assert c.assert_bootstrap_role_policy(cursor, role, database)["sequences_safe"] is True
            cursor.execute(
                sql.SQL("GRANT {} ON SEQUENCE {}.{} TO {}").format(
                    sql.SQL(privilege),
                    sql.Identifier(schema),
                    sql.Identifier(name),
                    sql.Identifier(role),
                )
            )
            with pytest.raises(AssertionError, match="bootstrap role policy refused"):
                c.assert_bootstrap_role_policy(cursor, role, database)
            cursor.execute(
                sql.SQL("REVOKE {} ON SEQUENCE {}.{} FROM {}").format(
                    sql.SQL(privilege),
                    sql.Identifier(schema),
                    sql.Identifier(name),
                    sql.Identifier(role),
                )
            )
            assert c.assert_bootstrap_role_policy(cursor, role, database)["sequences_safe"] is True
        finally:
            if created:
                cursor.execute(
                    sql.SQL("DROP SEQUENCE {}.{}").format(
                        sql.Identifier(schema), sql.Identifier(name)
                    )
                )
            if namespace == "synthetic":
                cursor.execute(sql.SQL("DROP SCHEMA {}").format(sql.Identifier(schema)))
