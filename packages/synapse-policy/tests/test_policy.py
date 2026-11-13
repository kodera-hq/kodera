import asyncio
import pathlib
import tomllib
from types import SimpleNamespace

import pytest

from kodera_synapse_policy import KoderaPolicy, __version__

SERVER = "acme-sa.kodera.io"
AGENT = f"@kodera-agent:{SERVER}"
ALICE = f"@alice:{SERVER}"
BOB = f"@bob:{SERVER}"
CAROL = f"@carol:{SERVER}"
OUTSIDER = "@eve:elsewhere.example"
ROOM_ACCESS = f"@kodera-rooms:{SERVER}"
FORBIDDEN = "M_FORBIDDEN"
ALLOWED = "NOT_SPAM"


class FakeApi:
    def __init__(self, rooms=None, users=None):
        self.callbacks = {}
        self.rooms = rooms or {}
        self.users = users

    def register_spam_checker_callbacks(self, **callbacks):
        self.callbacks.update(callbacks)

    def register_third_party_rules_callbacks(self, **callbacks):
        self.callbacks.update(callbacks)

    def is_mine(self, user_id):
        return user_id.endswith(f":{SERVER}")

    async def get_userinfo_by_id(self, user_id):
        if self.users is not None:
            return self.users.get(user_id)
        return SimpleNamespace(is_deactivated=False, is_guest=False, approved=True, locked=False, suspended=False)

    async def get_room_state(self, room_id):
        return self.rooms.get(room_id, {})


def run(coro):
    return asyncio.run(coro)


def policy(rooms=None):
    return KoderaPolicy({"agent_user_id": AGENT}, FakeApi(rooms))


def dm_request(**overrides):
    request = {"is_direct": True, "invite": [BOB], "preset": "private_chat", "visibility": "private"}
    request.update(overrides)
    return request


def event(kind, sender=ALICE, state=True, **content):
    return SimpleNamespace(type=kind, sender=sender, content=content, is_state=lambda: state)


def state_of(creator, members):
    state = {("m.room.create", ""): SimpleNamespace(sender=creator)}
    for member in members:
        state[("m.room.member", member)] = SimpleNamespace(sender=member)
    return state


def test_registers_every_callback_it_relies_on():
    api = FakeApi()
    KoderaPolicy({"agent_user_id": AGENT}, api)
    assert set(api.callbacks) == {
        "user_may_create_room",
        "user_may_invite",
        "user_may_join_room",
        "user_may_send_3pid_invite",
        "user_may_create_room_alias",
        "user_may_publish_room",
        "check_event_for_spam",
        "check_event_allowed",
        "on_create_room",
    }


@pytest.mark.parametrize("config", [{}, {"agent_user_id": "agent"}, {"agent_user_id": 3}, None])
def test_refuses_a_config_without_a_full_agent_id(config):
    with pytest.raises(Exception, match="agent_user_id"):
        KoderaPolicy.parse_config(config)


@pytest.mark.parametrize("room_access", ["kodera-rooms", "@kodera-rooms", 3, ""])
def test_refuses_a_malformed_room_access_id(room_access):
    with pytest.raises(Exception, match="room_access_user_id"):
        KoderaPolicy.parse_config({"agent_user_id": AGENT, "room_access_user_id": room_access})


def test_the_room_access_id_is_optional():
    assert KoderaPolicy.parse_config({"agent_user_id": AGENT}) == {
        "agent_user_id": AGENT,
        "room_access_user_id": None,
    }
    assert KoderaPolicy.parse_config({"agent_user_id": AGENT, "room_access_user_id": ROOM_ACCESS}) == {
        "agent_user_id": AGENT,
        "room_access_user_id": ROOM_ACCESS,
    }


def with_room_access():
    return KoderaPolicy({"agent_user_id": AGENT, "room_access_user_id": ROOM_ACCESS}, FakeApi())


AUDIO_POLICY = {"version": 1, "kind": "audio", "listen_only": False, "may_publish": [], "archived": False}


# A member who creates a direct message holds every power level in it. Without this lock she
# could declare it an audio room herself and be granted a call outside any channel (P2-1).
def kodera_state(kind, sender, content):
    return SimpleNamespace(type=kind, sender=sender, content=content, is_state=lambda: True)


@pytest.mark.parametrize("sender", [ALICE, BOB, ROOM_ACCESS, OUTSIDER])
def test_only_the_agent_sets_a_rooms_policy(sender):
    configured = with_room_access()
    assert run(configured.check_event_for_spam(kodera_state("io.kodera.room.policy", sender, AUDIO_POLICY))) == FORBIDDEN
    assert run(configured.check_event_for_spam(kodera_state("io.kodera.room.policy", AGENT, AUDIO_POLICY))) == ALLOWED


def test_only_room_access_and_the_agent_write_occupancy():
    occupancy = {"version": 1, "participants": [], "at_ms": 1}
    configured = with_room_access()
    for sender in (ALICE, BOB, OUTSIDER):
        assert run(configured.check_event_for_spam(kodera_state("io.kodera.room.occupancy", sender, occupancy))) == FORBIDDEN
    assert run(configured.check_event_for_spam(kodera_state("io.kodera.room.occupancy", ROOM_ACCESS, occupancy))) == ALLOWED
    assert run(configured.check_event_for_spam(kodera_state("io.kodera.room.occupancy", AGENT, occupancy))) == ALLOWED
    # Without room_access_user_id, nobody but the agent writes it.
    assert run(policy().check_event_for_spam(kodera_state("io.kodera.room.occupancy", ROOM_ACCESS, occupancy))) == FORBIDDEN


def test_version_is_0_1_5():
    assert __version__ == "0.1.5"
    pyproject = pathlib.Path(__file__).resolve().parent.parent / "pyproject.toml"
    if pyproject.exists():
        meta = tomllib.loads(pyproject.read_text(encoding="utf-8"))
        assert meta["project"]["version"] == "0.1.5"


@pytest.mark.parametrize(
    "call_event_type",
    [
        "m.call.member",
        "org.matrix.msc3401.call.member",
        "org.matrix.msc4143.rtc.member",
    ],
)
@pytest.mark.parametrize("sender", [ALICE, BOB, ROOM_ACCESS, OUTSIDER])
def test_member_cannot_spoof_call_membership(call_event_type, sender):
    configured = with_room_access()
    spoof = kodera_state(call_event_type, sender, {"memberships": [{"application": "m.call"}]})
    assert run(configured.check_event_for_spam(spoof)) == FORBIDDEN
    assert run(configured.check_event_for_spam(kodera_state(call_event_type, AGENT, {}))) == ALLOWED


def test_service_accounts_never_participate_in_direct_messages():
    rooms = {"!dm-alice": state_of(ALICE, [ALICE]), "!dm-ra": state_of(ROOM_ACCESS, [ROOM_ACCESS])}
    configured = KoderaPolicy(
        {"agent_user_id": AGENT, "room_access_user_id": ROOM_ACCESS},
        FakeApi(rooms),
    )
    assert run(configured.user_may_create_room(ROOM_ACCESS, dm_request())) == FORBIDDEN
    assert run(configured.user_may_create_room(ALICE, dm_request(invite=[ROOM_ACCESS]))) == FORBIDDEN
    assert run(configured.user_may_create_room(ALICE, dm_request(invite=[AGENT]))) == FORBIDDEN
    assert run(configured.user_may_invite(ROOM_ACCESS, BOB, "!dm-ra")) == FORBIDDEN
    assert run(configured.user_may_invite(ALICE, ROOM_ACCESS, "!dm-alice")) == FORBIDDEN
    assert run(configured.user_may_invite(ALICE, AGENT, "!dm-alice")) == FORBIDDEN
    assert run(configured.user_may_send_3pid_invite(ROOM_ACCESS, "email", "x@example.org", "!dm-ra")) == FORBIDDEN
    assert run(configured.user_may_create_room_alias(ROOM_ACCESS, "#general:acme-sa.kodera.io")) == FORBIDDEN
    assert run(configured.user_may_publish_room(ROOM_ACCESS, "!dm-ra")) == FORBIDDEN


def test_agent_creates_any_room():
    assert run(policy().user_may_create_room(AGENT, {"preset": "public_chat"})) == ALLOWED


def test_member_creates_a_direct_message():
    assert run(policy().user_may_create_room(ALICE, dm_request())) == ALLOWED


@pytest.mark.parametrize(
    "request_body",
    [
        None,
        {"preset": "private_chat"},
        dm_request(is_direct=False),
        dm_request(invite=[f"@member{i}:{SERVER}" for i in range(9)]),
        dm_request(invite=[BOB, BOB]),
        dm_request(invite=[BOB, "bob"]),
        dm_request(preset="trusted_private_chat"),
        dm_request(preset=None),
        dm_request(visibility=None),
        dm_request(invite=[]),
        dm_request(invite=[ALICE]),
        dm_request(invite=[OUTSIDER]),
        dm_request(invite_3pid=[{"medium": "email", "address": "x@example.org"}]),
        dm_request(room_alias_name="general"),
        dm_request(visibility="public"),
        dm_request(preset="public_chat"),
        dm_request(initial_state=[{"type": "m.room.history_visibility", "content": {"history_visibility": "shared"}}]),
        dm_request(power_level_content_override={"invite": 0}),
        dm_request(creation_content={"type": "m.space"}),
    ],
)
def test_member_cannot_create_anything_but_a_direct_message(request_body):
    assert run(policy().user_may_create_room(ALICE, request_body)) == FORBIDDEN


def test_member_invites_once_into_their_new_direct_message():
    rooms = {"!dm": state_of(ALICE, [ALICE])}
    assert run(policy(rooms).user_may_invite(ALICE, BOB, "!dm")) == ALLOWED


@pytest.mark.parametrize(
    ("room", "invitee"),
    [
        (state_of(ALICE, [ALICE, BOB]), CAROL),
        (state_of(AGENT, [AGENT, ALICE]), BOB),
        (state_of(BOB, [BOB]), CAROL),
        (state_of(BOB, [ALICE]), CAROL),
        (state_of(AGENT, [ALICE]), BOB),
        (state_of(ALICE, [ALICE]), OUTSIDER),
        ({}, BOB),
    ],
    ids=[
        "second-invite",
        "agent-channel",
        "someone-elses-room",
        "left-by-its-creator",
        "agent-channel-left-to-one-member",
        "outsider",
        "unknown-room",
    ],
)
def test_member_cannot_invite_otherwise(room, invitee):
    assert run(policy({"!r": room}).user_may_invite(ALICE, invitee, "!r")) == FORBIDDEN


def test_agent_invites_into_any_room():
    assert run(policy().user_may_invite(AGENT, BOB, "!channel")) == ALLOWED


def channel_with_policy(policy_content, memberships):
    state = {("m.room.create", ""): SimpleNamespace(sender=AGENT)}
    if policy_content is not None:
        state[("io.kodera.room.policy", "")] = SimpleNamespace(sender=AGENT, content=policy_content)
    for user_id, membership in memberships.items():
        if isinstance(membership, dict):
            state[("m.room.member", user_id)] = SimpleNamespace(sender=user_id, content=membership)
        else:
            state[("m.room.member", user_id)] = SimpleNamespace(
                sender=user_id,
                membership=membership,
                content={"membership": membership} if isinstance(membership, str) else {},
            )
    return state


def test_joined_member_invites_local_user_into_policy_authorized_channel():
    rooms = {
        "!ch": channel_with_policy(
            {"version": 1, "kind": "text", "allow_member_invites": True},
            {AGENT: "join", ALICE: "join"},
        ),
        "!ch-content-only": channel_with_policy(
            {"version": 1, "kind": "text", "allow_member_invites": True},
            {AGENT: "join", ALICE: {"membership": "join"}},
        ),
    }
    assert run(policy(rooms).user_may_invite(ALICE, BOB, "!ch")) == ALLOWED
    assert run(policy(rooms).user_may_invite(ALICE, BOB, "!ch-content-only")) == ALLOWED


@pytest.mark.parametrize("federated_user", ["@partner:dinum.gouv.fr", "@architect:octo.com", OUTSIDER])
def test_joined_member_invites_federated_user_when_federated_invites_allowed(federated_user):
    rooms = {
        "!ch": channel_with_policy(
            {"version": 1, "kind": "text", "allow_member_invites": True, "allow_federated_invites": True},
            {AGENT: "join", ALICE: "join"},
        )
    }
    assert run(policy(rooms).user_may_invite(ALICE, federated_user, "!ch")) == ALLOWED


@pytest.mark.parametrize(
    "policy_content",
    [
        {"version": 1, "kind": "text", "allow_member_invites": True},
        {"version": 1, "kind": "text", "allow_member_invites": True, "allow_federated_invites": False},
        {"version": 1, "kind": "text", "allow_member_invites": True, "allow_federated_invites": None},
        {"version": 1, "kind": "text", "allow_member_invites": True, "allow_federated_invites": "true"},
        {"version": 1, "kind": "text", "allow_member_invites": True, "allow_federated_invites": 1},
    ],
)
def test_joined_member_cannot_invite_federated_user_without_federated_policy(policy_content):
    rooms = {"!ch": channel_with_policy(policy_content, {AGENT: "join", ALICE: "join"})}
    assert run(policy(rooms).user_may_invite(ALICE, "@partner:dinum.gouv.fr", "!ch")) == FORBIDDEN


@pytest.mark.parametrize(
    "memberships",
    [
        {AGENT: "join"},
        {AGENT: "join", ALICE: "invite"},
        {AGENT: "join", ALICE: "leave"},
        {AGENT: "join", ALICE: "ban"},
        {AGENT: "join", ALICE: "knock"},
        {AGENT: "join", ALICE: None},
        {AGENT: "join", ALICE: {}},
    ],
)
def test_non_joined_member_cannot_invite_into_policy_authorized_channel(memberships):
    rooms = {
        "!ch": channel_with_policy(
            {"version": 1, "kind": "text", "allow_member_invites": True, "allow_federated_invites": True},
            memberships,
        )
    }
    assert run(policy(rooms).user_may_invite(ALICE, BOB, "!ch")) == FORBIDDEN
    assert run(policy(rooms).user_may_invite(ALICE, "@partner:dinum.gouv.fr", "!ch")) == FORBIDDEN


@pytest.mark.parametrize(
    "malformed_invitee",
    [
        "",
        "bob",
        f"bob:{SERVER}",
        "@bob",
        "@bob:",
        f"@:{SERVER}",
        f"@bob::{SERVER}",
        f"@bob :{SERVER}",
        None,
    ],
)
def test_service_accounts_and_malformed_ids_refused_in_channel_invites(malformed_invitee):
    rooms = {
        "!ch": channel_with_policy(
            {"version": 1, "kind": "text", "allow_member_invites": True, "allow_federated_invites": True},
            {AGENT: "join", ALICE: "join", ROOM_ACCESS: "join"},
        )
    }
    configured = KoderaPolicy(
        {"agent_user_id": AGENT, "room_access_user_id": ROOM_ACCESS},
        FakeApi(rooms),
    )
    assert run(configured.user_may_invite(ALICE, AGENT, "!ch")) == FORBIDDEN
    assert run(configured.user_may_invite(ALICE, ROOM_ACCESS, "!ch")) == FORBIDDEN
    assert run(configured.user_may_invite(AGENT, AGENT, "!ch")) == FORBIDDEN
    assert run(configured.user_may_invite(AGENT, ROOM_ACCESS, "!ch")) == FORBIDDEN
    assert run(configured.user_may_invite(ROOM_ACCESS, BOB, "!ch")) == FORBIDDEN
    assert run(configured.user_may_invite(ALICE, malformed_invitee, "!ch")) == FORBIDDEN
    assert run(configured.user_may_invite(AGENT, malformed_invitee, "!ch")) == FORBIDDEN


@pytest.mark.parametrize(
    "policy_content",
    [
        None,
        {},
        {"version": 1, "kind": "text"},
        {"version": 1, "kind": "text", "allow_member_invites": False},
        {"version": 1, "kind": "text", "allow_member_invites": False, "allow_federated_invites": True},
        {"version": 1, "kind": "text", "allow_member_invites": "true"},
        {"version": 1, "kind": "text", "allow_member_invites": 1},
    ],
)
def test_channel_without_allow_member_invites_refuses_member_invites(policy_content):
    rooms = {"!ch": channel_with_policy(policy_content, {AGENT: "join", ALICE: "join"})}
    assert run(policy(rooms).user_may_invite(ALICE, BOB, "!ch")) == FORBIDDEN
    assert run(policy(rooms).user_may_invite(ALICE, "@partner:dinum.gouv.fr", "!ch")) == FORBIDDEN


def test_member_cannot_invite_by_email_or_phone():
    assert run(policy().user_may_send_3pid_invite(ALICE, "email", "x@example.org", "!r")) == FORBIDDEN


def test_agent_may_invite_by_email():
    assert run(policy().user_may_send_3pid_invite(AGENT, "email", "x@example.org", "!r")) == ALLOWED


def test_member_cannot_create_a_room_alias():
    assert run(policy().user_may_create_room_alias(ALICE, "#general:acme-sa.kodera.io")) == FORBIDDEN


def test_agent_may_create_a_room_alias():
    assert run(policy().user_may_create_room_alias(AGENT, "#general:acme-sa.kodera.io")) == ALLOWED


@pytest.mark.parametrize("user", [ALICE, AGENT])
def test_nobody_publishes_to_the_directory(user):
    assert run(policy().user_may_publish_room(user, "!r")) == FORBIDDEN


@pytest.mark.parametrize("sender", [ALICE, AGENT])
def test_nobody_turns_on_encryption(sender):
    assert run(policy().check_event_for_spam(event("m.room.encryption", sender))) == FORBIDDEN


@pytest.mark.parametrize("creator", [AGENT, ALICE])
def test_nobody_creates_an_encrypted_room(creator):
    encrypted = {"type": "m.room.encryption", "state_key": "", "content": {"algorithm": "m.megolm.v1.aes-sha2"}}
    request = dm_request(initial_state=[encrypted]) if creator == ALICE else {"initial_state": [encrypted]}
    assert run(policy().user_may_create_room(creator, request)) == FORBIDDEN


@pytest.mark.parametrize("sender", [ALICE, AGENT])
def test_no_event_turns_on_encryption(sender):
    # The path Synapse's server admins take too: initial state, forced encryption, upgrades.
    assert run(policy().check_event_allowed(event("m.room.encryption", sender), {})) == (False, None)


MEGOLM_CIPHERTEXT = {
    "algorithm": "m.megolm.v1.aes-sha2",
    "ciphertext": "AwgAEnACgAkLmt6qF84IK++J7UDH2Za1YVchHyprqTqsg",
    "device_id": "RJYKSTBOIE",
    "sender_key": "IlRMeOPX2e0MurIyfWEucYBRVOEEUMrOHqn/8mLqMjA",
    "session_id": "X3lUlvLELLYxeTx4yOVu6UDpasGEVO0Jbu+QFnm0cKQ",
}


def ciphertext(sender, room, state):
    return SimpleNamespace(
        type="m.room.encrypted", sender=sender, room_id=room, content=MEGOLM_CIPHERTEXT, is_state=lambda: state
    )


CIPHERTEXT_CASES = pytest.mark.parametrize(
    "encrypted",
    [
        ciphertext(ALICE, "!channel", state=False),
        ciphertext(AGENT, "!channel", state=False),
        ciphertext(AGENT, "!channel", state=True),
        ciphertext(ALICE, "!dm", state=False),
        ciphertext(ALICE, "!dm", state=True),
    ],
    ids=["member-timeline", "agent-timeline", "agent-state", "member-timeline-in-a-dm", "member-state-in-a-dm"],
)


@CIPHERTEXT_CASES
def test_no_event_carries_ciphertext(encrypted):
    # A client can post ciphertext in a room where encryption is off, with keys sent by to-device
    # message; refusing m.room.encryption alone would let it through.
    assert run(policy().check_event_allowed(encrypted, {})) == (False, None)


@CIPHERTEXT_CASES
def test_no_federated_event_carries_ciphertext(encrypted):
    # Synapse checks events from other servers with check_event_for_spam, not check_event_allowed.
    assert run(policy().check_event_for_spam(encrypted)) == FORBIDDEN


@pytest.mark.parametrize("kind", ["m.room.message", "m.room.join_rules", "m.room.member"])
def test_rules_allow_every_other_event(kind):
    assert run(policy().check_event_allowed(event(kind, AGENT), {})) == (True, None)


def test_agent_creates_a_room_with_other_initial_state():
    request = {"initial_state": [{"type": "m.room.join_rules", "state_key": "", "content": {"join_rule": "invite"}}]}
    assert run(policy().user_may_create_room(AGENT, request)) == ALLOWED


@pytest.mark.parametrize(
    "refused",
    [
        event("m.room.join_rules", join_rule="public"),
        event("m.room.join_rules", join_rule="knock"),
        event("m.room.join_rules", join_rule="restricted"),
        event("m.room.history_visibility", history_visibility="world_readable"),
        event("m.room.canonical_alias", alias="#general:acme-sa.kodera.io"),
        event("m.room.aliases"),
        event("m.room.server_acl", allow=["*"]),
        event("m.room.tombstone", replacement_room="!new"),
        event("m.room.third_party_invite", display_name="x"),
        event("m.space.child"),
        event("m.space.parent"),
    ],
    ids=lambda e: f"{e.type}:{e.content}",
)
def test_member_cannot_open_a_room(refused):
    assert run(policy().check_event_for_spam(refused)) == FORBIDDEN


@pytest.mark.parametrize(
    "allowed",
    [
        event("m.room.message", state=False, body="hello"),
        event("m.reaction", state=False),
        event("m.room.join_rules", join_rule="invite"),
        event("m.room.history_visibility", history_visibility="shared"),
        event("m.room.name", name="Lunch"),
        event("m.room.power_levels", users={ALICE: 100}),
        event("io.kodera.room.occupancy", sender=AGENT),
        event("m.room.join_rules", sender=AGENT, join_rule="public"),
    ],
    ids=lambda e: f"{e.type}:{e.sender}",
)
def test_ordinary_events_pass(allowed):
    assert run(policy().check_event_for_spam(allowed)) == ALLOWED


@pytest.mark.parametrize("count", [1, 2, 8])
def test_member_creates_bounded_private_group_direct_messages(count):
    invitees = [f"@member{i}:{SERVER}" for i in range(count)]
    configured = policy()
    request = dm_request(invite=invitees)
    assert run(configured.user_may_create_room(ALICE, request)) == ALLOWED


@pytest.mark.parametrize("frozen", [False, True])
def test_group_dm_invites_are_bound_to_immutable_creation_state(frozen):
    invitees = [f"@member{i}:{SERVER}" for i in range(8)]
    configured = policy()
    request = dm_request(invite=invitees, creation_content={"io.kodera.dm.invitees": [OUTSIDER]})
    requester = SimpleNamespace(user=SimpleNamespace(to_string=lambda: ALICE))
    run(configured.on_create_room(requester, request, False))
    assert request["creation_content"]["io.kodera.dm.invitees"] == invitees
    state = state_of(ALICE, [ALICE])
    state[("m.room.create", "")].content = {"io.kodera.dm.invitees": tuple(invitees)} if frozen else request["creation_content"]
    configured._api.rooms["!group"] = state
    for invitee in invitees:
        assert run(configured.user_may_invite(ALICE, invitee, "!group")) == ALLOWED
        state[("m.room.member", invitee)] = SimpleNamespace(content={"membership": "invite"})
    assert run(configured.user_may_invite(ALICE, CAROL, "!group")) == FORBIDDEN
    assert run(configured.user_may_invite(invitees[0], BOB, "!group")) == FORBIDDEN
    assert run(configured.user_may_invite(ALICE, OUTSIDER, "!group")) == FORBIDDEN


@pytest.mark.parametrize("invitees", [[], [BOB] * 9, [BOB, OUTSIDER], [BOB, AGENT], [BOB, ROOM_ACCESS], [BOB, ALICE], [BOB, "bob"]])
def test_malformed_group_dm_creation_state_fails_closed(invitees):
    state = state_of(ALICE, [ALICE])
    state[("m.room.create", "")].content = {"io.kodera.dm.invitees": invitees}
    configured = KoderaPolicy({"agent_user_id": AGENT, "room_access_user_id": ROOM_ACCESS}, FakeApi({"!group": state}))
    assert run(configured.user_may_invite(ALICE, BOB, "!group")) == FORBIDDEN


@pytest.mark.parametrize("blocked", [ALICE, BOB])
@pytest.mark.parametrize("status", [None, {"is_deactivated": True}, {"is_guest": True}, {"approved": False}, {"locked": True}, {"suspended": True}])
def test_dm_creation_and_invites_require_active_registered_local_accounts(blocked, status):
    users = {user: SimpleNamespace(is_deactivated=False, is_guest=False, approved=True, locked=False, suspended=False) for user in (ALICE, BOB)}
    if status is None:
        del users[blocked]
    else:
        for key, value in status.items():
            setattr(users[blocked], key, value)
    state = state_of(ALICE, [ALICE])
    state[("m.room.create", "")].content = {"io.kodera.dm.invitees": [BOB]}
    configured = KoderaPolicy({"agent_user_id": AGENT}, FakeApi({"!dm": state}, users=users))
    assert run(configured.user_may_create_room(ALICE, dm_request())) == FORBIDDEN
    assert run(configured.user_may_invite(ALICE, BOB, "!dm")) == FORBIDDEN
