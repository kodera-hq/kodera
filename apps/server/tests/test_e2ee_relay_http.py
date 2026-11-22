"""Signed JWT and device-proof admission, guarded replay and database role boundaries."""

import json
import os
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from customer_http_fixtures import configure, http_signer as http_signer, token, trust_entry
from django.db import IntegrityError, connection, transaction
from django.test import Client
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_e2ee_relay import admit_peer, b64, relay as relay
from test_intake_writer_role import acting_as, refused
from workspace_safety.test_moderation import world as world

from apps.e2ee import services
from apps.e2ee.models import Device, Envelope, KeyPackage
from apps.identity.models import Identity
from apps.orgs.models import Membership
from apps.workspaces.models import Channel
from config.workspace_features import confidential_relay_enabled
from core.db.api_writer_role import grant_statements
from core.idempotency.models import IdempotencyRecord

pytestmark = [
    pytest.mark.django_db(transaction=True),
    pytest.mark.usefixtures("adapter"),
]


@pytest.fixture
def adapter(settings):
    settings.ROOT_URLCONF = "apps.e2ee.api.urls"
    settings.KODERA_E2EE_RELAY_ENABLED = True


@pytest.fixture
def http(world, http_signer, frozen_clock, settings):
    org, _, _, tokens = world
    configure(settings, [trust_entry(http_signer, org.issuer)])
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"
    return Client(HTTP_HOST="127.0.0.1"), [
        token(http_signer, org.issuer, subject=item.subject, email_verified=True) for item in tokens
    ]


def path(relay, suffix):
    return f"/api/v1/organisations/{relay[0].id}/confidential/" + suffix


def post(relay, http, operation, suffix, body, index=0, *, key=None, room=False):
    signed = relay[7](index, operation, body, relay[6] if room else None)
    client, tokens = http
    headers = {
        "HTTP_AUTHORIZATION": "Bearer " + tokens[index],
        "HTTP_IDEMPOTENCY_KEY": key or str(uuid4()),
    }
    return client.post(
        path(relay, suffix), data=json.dumps(signed), content_type="application/json", **headers
    )


def send(relay, http, *, index=0, key=None, ciphertext=None, epoch=0):
    return post(
        relay,
        http,
        "send-application",
        f"rooms/{relay[6]}/envelopes",
        {
            "deviceId": str(relay[5][index]),
            "epoch": epoch,
            "ciphertext": b64(ciphertext or os.urandom(32)),
        },
        index=index,
        key=key,
        room=True,
    )


def test_real_http_ciphertext_only_effect_and_successful_replay(relay, http):
    key = str(uuid4())
    plain = b"synthetic-private-http-sentinel-65ba"
    cipher_key, nonce = AESGCM.generate_key(bit_length=256), os.urandom(12)
    ciphertext = nonce + AESGCM(cipher_key).encrypt(nonce, plain, b"opaque test transport")
    response = send(relay, http, key=key, ciphertext=ciphertext)
    assert response.status_code == 201, response.content
    replayed = send(relay, http, key=key, ciphertext=ciphertext)
    assert replayed.status_code == 201 and replayed["Idempotency-Replayed"] == "true"
    assert replayed.content == response.content and Envelope.objects.count() == 1
    assert response["Cache-Control"] == "no-store" and response["X-Request-Id"]
    received = http[0].get(
        path(relay, f"rooms/{relay[6]}/envelopes"),
        {"deviceId": str(relay[5][0])},
        HTTP_AUTHORIZATION="Bearer " + http[1][0],
    )
    assert received.status_code == 200, received.content
    assert received.json()["envelopes"][0]["ciphertext"] == b64(ciphertext)
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_jsonb(record)::text FROM idempotency_record record")
        serialized = "".join(row[0] for row in cursor.fetchall())
    assert plain.decode() not in serialized and plain.hex() not in serialized
    assert bytes(Envelope.objects.get().ciphertext) == ciphertext


@pytest.mark.parametrize("revocation", ["membership", "device", "account-cutoff"])
def test_successful_replay_is_refused_after_current_authority_is_lost(relay, http, revocation):
    admit_peer(relay)
    key, ciphertext = str(uuid4()), os.urandom(32)
    created = send(relay, http, index=2, epoch=1, key=key, ciphertext=ciphertext)
    assert created.status_code == 201, created.content
    if revocation == "membership":
        Membership.objects.filter(pk=relay[2][2].id).update(state="suspended")
    elif revocation == "device":
        Device.objects.filter(pk=relay[5][2]).update(revoked_at=timezone.now())
    else:
        from test_e2ee_relay_privacy import account_cutoff

        account_cutoff(relay, 2)
    replayed = send(relay, http, index=2, epoch=1, key=key, ciphertext=ciphertext)
    assert replayed.status_code in {403, 404}, replayed.content
    assert "Idempotency-Replayed" not in replayed
    assert Envelope.objects.filter(kind="application").count() == 1


def test_replay_after_later_epoch_does_not_repeat_old_effect(relay, http):
    key, ciphertext = str(uuid4()), os.urandom(32)
    created = send(relay, http, key=key, ciphertext=ciphertext)
    assert created.status_code == 201
    admit_peer(relay)
    replayed = send(relay, http, key=key, ciphertext=ciphertext)
    assert replayed.status_code == 201 and replayed.content == created.content
    fresh = send(relay, http, ciphertext=ciphertext)
    assert fresh.status_code == 409
    assert Envelope.objects.filter(kind="application").count() == 1


def test_terminal_ciphertext_validation_replays_problem_without_an_effect(relay, http):
    body = {"deviceId": str(relay[5][0]), "epoch": 0, "ciphertext": b64(bytes(2))}
    key = str(uuid4())
    suffix = f"rooms/{relay[6]}/envelopes"
    refused_response = post(relay, http, "send-application", suffix, body, key=key, room=True)
    assert refused_response.status_code == 422
    assert refused_response["Content-Type"] == "application/problem+json"
    replayed = post(relay, http, "send-application", suffix, body, key=key, room=True)
    assert replayed.status_code == 422 and replayed.content == refused_response.content
    assert replayed["Idempotency-Replayed"] == "true"
    assert not Envelope.objects.exists() and IdempotencyRecord.objects.get().status == 422


def test_refused_http_publication_records_a_sticky_rekey_barrier(relay, http):
    from apps.e2ee.models import Room

    admit_peer(relay)
    Membership.objects.filter(pk=relay[2][2].id).update(state="suspended")
    assert send(relay, http, epoch=1).status_code == 409
    assert Room.objects.get(pk=relay[6]).rekey_required
    Membership.objects.filter(pk=relay[2][2].id).update(state="active")
    assert send(relay, http, epoch=1).status_code == 409
    assert not Envelope.objects.filter(kind="application").exists()


def test_transient_503_rolls_back_a_real_effect_and_same_key_executes_again(
    relay, http, monkeypatch
):
    from apps.e2ee.models import Room

    original = services._audit
    attempts = []

    def fail_after_mutation(principal, action, target, request_id):
        if action == "application_relayed":
            attempts.append(target)
            if len(attempts) == 1:
                raise services.RefusalError(503)
        return original(principal, action, target, request_id)

    monkeypatch.setattr(services, "_audit", fail_after_mutation)
    key, ciphertext = str(uuid4()), os.urandom(32)
    unavailable = send(relay, http, key=key, ciphertext=ciphertext)
    assert unavailable.status_code == 503 and unavailable["Retry-After"] == "1"
    assert not Envelope.objects.exists() and not IdempotencyRecord.objects.exists()
    assert Room.objects.get(pk=relay[6]).head_sequence == 0
    retried = send(relay, http, key=key, ciphertext=ciphertext)
    assert retried.status_code == 201 and "Idempotency-Replayed" not in retried
    assert len(attempts) == 2 and Envelope.objects.count() == 1
    assert IdempotencyRecord.objects.get().status == 201


@pytest.mark.parametrize(
    "raw",
    [
        '{"deviceId":"a","deviceId":"b"}',
        '{"epoch":NaN}',
        '{"epoch":Infinity}',
        "[]",
        '{"deviceId":',
        '{"plaintext":"private"}',
    ],
)
def test_strict_json_refuses_ambiguous_or_plaintext_bodies(relay, http, raw):
    result = http[0].post(
        path(relay, f"rooms/{relay[6]}/envelopes"),
        data=raw,
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + http[1][0],
        HTTP_IDEMPOTENCY_KEY=str(uuid4()),
    )
    assert result.status_code in {400, 422}, result.content
    assert not Envelope.objects.exists() and not IdempotencyRecord.objects.exists()


def test_real_bearer_and_device_proof_are_both_required(relay, http):
    url = path(relay, f"rooms/{relay[6]}/envelopes")
    document = relay[7](
        0,
        "send-application",
        {"deviceId": str(relay[5][0]), "epoch": 0, "ciphertext": b64(os.urandom(32))},
        relay[6],
    )
    headers = {"HTTP_IDEMPOTENCY_KEY": str(uuid4())}
    missing = http[0].post(
        url, data=json.dumps(document), content_type="application/json", **headers
    )
    assert missing.status_code == 401 and missing["WWW-Authenticate"] == "Bearer"
    document["signature"] = b64(os.urandom(64))
    invalid = http[0].post(
        url,
        data=json.dumps(document),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + http[1][0],
        **headers,
    )
    assert invalid.status_code == 403
    document["signature"] = relay[7](
        0, "send-application", {k: v for k, v in document.items() if k != "signature"}, relay[6]
    )["signature"]
    foreign = http[0].post(
        url,
        data=json.dumps(document),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + http[1][2],
        **headers,
    )
    assert foreign.status_code == 404
    assert not IdempotencyRecord.objects.exists()


def test_operator_gate_defaults_off_and_is_strict(relay, http, settings):
    assert confidential_relay_enabled({}) is False
    assert confidential_relay_enabled({"KODERA_E2EE_RELAY_ENABLED": "true"}) is True
    from django.core.exceptions import ImproperlyConfigured

    for value in ("", "1", "TRUE", "yes"):
        with pytest.raises(ImproperlyConfigured):
            confidential_relay_enabled({"KODERA_E2EE_RELAY_ENABLED": value})
    settings.KODERA_E2EE_RELAY_ENABLED = False
    assert send(relay, http).status_code == 503
    assert not IdempotencyRecord.objects.exists()


def test_device_revocation_discards_directory_payload_and_blocks_future_reads(relay, http):
    key = Ed25519PrivateKey.generate()
    body = {"signingKey": b64(key.public_key().public_bytes_raw())}
    body["signature"] = b64(
        key.sign(
            services.signed_statement("register-device", relay[0].id, relay[2][0].id, None, body)
        )
    )
    registered = http[0].post(
        path(relay, "devices"),
        data=json.dumps(body),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + http[1][0],
        HTTP_IDEMPOTENCY_KEY=str(uuid4()),
    )
    assert registered.status_code == 201, registered.content
    services.publish_package(
        verified=relay[3][0],
        organisation_id=relay[0].id,
        body=relay[7](
            0,
            "publish-key-package",
            {"deviceId": str(relay[5][0]), "keyPackage": b64(os.urandom(32))},
        ),
        request_id=str(uuid4()),
    )
    # A second device remains active while permanently revoking the original key.
    document = {"deviceId": registered.json()["deviceId"], "targetDeviceId": str(relay[5][0])}
    document["signature"] = b64(
        key.sign(
            services.signed_statement("revoke-device", relay[0].id, relay[2][0].id, None, document)
        )
    )
    headers = {"HTTP_AUTHORIZATION": "Bearer " + http[1][0], "HTTP_IDEMPOTENCY_KEY": str(uuid4())}
    revoked = http[0].post(
        path(relay, "devices/revoke"),
        data=json.dumps(document),
        content_type="application/json",
        **headers,
    )
    assert revoked.status_code == 200, revoked.content
    package = KeyPackage.objects.get(device_id=relay[5][0])
    assert package.package is None and package.discarded_at is not None
    assert send(relay, http).status_code == 404
    replayed = http[0].post(
        path(relay, "devices/revoke"),
        data=json.dumps(document),
        content_type="application/json",
        **headers,
    )
    assert replayed.status_code == 200 and replayed["Idempotency-Replayed"] == "true"


def test_room_creation_uses_real_http_proof_and_keeps_one_room_on_replay(relay, http, writer):
    channel = Channel.objects.create(
        workspace=relay[1],
        kind="text",
        name="Separate confidential room",
        position=1,
        lifecycle="active",
        room_state="ready",
        is_confidential=True,
    )
    document = {
        "deviceId": str(relay[5][0]),
        "channelId": str(channel.id),
        "algorithm": "io.kodera.mls.v1",
    }
    key = str(uuid4())
    with acting_as(writer):
        created = post(relay, http, "create-room", "rooms", document, key=key)
        assert created.status_code == 201, created.content
        replayed = post(relay, http, "create-room", "rooms", document, key=key)
        assert replayed.status_code == 201 and replayed.content == created.content
        assert replayed["Idempotency-Replayed"] == "true"
        denied = post(
            relay,
            http,
            "create-room",
            "rooms",
            {
                **document,
                "deviceId": str(relay[5][2]),
            },
            index=2,
        )
        assert denied.status_code == 404
        ordinary = Channel.objects.create(
            workspace=relay[1],
            kind="text",
            name="Ordinary plaintext channel",
            position=2,
            lifecycle="active",
            room_state="ready",
            is_confidential=False,
        )
        refused_ordinary = post(
            relay,
            http,
            "create-room",
            "rooms",
            {
                "deviceId": str(relay[5][0]),
                "channelId": str(ordinary.id),
                "algorithm": "io.kodera.mls.v1",
            },
        )
        assert refused_ordinary.status_code == 409


def test_http_package_claim_commit_retirement_and_rekey_under_real_writer_role(relay, http, writer):
    owner, peer = str(relay[5][0]), str(relay[5][2])
    room = f"rooms/{relay[6]}/"
    package = b64(os.urandom(64))
    claim_key = str(uuid4())
    with acting_as(writer):
        published = post(
            relay,
            http,
            "publish-key-package",
            "key-packages",
            {
                "deviceId": peer,
                "keyPackage": package,
            },
            index=2,
        )
        assert published.status_code == 201, published.content
        claim_body = {"deviceId": owner, "targetDeviceId": peer, "epoch": 0}
        claimed = post(
            relay,
            http,
            "claim-key-package",
            room + "key-packages/claims",
            claim_body,
            key=claim_key,
            room=True,
        )
        assert claimed.status_code == 200 and claimed.json()["keyPackage"] == package
        commit_key = str(uuid4())
        commit_body = {
            "deviceId": owner,
            "epoch": 0,
            "deviceIds": [owner, peer],
            "ciphertext": b64(os.urandom(32)),
            "welcome": b64(os.urandom(32)),
        }
        committed = post(
            relay,
            http,
            "commit-epoch",
            room + "commits",
            commit_body,
            key=commit_key,
            room=True,
        )
        assert committed.status_code == 201 and committed.json()["epoch"] == 1
        result = committed.json()
        assert set(result) == {
            "epoch",
            "commitEnvelopeId",
            "commitSequence",
            "headSequence",
            "deviceIds",
        }
        marker = Envelope.objects.get(pk=result["commitEnvelopeId"])
        assert str(marker.room_id) == str(relay[6]) and str(marker.sender_id) == owner
        assert marker.kind == "commit" and marker.epoch == result["epoch"]
        assert marker.sequence == result["commitSequence"] < result["headSequence"]
        assert (
            Envelope.objects.get(room_id=relay[6], sequence=result["headSequence"]).kind
            == "welcome"
        )
        envelope_count = Envelope.objects.count()
        replayed_commit = post(
            relay,
            http,
            "commit-epoch",
            room + "commits",
            commit_body,
            key=commit_key,
            room=True,
        )
        assert replayed_commit.status_code == 201
        assert replayed_commit["Idempotency-Replayed"] == "true"
        assert replayed_commit.content == committed.content
        assert Envelope.objects.count() == envelope_count
        same_claim = post(
            relay,
            http,
            "claim-key-package",
            room + "key-packages/claims",
            claim_body,
            key=claim_key,
            room=True,
        )
        assert same_claim.status_code == 200 and same_claim.content == claimed.content
        assert same_claim["Idempotency-Replayed"] == "true"
        welcome = http[0].get(
            path(relay, room + "envelopes"),
            {"deviceId": peer},
            HTTP_AUTHORIZATION="Bearer " + http[1][2],
        )
        assert welcome.status_code == 200
        assert [item["kind"] for item in welcome.json()["envelopes"]] == ["welcome"]
        assert send(relay, http, index=2, epoch=1).status_code == 201
        retired = post(
            relay,
            http,
            "retire-room-device",
            room + "participants/retire",
            {
                "deviceId": owner,
                "targetDeviceId": peer,
            },
            room=True,
        )
        assert retired.status_code == 200 and retired.json()["rekeyRequired"]
        assert send(relay, http, index=2, epoch=1).status_code == 404
        assert send(relay, http, epoch=1).status_code == 409
        rotated = post(
            relay,
            http,
            "commit-epoch",
            room + "commits",
            {
                "deviceId": owner,
                "epoch": 1,
                "deviceIds": [owner],
                "ciphertext": b64(os.urandom(32)),
            },
            room=True,
        )
        assert rotated.status_code == 201 and rotated.json()["epoch"] == 2
        rotation = rotated.json()
        marker = Envelope.objects.get(pk=rotation["commitEnvelopeId"])
        assert marker.kind == "commit" and marker.epoch == rotation["epoch"]
        assert marker.sequence == rotation["commitSequence"] == rotation["headSequence"]
        assert send(relay, http, epoch=2).status_code == 201
        republished = post(
            relay,
            http,
            "publish-key-package",
            "key-packages",
            {
                "deviceId": peer,
                "keyPackage": b64(os.urandom(64)),
            },
            index=2,
        )
        assert republished.status_code == 201
        reclaimed = post(
            relay,
            http,
            "claim-key-package",
            room + "key-packages/claims",
            {**claim_body, "epoch": 2},
            room=True,
        )
        assert reclaimed.status_code == 200 and reclaimed.json()["epoch"] == 2
        rejoined = post(
            relay,
            http,
            "commit-epoch",
            room + "commits",
            {
                "deviceId": owner,
                "epoch": 2,
                "deviceIds": [owner, peer],
                "ciphertext": b64(os.urandom(32)),
                "welcome": b64(os.urandom(32)),
            },
            room=True,
        )
        assert rejoined.status_code == 201 and rejoined.json()["epoch"] == 3
        resumed = http[0].get(
            path(relay, room + "envelopes"),
            {"deviceId": peer},
            HTTP_AUTHORIZATION="Bearer " + http[1][2],
        )
        assert resumed.status_code == 200
        assert [item["kind"] for item in resumed.json()["envelopes"]] == ["welcome"]
        assert resumed.json()["envelopes"][0]["epoch"] == 3


@pytest.fixture
def writer():
    role = "confidential_writer_" + uuid4().hex[:12]
    with connection.cursor() as cursor:
        cursor.execute(f'CREATE ROLE "{role}" NOLOGIN NOINHERIT')
        for statement in grant_statements(role):
            cursor.execute(statement)
    try:
        yield role
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")
            cursor.execute(f'DROP OWNED BY "{role}"')
            cursor.execute(f'DROP ROLE "{role}"')


def test_real_api_writer_grants_allow_ciphertext_and_refuse_mutable_bindings(relay, http, writer):
    with acting_as(writer):
        response = send(relay, http)
        assert response.status_code == 201, response.content
        admit_peer(relay)
        assert send(relay, http, epoch=1).status_code == 201
    for sql in (
        "DELETE FROM e2ee_envelope",
        "UPDATE e2ee_envelope SET epoch=epoch+1",
        "UPDATE e2ee_device SET signing_key=signing_key",
        "UPDATE e2ee_room SET algorithm=algorithm",
        "UPDATE e2ee_keypackage SET reference=reference",
        "UPDATE e2ee_participant SET room_id=room_id",
        "SELECT e2ee_purge_organisation(NULL)",
    ):
        with acting_as(writer), transaction.atomic():
            assert refused(sql) == "42501"


@pytest.mark.parametrize("identity_scope", ["foreign-customer", "staff"])
def test_same_person_identity_from_another_lane_cannot_bind_an_own_tenant_device(
    relay, writer, identity_scope, settings
):
    from test_e2ee_relay_privacy import foreign_device

    member = relay[2][0]
    if identity_scope == "foreign-customer":
        foreign = foreign_device().organisation
        identity = Identity.objects.create(
            user=member.user,
            organisation=foreign,
            issuer=foreign.issuer,
            realm=foreign.realm,
            subject=str(uuid4()),
            email=member.user.email,
        )
    else:
        identity = Identity.objects.create(
            user=member.user,
            organisation=None,
            issuer=settings.KODERA_STAFF_ISSUER,
            realm="kodera-staff",
            subject=str(uuid4()),
            email=member.user.email,
        )
    assert identity.user_id == member.user_id
    candidate = Device(
        organisation=relay[0],
        membership=member,
        identity=identity,
        signing_key=os.urandom(32),
    )
    assert not services._active_device(candidate, relay[1].id)
    with (
        acting_as(writer),
        pytest.raises(IntegrityError, match="device authority scope"),
        transaction.atomic(),
    ):
        candidate.save(force_insert=True)


def test_pre_existing_relay_room_on_ordinary_channel_is_refused_across_send_commit_read_claim_and_replay(
    relay, http, monkeypatch
):
    from apps.e2ee.models import Participant, Room

    owner, peer = str(relay[5][0]), str(relay[5][2])
    ordinary = Channel.objects.create(
        workspace=relay[1],
        kind="text",
        name="Pre-upgrade ordinary channel",
        position=10,
        lifecycle="active",
        room_state="ready",
        is_confidential=False,
    )
    legacy_room = Room.objects.create(
        organisation=relay[0], channel=ordinary, algorithm="io.kodera.mls.v1"
    )
    Participant.objects.create(
        organisation=relay[0], room=legacy_room, device_id=relay[5][0], joined_epoch=0
    )
    published = post(
        relay,
        http,
        "publish-key-package",
        "key-packages",
        {"deviceId": peer, "keyPackage": b64(os.urandom(64))},
        index=2,
    )
    assert published.status_code == 201, published.content

    replay_key = str(uuid4())
    send_body = {"deviceId": owner, "epoch": 0, "ciphertext": b64(os.urandom(32))}
    client, tokens = http

    def post_legacy(operation, suffix, body, *, key=None):
        signed = relay[7](0, operation, body, legacy_room.id)
        return client.post(
            path(relay, f"rooms/{legacy_room.id}/{suffix}"),
            data=json.dumps(signed),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer " + tokens[0],
            HTTP_IDEMPOTENCY_KEY=key or str(uuid4()),
        )

    real_check = services.is_designated_confidential_channel
    monkeypatch.setattr(services, "is_designated_confidential_channel", lambda **_: True)
    seeded = post_legacy("send-application", "envelopes", send_body, key=replay_key)
    assert seeded.status_code == 201, seeded.content
    monkeypatch.setattr(services, "is_designated_confidential_channel", real_check)

    replayed = post_legacy("send-application", "envelopes", send_body, key=replay_key)
    assert replayed.status_code == 409
    assert "Idempotency-Replayed" not in replayed

    fresh_send = post_legacy("send-application", "envelopes", send_body)
    assert fresh_send.status_code == 409

    claimed = post_legacy(
        "claim-key-package",
        "key-packages/claims",
        {"deviceId": owner, "targetDeviceId": peer, "epoch": 0},
    )
    assert claimed.status_code == 409

    committed = post_legacy(
        "commit-epoch",
        "commits",
        {"deviceId": owner, "epoch": 0, "deviceIds": [owner], "ciphertext": b64(os.urandom(32))},
    )
    assert committed.status_code == 409

    listed = client.get(
        path(relay, f"rooms/{legacy_room.id}/envelopes?deviceId={owner}"),
        HTTP_AUTHORIZATION="Bearer " + tokens[0],
    )
    assert listed.status_code == 409

    retired = post_legacy(
        "retire-room-device",
        "participants/retire",
        {"deviceId": owner, "targetDeviceId": owner, "epoch": 0},
    )
    assert retired.status_code == 200, retired.content
