"""Opaque transport authority and epoch lifecycle against disposable PostgreSQL."""

import base64
import json
import os
from dataclasses import replace
from uuid import UUID, uuid4

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from django.db import connection, transaction
from django.utils import timezone
from workspace_safety.test_moderation import world as world

from apps.audit.models import AuditEvent
from apps.e2ee import services
from apps.e2ee.models import Device, Envelope, KeyPackage, Participant, Room
from apps.identity.models import Identity
from apps.orgs.models import Membership
from apps.workspaces.models import Channel, ResourcePolicy, Workspace, WorkspaceMemberRestriction

pytestmark = pytest.mark.django_db(transaction=True)


def b64(value):
    return base64.b64encode(value).decode()


@pytest.fixture
def relay(world):
    org, workspace, members, tokens = world
    policy = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    Workspace.objects.filter(pk=workspace.id).update(default_policy=policy)
    channel = Channel.objects.create(
        workspace=workspace,
        kind="text",
        name="Example",
        position=0,
        lifecycle="active",
        room_state="ready",
    )
    keys = [Ed25519PrivateKey.generate() for _ in members]

    def signed(index, operation, body, room=None):
        document = dict(body)
        document["signature"] = b64(
            keys[index].sign(
                services.signed_statement(operation, org.id, members[index].id, room, document)
            )
        )
        return document

    devices = []
    for index, key in enumerate(keys):
        result = services.register_device(
            verified=tokens[index],
            organisation_id=org.id,
            body=signed(
                index, "register-device", {"signingKey": b64(key.public_key().public_bytes_raw())}
            ),
            request_id=str(uuid4()),
        )
        devices.append(UUID(result["deviceId"]))
    created = services.create_room(
        verified=tokens[0],
        organisation_id=org.id,
        body=signed(
            0,
            "create-room",
            {
                "deviceId": str(devices[0]),
                "channelId": str(channel.id),
                "algorithm": "io.kodera.mls.v1",
            },
        ),
        request_id=str(uuid4()),
    )
    room = UUID(created["roomId"])
    return org, workspace, members, tokens, keys, devices, room, signed


def operation(relay, name, index, body):
    org, _, _, tokens, _, devices, room, signed = relay
    names = {
        "publish_package": "publish-key-package",
        "claim_package": "claim-key-package",
        "commit_epoch": "commit-epoch",
        "send_application": "send-application",
        "retire_device": "retire-room-device",
    }
    needs_room = name != "publish_package"
    value = signed(
        index, names[name], {"deviceId": str(devices[index]), **body}, room if needs_room else None
    )
    return getattr(services, name)(
        verified=tokens[index],
        organisation_id=org.id,
        body=value,
        request_id=str(uuid4()),
        **({"room_id": room} if needs_room else {}),
    )


def admit_peer(relay, index=2, epoch=0, roster=None):
    devices = relay[5]
    operation(
        relay,
        "publish_package",
        index,
        {"keyPackage": b64(b"opaque client key package " + os.urandom(16))},
    )
    claimed = operation(relay, "claim_package", 0, {"targetDeviceId": str(devices[index])})
    result = operation(
        relay,
        "commit_epoch",
        0,
        {
            "epoch": epoch,
            "deviceIds": roster or [str(devices[0]), str(devices[index])],
            "ciphertext": b64(os.urandom(32)),
            "welcome": b64(os.urandom(32)),
        },
    )
    return claimed, result


def read(relay, index=0, after=0):
    return services.read_envelopes(
        verified=relay[3][index],
        organisation_id=relay[0].id,
        room_id=relay[6],
        device_id=str(relay[5][index]),
        after=after,
    )


def test_signed_statement_has_a_fixed_cross_client_serialization_vector():
    org = UUID("01950000-0000-7000-8000-0000000000a1")
    member = UUID("01950000-0000-7000-8000-0000000000a2")
    room = UUID("01950000-0000-7000-8000-0000000000a3")
    device = "01950000-0000-7000-8000-0000000000a4"
    actual = services.signed_statement(
        "send-application",
        org,
        member,
        room,
        {
            "signature": b64(bytes(64)),
            "epoch": 7,
            "deviceId": device,
            "ciphertext": "/////////////////////w==",
        },
    )
    expected = (
        b'kodera-e2ee-relay-v1\0["send-application",'
        b'"01950000-0000-7000-8000-0000000000a1",'
        b'"01950000-0000-7000-8000-0000000000a2",'
        b'"01950000-0000-7000-8000-0000000000a3",'
        b'{"ciphertext":"/////////////////////w==",'
        b'"deviceId":"01950000-0000-7000-8000-0000000000a4","epoch":7}]'
    )
    assert actual == expected


def test_single_use_package_claim_admission_and_recipient_welcome_isolation(relay):
    claimed, committed = admit_peer(relay)
    assert claimed["epoch"] == 0 and committed["epoch"] == 1
    assert KeyPackage.objects.get(pk=claimed["keyPackageId"]).claimed_at is not None
    with pytest.raises(services.RefusalError) as failure:
        operation(relay, "claim_package", 0, {"targetDeviceId": str(relay[5][2])})
    assert failure.value.status == 404
    assert [row["kind"] for row in read(relay, 2)["envelopes"]] == ["welcome"]
    assert [row["kind"] for row in read(relay, 0)["envelopes"]] == ["commit"]
    with pytest.raises(services.RefusalError):
        read(relay, 3)


def test_actual_encrypted_sentinel_persists_and_relays_without_plaintext_or_search_fields(relay):
    admit_peer(relay)
    plaintext = b"private-sentinel-never-persisted-93f7bd"
    key, nonce = AESGCM.generate_key(bit_length=256), os.urandom(12)
    ciphertext = nonce + AESGCM(key).encrypt(nonce, plaintext, b"test-only opaque payload")
    result = operation(relay, "send_application", 2, {"epoch": 1, "ciphertext": b64(ciphertext)})
    stored = Envelope.objects.get(pk=result["envelopeId"])
    assert bytes(stored.ciphertext) == ciphertext
    received = [row for row in read(relay, 0)["envelopes"] if row["kind"] == "application"][0]
    assert base64.b64decode(received["ciphertext"]) == ciphertext
    assert (
        AESGCM(key).decrypt(ciphertext[:12], ciphertext[12:], b"test-only opaque payload")
        == plaintext
    )
    assert not {"body", "plaintext", "formatted_body", "search_vector"}.intersection(
        field.name for field in Envelope._meta.fields
    )
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_jsonb(envelope)::text FROM e2ee_envelope envelope")
        serialized = "".join(row[0] for row in cursor.fetchall())
        cursor.execute("SELECT indexdef FROM pg_indexes WHERE tablename='e2ee_envelope'")
        indexes = "".join(row[0] for row in cursor.fetchall())
    assert plaintext.decode() not in serialized and plaintext.hex() not in serialized
    assert "gin" not in indexes.lower() and "tsvector" not in indexes.lower()
    assert all(
        event.metadata == {}
        for event in AuditEvent.objects.filter(action__startswith="workspace.e2ee.")
    )


@pytest.mark.parametrize(
    "extra", [{"body": "private"}, {"formatted_body": "private"}, {"plaintext": "private"}]
)
def test_plaintext_or_unknown_fields_are_refused_before_storage(relay, extra):
    before = Envelope.objects.count()
    with pytest.raises(services.RefusalError) as failure:
        operation(
            relay, "send_application", 0, {"epoch": 0, "ciphertext": b64(os.urandom(32)), **extra}
        )
    assert failure.value.status == 422 and Envelope.objects.count() == before


@pytest.mark.parametrize("change", ["identity", "membership", "device", "ban"])
def test_core_revocation_blocks_delivery_and_freezes_remaining_senders_until_rekey(relay, change):
    admit_peer(relay)
    member = relay[2][2]
    if change == "identity":
        Identity.objects.filter(user_id=member.user_id).update(enabled=False)
    elif change == "membership":
        Membership.objects.filter(pk=member.id).update(state="suspended")
    elif change == "device":
        Device.objects.filter(pk=relay[5][2]).update(revoked_at=timezone.now())
    else:
        WorkspaceMemberRestriction.objects.create(
            workspace=relay[1], membership=member, banned=True
        )
    with pytest.raises(services.RefusalError):
        read(relay, 2)
    assert read(relay)["rekeyRequired"]
    with pytest.raises(services.RefusalError) as failure:
        operation(relay, "send_application", 0, {"epoch": 1, "ciphertext": b64(os.urandom(32))})
    assert failure.value.status == 409
    result = operation(
        relay,
        "commit_epoch",
        0,
        {"epoch": 1, "deviceIds": [str(relay[5][0])], "ciphertext": b64(os.urandom(32))},
    )
    assert result["epoch"] == 2 and not read(relay)["rekeyRequired"]
    assert (
        operation(relay, "send_application", 0, {"epoch": 2, "ciphertext": b64(os.urandom(32))})[
            "epoch"
        ]
        == 2
    )


def test_retirement_blocks_current_epoch_publication_and_replay_then_commits_once(relay):
    admit_peer(relay)
    operation(relay, "retire_device", 0, {"targetDeviceId": str(relay[5][2])})
    with pytest.raises(services.RefusalError):
        read(relay, 2)
    with pytest.raises(services.RefusalError):
        operation(relay, "send_application", 0, {"epoch": 1, "ciphertext": b64(os.urandom(32))})
    body = {"epoch": 1, "deviceIds": [str(relay[5][0])], "ciphertext": b64(os.urandom(32))}
    assert operation(relay, "commit_epoch", 0, body)["epoch"] == 2
    with pytest.raises(services.RefusalError) as failure:
        operation(relay, "commit_epoch", 0, body)
    assert failure.value.status == 409


@pytest.mark.parametrize("change", ["identity", "membership", "ban"])
def test_observed_rekey_barrier_survives_temporary_authority_reactivation(relay, change):
    admit_peer(relay)
    member = relay[2][2]
    if change == "identity":
        Identity.objects.filter(user_id=member.user_id).update(enabled=False)
    elif change == "membership":
        Membership.objects.filter(pk=member.id).update(state="suspended")
    else:
        WorkspaceMemberRestriction.objects.create(
            workspace=relay[1], membership=member, banned=True
        )
    assert read(relay)["rekeyRequired"]
    assert Room.objects.get(pk=relay[6]).rekey_required
    if change == "identity":
        Identity.objects.filter(user_id=member.user_id).update(enabled=True)
    elif change == "membership":
        Membership.objects.filter(pk=member.id).update(state="active")
    else:
        WorkspaceMemberRestriction.objects.filter(workspace=relay[1], membership=member).update(
            banned=False
        )
    with pytest.raises(services.RefusalError) as failure:
        operation(relay, "send_application", 0, {"epoch": 1, "ciphertext": b64(os.urandom(32))})
    assert failure.value.status == 409
    operation(
        relay,
        "commit_epoch",
        0,
        {
            "epoch": 1,
            "deviceIds": [str(relay[5][0]), str(relay[5][2])],
            "ciphertext": b64(os.urandom(32)),
        },
    )
    assert not read(relay)["rekeyRequired"]
    assert (
        operation(relay, "send_application", 0, {"epoch": 2, "ciphertext": b64(os.urandom(32))})[
            "epoch"
        ]
        == 2
    )


@pytest.mark.parametrize("value", [-1, True, 1, 2**63])
def test_application_requires_the_exact_bounded_epoch_without_side_effect(relay, value):
    with pytest.raises(services.RefusalError):
        operation(relay, "send_application", 0, {"epoch": value, "ciphertext": b64(os.urandom(32))})
    assert not Envelope.objects.exists() and Room.objects.get(pk=relay[6]).head_sequence == 0


def test_device_proof_cannot_be_rebound_to_another_member_or_room(relay):
    org, _, members, tokens, keys, devices, room, signed = relay
    body = signed(
        0,
        "send-application",
        {"deviceId": str(devices[0]), "epoch": 0, "ciphertext": b64(os.urandom(32))},
        room,
    )
    with pytest.raises(services.RefusalError):
        services.send_application(
            verified=tokens[2],
            organisation_id=org.id,
            room_id=room,
            body=body,
            request_id=str(uuid4()),
        )
    body["deviceId"] = str(devices[2])
    with pytest.raises(services.RefusalError) as failure:
        services.send_application(
            verified=tokens[2],
            organisation_id=org.id,
            room_id=room,
            body=body,
            request_id=str(uuid4()),
        )
    assert failure.value.status == 403 and not Envelope.objects.exists()


def test_unknown_identity_and_cross_organisation_cannot_read_or_register(relay):
    token = replace(relay[3][0], subject="unknown-subject")
    with pytest.raises(services.RefusalError):
        services.read_envelopes(
            verified=token,
            organisation_id=relay[0].id,
            room_id=relay[6],
            device_id=str(relay[5][0]),
        )
    with pytest.raises(services.RefusalError):
        services.read_envelopes(
            verified=relay[3][0],
            organisation_id=uuid4(),
            room_id=relay[6],
            device_id=str(relay[5][0]),
        )


def test_new_admission_requires_a_room_bound_claim_and_admin_authority(relay):
    with pytest.raises(services.RefusalError) as failure:
        operation(
            relay,
            "commit_epoch",
            0,
            {
                "epoch": 0,
                "deviceIds": [str(relay[5][0]), str(relay[5][2])],
                "ciphertext": b64(os.urandom(32)),
                "welcome": b64(os.urandom(32)),
            },
        )
    assert failure.value.status == 409 and Participant.objects.count() == 1
    admit_peer(relay)
    with pytest.raises(services.RefusalError) as failure:
        operation(
            relay,
            "commit_epoch",
            2,
            {"epoch": 1, "deviceIds": [str(relay[5][2])], "ciphertext": b64(os.urandom(32))},
        )
    assert failure.value.status == 403


def test_ciphertext_pages_bound_bytes_and_preserve_sequence_continuation(relay):
    with transaction.atomic():
        for sequence in range(1, 21):
            Envelope.objects.create(
                organisation_id=relay[0].id,
                room_id=relay[6],
                sender_id=relay[5][0],
                sequence=sequence,
                epoch=0,
                kind="application",
                ciphertext=os.urandom(65536),
                signature=os.urandom(64),
            )
        Room.objects.filter(pk=relay[6]).update(head_sequence=20)
    received = []
    after = 0
    while True:
        page = read(relay, after=after)
        assert len(json.dumps(page).encode()) < 1024**2
        received.extend(row["sequence"] for row in page["envelopes"])
        after = page["nextAfter"]
        if not page["hasMore"]:
            break
    assert received == list(range(1, 21))
