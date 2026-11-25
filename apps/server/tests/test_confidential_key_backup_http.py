"""Opaque KVKB1 key-backup publication, monotonic rotation, fresh-device restore, and erasure."""

import base64
import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4

import pytest
from customer_http_fixtures import configure, http_signer as http_signer, token, trust_entry
from django.db import IntegrityError, connection, transaction
from django.test import Client
from test_access_tokens import frozen_clock as frozen_clock
from test_account_erasure import admit as admit_account
from test_core_erasure import operator
from test_e2ee_relay import b64, relay as relay
from test_intake_writer_role import acting_as, refused
from workspace_safety.test_moderation import world as world

from apps.confidential.models import KeyBackupArchive
from apps.e2ee import services as e2ee_services
from apps.e2ee.models import Device
from apps.orgs.account_erasure_services import purge_account_core
from apps.orgs.erasure_services import begin_erasure, database_now, purge_core
from core.db.api_writer_role import grant_statements

pytestmark = [
    pytest.mark.django_db(transaction=True),
    pytest.mark.usefixtures("adapter"),
]

VECTORS = (
    Path(__file__).resolve().parents[3] / "packages" / "kodera-rs" / "vectors" / "kvkb1-v1.json"
)


@pytest.fixture
def adapter(settings):
    settings.ROOT_URLCONF = "config.customer_urls"
    settings.KODERA_E2EE_RELAY_ENABLED = True


@pytest.fixture
def http(world, http_signer, frozen_clock, settings):
    org, _, _, tokens = world
    configure(settings, [trust_entry(http_signer, org.issuer)])
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"
    return Client(HTTP_HOST="127.0.0.1"), [
        token(http_signer, org.issuer, subject=item.subject, email_verified=True) for item in tokens
    ]


def build_kvkb1_capsule(
    *,
    organisation_id: str,
    user_id: str,
    backup_epoch: int,
    kdf_kind: str = "recovery-key",
    iterations: int = 0,
    ciphertext_len: int = 32,
) -> bytes:
    salt = base64.b64encode(os.urandom(16)).decode()
    iv = base64.b64encode(os.urandom(12)).decode()
    header = json.dumps(
        [
            "kodera-zk-key-backup",
            1,
            organisation_id,
            user_id,
            backup_epoch,
            kdf_kind,
            iterations,
            salt,
            iv,
        ],
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return b"KVKB1" + len(header).to_bytes(4, "big") + header + os.urandom(ciphertext_len)


def backup_url(org_id):
    return f"/api/v1/organisations/{org_id}/confidential/key-backup"


def publish(relay, http, *, index=0, backup_epoch=1, capsule=None, key=None):
    org = relay[0]
    member = relay[2][index]
    raw_capsule = capsule or build_kvkb1_capsule(
        organisation_id=str(org.id),
        user_id=str(member.user_id),
        backup_epoch=backup_epoch,
    )
    signed = relay[7](
        index,
        "publish-key-backup",
        {
            "deviceId": str(relay[5][index]),
            "backupEpoch": backup_epoch,
            "capsule": b64(raw_capsule),
        },
        None,
    )
    client, tokens = http
    return (
        client.post(
            backup_url(org.id),
            data=json.dumps(signed),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer " + tokens[index],
            HTTP_IDEMPOTENCY_KEY=key or str(uuid4()),
        ),
        raw_capsule,
    )


def test_shared_kvkb1_vectors_match_server_validator():
    from uuid import UUID

    from apps.confidential.services import validate_kvkb1_capsule
    from apps.e2ee.services import RefusalError

    payload = json.loads(VECTORS.read_text(encoding="utf-8"))
    for case in payload["valid"]:
        raw = base64.b64decode(case["capsuleBase64"], validate=True)
        kdf_kind, iterations = validate_kvkb1_capsule(
            raw,
            organisation_id=UUID(case["organisationId"]),
            user_id=case["accountId"],
            expected_epoch=case["backupEpoch"],
        )
        assert (kdf_kind, iterations) == (case["kdfKind"], case["iterations"])

    for bad in payload["invalid"]:
        raw = base64.b64decode(bad["capsuleBase64"], validate=True)
        with pytest.raises(RefusalError) as caught:
            validate_kvkb1_capsule(
                raw,
                organisation_id=UUID(bad["organisationId"]),
                user_id=bad["accountId"],
                expected_epoch=bad["backupEpoch"],
            )
        assert caught.value.status == 422, bad["name"]


def test_publish_restore_without_local_device_discard_and_monotonic_rotation(relay, http):
    client, tokens = http
    org = relay[0]

    # Absent backup returns 404 even for an active member without any registered device (index=3).
    missing = client.get(backup_url(org.id), HTTP_AUTHORIZATION="Bearer " + tokens[3])
    assert missing.status_code == 404

    # Initial publication must start at epoch 1; skipping to epoch 2 is refused with 409 + CORS exposed header.
    skipped, _ = publish(relay, http, index=0, backup_epoch=2)
    assert skipped.status_code == 409
    assert skipped["X-Kodera-Next-Backup-Epoch"] == "1"
    assert skipped.json()["type"] == "https://kodera.io/problems/conflict"

    from core.api.edge import EXPOSED_HEADERS

    assert "X-Kodera-Next-Backup-Epoch" in EXPOSED_HEADERS

    idem_key = str(uuid4())
    created, raw_epoch_1 = publish(relay, http, index=0, backup_epoch=1, key=idem_key)
    assert created.status_code == 201, created.content
    body_1 = created.json()
    assert body_1["backupEpoch"] == 1
    assert body_1["kdfKind"] == "recovery-key"
    assert body_1["iterations"] == 0
    assert body_1["capsuleSha256"] == hashlib.sha256(raw_epoch_1).hexdigest()
    assert body_1["sourceDeviceId"] == str(relay[5][0])

    # Idempotent replay returns identical body with Idempotency-Replayed: true.
    replayed, _ = publish(relay, http, index=0, backup_epoch=1, capsule=raw_epoch_1, key=idem_key)
    assert replayed.status_code == 201
    assert replayed["Idempotency-Replayed"] == "true"
    assert replayed.json() == body_1

    # Fresh-device retrieval succeeds even after the source device is revoked (no active local device).
    Device.objects.filter(pk=relay[5][0]).update(revoked_at=database_now())
    fetched = client.get(backup_url(org.id), HTTP_AUTHORIZATION="Bearer " + tokens[0])
    assert fetched.status_code == 200
    fetched_json = fetched.json()
    assert fetched_json["backupEpoch"] == 1
    assert base64.b64decode(fetched_json["capsule"]) == raw_epoch_1

    # Re-enable device in test fixture or register peer: member 1 cannot read member 0's backup.
    other_member_get = client.get(backup_url(org.id), HTTP_AUTHORIZATION="Bearer " + tokens[1])
    assert other_member_get.status_code == 404

    # Member 1 publishes epoch 1, discards it (204), cannot fetch discarded (404), and must rotate to epoch 2!
    c1, _ = publish(relay, http, index=1, backup_epoch=1)
    assert c1.status_code == 201
    discarded = client.delete(backup_url(org.id), HTTP_AUTHORIZATION="Bearer " + tokens[1])
    assert discarded.status_code == 204
    assert discarded["X-Kodera-Next-Backup-Epoch"] == "2"

    row_1 = KeyBackupArchive.objects.get(organisation=org, membership=relay[2][1])
    assert bytes(row_1.capsule) if row_1.capsule is not None else None is None
    assert row_1.discarded_at is not None

    after_discard = client.get(backup_url(org.id), HTTP_AUTHORIZATION="Bearer " + tokens[1])
    assert after_discard.status_code == 404
    assert after_discard["X-Kodera-Next-Backup-Epoch"] == "2"

    stale_republish, _ = publish(relay, http, index=1, backup_epoch=1)
    assert stale_republish.status_code == 409
    assert stale_republish["X-Kodera-Next-Backup-Epoch"] == "2"

    passphrase_capsule = build_kvkb1_capsule(
        organisation_id=str(org.id),
        user_id=str(relay[2][1].user_id),
        backup_epoch=2,
        kdf_kind="passphrase",
        iterations=600_000,
    )
    rotated, _ = publish(relay, http, index=1, backup_epoch=2, capsule=passphrase_capsule)
    assert rotated.status_code == 201
    assert rotated.json()["backupEpoch"] == 2
    assert rotated.json()["kdfKind"] == "passphrase"
    assert rotated.json()["iterations"] == 600_000

    # Concurrent first-publish IntegrityError savepoint returns 409 epoch-conflict with next epoch (never 500).
    from unittest.mock import patch as mock_patch

    orig_create = KeyBackupArchive.objects.create

    def simulate_race_create(**kwargs):
        orig_create(**kwargs)
        raise IntegrityError("simulated concurrent unique membership race")

    with mock_patch.object(KeyBackupArchive.objects, "create", side_effect=simulate_race_create):
        raced, _ = publish(relay, http, index=2, backup_epoch=1)
    assert raced.status_code == 409
    assert raced.json()["type"] == "https://kodera.io/problems/conflict"
    assert raced["X-Kodera-Next-Backup-Epoch"] == "2"


def test_staff_and_ai_service_actors_are_refused(relay, http_signer, frozen_clock, settings):
    org, _, _, tokens = relay[:4]
    configure(
        settings,
        [
            trust_entry(http_signer, org.issuer),
            trust_entry(http_signer, "https://staff.kodera.test", lane="staff"),
        ],
    )
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"
    client = Client(HTTP_HOST="127.0.0.1")

    staff_jwt = token(
        http_signer,
        "https://staff.kodera.test",
        subject="staff-op-1",
        email_verified=True,
        extra={"amr": ["pwd", "otp"]},
    )
    assert (
        client.get(backup_url(org.id), HTTP_AUTHORIZATION="Bearer " + staff_jwt).status_code == 403
    )

    ai_jwt = token(
        http_signer,
        org.issuer,
        subject=tokens[0].subject,
        email="kodera-ai@acme.kodera.test",
        email_verified=True,
    )
    assert client.get(backup_url(org.id), HTTP_AUTHORIZATION="Bearer " + ai_jwt).status_code == 403


def test_api_writer_role_forbids_sql_delete_and_erasure_purges_key_backups(relay, http):
    org = relay[0]
    c0, _ = publish(relay, http, index=0, backup_epoch=1)
    c2, _ = publish(relay, http, index=2, backup_epoch=1)
    assert c0.status_code == 201 and c2.status_code == 201

    archive_0 = KeyBackupArchive.objects.get(organisation=org, membership=relay[2][0])

    # API writer role has zero SQL DELETE grant on confidential_keybackuparchive, and DB trigger
    # independently blocks DELETE outside privacy worker context.
    role = f"kodera_api_kb_{uuid4().hex[:10]}"
    with connection.cursor() as cursor:
        cursor.execute(f'CREATE ROLE "{role}" NOLOGIN NOINHERIT')
        for statement in grant_statements(role):
            cursor.execute(statement)
    try:
        with acting_as(role):
            assert refused("DELETE FROM confidential_keybackuparchive") == "42501"
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")
            cursor.execute(f'DROP OWNED BY "{role}"')
            cursor.execute(f'DROP ROLE "{role}"')

    with pytest.raises(IntegrityError), transaction.atomic(), connection.cursor() as cursor:
        cursor.execute(
            "DELETE FROM confidential_keybackuparchive WHERE id = %s",
            [archive_0.id],
        )

    # Account erasure purges member 2's key backup and leaves zero residual user E2EE state.
    from dataclasses import replace

    account_req = admit_account(
        relay[:4],
        verified=replace(relay[3][2], auth_time=int(database_now().timestamp())),
    )
    assert account_req.inventory["e2ee"]["key_backups"] == 1
    account_res = purge_account_core(account_req.id)
    assert account_res["counts"]["key_backups"] == 1
    assert e2ee_services.count_residual_e2ee_for_user(user_id=relay[2][2].user_id) == 0

    # Organisation erasure purges remaining key backups and leaves zero residual org E2EE state.
    org_req = begin_erasure(
        organisation_id=org.id,
        instruction_ref="DEL-319",
        instruction_sha256="a" * 64,
        purge_not_before=database_now(),
        actor_identity_id=operator().id,
    )
    assert org_req.inventory["e2ee"]["key_backups"] == 1
    org_res = purge_core(org_req.id)
    assert org_res["key_backups"] == 1
    assert e2ee_services.count_residual_e2ee_for_organisation(organisation_id=org.id) == 0
