"""Observed real cutoff schedules and closed installed SQL inventories."""

import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy

import pytest
from django.db import IntegrityError, close_old_connections, connection, connections, transaction
from psycopg import sql
from test_core_erasure import operator
from test_e2ee_relay import admit_peer, b64, operation, relay as relay, world as world
from test_e2ee_relay_privacy import account_cutoff
from test_privacy_combined_lifecycle import ee_exists, seed_ee_person
from test_proximity_erasure import presence, private_broker

from apps.e2ee import services
from apps.identity.models import Identity
from apps.orgs.account_erasure_services import advance_account_erasure
from apps.orgs.erasure_services import advance_erasure, begin_erasure, database_now
from apps.proximity.api import views
from apps.proximity.services import ProximityRefusalError

pytestmark = pytest.mark.django_db(transaction=True)


def cutoff(relay, kind):
    if kind == "account":
        return account_cutoff(relay, 2)
    return begin_erasure(
        organisation_id=relay[0].id,
        instruction_ref="DEL-491",
        instruction_sha256="8" * 64,
        purge_not_before=database_now(),
        actor_identity_id=operator().id,
    )


@pytest.mark.parametrize("kind", ["account", "organisation"])
def test_actual_cutoff_waits_for_held_relay_then_refuses_ee_and_proximity(
    relay, monkeypatch, settings, kind
):
    admit_peer(relay)
    identity = Identity.objects.get(organisation=relay[0], user_id=relay[2][2].user_id)
    ee = seed_ee_person(relay[0], relay[2][2].user)
    entered, release, started, done = (threading.Event() for _ in range(4))
    backend = []
    original = services._append

    def hold(room, sender, event_kind, ciphertext, signature, recipient=None):
        if event_kind == "application" and sender.id == relay[5][2]:
            entered.set()
            assert release.wait(8)
        return original(room, sender, event_kind, ciphertext, signature, recipient)

    monkeypatch.setattr(services, "_append", hold)

    def emit():
        close_old_connections()
        try:
            return operation(
                relay, "send_application", 2, {"epoch": 1, "ciphertext": b64(os.urandom(32))}
            )
        finally:
            connections.close_all()

    def erase():
        close_old_connections()
        try:
            connection.ensure_connection()
            backend.append(connection.connection.info.backend_pid)
            started.set()
            result = cutoff(relay, kind)
            done.set()
            return result.id
        finally:
            connections.close_all()

    with private_broker() as (broker, gateway, path):
        settings.KODERA_PROXIMITY_BROKER = None
        settings.KODERA_PROXIMITY_BROKER_SOCKET = str(path)
        presence(broker, relay[1].id, identity.id, 21)
        with ThreadPoolExecutor(max_workers=2) as pool:
            sending = pool.submit(emit)
            assert entered.wait(5)
            erasing = pool.submit(erase)
            try:
                assert started.wait(5)
                deadline = time.monotonic() + 4
                blocked = False
                while time.monotonic() < deadline and not done.is_set():
                    with connection.cursor() as cursor:
                        cursor.execute(
                            "SELECT wait_event_type FROM pg_stat_activity WHERE pid=%s",
                            [backend[0]],
                        )
                        row = cursor.fetchone()
                    if row and row[0] == "Lock":
                        blocked = True
                        break
                    time.sleep(0.02)
                assert blocked and not done.is_set(), "actual cutoff escaped held operation fence"
            finally:
                release.set()
            assert sending.result(timeout=8)["epoch"] == 1
            assert erasing.result(timeout=8)
        with pytest.raises(services.RefusalError):
            operation(relay, "send_application", 2, {"epoch": 1, "ciphertext": b64(os.urandom(32))})
        with pytest.raises(ProximityRefusalError):
            views._operation(relay[3][2], relay[1].id, "bootstrap")
        with pytest.raises(IntegrityError, match="cutoff refuses write"), transaction.atomic():
            seed_ee_person(relay[0], relay[2][2].user)
        assert ee_exists(ee), "cutoff is not falsely treated as already purged"
        assert gateway.inspect_account(identity_ids=[str(identity.id)])["remaining_records"] == 1


@pytest.mark.parametrize("kind", ["account", "organisation"])
@pytest.mark.parametrize(
    "mutation",
    ["absent", "null", "string", "future", "partial", "duplicate", "unknown", "wrong-type"],
)
def test_installed_completion_rejects_closed_inventory_corruption_after_real_core_purge(
    relay, kind, mutation
):
    row = cutoff(relay, kind)
    advance = advance_account_erasure if kind == "account" else advance_erasure
    assert advance(row.id, {})["complete"] is False
    row.refresh_from_db()
    inventory = deepcopy(row.inventory)
    if mutation == "absent":
        inventory.pop("proximity_inventory_version")
    elif mutation == "null":
        inventory["proximity_inventory_version"] = None
    elif mutation == "string":
        inventory["proximity_inventory_version"] = "1"
    elif mutation == "future":
        inventory["proximity_inventory_version"] = 2
    elif mutation == "partial":
        inventory["required_domains"].remove("proximity_ephemeral")
    elif mutation == "duplicate":
        inventory["required_domains"].append("proximity_ephemeral")
    elif mutation == "unknown":
        inventory["required_domains"][-1] = "unregistered_provider"
    else:
        inventory["required_domains"] = None
    table = "orgs_accounterasure" if kind == "account" else "orgs_privacyerasure"
    trigger = "account_erasure_immutable" if kind == "account" else "erasure_journal_immutable"
    function = (
        "privacy_complete_account_erasure" if kind == "account" else "privacy_complete_erasure"
    )
    # Owner-only corruption calibrates installed SQL; the savepoint rolls back
    # both data and trigger DDL. API roles cannot perform this setup.
    with pytest.raises(IntegrityError, match="required domains"), transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(f"ALTER TABLE {table} DISABLE TRIGGER {trigger}")
            cursor.execute(
                sql.SQL(
                    "UPDATE {} SET inventory=%s::jsonb,inventory_sha256=retention_inventory_digest(%s::jsonb) WHERE id=%s"
                ).format(sql.Identifier(table)),
                [json.dumps(inventory), json.dumps(inventory), row.id],
            )
            cursor.execute(f"ALTER TABLE {table} ENABLE TRIGGER {trigger}")
            cursor.execute(f"SELECT {function}(%s)", [row.id])
    row.refresh_from_db()
    assert row.inventory["proximity_inventory_version"] == 1
    assert len(row.inventory["required_domains"]) == 6
