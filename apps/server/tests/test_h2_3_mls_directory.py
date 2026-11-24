"""Trusted monotonic MLS discovery and public cross-signing proofs against PostgreSQL."""

from uuid import UUID, uuid4

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from django.db import IntegrityError, transaction
from django.utils import timezone
from test_e2ee_relay import admit_peer, b64, operation, relay as relay, world as world
from test_h2_3_governance import governed as governed

from apps.confidential import services
from apps.confidential.models import MlsRoomEpoch
from apps.e2ee.models import Device

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.KODERA_E2EE_RELAY_ENABLED = True


def discover(relay, index=0):
    return services.discover(
        verified=relay[3][index],
        organisation_id=relay[0].id,
        room_id=relay[6],
        device_id=str(relay[5][index]),
    )


def bundle(relay, revision=1):
    master, self_signing = Ed25519PrivateKey.generate(), Ed25519PrivateKey.generate()
    body = {
        "deviceId": str(relay[5][0]),
        "revision": revision,
        "masterKey": b64(master.public_key().public_bytes_raw()),
        "selfSigningKey": b64(self_signing.public_key().public_bytes_raw()),
    }
    signing_key = b64(relay[4][0].public_key().public_bytes_raw())
    for key, field, purpose in [
        (master, "crossSigningSignature", "self-signing-key"),
        (self_signing, "deviceSignature", "device-verification"),
    ]:
        statement = services.verification_statement(
            organisation_id=relay[0].id,
            membership_id=str(relay[2][0].id),
            body=body,
            purpose=purpose,
            signing_key=signing_key,
        )
        body[field] = b64(key.sign(statement))
    return relay[7](0, "publish-verification-bundle", body)


def publish(relay, body):
    return services.publish_bundle(
        verified=relay[3][0], organisation_id=relay[0].id, body=body, request_id=str(uuid4())
    )


def test_discovery_tracks_accepted_commit_and_rejects_stale_claim(relay):
    assert discover(relay)["epoch"] == 0
    _, commit = admit_peer(relay)
    result = discover(relay)
    assert result["epoch"] == 1
    assert result["commitSequence"] == commit["commitSequence"]
    assert MlsRoomEpoch.objects.filter(room_id=relay[6]).count() == 2
    with pytest.raises(services.RefusalError) as failure:
        operation(relay, "claim_package", 0, {"targetDeviceId": str(relay[5][1]), "epoch": 0})
    assert failure.value.status == 409
    with pytest.raises(IntegrityError), transaction.atomic():
        MlsRoomEpoch.objects.create(
            room_id=relay[6], epoch=3, commit_sequence=0, commit_digest="0" * 64
        )


def test_bundle_requires_three_proofs_and_consecutive_revision(relay):
    body = bundle(relay)
    assert publish(relay, body)["revision"] == 1
    assert discover(relay)["verificationBundles"][0]["deviceId"] == str(relay[5][0])
    with pytest.raises(services.RefusalError) as failure:
        publish(relay, body)
    assert failure.value.status == 409
    bad = bundle(relay, revision=2)
    bad["crossSigningSignature"] = b64(b"\0" * 64)
    bad = relay[7](
        0,
        "publish-verification-bundle",
        {key: value for key, value in bad.items() if key != "signature"},
    )
    with pytest.raises(services.RefusalError):
        publish(relay, bad)
    assert publish(relay, bundle(relay, revision=2))["revision"] == 2


def test_unadmitted_or_revoked_device_cannot_discover_or_publish(relay):
    with pytest.raises(services.RefusalError):
        discover(relay, index=1)
    body = bundle(relay)
    Device.objects.filter(id=relay[5][0]).update(revoked_at=timezone.now())
    with pytest.raises(services.RefusalError):
        discover(relay)
    with pytest.raises(services.RefusalError):
        publish(relay, body)


def test_epoch_evidence_is_append_only(relay):
    with pytest.raises(IntegrityError), transaction.atomic():
        MlsRoomEpoch.objects.filter(room_id=relay[6]).update(commit_digest="0" * 64)


def test_organisation_erasure_removes_directory_before_relay_parents(relay):
    from test_core_erasure import operator

    from apps.confidential.models import DeviceVerificationBundle
    from apps.orgs.erasure_services import begin_erasure, database_now, purge_core

    publish(relay, bundle(relay))
    request = begin_erasure(
        organisation_id=relay[0].id,
        instruction_ref="DEL-324",
        instruction_sha256="8" * 64,
        purge_not_before=database_now(),
        actor_identity_id=operator().id,
    )
    with pytest.raises(services.RefusalError):
        discover(relay)
    purge_core(request.id)
    assert not MlsRoomEpoch.objects.exists()
    assert not DeviceVerificationBundle.objects.exists()


def test_channel_uuid_discovers_the_canonical_room_and_epoch(relay):
    first = discover(relay)
    answer = services.discover(
        verified=relay[3][0],
        organisation_id=relay[0].id,
        room_id=UUID(first["channelId"]),
        device_id=str(relay[5][0]),
    )
    assert answer["roomId"] == str(relay[6])
    assert answer["epoch"] == first["epoch"]


def test_stale_commit_cannot_append_epoch_or_envelope(relay):
    from apps.e2ee.models import Envelope, Room

    admit_peer(relay)
    before = Envelope.objects.count(), MlsRoomEpoch.objects.count()
    with pytest.raises(services.RefusalError) as failure:
        operation(
            relay,
            "commit_epoch",
            0,
            {
                "epoch": 0,
                "deviceIds": [str(relay[5][0])],
                "ciphertext": b64(b"s" * 32),
            },
        )
    assert failure.value.status == 409
    assert (Envelope.objects.count(), MlsRoomEpoch.objects.count()) == before
    assert Room.objects.get(id=relay[6]).epoch == discover(relay)["epoch"] == 1


def test_join_and_rejoin_read_fence_hides_prior_epochs(relay):
    from test_e2ee_relay import read

    old = operation(relay, "send_application", 0, {"epoch": 0, "ciphertext": b64(b"a" * 32)})
    admit_peer(relay)
    first = read(relay, 2)["envelopes"]
    assert [row["kind"] for row in first] == ["welcome"]
    assert old["envelopeId"] not in {row["id"] for row in first}
    visible = operation(relay, "send_application", 0, {"epoch": 1, "ciphertext": b64(b"b" * 32)})
    assert visible["envelopeId"] in {row["id"] for row in read(relay, 2)["envelopes"]}
    operation(
        relay,
        "commit_epoch",
        0,
        {
            "epoch": 1,
            "deviceIds": [str(relay[5][0])],
            "ciphertext": b64(b"c" * 32),
        },
    )
    with pytest.raises(services.RefusalError):
        read(relay, 2)
    operation(relay, "send_application", 0, {"epoch": 2, "ciphertext": b64(b"d" * 32)})
    admit_peer(relay, epoch=2)
    rejoined = read(relay, 2)["envelopes"]
    assert [row["kind"] for row in rejoined] == ["welcome"]
    assert all(row["epoch"] >= 3 for row in rejoined)


def test_cross_organisation_package_and_commit_replay_are_refused(relay, governed):
    from dataclasses import replace

    from apps.e2ee import services as relay_services
    from apps.e2ee.models import Envelope, KeyPackage, Room
    from apps.identity.models import Identity
    from apps.orgs.models import Membership
    from services.identity.access_tokens import VerifiedAccessToken

    # Both tenants are real and active; an authenticated foreign owner still cannot replay.
    foreign = governed[1]
    member = Membership.objects.get(organisation=foreign, role="org_owner")
    identity = Identity.objects.get(organisation=foreign, user=member.user)
    credential = replace(relay[3][0], issuer=foreign.issuer, subject=identity.subject)
    assert isinstance(credential, VerifiedAccessToken)
    foreign_org = foreign.id
    foreign_key = Ed25519PrivateKey.generate()
    device_body = {"signingKey": b64(foreign_key.public_key().public_bytes_raw())}
    device_body["signature"] = b64(
        foreign_key.sign(
            relay_services.signed_statement(
                "register-device",
                foreign.id,
                member.id,
                None,
                device_body,
            )
        )
    )
    foreign_device = relay_services.register_device(
        verified=credential,
        organisation_id=foreign.id,
        body=device_body,
        request_id=str(uuid4()),
    )["deviceId"]
    package = relay[7](
        0,
        "publish-key-package",
        {
            "deviceId": str(relay[5][0]),
            "keyPackage": b64(b"k" * 32),
        },
    )
    commit = relay[7](
        0,
        "commit-epoch",
        {
            "deviceId": str(relay[5][0]),
            "epoch": 0,
            "deviceIds": [str(relay[5][0])],
            "ciphertext": b64(b"c" * 32),
        },
        relay[6],
    )
    before = KeyPackage.objects.count(), Envelope.objects.count(), MlsRoomEpoch.objects.count()
    for name, body, extra in [
        ("publish_package", package, {}),
        ("commit_epoch", commit, {"room_id": relay[6]}),
    ]:
        with pytest.raises(services.RefusalError) as failure:
            getattr(relay_services, name)(
                verified=credential,
                organisation_id=foreign_org,
                body=body,
                request_id=str(uuid4()),
                **extra,
            )
        assert failure.value.status in {403, 404}
    assert (
        KeyPackage.objects.count(),
        Envelope.objects.count(),
        MlsRoomEpoch.objects.count(),
    ) == before
    # Changing the device ID cannot transplant the source tenant's signed package proof.
    with pytest.raises(services.RefusalError) as failure:
        relay_services.publish_package(
            verified=credential,
            organisation_id=foreign.id,
            body={**package, "deviceId": foreign_device},
            request_id=str(uuid4()),
        )
    assert failure.value.status == 403
    # A current local signer also cannot claim a foreign device's key package or admit it.
    for name, body in [
        ("claim_package", {"targetDeviceId": foreign_device}),
        (
            "commit_epoch",
            {
                "epoch": 0,
                "deviceIds": [str(relay[5][0]), foreign_device],
                "ciphertext": b64(b"c" * 32),
                "welcome": b64(b"w" * 32),
            },
        ),
    ]:
        with pytest.raises(services.RefusalError) as failure:
            operation(relay, name, 0, body)
        assert failure.value.status == 404
    assert Room.objects.get(id=relay[6]).epoch == 0
    assert (
        KeyPackage.objects.count(),
        Envelope.objects.count(),
        MlsRoomEpoch.objects.count(),
    ) == before


def test_concurrent_commits_serialize_to_one_accepted_epoch(relay):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from django.db import connections

    from apps.e2ee.models import Envelope, Room

    barrier = Barrier(2)

    def commit():
        try:
            barrier.wait(timeout=10)
            return operation(
                relay,
                "commit_epoch",
                0,
                {
                    "epoch": 0,
                    "deviceIds": [str(relay[5][0])],
                    "ciphertext": b64(b"x" * 32),
                },
            )["epoch"]
        except services.RefusalError as failure:
            return failure.status
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: commit(), range(2)))
    assert sorted(results) == [1, 409]
    assert Room.objects.get(id=relay[6]).epoch == 1
    assert Envelope.objects.filter(room_id=relay[6], kind="commit").count() == 1
    assert list(
        MlsRoomEpoch.objects.filter(room_id=relay[6])
        .order_by("epoch")
        .values_list("epoch", flat=True)
    ) == [0, 1]
