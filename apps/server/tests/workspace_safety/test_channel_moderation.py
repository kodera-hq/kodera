# ruff: noqa: S101
"""Bans and expiring mutes survive native public-room reconciliation."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from test_tenant_agent import ALICE, BOB
from test_tenant_agent_channels import FakeHomeserver, build, channel, channel_set

from tenant_agent.channels import CHANNEL_KIND, parse
from tenant_agent.synapse import POLICY


class ModeratedHomeserver(FakeHomeserver):
    def __init__(self):
        super().__init__()
        self.server_name = "community.example.org"
        self.bans = {}
        self.owned_bans = {}
        self.removals = []

    def moderation_bans(self, room):
        return set(self.bans.get(room, set())), set(self.owned_bans.get(room, set()))

    def ban(self, room, user):
        self.bans.setdefault(room, set()).add(user)
        self.owned_bans.setdefault(room, set()).add(user)
        self.rooms[room]["members"][user] = "ban"

    def join(self, room, user):
        from tenant_agent.engines import EngineError

        if user in self.bans.get(room, set()):
            raise EngineError("a banned member cannot rejoin")
        return super().join(room, user)

    def unban(self, room, user):
        self.bans[room].remove(user)
        self.owned_bans[room].remove(user)
        self.rooms[room]["members"][user] = "leave"
        self.removals.append(user)


def test_native_public_room_carries_ban_and_mute_then_unbans(tmp_path, monkeypatch):
    import test_tenant_agent_channels as fixtures

    monkeypatch.setattr(fixtures, "SERVER", "community.example.org")
    monkeypatch.setattr(fixtures, "AGENT", "@kodera-agent:community.example.org")
    monkeypatch.setattr(fixtures, "ROOMS", "@kodera-rooms:community.example.org")
    homeserver = ModeratedHomeserver()
    handlers, _, _, state = build(tmp_path, homeserver=homeserver)
    channel_id = str(uuid4())
    entry = channel(channel_id, audience="all", members=[], denied=[])
    payload = channel_set(1, entry, all_members=(ALICE, BOB))
    until = (datetime.now(UTC) + timedelta(minutes=5)).isoformat()
    payload.update(banned_subjects=[ALICE], muted_subjects=[{"subject": BOB, "expires_at": until}])
    outcome = handlers.handle(CHANNEL_KIND, payload)
    assert outcome.status == "succeeded"
    room = state.channel_rooms()[channel_id]
    policy = homeserver.rooms[room]["state"][(POLICY, "")]
    assert policy["local_only"] is True
    assert homeserver.user_id(ALICE) in policy["banned"]
    assert policy["muted_until"][homeserver.user_id(BOB)] == until
    assert homeserver.user_id(ALICE) in homeserver.bans[room]
    payload.update(revision=2, banned_subjects=[], muted_subjects=[])
    assert handlers.handle(CHANNEL_KIND, payload).status == "succeeded"
    assert len(homeserver.rooms) == 1
    assert homeserver.bans[room] == set()
    assert homeserver.user_id(ALICE) in homeserver.removals


def test_invalid_mute_or_ban_payload_is_refused_before_room_mutation():
    payload = channel_set(1, channel(str(uuid4())))
    payload.update(banned_subjects=[None])
    assert parse(payload) is None
    payload.update(banned_subjects=[], muted_subjects=[{"subject": BOB, "expires_at": "invalid"}])
    assert parse(payload) is None
    payload["muted_subjects"][0]["expires_at"] = "2026-01-01T00:00:00"
    assert parse(payload) is None


def test_unhashable_moderation_subjects_are_refused():
    payload = channel_set(1, channel(str(uuid4())))
    for invalid in ({}, [], None, 1):
        payload.update(banned_subjects=[invalid], muted_subjects=[])
        assert parse(payload) is None
        payload.update(
            banned_subjects=[], muted_subjects=[{"subject": invalid, "expires_at": "invalid"}]
        )
        assert parse(payload) is None


def test_private_room_unbans_before_readmitting_a_member(tmp_path):
    import test_tenant_agent_channels as fixtures

    homeserver = ModeratedHomeserver()
    homeserver.server_name = fixtures.SERVER
    handlers, _, _, state = build(tmp_path, homeserver=homeserver)
    channel_id = str(uuid4())
    payload = channel_set(1, channel(channel_id, audience="listed", members=[ALICE, BOB]))
    payload.update(banned_subjects=[ALICE], muted_subjects=[])
    assert handlers.handle(CHANNEL_KIND, payload).status == "succeeded"
    room = state.channel_rooms()[channel_id]
    assert homeserver.user_id(ALICE) in homeserver.bans[room]
    payload.update(revision=2, banned_subjects=[])
    assert handlers.handle(CHANNEL_KIND, payload).status == "succeeded"
    assert homeserver.rooms[room]["members"][homeserver.user_id(ALICE)] == "join"


def test_an_independent_operator_ban_is_neither_overwritten_nor_reversed(tmp_path):
    import test_tenant_agent_channels as fixtures

    homeserver = ModeratedHomeserver()
    homeserver.server_name = fixtures.SERVER
    handlers, _, _, state = build(tmp_path, homeserver=homeserver)
    channel_id = str(uuid4())
    payload = channel_set(1, channel(channel_id, audience="listed", members=[BOB]))
    payload.update(banned_subjects=[], muted_subjects=[])
    assert handlers.handle(CHANNEL_KIND, payload).status == "succeeded"
    room = state.channel_rooms()[channel_id]
    user = homeserver.user_id(ALICE)
    homeserver.bans[room] = {user}
    homeserver.rooms[room]["members"][user] = "ban"
    payload.update(revision=2, banned_subjects=[ALICE])
    assert handlers.handle(CHANNEL_KIND, payload).status == "succeeded"
    assert user not in homeserver.owned_bans.get(room, set())
    payload.update(revision=3, banned_subjects=[])
    assert handlers.handle(CHANNEL_KIND, payload).status == "succeeded"
    assert user in homeserver.bans[room] and user not in homeserver.removals


def test_synapse_ban_inventory_separates_operator_bans(monkeypatch):
    from tenant_agent.synapse import Synapse

    synapse = Synapse(
        "https://matrix.example.org", str(uuid4()), "example.org", "@rooms:example.org"
    )
    agent, operator = "@agent:example.org", "@operator:example.org"
    own, independent = "@first:example.org", "@second:example.org"
    events = [
        {
            "state_key": own,
            "sender": agent,
            "content": {"membership": "ban", "reason": "workspace moderation in Kodera"},
        },
        {
            "state_key": independent,
            "sender": operator,
            "content": {"membership": "ban", "reason": "Independent moderation"},
        },
        {"state_key": agent, "sender": agent, "content": {"membership": "join"}},
    ]
    monkeypatch.setattr(synapse, "me", lambda: agent)
    monkeypatch.setattr(synapse, "_call", lambda *args: (200, {"chunk": events}))
    assert synapse.moderation_bans("!room:example.org") == ({own, independent}, {own})


def test_moderation_transport_outage_stops_after_one_room(tmp_path, monkeypatch):
    import test_tenant_agent_channels as fixtures

    from tenant_agent.synapse import SynapseUnavailableError

    homeserver = ModeratedHomeserver()
    homeserver.server_name = fixtures.SERVER
    handlers, _, _, _ = build(tmp_path, homeserver=homeserver)
    calls = []

    def unavailable(room):
        calls.append(room)
        raise SynapseUnavailableError("owned transport outage")

    monkeypatch.setattr(homeserver, "moderation_bans", unavailable)
    payload = channel_set(1, channel(str(uuid4())), channel(str(uuid4())))
    payload.update(banned_subjects=[], muted_subjects=[])
    assert handlers.handle(CHANNEL_KIND, payload).status == "failed"
    assert len(calls) == 1
