"""Real proofs, epochs, SQL constraints and capacity boundaries for the relay."""

import hashlib
import json
import os
from datetime import timedelta
from uuid import uuid4

import pytest
import time_machine
from customer_http_fixtures import http_signer as http_signer
from django.db import IntegrityError, transaction
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_e2ee_production_mount import production_route as production_route, snapshot
from test_e2ee_relay import admit_peer, b64, relay as relay
from test_e2ee_relay_http import http as http, path, post, send, writer as writer
from test_e2ee_relay_privacy import account_cutoff
from test_intake_writer_role import acting_as
from workspace_safety.test_moderation import world as world

from apps.e2ee import services
from apps.e2ee.models import Device, Envelope, KeyPackage, Participant, Room
from apps.orgs.account_erasure_services import purge_account_core

pytestmark = pytest.mark.django_db(transaction=True)


def raw_post(relay, http, suffix, document, key):
    return http[0].post(
        path(relay, suffix),
        data=json.dumps(document),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + http[1][0],
        HTTP_IDEMPOTENCY_KEY=key,
    )


def commit(relay, http, epoch, ids, *, welcome=False):
    body = {
        "deviceId": str(relay[5][0]),
        "epoch": epoch,
        "deviceIds": [str(x) for x in ids],
        "ciphertext": b64(os.urandom(32)),
    }
    if welcome:
        body["welcome"] = b64(os.urandom(32))
    return post(relay, http, "commit-epoch", f"rooms/{relay[6]}/commits", body, room=True)


def publish(relay, http, index=2):
    response = post(
        relay,
        http,
        "publish-key-package",
        "key-packages",
        {"deviceId": str(relay[5][index]), "keyPackage": b64(os.urandom(64))},
        index=index,
    )
    assert response.status_code == 201, response.content
    return KeyPackage.objects.get(pk=response.json()["keyPackageId"])


def claim(relay, http, epoch, index=2, *, key=None):
    return post(
        relay,
        http,
        "claim-key-package",
        f"rooms/{relay[6]}/key-packages/claims",
        {"deviceId": str(relay[5][0]), "targetDeviceId": str(relay[5][index]), "epoch": epoch},
        key=key,
        room=True,
    )


@pytest.mark.parametrize("operation_name", ["claim-key-package", "retire-room-device"])
def test_mutation_epoch_is_required_on_the_real_http_boundary(
    relay, http, production_route, writer, operation_name
):
    body = {"deviceId": str(relay[5][0]), "targetDeviceId": str(relay[5][0])}
    body["signature"] = b64(
        relay[4][0].sign(
            services.signed_statement(operation_name, relay[0].id, relay[2][0].id, relay[6], body)
        )
    )
    suffix = (
        "key-packages/claims" if operation_name == "claim-key-package" else "participants/retire"
    )
    before = snapshot()
    with acting_as(writer):
        response = raw_post(relay, http, f"rooms/{relay[6]}/" + suffix, body, str(uuid4()))
    assert response.status_code == 422, response.content
    assert snapshot() == before


def test_captured_claim_proof_cannot_consume_a_new_package_after_epoch_advance(
    relay, http, production_route, writer
):
    with acting_as(writer):
        first = publish(relay, http)
        body = {"deviceId": str(relay[5][0]), "targetDeviceId": str(relay[5][2]), "epoch": 0}
        signed = relay[7](0, "claim-key-package", body, relay[6])
        suffix, original_key = f"rooms/{relay[6]}/key-packages/claims", str(uuid4())
        accepted = raw_post(relay, http, suffix, signed, original_key)
        assert accepted.status_code == 200, accepted.content
        assert commit(relay, http, 0, [relay[5][0], relay[5][2]], welcome=True).status_code == 201
        second = publish(relay, http)
        before = snapshot()
        replay = raw_post(relay, http, suffix, signed, original_key)
        assert replay.status_code == 200 and replay.content == accepted.content
        assert replay["Idempotency-Replayed"] == "true"
        assert snapshot() == before
        stale = raw_post(relay, http, suffix, signed, str(uuid4()))
        assert stale.status_code == 409, stale.content
        first.refresh_from_db()
        second.refresh_from_db()
        assert first.package is None and first.discarded_at is not None
        assert second.claimed_at is None and second.package is not None
        fresh = claim(relay, http, 1)
        assert fresh.status_code == 200 and fresh.json()["keyPackageId"] == str(second.id)


def test_captured_retirement_proof_cannot_retire_a_readmitted_device(
    relay, http, production_route, writer
):
    admit_peer(relay)
    with acting_as(writer):
        body = {"deviceId": str(relay[5][0]), "targetDeviceId": str(relay[5][2]), "epoch": 1}
        signed = relay[7](0, "retire-room-device", body, relay[6])
        suffix, original_key = f"rooms/{relay[6]}/participants/retire", str(uuid4())
        retired = raw_post(relay, http, suffix, signed, original_key)
        assert retired.status_code == 200, retired.content
        assert commit(relay, http, 1, [relay[5][0]]).status_code == 201
        publish(relay, http)
        assert claim(relay, http, 2).status_code == 200
        assert commit(relay, http, 2, [relay[5][0], relay[5][2]], welcome=True).status_code == 201
        before = snapshot()
        replay = raw_post(relay, http, suffix, signed, original_key)
        assert replay.status_code == 200 and replay.content == retired.content
        assert replay["Idempotency-Replayed"] == "true"
        assert snapshot() == before
        stale = raw_post(relay, http, suffix, signed, str(uuid4()))
        assert stale.status_code == 409, stale.content
        assert Participant.objects.get(room_id=relay[6], device_id=relay[5][2]).left_epoch is None
        fresh = post(
            relay,
            http,
            "retire-room-device",
            suffix,
            {**body, "epoch": 3},
            room=True,
        )
        assert fresh.status_code == 200, fresh.content
        assert Participant.objects.get(room_id=relay[6], device_id=relay[5][2]).left_epoch == 4


def test_distinct_replay_keys_cannot_drain_the_same_room_epoch(
    relay, http, production_route, writer
):
    with acting_as(writer):
        for _ in range(services.MAX_PACKAGES):
            publish(relay, http)
        first = claim(relay, http, 0)
        assert first.status_code == 200, first.content
        for _ in range(services.MAX_PACKAGES - 1):
            refused = claim(relay, http, 0)
            assert refused.status_code == 409, refused.content
    assert KeyPackage.objects.filter(device_id=relay[5][2], claimed_at__isnull=False).count() == 1
    assert KeyPackage.objects.filter(device_id=relay[5][2], claimed_at__isnull=True).count() == 15
    first_row = KeyPackage.objects.get(pk=first.json()["keyPackageId"])
    other = KeyPackage.objects.filter(device_id=relay[5][2], claimed_at__isnull=True).first()
    with acting_as(writer), pytest.raises(IntegrityError) as failure:
        with transaction.atomic():
            KeyPackage.objects.filter(pk=other.id).update(
                claimed_at=timezone.now(),
                claimed_for_id=relay[6],
                claimed_by_id=relay[5][0],
                claimed_epoch=0,
            )
    assert failure.value.__cause__.sqlstate == "23505"
    assert failure.value.__cause__.diag.constraint_name == "e2ee_package_epoch_claim_unique"
    first_row.refresh_from_db()
    assert first_row.package is not None


@pytest.mark.parametrize("state", ["expired", "discarded"])
def test_stale_claim_metadata_cannot_admit_a_device_until_a_fresh_epoch_claim(
    relay, http, production_route, writer, state
):
    now = timezone.now()
    payload = os.urandom(64)
    with acting_as(writer):
        package = KeyPackage.objects.create(
            organisation_id=relay[0].id,
            device_id=relay[5][2],
            reference=hashlib.sha256(payload).digest(),
            package=payload,
            expires_at=now + timedelta(seconds=1)
            if state == "expired"
            else now + timedelta(days=7),
        )
        assert claim(relay, http, 0).status_code == 200
        if state == "discarded":
            KeyPackage.objects.filter(pk=package.id).update(
                package=None, discarded_at=now, updated_at=now
            )
    with time_machine.travel(now + timedelta(seconds=2), tick=False), acting_as(writer):
        refused = commit(relay, http, 0, [relay[5][0], relay[5][2]], welcome=True)
        assert refused.status_code == 409, refused.content
        package.refresh_from_db()
        assert package.package is None and package.discarded_at is not None
        assert not Participant.objects.filter(room_id=relay[6], device_id=relay[5][2]).exists()
        assert Room.objects.get(pk=relay[6]).epoch == 0
        # The old scope remains consumed, even after its bytes are discarded.
        assert claim(relay, http, 0).status_code == 409
        assert commit(relay, http, 0, [relay[5][0]]).status_code == 201
        publish(relay, http)
        assert claim(relay, http, 1).status_code == 200
        admitted = commit(relay, http, 1, [relay[5][0], relay[5][2]], welcome=True)
        assert admitted.status_code == 201, admitted.content


def test_application_capacity_keeps_bounded_control_room_for_eviction(
    relay, http, production_route, writer, monkeypatch
):
    assert services.MAX_ENVELOPES == 4096
    assert services.MAX_RECOVERY_ENVELOPES == 4096 + 128 + 1
    monkeypatch.setattr(services, "MAX_ENVELOPES", 4)
    monkeypatch.setattr(services, "MAX_RECOVERY_ENVELOPES", 6)
    admit_peer(relay)
    with acting_as(writer):
        for _ in range(2):
            assert send(relay, http, epoch=1).status_code == 201
        assert Envelope.objects.count() == 4
        assert send(relay, http, epoch=1).status_code == 409
        retired = post(
            relay,
            http,
            "retire-room-device",
            f"rooms/{relay[6]}/participants/retire",
            {"deviceId": str(relay[5][0]), "targetDeviceId": str(relay[5][2]), "epoch": 1},
            room=True,
        )
        assert retired.status_code == 200, retired.content
        evicted = commit(relay, http, 1, [relay[5][0]])
        assert evicted.status_code == 201, evicted.content
        assert Envelope.objects.count() == 5
        assert not Room.objects.get(pk=relay[6]).rekey_required
        assert commit(relay, http, 2, [relay[5][0]]).status_code == 201
        assert Envelope.objects.count() == 6
        exhausted = commit(relay, http, 3, [relay[5][0]])
        assert exhausted.status_code == 409, exhausted.content
        assert Room.objects.get(pk=relay[6]).epoch == 3 and Envelope.objects.count() == 6


@pytest.mark.parametrize("conflict", ["revoked", "another-member"])
def test_registration_conflict_is_consistently_409_with_valid_possession(
    relay, http, production_route, writer, conflict
):
    index = 0 if conflict == "revoked" else 2
    if conflict == "revoked":
        Device.objects.filter(pk=relay[5][0]).update(revoked_at=timezone.now())
    body = {"signingKey": b64(relay[4][0].public_key().public_bytes_raw())}
    body["signature"] = b64(
        relay[4][0].sign(
            services.signed_statement(
                "register-device", relay[0].id, relay[2][index].id, None, body
            )
        )
    )
    with acting_as(writer):
        with pytest.raises(services.RefusalError) as failure:
            services.register_device(
                verified=relay[3][index],
                organisation_id=relay[0].id,
                body=body,
                request_id=str(uuid4()),
            )
        assert failure.value.status == 409
        response = http[0].post(
            path(relay, "devices"),
            data=json.dumps(body),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer " + http[1][index],
            HTTP_IDEMPOTENCY_KEY=str(uuid4()),
        )
    assert response.status_code == 409, response.content
    assert Device.objects.count() == 4


def test_inventory_counts_retained_metadata_while_purge_counts_removed_payloads(relay):
    admit_peer(relay)
    package = KeyPackage.objects.get(device_id=relay[5][2])
    assert package.package is None and package.discarded_at is not None
    request = account_cutoff(relay, 2)
    assert request.inventory["e2ee"]["directory_packages"] == 1
    result = purge_account_core(request.id)
    assert result["counts"]["e2ee_directory_packages_discarded"] == 0
    assert KeyPackage.objects.get(pk=package.id).claimed_for_id == relay[6]


def test_foreign_cutoff_payload_removal_cannot_change_claim_or_restore_bytes(relay, writer):
    from test_e2ee_relay import operation

    admit_peer(relay, index=1)
    published = operation(relay, "publish_package", 2, {"keyPackage": b64(os.urandom(64))})
    operation(relay, "claim_package", 1, {"targetDeviceId": str(relay[5][2])})
    package = KeyPackage.objects.get(pk=published["keyPackageId"])
    payload = bytes(package.package)
    metadata = (
        package.claimed_at,
        package.claimed_by_id,
        package.claimed_for_id,
        package.claimed_epoch,
    )
    account_cutoff(relay, 1)
    with acting_as(writer), pytest.raises(IntegrityError) as changed:
        with transaction.atomic():
            KeyPackage.objects.filter(pk=package.id).update(
                package=None,
                discarded_at=timezone.now(),
                updated_at=timezone.now(),
                claimed_epoch=package.claimed_epoch + 1,
            )
    assert changed.value.__cause__.sqlstate == "23514"
    package.refresh_from_db()
    assert bytes(package.package) == payload
    with acting_as(writer), transaction.atomic():
        assert (
            KeyPackage.objects.filter(pk=package.id).update(
                package=None, discarded_at=timezone.now(), updated_at=timezone.now()
            )
            == 1
        )
    package.refresh_from_db()
    assert package.package is None and package.discarded_at is not None
    assert (
        package.claimed_at,
        package.claimed_by_id,
        package.claimed_for_id,
        package.claimed_epoch,
    ) == metadata
    with acting_as(writer), pytest.raises(IntegrityError) as restored:
        with transaction.atomic():
            KeyPackage.objects.filter(pk=package.id).update(package=payload)
    assert restored.value.__cause__.sqlstate == "23514"
    package.refresh_from_db()
    assert package.package is None
