"""Self-retirement reduces authority even when current publication is restricted."""

import base64
import json
from datetime import timedelta
from uuid import uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_e2ee_production_mount import production_route as production_route, snapshot
from test_e2ee_relay import admit_peer, b64, relay as relay
from test_e2ee_relay_http import http as http, path, post, send, writer as writer
from test_intake_writer_role import acting_as
from workspace_safety.test_moderation import world as world

from apps.e2ee.models import Device, Participant, Room
from apps.orgs.models import Membership
from apps.workspaces.models import (
    Channel,
    ResourcePolicyRule,
    Workspace,
    WorkspaceMemberRestriction,
)

pytestmark = pytest.mark.django_db(transaction=True)


def restrict(relay, mode, index):
    if mode == "mute":
        WorkspaceMemberRestriction.objects.create(
            workspace=relay[1],
            membership=relay[2][index],
            muted_until=timezone.now() + timedelta(hours=1),
        )
    elif mode == "read_only":
        policy_id = Workspace.objects.values_list("default_policy_id", flat=True).get(
            pk=relay[1].id
        )
        ResourcePolicyRule.objects.create(
            policy_id=policy_id,
            kind="deny_capability",
            capability="message.post",
        )
    elif mode == "archived":
        Channel.objects.filter(pk=Room.objects.get(pk=relay[6]).channel_id).update(
            lifecycle="archived"
        )
    else:
        assert mode == "unrestricted"


def state(relay):
    room = Room.objects.get(pk=relay[6])
    return (
        snapshot(),
        (room.epoch, room.head_sequence, room.rekey_required),
        tuple(
            Participant.objects.filter(room=room)
            .order_by("device_id")
            .values_list("device_id", "joined_epoch", "left_epoch")
        ),
    )


def receive(relay, http, index):
    return http[0].get(
        path(relay, f"rooms/{relay[6]}/envelopes"),
        {"deviceId": str(relay[5][index])},
        HTTP_AUTHORIZATION="Bearer " + http[1][index],
    )


@pytest.mark.parametrize("mode", ["unrestricted", "mute", "read_only", "archived"])
def test_visible_member_self_retirement_survives_publication_restrictions(
    relay, http, production_route, writer, mode
):
    admit_peer(relay)
    with acting_as(writer):
        assert send(relay, http, index=2, epoch=1).status_code == 201
    restrict(relay, mode, 2)
    before = state(relay)
    body = {"deviceId": str(relay[5][2]), "targetDeviceId": str(relay[5][2])}
    suffix, key = f"rooms/{relay[6]}/participants/retire", str(uuid4())
    with acting_as(writer):
        visible = receive(relay, http, 2)
        assert visible.status_code == 200, visible.content
        if mode != "unrestricted":
            denied = send(relay, http, index=2, epoch=1)
            assert denied.status_code == 403, denied.content
            assert "Idempotency-Replayed" not in denied and state(relay) == before
        retired = post(relay, http, "retire-room-device", suffix, body, index=2, key=key, room=True)
        assert retired.status_code == 200, retired.content
        assert retired.json() == {"epoch": 1, "rekeyRequired": True}
        assert "Idempotency-Replayed" not in retired
        participant = Participant.objects.get(room_id=relay[6], device_id=relay[5][2])
        assert participant.left_epoch == 2
        after = state(relay)
        assert after[1] == (before[1][0], before[1][1], True)
        assert after[0][3:5] == before[0][3:5]  # No package or envelope publication.
        assert after[0][5] == before[0][5] + 1  # One retirement audit.
        assert after[0][6] == before[0][6] + 1  # One stored successful response.
        for refused in (
            receive(relay, http, 2),
            send(relay, http, index=2, epoch=1),
            post(relay, http, "retire-room-device", suffix, body, index=2, key=key, room=True),
        ):
            assert refused.status_code == 404, refused.content
            assert "Idempotency-Replayed" not in refused
        assert state(relay) == after


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        ("signature", 403),
        ("device", 404),
        ("membership", 404),
        ("view", 404),
        ("revoked", 404),
        ("ban", 403),
    ],
)
def test_self_retirement_exception_never_substitutes_for_current_authority(
    relay, http, production_route, writer, change, expected
):
    admit_peer(relay)
    restrict(relay, "mute", 2)
    body = {"deviceId": str(relay[5][2]), "targetDeviceId": str(relay[5][2])}
    if change == "device":
        body["deviceId"] = str(relay[5][0])
    elif change == "membership":
        Membership.objects.filter(pk=relay[2][2].id).update(state="suspended")
    elif change == "view":
        policy_id = Workspace.objects.values_list("default_policy_id", flat=True).get(
            pk=relay[1].id
        )
        ResourcePolicyRule.objects.create(
            policy_id=policy_id, kind="deny_member", membership=relay[2][2]
        )
    elif change == "revoked":
        Device.objects.filter(pk=relay[5][2]).update(revoked_at=timezone.now())
    elif change == "ban":
        WorkspaceMemberRestriction.objects.filter(
            workspace=relay[1], membership=relay[2][2]
        ).update(banned=True)
    signed = relay[7](2, "retire-room-device", body, relay[6])
    if change == "signature":
        signature = bytearray(base64.b64decode(signed["signature"]))
        signature[0] ^= 1
        signed["signature"] = b64(signature)
    before = state(relay)
    with acting_as(writer):
        response = http[0].post(
            path(relay, f"rooms/{relay[6]}/participants/retire"),
            data=json.dumps(signed),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer " + http[1][2],
            HTTP_IDEMPOTENCY_KEY=str(uuid4()),
        )
    assert response.status_code == expected, response.content
    assert "Idempotency-Replayed" not in response and state(relay) == before


@pytest.mark.parametrize(
    ("mode", "expected"), [("mute", 403), ("archived", 403), ("read_only", 200)]
)
def test_admin_retiring_another_device_keeps_existing_publication_policy(
    relay, http, production_route, writer, mode, expected
):
    admit_peer(relay)
    restrict(relay, mode, 0)
    before = state(relay)
    with acting_as(writer):
        visible = receive(relay, http, 0)
        assert visible.status_code == 200, visible.content
        response = post(
            relay,
            http,
            "retire-room-device",
            f"rooms/{relay[6]}/participants/retire",
            {"deviceId": str(relay[5][0]), "targetDeviceId": str(relay[5][2])},
            room=True,
        )
    assert response.status_code == expected, response.content
    assert "Idempotency-Replayed" not in response
    if expected == 403:
        assert state(relay) == before
    else:
        # Existing owner/admin message.post bypass remains, without broadening mute/archive.
        assert response.json() == {"epoch": 1, "rekeyRequired": True}
        assert Participant.objects.get(room_id=relay[6], device_id=relay[5][2]).left_epoch == 2
        assert state(relay)[0][3:5] == before[0][3:5]
