"""Proximity downgrade refusal, isolated from the later confidential erasure protocol."""

from __future__ import annotations

from dataclasses import replace

import pytest
from django.db import IntegrityError, connection
from django.db.migrations.executor import MigrationExecutor
from test_account_erasure import admit as admit_account
from test_core_erasure import operator
from test_proximity_erasure import presence, private_broker
from workspace_safety.test_moderation import world as world

from apps.identity.models import Identity
from apps.orgs.account_erasure_services import (
    AccountErasureScope,
    advance_account_erasure,
    persist_account_absence,
)
from apps.orgs.erasure_services import (
    ErasureScope,
    advance_erasure,
    begin_erasure,
    database_now,
    persist_absence,
)
from apps.orgs.privacy_models import (
    AccountErasure,
    AccountErasureReceipt,
    ErasureReceipt,
    PrivacyErasure,
)
from apps.proximity.erasure import ProximityAccountErasureAdapter, ProximityWorkspaceErasureAdapter
from core.db.ids import new_uuid7

pytestmark = pytest.mark.django_db(transaction=True)

ORGS_0032 = ("orgs", "0032_ee_enterprise_store")
ORGS_0033 = ("orgs", "0033_proximity_erasure_inventory")
EXTENSIONS_0011 = ("extensions", "0011_native_document_release_fact")
EXTENSIONS_0012 = ("extensions", "0012_proximity_erasure_domains")
E2EE_0001 = ("e2ee", "0001_initial")
E2EE_0002 = ("e2ee", "0002_scope_and_privacy")
REFUSAL_MESSAGE = (
    "cannot downgrade proximity erasure migration with admitted proximity obligations or receipts"
)


def restore_leaf_migrations() -> None:
    executor = MigrationExecutor(connection)
    executor.migrate(executor.loader.graph.leaf_nodes())
    after = MigrationExecutor(connection)
    assert after.migration_plan(after.loader.graph.leaf_nodes()) == []


def restore_proximity_test_migrations() -> None:
    # These tests target the proximity guards themselves. The newer confidential
    # guard is tested separately, and otherwise refuses the downgrade before them.
    executor = MigrationExecutor(connection)
    targets = [
        node
        for node in executor.loader.graph.leaf_nodes()
        if node[0] not in {"e2ee", "confidential"}
    ]
    targets.extend([E2EE_0001, ("confidential", None)])
    executor.migrate(targets)
    after = MigrationExecutor(connection)
    assert after.migration_plan(targets) == []
    assert E2EE_0001 in after.loader.applied_migrations
    assert E2EE_0002 not in after.loader.applied_migrations


@pytest.fixture(autouse=True)
def proximity_migration_profile():
    restore_proximity_test_migrations()
    try:
        yield
    finally:
        # Never leave the shared test database at this deliberately older profile.
        restore_leaf_migrations()


def assert_downgrade_refused(target: tuple[str, str]) -> None:
    with pytest.raises(IntegrityError, match=REFUSAL_MESSAGE) as caught:
        MigrationExecutor(connection).migrate([target])
    cause = caught.value.__cause__
    assert cause is not None
    assert getattr(cause, "sqlstate", None) == "23514"


def assert_proximity_erasure_schema_state(*, expect_extensions_0012: bool) -> None:
    applied = set(MigrationExecutor(connection).loader.applied_migrations)
    assert E2EE_0001 in applied and E2EE_0002 not in applied
    assert ORGS_0033 in applied
    if expect_extensions_0012:
        assert EXTENSIONS_0012 in applied
    else:
        assert EXTENSIONS_0012 not in applied

    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT c.relname, t.tgenabled
            FROM pg_trigger t
            JOIN pg_class c ON c.oid = t.tgrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND t.tgname = 'aa_proximity_inventory'
              AND NOT t.tgisinternal
            ORDER BY c.relname
            """
        )
        assert cursor.fetchall() == [
            ("orgs_accounterasure", "O"),
            ("orgs_privacyerasure", "O"),
        ]
        cursor.execute("SELECT to_regprocedure('public.proximity_erasure_inventory()') IS NOT NULL")
        assert cursor.fetchone()[0] is True
        cursor.execute(
            "SELECT pg_get_functiondef('public.privacy_complete_erasure(uuid)'::regprocedure)"
        )
        assert "proximity_ephemeral" in cursor.fetchone()[0]
        cursor.execute(
            "SELECT pg_get_functiondef('public.privacy_complete_account_erasure(uuid)'::regprocedure)"
        )
        assert "proximity_ephemeral" in cursor.fetchone()[0]
        cursor.execute(
            """
            SELECT conname, pg_get_constraintdef(oid)
            FROM pg_constraint
            WHERE conname IN ('erasure_domain', 'account_erasure_receipt_domain')
            ORDER BY conname
            """
        )
        constraints = dict(cursor.fetchall())
        assert "proximity_ephemeral" in constraints["erasure_domain"]
        assert "proximity_ephemeral" in constraints["account_erasure_receipt_domain"]
        cursor.execute(
            "SELECT pg_get_functiondef('public.extension_erasure_step(uuid,uuid,timestamptz,text,integer)'::regprocedure)"
        )
        extension_def = cursor.fetchone()[0]
        assert ("proximity_ephemeral" in extension_def) is expect_extensions_0012


def admit_core_workspace_erasure(org_id) -> PrivacyErasure:
    request_id = new_uuid7()
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT privacy_begin_erasure(%s,%s,%s,%s,%s,%s)",
            [
                request_id,
                org_id,
                "DEL-401",
                "a" * 64,
                database_now(),
                operator().id,
            ],
        )
    return PrivacyErasure.objects.get(pk=request_id)


def test_empty_and_historical_pre_proximity_journals_roundtrip_cleanly(world) -> None:
    org, _, _, _ = world
    try:
        MigrationExecutor(connection).migrate([ORGS_0032])
        applied = set(MigrationExecutor(connection).loader.applied_migrations)
        assert EXTENSIONS_0012 not in applied
        assert ORGS_0033 not in applied
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT count(*) FROM pg_trigger WHERE tgname = 'aa_proximity_inventory' AND NOT tgisinternal"
            )
            assert cursor.fetchone()[0] == 0
            cursor.execute("SELECT to_regprocedure('public.proximity_erasure_inventory()') IS NULL")
            assert cursor.fetchone()[0] is True

        # A pre-proximity 5-domain journal admitted at 0032+0011 has no proximity obligation
        # and must neither break forward upgrade nor falsely block rollback before proximity admission.
        historical = begin_erasure(
            organisation_id=org.id,
            instruction_ref="DEL-400",
            instruction_sha256="9" * 64,
            purge_not_before=database_now(),
            actor_identity_id=operator().id,
        )
        assert "proximity_ephemeral" not in historical.inventory["required_domains"]
        assert "proximity_inventory_version" not in historical.inventory

        restore_proximity_test_migrations()
        assert_proximity_erasure_schema_state(expect_extensions_0012=True)

        MigrationExecutor(connection).migrate([ORGS_0032])
        applied_after_second_rollback = set(MigrationExecutor(connection).loader.applied_migrations)
        assert EXTENSIONS_0012 not in applied_after_second_rollback
        assert ORGS_0033 not in applied_after_second_rollback
        historical.refresh_from_db()
        assert "proximity_ephemeral" not in historical.inventory["required_domains"]
    finally:
        restore_proximity_test_migrations()
    assert_proximity_erasure_schema_state(expect_extensions_0012=True)


def test_admitted_and_in_flight_workspace_journal_refuses_extensions_and_orgs_downgrade(
    world,
) -> None:
    org, _, _, _ = world
    try:
        row = begin_erasure(
            organisation_id=org.id,
            instruction_ref="DEL-402",
            instruction_sha256="b" * 64,
            purge_not_before=database_now(),
            actor_identity_id=operator().id,
        )
        assert "proximity_ephemeral" in row.inventory["required_domains"]
        progress = advance_erasure(row.id, {})
        assert progress["core_purged"] is True and progress["complete"] is False
        assert "proximity_ephemeral" in progress["held_domains"]

        assert_downgrade_refused(EXTENSIONS_0011)
        assert_downgrade_refused(ORGS_0032)

        assert_proximity_erasure_schema_state(expect_extensions_0012=True)
        preserved = PrivacyErasure.objects.get(pk=row.id)
        assert preserved.status == "core_purged"
        assert preserved.inventory_sha256 == row.inventory_sha256
        assert "proximity_ephemeral" in preserved.inventory["required_domains"]
    finally:
        restore_proximity_test_migrations()


def test_direct_orgs_0032_downgrade_refuses_workspace_journal_when_extensions_at_0011(
    world,
) -> None:
    org, _, _, _ = world
    try:
        MigrationExecutor(connection).migrate([EXTENSIONS_0011])
        assert_proximity_erasure_schema_state(expect_extensions_0012=False)

        row = admit_core_workspace_erasure(org.id)
        assert "proximity_ephemeral" in row.inventory["required_domains"]
        assert row.inventory["proximity_inventory_version"] == 1

        assert_downgrade_refused(ORGS_0032)
        assert_proximity_erasure_schema_state(expect_extensions_0012=False)
        preserved = PrivacyErasure.objects.get(pk=row.id)
        assert preserved.inventory_sha256 == row.inventory_sha256
        assert "proximity_ephemeral" in preserved.inventory["required_domains"]
    finally:
        restore_proximity_test_migrations()
    assert_proximity_erasure_schema_state(expect_extensions_0012=True)


def test_admitted_and_in_flight_account_journal_refuses_extensions_and_orgs_downgrade(
    world,
) -> None:
    try:
        row = admit_account(
            world, verified=replace(world[3][2], auth_time=int(database_now().timestamp()))
        )
        assert "proximity_ephemeral" in row.inventory["required_domains"]
        progress = advance_account_erasure(row.id, {})
        assert progress["complete"] is False
        assert "proximity_ephemeral" in progress["held_domains"]

        assert_downgrade_refused(EXTENSIONS_0011)
        assert_downgrade_refused(ORGS_0032)

        assert_proximity_erasure_schema_state(expect_extensions_0012=True)
        preserved = AccountErasure.objects.get(pk=row.id)
        assert preserved.status == "core_purged"
        assert preserved.inventory_sha256 == row.inventory_sha256
        assert "proximity_ephemeral" in preserved.inventory["required_domains"]
    finally:
        restore_proximity_test_migrations()


def test_direct_orgs_0032_downgrade_refuses_account_journal_when_extensions_at_0011(
    world,
) -> None:
    try:
        MigrationExecutor(connection).migrate([EXTENSIONS_0011])
        assert_proximity_erasure_schema_state(expect_extensions_0012=False)

        row = admit_account(
            world, verified=replace(world[3][2], auth_time=int(database_now().timestamp()))
        )
        assert "proximity_ephemeral" in row.inventory["required_domains"]
        progress = advance_account_erasure(row.id, {})
        assert progress["complete"] is False and "proximity_ephemeral" in progress["held_domains"]

        assert_downgrade_refused(ORGS_0032)
        assert_proximity_erasure_schema_state(expect_extensions_0012=False)
        preserved = AccountErasure.objects.get(pk=row.id)
        assert preserved.inventory_sha256 == row.inventory_sha256
    finally:
        restore_proximity_test_migrations()
    assert_proximity_erasure_schema_state(expect_extensions_0012=True)


def test_recorded_workspace_proximity_receipt_refuses_extensions_and_orgs_downgrade(world) -> None:
    org, workspace, members, _ = world
    target = Identity.objects.get(organisation=org, user=members[2].user)
    try:
        with private_broker() as (broker, gateway, _):
            presence(broker, workspace.id, target.id, 11)
            row = begin_erasure(
                organisation_id=org.id,
                instruction_ref="DEL-403",
                instruction_sha256="c" * 64,
                purge_not_before=database_now(),
                actor_identity_id=operator().id,
            )
            scope = ErasureScope(row.id, row.organisation_reference, row.cutoff_at, row.inventory)
            adapter = ProximityWorkspaceErasureAdapter(gateway)
            proof = adapter.erase_and_verify(scope)
            persist_absence(scope, proof, adapter)

        assert ErasureReceipt.objects.filter(erasure=row, domain="proximity_ephemeral").exists()
        assert_downgrade_refused(EXTENSIONS_0011)
        assert_downgrade_refused(ORGS_0032)

        assert_proximity_erasure_schema_state(expect_extensions_0012=True)
        assert ErasureReceipt.objects.filter(erasure=row, domain="proximity_ephemeral").count() == 1
    finally:
        restore_proximity_test_migrations()


def test_direct_orgs_0032_downgrade_refuses_workspace_proximity_receipt_when_extensions_at_0011(
    world,
) -> None:
    org, workspace, members, _ = world
    target = Identity.objects.get(organisation=org, user=members[2].user)
    try:
        MigrationExecutor(connection).migrate([EXTENSIONS_0011])
        assert_proximity_erasure_schema_state(expect_extensions_0012=False)

        with private_broker() as (broker, gateway, _):
            presence(broker, workspace.id, target.id, 12)
            row = admit_core_workspace_erasure(org.id)
            scope = ErasureScope(row.id, row.organisation_reference, row.cutoff_at, row.inventory)
            adapter = ProximityWorkspaceErasureAdapter(gateway)
            proof = adapter.erase_and_verify(scope)
            persist_absence(scope, proof, adapter)

        assert ErasureReceipt.objects.filter(erasure=row, domain="proximity_ephemeral").exists()
        assert_downgrade_refused(ORGS_0032)
        assert_proximity_erasure_schema_state(expect_extensions_0012=False)
        assert ErasureReceipt.objects.filter(erasure=row, domain="proximity_ephemeral").count() == 1
    finally:
        restore_proximity_test_migrations()
    assert_proximity_erasure_schema_state(expect_extensions_0012=True)


def test_recorded_account_proximity_receipt_refuses_extensions_and_direct_orgs_downgrade(
    world,
) -> None:
    org, workspace, members, tokens = world
    target = Identity.objects.get(organisation=org, user=members[2].user)
    try:
        MigrationExecutor(connection).migrate([EXTENSIONS_0011])
        assert_proximity_erasure_schema_state(expect_extensions_0012=False)

        with private_broker() as (broker, gateway, _):
            presence(broker, workspace.id, target.id, 13)
            row = admit_account(
                world, verified=replace(tokens[2], auth_time=int(database_now().timestamp()))
            )
            scope = AccountErasureScope(row.id, row.user_reference, row.cutoff_at, row.inventory)
            adapter = ProximityAccountErasureAdapter(gateway)
            proof = adapter.erase_and_verify(scope)
            persist_account_absence(scope, proof, adapter)

        assert AccountErasureReceipt.objects.filter(
            erasure=row, domain="proximity_ephemeral"
        ).exists()
        assert_downgrade_refused(ORGS_0032)
        assert_proximity_erasure_schema_state(expect_extensions_0012=False)

        restore_proximity_test_migrations()
        assert_proximity_erasure_schema_state(expect_extensions_0012=True)
        assert_downgrade_refused(EXTENSIONS_0011)
        assert_downgrade_refused(ORGS_0032)
        assert_proximity_erasure_schema_state(expect_extensions_0012=True)
        assert (
            AccountErasureReceipt.objects.filter(erasure=row, domain="proximity_ephemeral").count()
            == 1
        )
    finally:
        restore_proximity_test_migrations()
    assert_proximity_erasure_schema_state(expect_extensions_0012=True)
