"""Hosted real issued-token HTTP/column-role proof, never a live IAM policy."""

from contextlib import contextmanager
from uuid import uuid4

import pytest
from django.db import DatabaseError, connection, transaction
from django.test import Client


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
def consume_db(settings, request):
    from psycopg import sql

    from dev import accept_owner_claim_consume_http as c

    # Record every seed override in pytest's settings wrapper before the real operator call.
    # The disposable seed subprocess ends immediately; this shared test process must restore them.
    for name in (
        "KODERA_STAFF_ISSUER",
        "KODERA_INTAKE_ADMITTED",
        "KODERA_CONTACT_SEAL_KEY",
        "KODERA_OUTBOX_SEAL_KEY",
        "KODERA_MAIL_LINK_ORIGINS",
        "KODERA_OWNER_CLAIM_LINK",
        "KODERA_OWNER_CLAIM_LIFETIME_SECONDS",
        "KODERA_AUTH_TRUST",
    ):
        setattr(settings, name, getattr(settings, name, None))
    world = c.seed_consume_fixture(cases=(getattr(request, "param", "success"),))
    settings.ROOT_URLCONF = "config.customer_urls"
    role = "synthetic_consume_" + uuid4().hex[:12]
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_database()")
        database = cursor.fetchone()[0]
        cursor.execute(
            "SELECT privilege_type FROM pg_database d, LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database() AND a.grantee=0"
        )
        prior = {row[0] for row in cursor.fetchall()}
        c.install_consume_role(cursor, role, database, "synthetic-consume-test-only")
    try:
        with connection.cursor() as cursor:
            c.assert_consume_role_policy(cursor, role, database)
        yield c, world, role, database
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


def request(world, *, facts="credential", key="0000000000000001", payload=None):
    import json

    record = world["cases"]["success"]
    return Client().post(
        "/api/v1/owner-claims/actions/consume",
        data=json.dumps({"token": record["token"]} if payload is None else payload),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + record[facts],
        HTTP_IDEMPOTENCY_KEY=key,
    )


@pytest.mark.django_db(transaction=True)
def test_actual_scoped_role_success_and_executed_insert_shapes(consume_db):
    from apps.audit.models import AuditEvent
    from apps.orgs.models import Membership, Organisation, OwnerClaim, SlugReservation
    from core.idempotency.models import IdempotencyRecord

    c, world, role, _ = consume_db
    shapes = []
    with scoped(role), connection.execute_wrapper(c.insert_shape_capture(shapes)):
        response = request(world)
    assert response.status_code == 200
    c.assert_insert_shapes(shapes)
    record = world["cases"]["success"]
    claim = OwnerClaim.objects.get(id=record["claim_id"])
    member = Membership.objects.get(id=claim.membership_id)
    assert claim.state == "consumed" and str(claim.consumed_by_identity_id) == record["identity_id"]
    assert (
        member.role == "org_owner" and member.state == "active" and member.accepted_at is not None
    )
    assert Organisation.objects.get(id=record["organisation_id"]).state == "active"
    reservation = SlugReservation.objects.get(organisation_id=record["organisation_id"])
    assert reservation.state == "permanent" and reservation.protected_at is not None
    assert IdempotencyRecord.objects.get(path=c.PATH).body == response.content
    for action in ("owner_claim.consumed", "membership.created", "organisation.activated"):
        assert (
            AuditEvent.objects.filter(
                action=action, organisation_id=record["organisation_id"]
            ).count()
            == 1
        )
    c.public_bytes(response.content, c.secret_material(world))
    with connection.cursor() as cursor:
        cursor.execute("SELECT row_to_json(a)::text FROM audit_auditevent a")
        c.public_bytes(str(cursor.fetchall()).encode(), c.secret_material(world))


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "facts,kind",
    [("contact_credential", "owner-claim-contact-unverified"), ("mfa_credential", "mfa-required")],
)
def test_actual_scoped_denial_receipt_requires_new_key(consume_db, facts, kind):
    from core.idempotency.models import IdempotencyRecord

    c, world, role, _ = consume_db
    with scoped(role):
        refusal = request(world, facts=facts)
    assert refusal.status_code == 403 and refusal.json()["type"].endswith("/" + kind)
    original = IdempotencyRecord.objects.get(path=c.PATH)
    with scoped(role):
        replay = request(world)
        fresh = request(world, key="consume-scoped-new-key")
    assert replay.status_code == 403 and replay.content == refusal.content
    assert fresh.status_code == 200
    original.refresh_from_db()
    assert bytes(original.body) == refusal.content


@pytest.mark.django_db(transaction=True)
def test_actual_scoped_replay_withdrawal_preserves_receipt(consume_db):
    from apps.identity.models import User
    from core.idempotency.models import IdempotencyRecord

    c, world, role, _ = consume_db
    record = world["cases"]["success"]
    with scoped(role):
        original = request(world)
    assert original.status_code == 200
    receipt = IdempotencyRecord.objects.get(path=c.PATH)
    retained = (bytes(receipt.body), receipt.created_at, receipt.body_sha256)
    User.objects.filter(id=record["user_id"]).update(enabled=False)
    with scoped(role):
        disabled = request(world)
    assert disabled.status_code == 403 and "WWW-Authenticate" not in disabled
    assert disabled.json()["type"] == "https://kodera.io/problems/identity-unknown"
    receipt.refresh_from_db()
    assert (bytes(receipt.body), receipt.created_at, receipt.body_sha256) == retained
    User.objects.filter(id=record["user_id"]).update(enabled=True)
    with scoped(role):
        restored = request(world)
    assert restored.status_code == 200 and restored.content == original.content


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("privilege", ["USAGE", "SELECT", "UPDATE"])
@pytest.mark.parametrize("schema", ["public", "synthetic_consume_catalog"])
def test_actual_sequence_kind_policy_and_privilege_refusal(consume_db, privilege, schema):
    from psycopg import sql

    c, _, role, database = consume_db
    with connection.cursor() as cursor:
        if schema != "public":
            cursor.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        try:
            cursor.execute(sql.SQL("CREATE SEQUENCE {}.probe_seq").format(sql.Identifier(schema)))
            c.assert_consume_role_policy(cursor, role, database)
            cursor.execute(
                sql.SQL("GRANT {} ON SEQUENCE {}.probe_seq TO {}").format(
                    sql.SQL(privilege), sql.Identifier(schema), sql.Identifier(role)
                )
            )
            with pytest.raises(AssertionError, match="consume role policy refused"):
                c.assert_consume_role_policy(cursor, role, database)
            cursor.execute(
                sql.SQL("REVOKE {} ON SEQUENCE {}.probe_seq FROM {}").format(
                    sql.SQL(privilege), sql.Identifier(schema), sql.Identifier(role)
                )
            )
            c.assert_consume_role_policy(cursor, role, database)
        finally:
            cursor.execute(sql.SQL("DROP SEQUENCE {}.probe_seq").format(sql.Identifier(schema)))
            if schema != "public":
                cursor.execute(sql.SQL("DROP SCHEMA {}").format(sql.Identifier(schema)))


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "table,column",
    [
        ("identity_user", "deleted_at"),
        ("identity_identity", "enabled"),
        ("orgs_ownerclaim", "token_hash"),
        ("orgs_ownerbinding", "identity_id"),
        ("jobs_job", "status"),
    ],
)
def test_actual_nonadmitted_column_write_refuses(consume_db, table, column):
    from psycopg import sql

    _, _, role, _ = consume_db
    with scoped(role), pytest.raises(DatabaseError) as refused, transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                sql.SQL("UPDATE {} SET {}={} WHERE false").format(
                    sql.Identifier(table), sql.Identifier(column), sql.Identifier(column)
                )
            )
    assert refused.value.__cause__.sqlstate == "42501"


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("table", ["identity_identity", "orgs_membership", "orgs_ownerbinding"])
def test_actual_granted_lock_id_storage_refusal(consume_db, table):
    from psycopg import sql

    from apps.orgs.models import OwnerClaim

    _, world, role, _ = consume_db
    record = world["cases"]["success"]
    if table == "orgs_membership":
        with scoped(role):
            assert request(world).status_code == 200
        target = OwnerClaim.objects.get(id=record["claim_id"]).membership_id
        condition, key, constraint = "id", target, "membership_id_immutable"
    elif table == "identity_identity":
        condition, key, constraint = "id", record["identity_id"], "identity_id_immutable"
    else:
        condition, key, constraint = "identity_id", record["identity_id"], "owner_binding_immutable"
    with scoped(role), pytest.raises(DatabaseError) as refused, transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                sql.SQL("UPDATE {} SET id=%s WHERE {}=%s").format(
                    sql.Identifier(table), sql.Identifier(condition)
                ),
                [uuid4(), key],
            )
    assert refused.value.__cause__.sqlstate == "23514"
    assert refused.value.__cause__.diag.constraint_name == constraint


@pytest.mark.django_db(transaction=True)
def test_actual_enabled_privilege_is_value_unrestricted(consume_db):
    from apps.identity.models import User

    _, world, role, _ = consume_db
    target = world["cases"]["success"]["user_id"]
    with scoped(role), connection.cursor() as cursor:
        cursor.execute("UPDATE identity_user SET enabled=false WHERE id=%s", [target])
    assert User.objects.get(id=target).enabled is False
    with scoped(role), connection.cursor() as cursor:
        cursor.execute("UPDATE identity_user SET enabled=true WHERE id=%s", [target])
    assert User.objects.get(id=target).enabled is True


@pytest.mark.django_db(transaction=True)
def test_actual_column_grant_omission_rolls_back_without_widening(consume_db):
    from psycopg import sql

    from apps.orgs.models import Membership, OwnerClaim
    from core.idempotency.models import IdempotencyRecord

    c, world, role, _ = consume_db
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("REVOKE UPDATE (enabled) ON identity_user FROM {}").format(sql.Identifier(role))
        )
    with scoped(role):
        response = request(world)
    assert response.status_code == 500
    assert (
        not Membership.objects.exists()
        and not IdempotencyRecord.objects.filter(path=c.PATH).exists()
    )
    assert OwnerClaim.objects.get(id=world["cases"]["success"]["claim_id"]).state == "issued"


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "privilege,table,column",
    [
        ("SELECT", "identity_user", "purge_after"),
        ("UPDATE", "identity_user", "deleted_at"),
        ("INSERT", "audit_auditevent", "occurred_at"),
    ],
)
def test_actual_catalog_paired_column_widening_refuses(
    consume_db, monkeypatch, privilege, table, column
):
    from copy import deepcopy

    from psycopg import sql

    c, _, role, database = consume_db
    matrix = deepcopy(getattr(c, "CONSUME_" + privilege + "_COLUMNS"))
    matrix[table] += (column,)
    monkeypatch.setattr(c, "CONSUME_" + privilege + "_COLUMNS", matrix)
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("GRANT {} ({}) ON {} TO {}").format(
                sql.SQL(privilege),
                sql.Identifier(column),
                sql.Identifier(table),
                sql.Identifier(role),
            )
        )
        with pytest.raises(AssertionError, match="consume role policy refused"):
            c.assert_consume_role_policy(cursor, role, database)
        cursor.execute(
            sql.SQL("REVOKE {} ({}) ON {} FROM {}").format(
                sql.SQL(privilege),
                sql.Identifier(column),
                sql.Identifier(table),
                sql.Identifier(role),
            )
        )
        c.assert_consume_role_policy(cursor, role, database)


@pytest.mark.django_db(transaction=True)
def test_actual_delete_table_and_security_definer_widening_refuse(consume_db):
    from psycopg import sql

    c, _, role, database = consume_db
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("GRANT DELETE ON orgs_ownerclaim TO {}").format(sql.Identifier(role))
        )
        try:
            with pytest.raises(AssertionError, match="consume role policy refused"):
                c.assert_consume_role_policy(cursor, role, database)
        finally:
            cursor.execute(
                sql.SQL("REVOKE DELETE ON orgs_ownerclaim FROM {}").format(sql.Identifier(role))
            )
        cursor.execute(
            "CREATE FUNCTION synthetic_consume_definer() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN RETURN NEW; END'"
        )
        try:
            with pytest.raises(AssertionError, match="consume role policy refused"):
                c.assert_consume_role_policy(cursor, role, database)
        finally:
            cursor.execute("DROP FUNCTION synthetic_consume_definer()")
        c.assert_consume_role_policy(cursor, role, database)


@pytest.mark.django_db(transaction=True)
def test_actual_retained_organisation_fanout_and_rollback(consume_db):
    from psycopg import sql

    from apps.identity.models import Identity, User
    from apps.orgs.models import Organisation, OwnerClaim, SlugReservation

    c, world, role, _ = consume_db
    record = world["cases"]["success"]
    with transaction.atomic():
        other = Organisation.objects.create(
            slug="consume-retained",
            name="Retained synthetic association",
            realm="consume-retained",
            issuer="https://identity.synthetic.test/realms/consume-retained",
            state="prospect",
        )
        SlugReservation.objects.create(organisation=other, slug=other.slug, state="provisional")
    user = User.objects.get(id=record["user_id"])
    Identity.objects.create(
        user=user,
        organisation=other,
        issuer=other.issuer,
        realm=other.realm,
        subject="retained-consume-owner",
        email=user.email,
    )
    rows = list(
        Organisation.objects.order_by("id").values_list(
            "id", "owner_guard_revision", "authority_revision"
        )
    )
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("REVOKE INSERT ({}) ON audit_auditevent FROM {}").format(
                sql.SQL(",").join(
                    map(sql.Identifier, c.CONSUME_INSERT_COLUMNS["audit_auditevent"])
                ),
                sql.Identifier(role),
            )
        )
    with scoped(role):
        assert (
            request(
                world, payload={"token": record["token"], "display_name": "rollback-profile"}
            ).status_code
            == 500
        )
    assert (
        list(
            Organisation.objects.order_by("id").values_list(
                "id", "owner_guard_revision", "authority_revision"
            )
        )
        == rows
    )
    assert User.objects.get(id=user.id).display_name is None
    assert OwnerClaim.objects.get(id=record["claim_id"]).state == "issued"
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("GRANT INSERT ({}) ON audit_auditevent TO {}").format(
                sql.SQL(",").join(
                    map(sql.Identifier, c.CONSUME_INSERT_COLUMNS["audit_auditevent"])
                ),
                sql.Identifier(role),
            )
        )
    before = other.authority_revision
    other.refresh_from_db()
    before = other.authority_revision
    with scoped(role):
        assert (
            request(
                world, payload={"token": record["token"], "display_name": "only-own-profile"}
            ).status_code
            == 200
        )
    other.refresh_from_db()
    assert other.authority_revision > before
    assert other.state == "prospect"
    assert User.objects.get(id=user.id).display_name == "only-own-profile"


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("withdrawal", ["user", "membership", "organisation"])
def test_actual_scoped_replay_holds_through_cached_materialization(
    consume_db, monkeypatch, withdrawal
):
    import threading

    from django.utils import timezone
    from owner_claim_fixtures import (
        assert_database_wait,
        finish_db_call,
        settle_db_calls,
        start_db_call,
    )

    from apps.identity.models import User
    from apps.orgs.models import Membership, Organisation, OwnerClaim
    from core.idempotency import store
    from core.idempotency.models import IdempotencyRecord

    c, world, role, _ = consume_db
    record = world["cases"]["success"]
    with scoped(role):
        original = request(world)
    assert original.status_code == 200
    receipt = IdempotencyRecord.objects.get(path=c.PATH)
    retained = (bytes(receipt.body), receipt.created_at, receipt.body_sha256)
    membership = OwnerClaim.objects.get(id=record["claim_id"]).membership_id
    if withdrawal == "membership":
        other = User.objects.create(email="retained.owner@consume.synthetic.test")
        Membership.objects.create(
            user=other,
            organisation_id=record["organisation_id"],
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
    entered, release = threading.Event(), threading.Event()
    materialize = store._response

    def held_body(row):
        assert connection.in_atomic_block
        entered.set()
        assert release.wait(5), "bounded replay observer not released"
        return materialize(row)

    def replay():
        with scoped(role):
            return request(world)

    def withdraw():
        if withdrawal == "user":
            return User.objects.filter(id=record["user_id"]).update(enabled=False)
        if withdrawal == "membership":
            return Membership.objects.filter(id=membership).update(role="org_member")
        return Organisation.objects.filter(id=record["organisation_id"]).update(state="suspended")

    monkeypatch.setattr(store, "_response", held_body)
    reader = writer = None
    try:
        reader = start_db_call(replay)
        assert entered.wait(5), "actual scoped replay not at materialization"
        writer = start_db_call(withdraw)
        assert_database_wait(writer[2])
        release.set()
        replayed = finish_db_call(reader)
        assert replayed.status_code == 200 and replayed.content == original.content
        assert finish_db_call(writer) == 1
    finally:
        release.set()
        settle_db_calls(reader, writer)
    monkeypatch.setattr(store, "_response", materialize)
    with scoped(role):
        refused = request(world)
    assert refused.status_code == 403
    if withdrawal == "user":
        assert refused.json()["type"] == "https://kodera.io/problems/identity-unknown"
    receipt.refresh_from_db()
    assert (bytes(receipt.body), receipt.created_at, receipt.body_sha256) == retained


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("consume_db", ["past"], indirect=True)
def test_actual_scoped_database_clock_expiry_is_single_and_audited(consume_db):
    import time

    from apps.audit.models import AuditEvent
    from apps.orgs.models import OwnerClaim

    _, world, role, _ = consume_db
    record = world["cases"]["past"]
    # Actual configured one-second issuance, never an immutable-time fixture rewrite.
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT expires_at<=clock_timestamp() FROM orgs_ownerclaim WHERE id=%s",
                [record["claim_id"]],
            )
            if cursor.fetchone()[0]:
                break
        time.sleep(0.02)
    else:
        raise AssertionError("bounded issued expiry not reached")
    with scoped(role):
        import json

        from django.test import Client

        response = Client().post(
            "/api/v1/owner-claims/actions/consume",
            data=json.dumps({"token": record["token"]}),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer " + record["credential"],
            HTTP_IDEMPOTENCY_KEY="0000000000000002",
        )
    assert response.status_code == 410
    claim = OwnerClaim.objects.get(id=record["claim_id"])
    assert claim.state == "expired" and claim.revoked_at is not None
    assert (
        AuditEvent.objects.filter(
            action="owner_claim.expired",
            organisation_id=record["organisation_id"],
            actor_type="system",
            actor_id__isnull=True,
        ).count()
        == 1
    )


@pytest.mark.django_db(transaction=True)
def test_actual_scoped_staff_and_unknown_customer_have_no_consume_capability(consume_db):
    import json

    from apps.orgs.models import Membership
    from core.idempotency.models import IdempotencyRecord

    c, world, role, _ = consume_db
    record = world["cases"]["success"]
    with scoped(role):
        staff = Client().post(
            c.PATH,
            data=json.dumps({"token": record["token"]}),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer " + world["staff_token"],
            HTTP_IDEMPOTENCY_KEY="consume-no-staff-key",
        )
        unknown = request(world, facts="unknown_credential", key="!")
    assert staff.status_code == 403 and unknown.status_code == 403
    assert unknown.json()["type"] == "https://kodera.io/problems/identity-unknown"
    assert "WWW-Authenticate" not in unknown
    assert not Membership.objects.exists()
    assert not IdempotencyRecord.objects.filter(path=c.PATH).exists()


@pytest.mark.django_db(transaction=True)
def test_actual_replay_guard_omission_mutation_releases_forbidden_cached_bytes(
    consume_db, monkeypatch
):
    from django.utils import timezone

    from apps.identity.models import User
    from apps.orgs.claim_consumption import Consumption
    from apps.orgs.models import Membership, OwnerClaim
    from core.idempotency.models import IdempotencyRecord

    c, world, role, _ = consume_db
    record = world["cases"]["success"]
    with scoped(role):
        original = request(world)
    assert original.status_code == 200
    claim = OwnerClaim.objects.get(id=record["claim_id"])
    other = User.objects.create(email="second.owner@consume.synthetic.test")
    Membership.objects.create(
        user=other,
        organisation_id=record["organisation_id"],
        role="org_owner",
        state="active",
        accepted_at=timezone.now(),
    )
    Membership.objects.filter(id=claim.membership_id).update(role="org_member")
    receipt = IdempotencyRecord.objects.get(path=c.PATH)
    retained = (bytes(receipt.body), receipt.created_at, receipt.body_sha256)
    with scoped(role):
        assert request(world).status_code == 403
    monkeypatch.setattr(Consumption, "authority", lambda self, event: None)
    with scoped(role):
        forbidden = request(world)
    assert forbidden.status_code == 200 and forbidden.content == original.content
    receipt.refresh_from_db()
    assert (bytes(receipt.body), receipt.created_at, receipt.body_sha256) == retained
