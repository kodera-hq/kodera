"""Real cutoff, purge and direct-SQL association refusals for the opaque relay."""

import hashlib
import os
from dataclasses import replace
from datetime import timedelta
from uuid import uuid4

import pytest
from django.db import IntegrityError, transaction
from django.utils import timezone
from test_core_erasure import operator
from test_e2ee_relay import admit_peer, b64, operation, read, relay as relay, world as world

from apps.e2ee import services
from apps.e2ee.models import Device, Envelope, KeyPackage, Participant, Room
from apps.identity.models import Identity, User
from apps.orgs.account_erasure_services import begin_account_erasure, purge_account_core
from apps.orgs.erasure_services import begin_erasure, database_now, purge_core
from apps.orgs.models import Membership, Organisation, SlugReservation

pytestmark = pytest.mark.django_db(transaction=True)


def account_cutoff(relay, index):
    return begin_account_erasure(
        verified=replace(relay[3][index], auth_time=int(database_now().timestamp())),
        confirmation="delete",
        instruction_ref="DEL-310",
        instruction_sha256="7" * 64,
        purge_not_before=database_now(),
        actor_identity_id=operator().id,
    )


def test_account_cutoff_retires_keys_and_discards_directory_payload_but_keeps_controller_history(
    relay,
):
    admit_peer(relay)
    operation(relay, "send_application", 2, {"epoch": 1, "ciphertext": b64(os.urandom(32))})
    pending = operation(
        relay, "publish_package", 2, {"keyPackage": b64(b"synthetic unused directory payload")}
    )
    before = Envelope.objects.count()
    request = account_cutoff(relay, 2)
    assert str(relay[5][2]) in request.inventory["e2ee"]["device_ids"]
    with pytest.raises(services.RefusalError):
        read(relay, 2)
    result = purge_account_core(request.id)
    assert result["counts"]["e2ee_devices_revoked"] == 1
    assert result["counts"]["e2ee_directory_packages_discarded"] == 1
    assert Envelope.objects.count() == before
    device = Device.objects.get(pk=relay[5][2])
    assert device.revoked_at is not None and len(bytes(device.signing_key)) == 32
    package = KeyPackage.objects.get(pk=pending["keyPackageId"])
    assert package.package is None and package.discarded_at is not None
    assert read(relay)["rekeyRequired"]
    committed = operation(
        relay,
        "commit_epoch",
        0,
        {"epoch": 1, "deviceIds": [str(relay[5][0])], "ciphertext": b64(os.urandom(32))},
    )
    assert committed["epoch"] == 2 and not read(relay)["rekeyRequired"]
    assert purge_account_core(request.id)["counts"] == result["counts"]
    with pytest.raises(IntegrityError), transaction.atomic():
        Device.objects.filter(pk=device.id).update(revoked_at=None)


def test_two_erased_accounts_sharing_a_claim_do_not_block_minimal_owner_cleanup(relay):
    admit_peer(relay, index=1)
    published = operation(
        relay, "publish_package", 2, {"keyPackage": b64(b"synthetic cross-account claim payload")}
    )
    operation(relay, "claim_package", 1, {"targetDeviceId": str(relay[5][2])})
    second = account_cutoff(relay, 2)
    first = account_cutoff(relay, 1)
    assert purge_account_core(second.id)["counts"]["e2ee_directory_packages_discarded"] == 1
    assert purge_account_core(first.id)["counts"]["e2ee_devices_revoked"] == 1
    assert KeyPackage.objects.get(pk=published["keyPackageId"]).package is None
    assert (
        operation(
            relay,
            "commit_epoch",
            0,
            {"epoch": 1, "deviceIds": [str(relay[5][0])], "ciphertext": b64(os.urandom(32))},
        )["epoch"]
        == 2
    )


def test_device_revocation_does_not_wait_for_or_mutate_an_erased_foreign_claimant(relay):
    admit_peer(relay, index=1)
    published = operation(
        relay, "publish_package", 2, {"keyPackage": b64(b"synthetic claimed public package")}
    )
    operation(relay, "claim_package", 1, {"targetDeviceId": str(relay[5][2])})
    account_cutoff(relay, 1)
    result = services.revoke_device(
        verified=relay[3][2],
        organisation_id=relay[0].id,
        body=relay[7](
            2,
            "revoke-device",
            {"deviceId": str(relay[5][2]), "targetDeviceId": str(relay[5][2])},
        ),
        request_id=str(uuid4()),
    )
    assert result["revoked"] and Device.objects.get(pk=relay[5][2]).revoked_at is not None
    package = KeyPackage.objects.get(pk=published["keyPackageId"])
    assert package.claimed_by_id == relay[5][1] and package.package is not None
    with pytest.raises(services.RefusalError):
        read(relay, 2)


def test_organisation_cutoff_inventory_and_purge_cover_every_relay_table(relay):
    admit_peer(relay)
    request = begin_erasure(
        organisation_id=relay[0].id,
        instruction_ref="DEL-311",
        instruction_sha256="8" * 64,
        purge_not_before=database_now(),
        actor_identity_id=operator().id,
    )
    assert request.inventory["e2ee"]["devices"] == 4
    assert request.inventory["e2ee"]["envelopes"] == 2
    with pytest.raises(IntegrityError), transaction.atomic():
        Room.objects.filter(pk=relay[6]).update(rekey_required=True)
    result = purge_core(request.id)
    assert result["e2ee_devices"] == 4 and result["e2ee_envelopes"] == 2
    for model in (Device, Room, Participant, KeyPackage, Envelope):
        assert not model.objects.filter(organisation_id=relay[0].id).exists()
    assert purge_core(request.id) == result


def foreign_device():
    with transaction.atomic():
        slug = "other-" + uuid4().hex[:12]
        org = Organisation.objects.create(
            slug=slug,
            realm=slug,
            name="Other example",
            issuer=f"https://identity.example.org/realms/{slug}",
            state="active",
        )
        SlugReservation.objects.create(
            organisation=org,
            slug=slug,
            namespace="organisation",
            state="permanent",
            protected_at=timezone.now(),
        )
        user = User.objects.create(email=f"{uuid4()}@example.org")
        identity = Identity.objects.create(
            user=user,
            organisation=org,
            issuer=org.issuer,
            realm=slug,
            subject=str(uuid4()),
            email=user.email,
        )
        member = Membership.objects.create(
            user=user,
            organisation=org,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
        return Device.objects.create(
            organisation=org, membership=member, identity=identity, signing_key=os.urandom(32)
        )


@pytest.mark.parametrize("kind", ["device", "room", "participant", "package", "envelope"])
def test_database_cannot_store_cross_organisation_relay_associations(relay, kind):
    foreign = foreign_device()
    own = Device.objects.get(pk=relay[5][0])
    with pytest.raises(IntegrityError, match="e2ee"), transaction.atomic():
        if kind == "device":
            Device.objects.create(
                organisation_id=foreign.organisation_id,
                membership_id=own.membership_id,
                identity_id=own.identity_id,
                signing_key=os.urandom(32),
            )
        elif kind == "room":
            Room.objects.create(
                organisation_id=foreign.organisation_id,
                channel_id=Room.objects.get(pk=relay[6]).channel_id,
                algorithm="io.kodera.mls.v1",
            )
        elif kind == "participant":
            Participant.objects.create(
                organisation_id=relay[0].id, room_id=relay[6], device=foreign, joined_epoch=0
            )
        elif kind == "package":
            package = b"synthetic payload"
            KeyPackage.objects.create(
                organisation_id=relay[0].id,
                device=foreign,
                package=package,
                reference=hashlib.sha256(package).digest(),
                expires_at=timezone.now() + timedelta(hours=1),
            )
        else:
            Envelope.objects.create(
                organisation_id=relay[0].id,
                room_id=relay[6],
                sender=foreign,
                sequence=1,
                epoch=0,
                kind="application",
                ciphertext=os.urandom(32),
                signature=bytes(64),
            )


def test_database_requires_a_real_committed_envelope_for_epoch_or_sequence_advancement(relay):
    for values in ({"epoch": 1}, {"head_sequence": 1}):
        with pytest.raises(IntegrityError, match="committed counters"), transaction.atomic():
            Room.objects.filter(pk=relay[6]).update(**values)


def test_captured_application_request_is_not_stored_twice(relay):
    payload = {"epoch": 0, "ciphertext": b64(os.urandom(32))}
    operation(relay, "send_application", 0, payload)
    with pytest.raises(services.RefusalError) as failure:
        operation(relay, "send_application", 0, payload)
    assert failure.value.status == 409 and Envelope.objects.count() == 1
