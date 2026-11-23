"""Trusted monotonic MLS discovery and public cross-signing proofs against PostgreSQL."""

from uuid import UUID, uuid4

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from django.db import IntegrityError, transaction
from django.utils import timezone
from test_e2ee_relay import admit_peer, b64, operation, relay as relay, world as world

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
