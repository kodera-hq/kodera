"""Guest delivery invites exact bound rooms without creating realm membership."""

import pytest
from test_tenant_agent_channels import TEXT, build, channel, channel_set

from apps.engine_intents.channel_sets import ChannelSetError, normalise
from tenant_agent.channels import CHANNEL_KIND, parse


def test_guest_invite_preserves_join_and_revocation_removes_it(tmp_path):
    handlers, homeserver, _, state = build(tmp_path)
    assert handlers.handle(CHANNEL_KIND, channel_set(1, channel())).status == "succeeded"
    room = state.channel_rooms()[TEXT]
    guest = "@guest:acme.kodera.io"
    granted = channel(guest_grants=[{"user_id": guest, "room_id": room}])
    assert handlers.handle(CHANNEL_KIND, channel_set(2, granted)).status == "succeeded"
    assert homeserver.rooms[room]["members"][guest] == "invite"
    assert guest not in homeserver.accounts
    homeserver.rooms[room]["members"][guest] = "join"
    assert handlers.handle(CHANNEL_KIND, channel_set(3, granted)).status == "succeeded"
    assert homeserver.rooms[room]["members"][guest] == "join"
    assert handlers.handle(CHANNEL_KIND, channel_set(4, channel())).status == "succeeded"
    assert homeserver.rooms[room]["members"][guest] == "leave"


def test_mismatched_room_grant_never_invites_or_creates_an_account(tmp_path):
    handlers, homeserver, _, state = build(tmp_path)
    assert handlers.handle(CHANNEL_KIND, channel_set(1, channel())).status == "succeeded"
    grant = {"user_id": "@guest:acme.kodera.io", "room_id": "!other:remote.example.org"}
    assert (
        handlers.handle(CHANNEL_KIND, channel_set(2, channel(guest_grants=[grant]))).status
        == "succeeded"
    )
    assert grant["user_id"] not in homeserver.rooms[state.channel_rooms()[TEXT]]["members"]
    assert grant["user_id"] not in homeserver.accounts


@pytest.mark.parametrize(
    "grants",
    [
        "invalid",
        [{"user_id": "guest", "room_id": "!room:example.org"}],
        [{"user_id": "@guest:example.org", "room_id": "room"}],
        [{"user_id": "@guest:example.org", "room_id": "!room:example.org", "role": "org_owner"}],
        [{"user_id": "@guest:example.org", "room_id": "!room:example.org"}] * 2,
    ],
)
def test_core_and_agent_refuse_malformed_guest_grants(grants):
    document = channel_set(1, channel(guest_grants=grants))
    assert parse(document) is None
    with pytest.raises(ChannelSetError):
        normalise(document["all_members"], document["channels"])
