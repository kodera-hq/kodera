"""Real PostgreSQL migration composition and atomic confidential-erasure downgrade refusal."""

from __future__ import annotations

import os
from dataclasses import replace

import pytest
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from test_account_erasure import admit as admit_account
from test_core_erasure import operator
from test_e2ee_relay import admit_peer, b64, operation, relay as relay, world as world
from test_e2ee_relay_privacy import account_cutoff

from apps.e2ee.models import Device, Envelope, KeyPackage, Participant, Room
from apps.orgs.account_erasure_services import purge_account_core
from apps.orgs.erasure_services import advance_erasure, begin_erasure, database_now, purge_core
from apps.orgs.privacy_models import AccountErasureReceipt, ErasureReceipt, PrivacyErasure

pytestmark = pytest.mark.django_db(transaction=True)

BASE = ("e2ee", "0001_initial")
TARGET = ("e2ee", "0002_scope_and_privacy")
EE = ("orgs", "0032_ee_enterprise_store")
PROXIMITY = ("orgs", "0033_proximity_erasure_inventory")
REFUSAL = "cannot downgrade confidential relay privacy with retained resources or admitted erasure obligations"
MODELS = (Device, Room, Participant, KeyPackage, Envelope)
# Exact additions are the only permitted difference from the installed predecessor functions.
ADDITIONS = {
    "privacy_begin_erasure(uuid,uuid,text,text,timestamptz,uuid)": "\n inventory:=inventory||public.e2ee_organisation_inventory(p_org);",
    "privacy_begin_account_erasure(uuid,uuid,text,text,timestamptz,uuid)": "\n inventory:=inventory||public.e2ee_account_inventory(person);",
    "privacy_purge_core(uuid)": " purged_counts:=purged_counts||public.e2ee_purge_organisation(org);\n",
    "privacy_purge_account_core(uuid)": " purged_counts:=purged_counts||public.e2ee_purge_account(person);\n",
}
UNCHANGED = (
    "privacy_complete_erasure(uuid)",
    "privacy_complete_account_erasure(uuid)",
    "proximity_erasure_inventory()",
    "extension_erasure_step(uuid,uuid,timestamptz,text,integer)",
)


def definitions():
    with connection.cursor() as cursor:
        result = {}
        for signature in (*ADDITIONS, *UNCHANGED):
            cursor.execute("SELECT pg_get_functiondef(%s::regprocedure)", ["public." + signature])
            result[signature] = cursor.fetchone()[0]
        return result


def core_function_metadata():
    """Numeric identity and security attributes must survive every body replacement."""
    with connection.cursor() as cursor:
        cursor.execute(
            """SELECT p.oid,p.proowner,p.proacl,p.prosecdef,p.proconfig,p.provolatile,
            p.proparallel,p.proisstrict,p.proretset,p.proleakproof,p.prolang,p.procost,p.prorows,
            p.prorettype,p.proargtypes::text,p.proargnames,p.provariadic,p.prosupport::oid,
            p.prokind,p.pronargs,p.pronargdefaults,p.proallargtypes,p.proargmodes,
            p.proargdefaults::text,p.protrftypes,p.probin,p.prosqlbody::text,
            p.proname,p.pronamespace
            FROM pg_catalog.pg_proc p WHERE p.oid IN
              (%s::regprocedure,%s::regprocedure,%s::regprocedure,%s::regprocedure)
            ORDER BY p.oid""",
            ["public." + signature for signature in ADDITIONS],
        )
        rows = cursor.fetchall()
        assert len(rows) == 4
        return rows


def schema_snapshot():
    with connection.cursor() as cursor:
        cursor.execute("SELECT app,name FROM django_migrations ORDER BY app,name")
        migrations = cursor.fetchall()
        cursor.execute(
            """SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)
            FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
            WHERE NOT t.tgisinternal AND (c.relname LIKE 'e2ee_%'
              OR t.tgname='aa_proximity_inventory') ORDER BY c.relname,t.tgname"""
        )
        triggers = cursor.fetchall()
        cursor.execute(
            """SELECT p.oid::regprocedure::text,p.proowner,p.proacl
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND (p.proname LIKE 'e2ee_%'
              OR p.proname LIKE 'privacy_%' OR p.proname='proximity_erasure_inventory')
            ORDER BY p.oid::regprocedure::text"""
        )
        privileges = cursor.fetchall()
    return definitions(), migrations, triggers, privileges


def restore_leaves():
    executor = MigrationExecutor(connection)
    executor.migrate(executor.loader.graph.leaf_nodes())
    current = MigrationExecutor(connection)
    assert current.migration_plan(current.loader.graph.leaf_nodes()) == []


def refused_without_schema_change():
    before = schema_snapshot()
    with pytest.raises(IntegrityError, match=REFUSAL) as caught:
        MigrationExecutor(connection).migrate([BASE])
    assert getattr(caught.value.__cause__, "sqlstate", None) == "23514"
    assert schema_snapshot() == before
    assert TARGET in MigrationExecutor(connection).loader.applied_migrations


def begin_workspace(org):
    return begin_erasure(
        organisation_id=org.id,
        instruction_ref="DEL-412",
        instruction_sha256="4" * 64,
        purge_not_before=database_now(),
        actor_identity_id=operator().id,
    )


def test_prior_core_chain_upgrade_orders_replacement_functions_before_relay(world):
    # Actual MigrationExecutor transitions, not an alternate handmade SQL schema.
    try:
        MigrationExecutor(connection).migrate([("orgs", "0031_account_erasure_completion")])
        executor = MigrationExecutor(connection)
        plan = executor.loader.graph.forwards_plan(TARGET)
        assert plan.index(EE) < plan.index(PROXIMITY) < plan.index(TARGET)
        pending = [
            migration.app_label
            for migration, backwards in executor.migration_plan([TARGET])
            if not backwards
        ]
        assert "orgs" in pending and "e2ee" in pending
        restore_leaves()
        actual = definitions()
        for signature, addition in ADDITIONS.items():
            assert actual[signature].count(addition) == 1
        assert "ee_scim" in actual["privacy_purge_core(uuid)"]
        assert "ee_scim" in actual["privacy_purge_account_core(uuid)"]
        for signature in (
            "privacy_complete_erasure(uuid)",
            "privacy_complete_account_erasure(uuid)",
        ):
            assert "ee_pending" in actual[signature] and "proximity_ephemeral" in actual[signature]
    finally:
        restore_leaves()


def test_empty_and_historical_pre_relay_journal_roundtrip_preserves_predecessor_bytes(world):
    org = world[0]
    try:
        MigrationExecutor(connection).migrate([BASE])
        predecessor = definitions()
        predecessor_metadata = core_function_metadata()
        # This real journal has the existing proximity obligation, but no relay inventory.
        historical = begin_workspace(org)
        assert "e2ee" not in historical.inventory
        assert historical.inventory["proximity_inventory_version"] == 1
        immutable_inventory = historical.inventory
        immutable_digest = historical.inventory_sha256
        restore_leaves()
        upgraded = definitions()
        assert core_function_metadata() == predecessor_metadata
        for signature, addition in ADDITIONS.items():
            assert upgraded[signature].count(addition) == 1
            assert upgraded[signature].replace(addition, "") == predecessor[signature]
        for signature in UNCHANGED:
            assert upgraded[signature] == predecessor[signature]
        MigrationExecutor(connection).migrate([BASE])
        assert definitions() == predecessor
        assert core_function_metadata() == predecessor_metadata
        historical.refresh_from_db()
        assert historical.inventory == immutable_inventory
        assert historical.inventory_sha256 == immutable_digest
    finally:
        restore_leaves()


def test_existing_relay_rows_without_a_journal_refuse_downgrade(relay):
    assert not PrivacyErasure.objects.exists()
    before = {model: model.objects.count() for model in MODELS}
    refused_without_schema_change()
    assert {model: model.objects.count() for model in MODELS} == before
    # The real binding trigger remains active after the entire reverse attempt rolls back.
    with pytest.raises(IntegrityError) as caught, transaction.atomic():
        Device.objects.filter(pk=relay[5][0]).update(signing_key=os.urandom(32))
    assert getattr(caught.value.__cause__, "sqlstate", None) == "23514"


@pytest.mark.parametrize("record_receipt", [False, True])
def test_workspace_obligation_refuses_downgrade_before_and_after_real_core_purge(
    relay, record_receipt
):
    admit_peer(relay)
    request = begin_workspace(relay[0])
    assert request.inventory["e2ee"]["devices"] == 4
    assert request.inventory["e2ee"]["envelopes"] == 2
    immutable = (request.inventory, request.inventory_sha256)
    if record_receipt:
        # Invoke the actual trusted-worker SQL boundary; no receipt or DB adapter is mocked.
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT privacy_record_absence(%s,%s,%s,%s,%s,%s)",
                [
                    request.id,
                    "objects",
                    request.cutoff_at,
                    "5" * 64,
                    "relay-migration-fixture-v1",
                    database_now(),
                ],
            )
        assert ErasureReceipt.objects.filter(erasure=request, domain="objects").count() == 1
    refused_without_schema_change()
    result = advance_erasure(request.id, {})
    assert result["core_purged"] is True and result["complete"] is False
    assert "proximity_ephemeral" in result["held_domains"]
    assert result["counts"]["e2ee_devices"] == 4
    assert result["counts"]["e2ee_envelopes"] == 2
    assert all(not model.objects.filter(organisation=relay[0]).exists() for model in MODELS)
    # No rows remain: this refusal now necessarily comes from the durable journal obligation.
    refused_without_schema_change()
    request.refresh_from_db()
    assert (request.inventory, request.inventory_sha256) == immutable
    assert request.status == "core_purged"
    assert purge_core(request.id) == result["counts"]


@pytest.mark.parametrize("record_receipt", [False, True])
def test_account_obligation_keeps_revocation_payload_purge_and_receipt_binding(
    relay, record_receipt
):
    operation(relay, "publish_package", 2, {"keyPackage": b64(os.urandom(64))})
    request = account_cutoff(relay, 2)
    assert str(relay[5][2]) in request.inventory["e2ee"]["device_ids"]
    immutable = (request.inventory, request.inventory_sha256)
    if record_receipt:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT privacy_record_account_absence(%s,%s,%s,%s,%s,%s,%s,%s)",
                [
                    request.id,
                    request.user_reference,
                    request.cutoff_at,
                    request.inventory_sha256,
                    "private_exports",
                    "6" * 64,
                    "relay-migration-fixture-v1",
                    database_now(),
                ],
            )
        assert (
            AccountErasureReceipt.objects.filter(erasure=request, domain="private_exports").count()
            == 1
        )
    refused_without_schema_change()
    result = purge_account_core(request.id)
    assert result["complete"] is False and "proximity_ephemeral" in result["held_domains"]
    assert result["counts"]["e2ee_devices_revoked"] == 1
    assert result["counts"]["e2ee_directory_packages_discarded"] == 1
    assert Device.objects.get(pk=relay[5][2]).revoked_at is not None
    assert not KeyPackage.objects.filter(device_id=relay[5][2], package__isnull=False).exists()
    refused_without_schema_change()
    request.refresh_from_db()
    assert (request.inventory, request.inventory_sha256) == immutable
    if record_receipt:
        assert (
            AccountErasureReceipt.objects.filter(erasure=request, domain="private_exports").count()
            == 1
        )


def test_pre_relay_journal_with_later_relay_purge_counts_also_blocks_downgrade(world):
    try:
        MigrationExecutor(connection).migrate([BASE])
        request = begin_workspace(world[0])
        assert "e2ee" not in request.inventory
        restore_leaves()
        counts = purge_core(request.id)
        assert counts["e2ee_devices"] == 0 and counts["e2ee_envelopes"] == 0
        assert all(not model.objects.exists() for model in MODELS)
        request.refresh_from_db()
        assert "e2ee" not in request.inventory and "e2ee_devices" in request.counts
        refused_without_schema_change()
    finally:
        restore_leaves()


def test_empty_relay_account_inventory_still_prevents_downgrade(world):
    request = admit_account(
        world, verified=replace(world[3][2], auth_time=int(database_now().timestamp()))
    )
    assert request.inventory["e2ee"]["device_ids"] == []
    assert all(not model.objects.exists() for model in MODELS)
    # With no relay rows this proves the account journal branch independently.
    refused_without_schema_change()
    result = purge_account_core(request.id)
    assert result["counts"]["e2ee_devices_revoked"] == 0
    assert result["counts"]["e2ee_directory_packages_discarded"] == 0
    assert result["complete"] is False
    refused_without_schema_change()


def test_predecessor_body_drift_refuses_upgrade_without_overwriting_functions(world):
    signature = "privacy_begin_erasure(uuid,uuid,text,text,timestamptz,uuid)"
    original = None
    try:
        MigrationExecutor(connection).migrate([BASE])
        original = definitions()[signature]
        assert original.count("\nBEGIN\n") == 1
        changed = original.replace("\nBEGIN\n", "\nBEGIN\n -- retained predecessor body drift\n", 1)
        assert changed != original
        with connection.cursor() as cursor:
            cursor.execute(changed)
        before = schema_snapshot()
        metadata = core_function_metadata()
        with pytest.raises(
            IntegrityError, match="privacy protocol integration anchor changed"
        ) as caught:
            restore_leaves()
        assert getattr(caught.value.__cause__, "sqlstate", None) == "23514"
        assert schema_snapshot() == before
        assert core_function_metadata() == metadata
        assert TARGET not in MigrationExecutor(connection).loader.applied_migrations
    finally:
        if original is not None:
            with connection.cursor() as cursor:
                cursor.execute(original)
        restore_leaves()


def test_relay_body_drift_refuses_empty_reverse_without_changing_guards(world):
    signature = "privacy_purge_account_core(uuid)"
    original = None
    try:
        restore_leaves()
        assert all(not model.objects.exists() for model in MODELS)
        original = definitions()[signature]
        assert original.count("\nBEGIN\n") == 1
        changed = original.replace("\nBEGIN\n", "\nBEGIN\n -- retained relay body drift\n", 1)
        assert changed != original
        assert changed.count(ADDITIONS[signature]) == 1
        with connection.cursor() as cursor:
            cursor.execute(changed)
        before = schema_snapshot()
        metadata = core_function_metadata()
        with pytest.raises(
            IntegrityError, match="privacy protocol integration cannot be restored"
        ) as caught:
            MigrationExecutor(connection).migrate([BASE])
        assert getattr(caught.value.__cause__, "sqlstate", None) == "23514"
        assert schema_snapshot() == before
        assert core_function_metadata() == metadata
        assert TARGET in MigrationExecutor(connection).loader.applied_migrations
    finally:
        if original is not None:
            with connection.cursor() as cursor:
                cursor.execute(original)
        restore_leaves()


@pytest.mark.parametrize("change", ["configuration", "security"])
def test_predecessor_metadata_drift_refuses_upgrade_before_reset(world, change):
    signature = "privacy_begin_erasure(uuid,uuid,text,text,timestamptz,uuid)"
    original = None
    try:
        MigrationExecutor(connection).migrate([BASE])
        original = definitions()[signature]
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT prosrc FROM pg_catalog.pg_proc WHERE oid=%s::regprocedure",
                ["public." + signature],
            )
            original_body = cursor.fetchone()[0]
            if change == "configuration":
                cursor.execute(
                    "ALTER FUNCTION public.privacy_begin_erasure(uuid,uuid,text,text,timestamptz,uuid) SET statement_timeout='17s'"
                )
            else:
                cursor.execute(
                    "ALTER FUNCTION public.privacy_begin_erasure(uuid,uuid,text,text,timestamptz,uuid) SECURITY INVOKER"
                )
            cursor.execute(
                "SELECT prosrc FROM pg_catalog.pg_proc WHERE oid=%s::regprocedure",
                ["public." + signature],
            )
            assert cursor.fetchone()[0] == original_body
        assert definitions()[signature] != original
        before = schema_snapshot()
        metadata = core_function_metadata()
        with pytest.raises(
            IntegrityError, match="privacy protocol integration anchor changed"
        ) as caught:
            restore_leaves()
        assert getattr(caught.value.__cause__, "sqlstate", None) == "23514"
        assert schema_snapshot() == before
        assert core_function_metadata() == metadata
        assert TARGET not in MigrationExecutor(connection).loader.applied_migrations
    finally:
        if original is not None:
            with connection.cursor() as cursor:
                cursor.execute(original)
        restore_leaves()
