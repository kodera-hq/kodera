"""Real PostgreSQL interleaves and departed-target disclosure acceptance."""

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest
import time_machine
from django.db import close_old_connections, connection, connections, transaction
from django.test import Client
from test_core_erasure import operator
from test_proximity_broker import (
    ISSUER_A,
    NOW,
    SLUG_A,
    WORKSPACE_A,
    _mint_jwt,
    _post_json,
    broker_env as broker_env,
    es256_signer as es256_signer,
)
from workspace_safety.test_moderation import world as world

from apps.identity.models import Identity, User
from apps.orgs import member_set_hooks
from apps.orgs.account_erasure_services import begin_account_erasure
from apps.orgs.erasure_services import database_now
from apps.orgs.models import Membership
from apps.proximity.api import views
from apps.proximity.services import (
    ProximityBroker,
    ProximityRefusalError,
    mint_ephemeral_beacon_token_with_epoch_key,
)

pytestmark = pytest.mark.django_db(transaction=True)


def _bootstrap_status(verified: Any, workspace_id: UUID) -> int:
    close_old_connections()
    try:
        try:
            return views._operation(verified, workspace_id, "bootstrap").status_code
        except ProximityRefusalError as failure:
            return failure.status
    finally:
        connections.close_all()


def test_unrelated_account_cutoff_cannot_deadlock_workspace_authority(
    world: Any, settings: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    org, workspace, _, tokens = world
    settings.KODERA_PROXIMITY_BROKER = ProximityBroker()
    assert views._operation(tokens[0], workspace.id, "bootstrap").status_code == 200
    actor = operator().id
    cutoff_ready, release = threading.Event(), threading.Event()
    original = member_set_hooks.member_erased

    def held_member_erased(member: Any) -> None:
        # The real cutoff SQL already owns account/organisation authority. Its actual
        # engine emission will request the workspace lock after this test barrier.
        cutoff_ready.set()
        assert release.wait(timeout=5), "cutoff release deadline"
        original(member)

    monkeypatch.setattr(member_set_hooks, "member_erased", held_member_erased)

    def cutoff() -> None:
        close_old_connections()
        try:
            begin_account_erasure(
                verified=replace(tokens[3], auth_time=int(database_now().timestamp())),
                confirmation="delete",
                instruction_ref="DEL-401",
                instruction_sha256="7" * 64,
                purge_not_before=database_now(),
                actor_identity_id=actor,
            )
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        cutting = pool.submit(cutoff)
        if not cutoff_ready.wait(timeout=5):
            cutting.result(timeout=1)
            pytest.fail("cutoff did not reach its authority barrier")
        request = pool.submit(_bootstrap_status, tokens[0], workspace.id)
        try:
            assert request.result(timeout=2) == 503
        finally:
            release.set()
            cutting.result(timeout=5)
    assert views._operation(tokens[0], workspace.id, "bootstrap").status_code == 200


@pytest.mark.parametrize("scope", ["organisation", "account"])
def test_existing_exclusive_privacy_fence_refuses_without_waiting(
    world: Any, settings: Any, scope: str
) -> None:
    org, workspace, members, tokens = world
    settings.KODERA_PROXIMITY_BROKER = ProximityBroker()
    assert views._operation(tokens[0], workspace.id, "bootstrap").status_code == 200
    prefix, identifier = (
        ("privacy_erasure_cutoff:", org.id)
        if scope == "organisation"
        else ("privacy_account_cutoff:", members[0].user_id)
    )
    pool = ThreadPoolExecutor(max_workers=1)
    result = None
    try:
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s||%s::text,0))",
                    [prefix, identifier],
                )
            request = pool.submit(_bootstrap_status, tokens[0], workspace.id)
            try:
                result = request.result(timeout=2)
            except TimeoutError:
                pass  # Release the held fence before joining a failed calibration.
    finally:
        pool.shutdown(wait=True)
    assert result == 503, "operation waited on an already exclusive privacy fence"


def _request(bearer: str, path: str = "/api/v1/proximity/bootstrap") -> Any:
    close_old_connections()
    try:
        return _post_json(Client(), path, {"workspace_id": str(WORKSPACE_A)}, bearer=bearer)
    finally:
        connections.close_all()


def test_membership_revocation_waits_until_admitted_bootstrap_finishes(
    broker_env: Any, es256_signer: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    admitted, release, writer_started, writer_done = (threading.Event() for _ in range(4))
    backend: list[int] = []
    original = views._active_broker

    class HeldBroker:
        def checkin(self, **arguments: Any) -> dict[str, Any]:
            return original().checkin(**arguments)

        def resolve(self, **arguments: Any) -> dict[str, Any]:
            return original().resolve(**arguments)

        def nearby(self, **arguments: Any) -> dict[str, Any]:
            return original().nearby(**arguments)

        def checkout(self, **arguments: Any) -> dict[str, Any]:
            return original().checkout(**arguments)

        def bootstrap(self, **arguments: Any) -> dict[str, Any]:
            admitted.set()
            assert release.wait(timeout=5), "test release deadline"
            return original().bootstrap(**arguments)

    monkeypatch.setattr(views, "_active_broker", lambda: HeldBroker())

    def revoke() -> None:
        close_old_connections()
        try:
            connection.ensure_connection()
            backend.append(connection.connection.info.backend_pid)
            writer_started.set()
            Membership.objects.filter(user__email=f"user-bob@{SLUG_A}.example.org").update(
                state="suspended"
            )
            writer_done.set()
        finally:
            connections.close_all()

    with (
        time_machine.travel(datetime.fromtimestamp(NOW, UTC), tick=False),
        ThreadPoolExecutor(max_workers=2) as pool,
    ):
        bearer = _mint_jwt(es256_signer, "user-bob", issuer=ISSUER_A)
        response = pool.submit(_request, bearer)
        if not admitted.wait(timeout=5):
            response.result(timeout=1)
            pytest.fail("request did not reach its broker barrier")
        revoker = pool.submit(revoke)
        try:
            assert writer_started.wait(timeout=5)
            deadline = time.monotonic() + 2
            blocked = False
            while time.monotonic() < deadline and not writer_done.is_set():
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT wait_event_type FROM pg_stat_activity WHERE pid=%s", [backend[0]]
                    )
                    row = cursor.fetchone()
                if row and row[0] == "Lock":
                    blocked = True
                    break
                time.sleep(0.02)
            assert blocked and not writer_done.is_set(), (
                "revocation committed while bootstrap was admitted and paused in RPC"
            )
        finally:
            release.set()
            assert response.result(timeout=5).status_code == 200
            revoker.result(timeout=5)
        assert _request(bearer).status_code == 404


@pytest.mark.parametrize("cutoff", ["membership", "identity", "person"])
def test_departed_target_is_purged_before_another_member_can_list_it(
    broker_env: Any, es256_signer: Any, cutoff: str
) -> None:
    client = Client()
    with time_machine.travel(datetime.fromtimestamp(NOW, UTC), tick=False):
        bearers = {}
        for index, subject in enumerate(("user-alice", "user-bob")):
            bearer = _mint_jwt(es256_signer, subject, issuer=ISSUER_A)
            bearers[subject] = bearer
            lease = _post_json(
                client,
                "/api/v1/proximity/bootstrap",
                {"workspace_id": str(WORKSPACE_A)},
                bearer=bearer,
            ).json()
            token = mint_ephemeral_beacon_token_with_epoch_key(
                epoch_mac_key=bytes.fromhex(lease["epoch_mac_key"]),
                epoch=lease["epoch"],
                epoch_expires_at=lease["epoch_expires_at"],
                device_ephemeral_seed=bytes([index + 7]) * 32,
                workspace_id=WORKSPACE_A,
                event_scope="default",
                now_unix_secs=NOW,
            )
            assert (
                _post_json(
                    client,
                    "/api/v1/proximity/checkin",
                    {
                        "workspace_id": str(WORKSPACE_A),
                        "beacon_token": token,
                        "handle": "alice" if index == 0 else "departing-bob",
                        "status_note": "" if index == 0 else "synthetic target private note",
                        "ttl_seconds": 7200,
                    },
                    bearer=bearer,
                ).status_code
                == 201
            )
        person = User.objects.get(email=f"user-bob@{SLUG_A}.example.org")
        if cutoff == "membership":
            Membership.objects.filter(user=person).update(state="suspended")
        elif cutoff == "identity":
            Identity.objects.filter(user=person).update(enabled=False)
        else:
            User.objects.filter(pk=person.id).update(enabled=False)
        response = client.get(
            f"/api/v1/proximity/nearby?workspace_id={WORKSPACE_A}",
            HTTP_AUTHORIZATION=f"Bearer {bearers['user-alice']}",
        )
        assert response.status_code == 200
        assert response.json()["peers"] == [], (
            "departed target handle/status remained visible after persisted authority removal"
        )
        assert all(
            record.handle != "departing-bob" for record in broker_env._by_principal.values()
        ), "departed target personal data remained in broker RAM"
