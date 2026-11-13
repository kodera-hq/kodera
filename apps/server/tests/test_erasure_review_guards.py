"""Real SQL review controls: admission TEMP shadowing and OLD-scope relocation escapes."""

from contextlib import contextmanager
from datetime import UTC, datetime
from uuid import uuid4

import psycopg
import pytest
from django.db import IntegrityError, connection, transaction
from psycopg import sql
from test_account_erasure import admit, transfer
from test_core_erasure import begin, seed
from workspace_safety.test_moderation import world as make_world, world as world

from apps.billing.models import FiscalPeriod
from apps.notifications.models import Notification, PushSubscription
from core.db.ids import new_uuid7
from core.db.retention_worker_role import admission_grant_statements, grant_statements

pytestmark = pytest.mark.django_db(transaction=True)


def test_restricted_admission_temp_relations_cannot_hide_overlap_or_invent_timezone():
    name = "kodera_retention_admission_" + uuid4().hex[:12]
    password = "synthetic-" + uuid4().hex
    config = connection.settings_dict
    FiscalPeriod.objects.create(
        issuer_siren="123456789",
        starts_at=datetime(2025, 4, 1, tzinfo=UTC),
        closed_at=datetime(2026, 4, 1, tzinfo=UTC),
        timezone="UTC",
        authority_ref="FIS-700",
    )
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL(
                "CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT"
            ).format(sql.Identifier(name), sql.Literal(password))
        )
        for statement in admission_grant_statements(name):
            cursor.execute(statement)
    try:
        with psycopg.connect(
            host=config["HOST"],
            port=config["PORT"],
            dbname=config["NAME"],
            user=name,
            password=password,
            autocommit=True,
        ) as login:
            assert login.execute("SELECT current_user=session_user").fetchone()[0]
            login.execute(
                "CREATE TEMP TABLE billing_fiscalperiod (issuer_siren text,starts_at timestamptz,closed_at timestamptz)"
            )
            login.execute("CREATE TEMP TABLE pg_timezone_names (name text)")
            login.execute("INSERT INTO pg_timezone_names VALUES ('UTC'),('Synthetic/Invented')")
            login.execute("SET search_path=pg_temp,public,pg_catalog")
            insert = "INSERT INTO public.billing_fiscalperiod(id,created_at,updated_at,issuer_siren,starts_at,closed_at,timezone,authority_ref) VALUES (%s,clock_timestamp(),clock_timestamp(),'123456789',%s,%s,%s,%s)"
            with pytest.raises(psycopg.errors.CheckViolation, match="invalid or overlapping"):
                login.execute(
                    insert,
                    [
                        new_uuid7(),
                        datetime(2025, 6, 1, tzinfo=UTC),
                        datetime(2026, 6, 1, tzinfo=UTC),
                        "UTC",
                        "FIS-701",
                    ],
                )
            with pytest.raises(psycopg.errors.CheckViolation, match="invalid or overlapping"):
                login.execute(
                    insert,
                    [
                        new_uuid7(),
                        datetime(2026, 4, 1, tzinfo=UTC),
                        datetime(2027, 4, 1, tzinfo=UTC),
                        "Synthetic/Invented",
                        "FIS-702",
                    ],
                )
            login.execute(
                insert,
                [
                    new_uuid7(),
                    datetime(2026, 4, 1, tzinfo=UTC),
                    datetime(2027, 4, 1, tzinfo=UTC),
                    "UTC",
                    "FIS-703",
                ],
            )
        assert FiscalPeriod.objects.filter(authority_ref="FIS-703").exists()
    finally:
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(name)))
            cursor.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(name)))


@pytest.mark.parametrize("cutoff", ["workspace", "account"])
@pytest.mark.parametrize("resource", ["attachment", "subscription", "notification"])
def test_old_cutoff_payload_cannot_move_to_valid_live_other_scope(world, cutoff, resource):
    _, attachment, _ = seed(world)
    other, _, other_members, _ = make_world.__wrapped__()
    if cutoff == "workspace":
        begin(world[0])
    else:
        transfer(world)
        admit(world)
    rows = {
        "attachment": (
            attachment,
            {"organisation_id": other.id, "uploader_id": other_members[0].id},
        ),
        "subscription": (
            PushSubscription.objects.get(membership=world[2][0]),
            {"organisation_id": other.id, "membership_id": other_members[0].id},
        ),
        "notification": (
            Notification.objects.get(membership=world[2][0]),
            {"organisation_id": other.id, "membership_id": other_members[0].id},
        ),
    }
    row, changes = rows[resource]
    with (
        pytest.raises(IntegrityError, match="resource authority binding immutable"),
        transaction.atomic(),
    ):
        row.__class__.objects.filter(pk=row.pk).update(**changes)
    row.refresh_from_db()
    assert row.organisation_id == world[0].id
    # Mutation control proves the preexisting NEW-only guards actually allowed this escape.
    # Roll back this owner-only fixture operation; production roles cannot disable triggers.
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("ALTER TABLE {} DISABLE TRIGGER a_resource_binding").format(
                sql.Identifier(row._meta.db_table)
            )
        )
        assert row.__class__.objects.filter(pk=row.pk).update(**changes) == 1
        transaction.set_rollback(True)
    row.refresh_from_db()
    assert row.organisation_id == world[0].id


@contextmanager
def restricted_login(purpose):
    name = "kodera_retention_" + purpose + "_" + uuid4().hex[:12]
    password = "synthetic-" + uuid4().hex
    config = connection.settings_dict
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL(
                "CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT"
            ).format(sql.Identifier(name), sql.Literal(password))
        )
        for statement in (
            grant_statements(name) if purpose == "worker" else admission_grant_statements(name)
        ):
            cursor.execute(statement)

    def connect():
        return psycopg.connect(
            host=config["HOST"],
            port=config["PORT"],
            dbname=config["NAME"],
            user=name,
            password=password,
            autocommit=True,
        )

    try:
        yield name, connect
    finally:
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(name)))
            cursor.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(name)))
