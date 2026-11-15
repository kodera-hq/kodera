"""Real cutoff inventories and private-socket absence receipts, without durable presence."""

import json
import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from uuid import UUID

import pytest
from django.db import IntegrityError, connection, transaction
from test_account_erasure import admit as admit_account
from test_core_erasure import operator
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
from apps.proximity.broker_rpc import BrokerGateway, BrokerServer
from apps.proximity.erasure import ProximityAccountErasureAdapter, ProximityWorkspaceErasureAdapter
from apps.proximity.services import ProximityBroker, ProximityRefusalError

pytestmark = pytest.mark.django_db(transaction=True)


@contextmanager
def private_broker() -> Iterator[tuple[ProximityBroker, BrokerGateway, Path]]:
    with tempfile.TemporaryDirectory(
        prefix="cx-erase-", dir=Path(Path(tempfile.gettempdir()).anchor, "tmp").resolve()
    ) as directory:
        with BrokerServer(str(Path(directory) / "broker.sock")) as server:
            worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02})
            worker.start()
            try:
                yield server.broker, BrokerGateway(str(server.path)), server.path
            finally:
                server.shutdown()
                worker.join(timeout=3)
                assert not worker.is_alive()


def presence(
    broker: ProximityBroker, workspace: UUID, identity: UUID, seed: int, counter: int = 0
) -> None:
    now = int(database_now().timestamp())
    token = broker.mint_client_token(
        workspace_id=workspace, device_seed=bytes([seed]) * 32, now_unix_secs=now, counter=counter
    )
    broker.checkin(
        principal_key=str(identity),
        workspace_id=workspace,
        beacon_token_hex=token,
        status_note="synthetic private presence note",
        ttl_seconds=7200,
        now_unix_secs=now,
    )


def test_account_cutoff_requires_real_broker_absence_and_preserves_other_people(world) -> None:
    org, workspace, members, tokens = world
    target = Identity.objects.get(organisation=org, user=members[2].user)
    other = Identity.objects.get(organisation=org, user=members[0].user)
    with private_broker() as (broker, gateway, _):
        presence(broker, workspace.id, target.id, 7)
        presence(broker, UUID("01950000-0000-7000-8000-0000000000a2"), target.id, 8)
        presence(broker, workspace.id, other.id, 9)
        row = admit_account(
            world, verified=replace(tokens[2], auth_time=int(database_now().timestamp()))
        )
        assert row.inventory["proximity_inventory_version"] == 1
        assert "proximity_ephemeral" in row.inventory["required_domains"]
        progress = advance_account_erasure(row.id, {})
        assert progress["complete"] is False and "proximity_ephemeral" in progress["held_domains"]
        assert gateway.inspect_account(identity_ids=[str(target.id)])["remaining_records"] == 2
        scope = AccountErasureScope(row.id, row.user_reference, row.cutoff_at, row.inventory)
        adapter = ProximityAccountErasureAdapter(gateway)
        proof = adapter.erase_and_verify(scope)
        assert adapter.verify_proof(scope, proof)
        assert gateway.inspect_account(identity_ids=[str(target.id)]) == {
            "remaining_records": 0,
            "remaining_replay_bindings": 0,
        }
        assert gateway.inspect_account(identity_ids=[str(other.id)])["remaining_records"] == 1
        assert not adapter.verify_proof(scope, replace(proof, evidence_sha256="0" * 64))
        persist_account_absence(scope, proof, adapter)
        progress = advance_account_erasure(row.id, {})
        assert (
            progress["complete"] is False and "proximity_ephemeral" not in progress["held_domains"]
        )


def test_workspace_cutoff_captures_namespace_before_core_purge_and_holds_without_adapter(
    world,
) -> None:
    org, workspace, members, _ = world
    target = Identity.objects.get(organisation=org, user=members[2].user)
    with private_broker() as (broker, gateway, _):
        presence(broker, workspace.id, target.id, 7)
        row = begin_erasure(
            organisation_id=org.id,
            instruction_ref="DEL-301",
            instruction_sha256="7" * 64,
            purge_not_before=database_now(),
            actor_identity_id=operator().id,
        )
        assert row.inventory["proximity_workspaces"] == [str(workspace.id)]
        assert row.inventory["proximity_inventory_version"] == 1
        progress = advance_erasure(row.id, {})
        assert progress["complete"] is False and "proximity_ephemeral" in progress["held_domains"]
        assert gateway.inspect_workspace(workspace_id=workspace.id)["remaining_records"] == 1
        scope = ErasureScope(row.id, row.organisation_reference, row.cutoff_at, row.inventory)
        adapter = ProximityWorkspaceErasureAdapter(gateway)
        proof = adapter.erase_and_verify(scope)
        assert adapter.verify_proof(scope, proof)
        assert gateway.inspect_workspace(workspace_id=workspace.id) == {
            "remaining_records": 0,
            "remaining_replay_bindings": 0,
        }
        assert not adapter.verify_proof(scope, replace(proof, organisation_id=UUID(int=7)))
        persist_absence(scope, proof, adapter)
        progress = advance_erasure(row.id, {})
        assert (
            progress["complete"] is False and "proximity_ephemeral" not in progress["held_domains"]
        )


def test_missing_broker_cannot_issue_or_verify_an_account_absence_receipt(world) -> None:
    row = admit_account(
        world, verified=replace(world[3][2], auth_time=int(database_now().timestamp()))
    )
    scope = AccountErasureScope(row.id, row.user_reference, row.cutoff_at, row.inventory)
    with tempfile.TemporaryDirectory(
        prefix="cx-missing-", dir=Path(Path(tempfile.gettempdir()).anchor, "tmp").resolve()
    ) as directory:
        gateway = BrokerGateway(str(Path(directory) / "absent.sock"))
        with pytest.raises(ProximityRefusalError, match="proximity_broker_unavailable"):
            ProximityAccountErasureAdapter(gateway).erase_and_verify(scope)


@pytest.mark.parametrize(
    "mutation",
    ["missing-version", "null-version", "future-version", "missing-domain", "extra", "duplicate"],
)
def test_extension_step_refuses_incomplete_or_unregistered_proximity_inventory(world, mutation):
    row = begin_erasure(
        organisation_id=world[0].id,
        instruction_ref="DEL-302",
        instruction_sha256="8" * 64,
        purge_not_before=database_now(),
        actor_identity_id=operator().id,
    )
    inventory = dict(row.inventory)
    domains = list(inventory["required_domains"])
    if mutation == "missing-version":
        inventory.pop("proximity_inventory_version")
    elif mutation == "null-version":
        inventory["proximity_inventory_version"] = None
    elif mutation == "future-version":
        inventory["proximity_inventory_version"] = 2
    elif mutation == "missing-domain":
        domains.remove("proximity_ephemeral")
    elif mutation == "extra":
        domains.append("unregistered_provider")
    else:
        domains.append("proximity_ephemeral")
    inventory["required_domains"] = domains
    with (
        pytest.raises(IntegrityError, match="required provider inventory refused"),
        transaction.atomic(),
    ):
        with connection.cursor() as cursor:
            # Owner-only corruption calibrates the actual SQL guard. Runtime roles cannot
            # alter this immutable journal or disable its trigger. The savepoint rolls back
            # the corruption and trigger DDL after the expected refusal.
            cursor.execute(
                "ALTER TABLE orgs_privacyerasure DISABLE TRIGGER erasure_journal_immutable"
            )
            cursor.execute(
                "UPDATE orgs_privacyerasure SET inventory=%s::jsonb,inventory_sha256=retention_inventory_digest(%s::jsonb) WHERE id=%s RETURNING inventory_sha256",
                [json.dumps(inventory), json.dumps(inventory), row.id],
            )
            digest = cursor.fetchone()[0]
            cursor.execute(
                "ALTER TABLE orgs_privacyerasure ENABLE TRIGGER erasure_journal_immutable"
            )
            cursor.execute(
                "SELECT extension_erasure_step(%s,%s,%s,%s,1)",
                [row.id, row.organisation_reference, row.cutoff_at, digest],
            )
