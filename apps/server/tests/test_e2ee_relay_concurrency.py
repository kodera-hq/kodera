"""Competing PostgreSQL connections prove one-use claims, epoch CAS and revocation fencing."""

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from django.db import close_old_connections, connection, connections, transaction
from django.test.utils import CaptureQueriesContext
from test_e2ee_relay import admit_peer, b64, operation, read, relay as relay, world as world

from apps.e2ee import services
from apps.e2ee.models import Device, Envelope, KeyPackage, Participant, Room
from apps.orgs.models import Membership

pytestmark = pytest.mark.django_db(transaction=True)


def concurrent(callables):
    barrier = threading.Barrier(len(callables))

    def run(call):
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            try:
                return 200, call()
            except services.RefusalError as error:
                return error.status, None
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=len(callables)) as pool:
        return list(pool.map(run, callables))


def test_two_commits_cannot_both_advance_one_epoch(relay):
    body = {"epoch": 0, "deviceIds": [str(relay[5][0])], "ciphertext": b64(os.urandom(32))}
    results = concurrent(
        [
            lambda: operation(relay, "commit_epoch", 0, body),
            lambda: operation(relay, "commit_epoch", 0, body),
        ]
    )
    assert sorted(result[0] for result in results) == [200, 409]
    assert Room.objects.get(pk=relay[6]).epoch == 1
    assert Envelope.objects.filter(kind="commit").count() == 1


def test_competing_admin_claims_never_deliver_the_same_package_twice(relay):
    admit_peer(relay, index=1)
    operation(
        relay, "publish_package", 2, {"keyPackage": b64(b"synthetic concurrent claim package")}
    )
    body = {"targetDeviceId": str(relay[5][2])}
    results = concurrent(
        [
            lambda: operation(relay, "claim_package", 0, body),
            lambda: operation(relay, "claim_package", 1, body),
        ]
    )
    assert sorted(result[0] for result in results) == [200, 409]
    assert KeyPackage.objects.filter(device_id=relay[5][2], claimed_at__isnull=False).count() == 1


def test_membership_revocation_waits_for_admitted_emission_then_refuses_later_messages(
    relay, monkeypatch
):
    admit_peer(relay)
    admitted = threading.Event()
    release = threading.Event()
    writer_started = threading.Event()
    writer_done = threading.Event()
    backend = []
    original = services._append

    def held_append(room, sender, kind, ciphertext, signature, recipient=None):
        if kind == "application" and sender.id == relay[5][2]:
            admitted.set()
            assert release.wait(timeout=5), "test release deadline"
        return original(room, sender, kind, ciphertext, signature, recipient)

    monkeypatch.setattr(services, "_append", held_append)

    def send():
        close_old_connections()
        try:
            return operation(
                relay, "send_application", 2, {"epoch": 1, "ciphertext": b64(os.urandom(32))}
            )
        finally:
            connections.close_all()

    def revoke():
        close_old_connections()
        try:
            connection.ensure_connection()
            backend.append(connection.connection.info.backend_pid)
            writer_started.set()
            Membership.objects.filter(pk=relay[2][2].id).update(state="suspended")
            writer_done.set()
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        sending = pool.submit(send)
        assert admitted.wait(timeout=5)
        revoking = pool.submit(revoke)
        try:
            assert writer_started.wait(timeout=5)
            deadline = time.monotonic() + 3
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
            assert blocked and not writer_done.is_set(), "revocation escaped the emission fence"
        finally:
            release.set()
        assert sending.result(timeout=5)["epoch"] == 1
        revoking.result(timeout=5)
    with pytest.raises(services.RefusalError):
        operation(relay, "send_application", 2, {"epoch": 1, "ciphertext": b64(os.urandom(32))})
    assert Envelope.objects.filter(kind="application").count() == 1


def test_ambient_old_snapshot_cannot_bypass_current_authority_fences(relay):
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        with pytest.raises(services.RefusalError) as failure:
            read(relay)
        assert failure.value.status == 503


@pytest.mark.parametrize("scope", ["privacy_erasure_cutoff", "privacy_account_cutoff"])
def test_busy_privacy_fence_returns_retry_without_waiting_behind_cutoff(relay, scope):
    ready, release = threading.Event(), threading.Event()
    identifier = relay[0].id if scope == "privacy_erasure_cutoff" else relay[2][0].user_id

    def cutoff():
        close_old_connections()
        try:
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
                    [scope + ":" + str(identifier)],
                )
                ready.set()
                assert release.wait(timeout=5)
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=1) as pool:
        cut = pool.submit(cutoff)
        assert ready.wait(timeout=5)
        try:
            start = time.monotonic()
            with pytest.raises(services.RefusalError) as failure:
                read(relay)
            assert failure.value.status == 503 and time.monotonic() - start < 1
        finally:
            release.set()
        cut.result(timeout=5)


def test_unrelated_account_cutoff_cannot_invert_organisation_and_workspace_locks(relay):
    from test_e2ee_relay_privacy import account_cutoff

    ready, release = threading.Event(), threading.Event()

    def hold_after_cutoff_sql(execute, sql, params, many, context):
        result = execute(sql, params, many, context)
        if "SELECT privacy_begin_account_erasure(" in sql:
            ready.set()
            assert release.wait(timeout=5)
        return result

    def cutoff():
        close_old_connections()
        try:
            with connection.execute_wrapper(hold_after_cutoff_sql):
                # This person is not an admitted relay participant. Its real
                # cutoff holds organisation authority before its workspace hook.
                return account_cutoff(relay, 3).id
        finally:
            connections.close_all()

    def send():
        close_old_connections()
        try:
            try:
                operation(
                    relay, "send_application", 0, {"epoch": 0, "ciphertext": b64(os.urandom(32))}
                )
            except services.RefusalError as failure:
                return failure.status
            return 200
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        cutting = pool.submit(cutoff)
        assert ready.wait(timeout=5)
        try:
            sending = pool.submit(send)
            assert sending.result(timeout=2) == 503
        finally:
            release.set()
        assert cutting.result(timeout=5)
    # The unrelated account's completed erasure does not revoke the admitted owner.
    assert (
        operation(relay, "send_application", 0, {"epoch": 0, "ciphertext": b64(os.urandom(32))})[
            "epoch"
        ]
        == 0
    )


def test_roster_validation_uses_batched_moderation_facts_instead_of_per_device_queries(relay):
    admit_peer(relay)
    with CaptureQueriesContext(connection) as first:
        read(relay)
    peer = Device.objects.get(pk=relay[5][2])
    for _ in range(14):
        device = Device.objects.create(
            organisation_id=relay[0].id,
            membership_id=peer.membership_id,
            identity_id=peer.identity_id,
            signing_key=os.urandom(32),
        )
        Participant.objects.create(
            organisation_id=relay[0].id, room_id=relay[6], device=device, joined_epoch=1
        )
    with CaptureQueriesContext(connection) as larger:
        read(relay)
    assert len(larger) == len(first)
