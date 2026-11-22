"""Community policy remains effective even with permissive native room power levels."""

from types import SimpleNamespace, MappingProxyType

import pytest

from test_policy import AGENT, ALICE, BOB, CAROL, ALLOWED, FORBIDDEN, FakeApi, KoderaPolicy, event, run

ROOM = "!community:example.test"


def governed(*, read_only=False, audience="all", members=None, exempt=None, sender=AGENT):
    return {
        ("m.room.create", ""): SimpleNamespace(sender=AGENT),
        ("io.kodera.room.policy", ""): SimpleNamespace(sender=sender, content={
            "version": 1, "kind": "text", "read_only": read_only, "audience": audience,
            "members": members or [], "exempt": exempt or [], "allow_member_invites": True,
        }),
        ("m.room.power_levels", ""): SimpleNamespace(content={"users_default": 100, "state_default": 0, "users": {BOB: 50}}),
        ("m.room.member", ALICE): SimpleNamespace(content={"membership": "join"}),
        ("m.room.member", BOB): SimpleNamespace(content={"membership": "join"}),
    }


def both_callbacks(state, message):
    message.room_id = ROOM
    configured = KoderaPolicy({"agent_user_id": AGENT}, FakeApi({ROOM: state}))
    allowed, _ = run(configured.check_event_allowed(message, state))
    spam = run(configured.check_event_for_spam(message))
    return allowed, spam


@pytest.mark.parametrize("kind,is_state", [("m.room.message", False), ("m.sticker", False), ("m.room.topic", True), ("m.room.power_levels", True)])
def test_announcement_member_cannot_post_or_edit_even_with_permissive_levels(kind, is_state):
    assert both_callbacks(governed(read_only=True), event(kind, ALICE, state=is_state)) == (False, FORBIDDEN)


@pytest.mark.parametrize("sender", [AGENT, BOB, CAROL])
def test_announcement_agent_moderator_and_explicit_exempt_can_post(sender):
    assert both_callbacks(governed(read_only=True, exempt=[CAROL]), event("m.room.message", sender, state=False)) == (True, ALLOWED)


def test_announcement_member_can_react_and_join_or_leave():
    state = governed(read_only=True)
    assert both_callbacks(state, event("m.reaction", ALICE, state=False)) == (True, ALLOWED)
    for membership in ("join", "leave"):
        member = event("m.room.member", ALICE, membership=membership)
        member.state_key = ALICE
        assert both_callbacks(state, member) == (True, ALLOWED)


def test_explicit_power_requires_joined_membership_and_integer_level():
    state = governed(read_only=True)
    state[("m.room.member", BOB)].content["membership"] = "leave"
    assert both_callbacks(state, event("m.room.message", BOB, state=False)) == (False, FORBIDDEN)
    state[("m.room.member", BOB)].content["membership"] = "join"
    state[("m.room.power_levels", "")].content["users"][BOB] = "100"
    assert both_callbacks(state, event("m.room.message", BOB, state=False)) == (False, FORBIDDEN)


@pytest.mark.parametrize("membership", ["join", "invite", "knock"])
def test_private_room_refuses_unlisted_membership_even_with_invitation(membership):
    state = governed(audience="listed", members=[BOB])
    member = event("m.room.member", BOB if membership == "invite" else ALICE, membership=membership)
    member.state_key = ALICE
    assert both_callbacks(state, member) == (False, FORBIDDEN)


def test_private_room_allows_explicit_member_and_agent():
    state = governed(audience="listed", members=[BOB])
    member = event("m.room.member", BOB, membership="join")
    member.state_key = BOB
    assert both_callbacks(state, member) == (True, ALLOWED)
    assert both_callbacks(state, event("m.room.message", AGENT, state=False)) == (True, ALLOWED)
    assert both_callbacks(state, event("m.room.message", ALICE, state=False)) == (False, FORBIDDEN)


def test_private_room_cannot_be_opened_through_member_invite_policy():
    state = governed(audience="listed", members=[BOB, CAROL])
    configured = KoderaPolicy({"agent_user_id": AGENT}, FakeApi({ROOM: state}))
    assert run(configured.user_may_invite(ALICE, CAROL, ROOM)) == FORBIDDEN
    assert run(configured.user_may_invite(BOB, ALICE, ROOM)) == FORBIDDEN
    assert run(configured.user_may_invite(BOB, CAROL, ROOM)) == ALLOWED
    assert run(configured.user_may_invite(AGENT, CAROL, ROOM)) == ALLOWED
    for invited in (True, False):
        assert run(configured.user_may_join_room(ALICE, ROOM, invited)) == FORBIDDEN
        assert run(configured.user_may_join_room(BOB, ROOM, invited)) == ALLOWED


@pytest.mark.parametrize("changes", [
    {"audience": "public"}, {"audience": []}, {"read_only": "false"},
    {"members": "*"}, {"members": ["*"]}, {"exempt": [None]},
    {"audience": "listed", "members": [BOB], "exempt": [ALICE]},
])
def test_malformed_governance_fails_closed(changes):
    state = governed()
    state[("io.kodera.room.policy", "")].content.update(changes)
    assert both_callbacks(state, event("m.room.message", ALICE, state=False)) == (False, FORBIDDEN)


def test_untrusted_governance_author_fails_closed():
    assert both_callbacks(governed(sender=ALICE), event("m.room.message", ALICE, state=False)) == (False, FORBIDDEN)


def test_frozen_synapse_event_content_enforces_governance():
    state = governed(read_only=True, audience="listed", members=[ALICE, BOB])
    policy = state[("io.kodera.room.policy", "")]
    policy.content = MappingProxyType({**policy.content, "members": (ALICE, BOB), "exempt": ()})
    assert both_callbacks(state, event("m.room.message", ALICE, state=False)) == (False, FORBIDDEN)
    configured = KoderaPolicy({"agent_user_id": AGENT}, FakeApi({ROOM: state}))
    assert run(configured.user_may_join_room(CAROL, ROOM, True)) == FORBIDDEN


@pytest.mark.parametrize("invited", [False, True])
def test_public_local_only_room_refuses_remote_native_join(invited):
    state = governed()
    state[("io.kodera.room.policy", "")].content["local_only"] = True
    configured = KoderaPolicy({"agent_user_id": AGENT}, FakeApi({ROOM: state}))
    assert run(configured.user_may_join_room(ALICE, ROOM, invited)) == ALLOWED
    remote = "@visitor:remote.example.org"
    assert run(configured.user_may_join_room(remote, ROOM, invited)) == FORBIDDEN
    member = event("m.room.member", remote, membership="join")
    member.state_key = remote
    assert both_callbacks(state, member) == (False, FORBIDDEN)


def test_public_local_only_flag_must_be_boolean():
    state = governed()
    state[("io.kodera.room.policy", "")].content["local_only"] = "false"
    assert both_callbacks(state, event("m.room.message", ALICE, state=False)) == (False, FORBIDDEN)


def test_archived_public_room_refuses_rejoin_and_post_but_allows_leave():
    state = governed()
    state[("io.kodera.room.policy", "")].content.update(local_only=True, archived=True)
    configured = KoderaPolicy({"agent_user_id": AGENT}, FakeApi({ROOM: state}))
    assert run(configured.user_may_join_room(ALICE, ROOM, False)) == FORBIDDEN
    assert both_callbacks(state, event("m.room.message", ALICE, state=False)) == (False, FORBIDDEN)
    for membership, expected in [("join", (False, FORBIDDEN)), ("leave", (True, ALLOWED))]:
        member = event("m.room.member", ALICE, membership=membership)
        member.state_key = ALICE
        assert both_callbacks(state, member) == expected


@pytest.mark.parametrize('invited', [True, False])
def test_workspace_ban_refuses_native_public_join_and_post(invited):
    state = governed()
    state[("io.kodera.room.policy", "")].content['banned'] = [ALICE]
    policy = KoderaPolicy({'agent_user_id': AGENT}, FakeApi({ROOM: state}))
    assert run(policy.user_may_join_room(ALICE, ROOM, invited)) == FORBIDDEN
    assert both_callbacks(state, event('m.room.message', ALICE, state=False)) == (False, FORBIDDEN)
    joining = event('m.room.member', ALICE, membership='join')
    joining.state_key = ALICE
    assert both_callbacks(state, joining) == (False, FORBIDDEN)
    leaving = event('m.room.member', ALICE, membership='leave')
    leaving.state_key = ALICE
    assert both_callbacks(state, leaving) == (True, ALLOWED)


def test_workspace_mute_uses_server_time_even_for_exempt_member():
    from datetime import UTC, datetime, timedelta
    state = governed(exempt=[ALICE])
    content = state[("io.kodera.room.policy", "")].content
    content['muted_until'] = {ALICE: (datetime.now(UTC) + timedelta(minutes=5)).isoformat()}
    for kind, is_state in (
        ('m.room.message', False),
        ('m.reaction', False),
        ('io.kodera.custom', False),
        ('m.room.topic', True),
    ):
        assert both_callbacks(state, event(kind, ALICE, state=is_state)) == (False, FORBIDDEN)
    configured = KoderaPolicy({'agent_user_id': AGENT}, FakeApi({ROOM: state}))
    assert run(configured.user_may_invite(ALICE, CAROL, ROOM)) == FORBIDDEN
    leaving = event('m.room.member', ALICE, membership='leave')
    leaving.state_key = ALICE
    assert both_callbacks(state, leaving) == (True, ALLOWED)
    content['muted_until'][ALICE] = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
    assert both_callbacks(state, event('m.room.message', ALICE, state=False)) == (True, ALLOWED)
    assert both_callbacks(state, event('m.reaction', ALICE, state=False)) == (True, ALLOWED)
    assert run(configured.user_may_invite(ALICE, CAROL, ROOM)) == ALLOWED
    content['muted_until'][ALICE] = 'invalid'
    assert both_callbacks(state, event('m.room.message', ALICE, state=False)) == (False, FORBIDDEN)


def test_room_access_joins_a_listed_audio_room():
    room_access = "@rooms:" + AGENT.split(":", 1)[1]
    state = governed(audience="listed", members=[BOB])
    state[("io.kodera.room.policy", "")].content.update(kind="audio", local_members=[BOB])
    configured = KoderaPolicy(
        {"agent_user_id": AGENT, "room_access_user_id": room_access}, FakeApi({ROOM: state})
    )
    assert run(configured.user_may_invite(AGENT, room_access, ROOM)) == ALLOWED
    assert run(configured.user_may_invite(BOB, room_access, ROOM)) == FORBIDDEN
    for invited in (False, True):
        assert run(configured.user_may_join_room(room_access, ROOM, invited)) == ALLOWED
        assert run(configured.user_may_join_room(CAROL, ROOM, invited)) == FORBIDDEN
    for membership in ("join", "invite", "knock"):
        member = event("m.room.member", room_access, membership=membership)
        member.state_key = room_access
        member.room_id = ROOM
        allowed, _ = run(configured.check_event_allowed(member, state))
        assert allowed is (membership == "join")
    message = event("m.room.message", room_access, state=False)
    message.room_id = ROOM
    assert run(configured.check_event_allowed(message, state))[0] is False
    assert run(configured.check_event_for_spam(message)) == FORBIDDEN


def test_room_access_cannot_use_audio_join_exemption_in_text_room():
    room_access = "@rooms:" + AGENT.split(":", 1)[1]
    state = governed(audience="listed", members=[BOB])
    state[("io.kodera.room.policy", "")].content.update(kind="text", local_members=[BOB])
    configured = KoderaPolicy(
        {"agent_user_id": AGENT, "room_access_user_id": room_access}, FakeApi({ROOM: state})
    )
    assert run(configured.user_may_invite(AGENT, room_access, ROOM)) == FORBIDDEN
    assert run(configured.user_may_join_room(room_access, ROOM, True)) == FORBIDDEN
    member = event("m.room.member", room_access, membership="join")
    member.state_key = room_access
    member.room_id = ROOM
    assert run(configured.check_event_allowed(member, state))[0] is False


def test_agent_room_access_invite_requires_current_trusted_audio_policy():
    room_access = "@rooms:" + AGENT.split(":", 1)[1]
    for change in ("missing", "untrusted", "archived", "banned", "text"):
        state = governed(audience="listed", members=[BOB])
        policy = state[("io.kodera.room.policy", "")]
        policy.content.update(kind="audio", local_members=[BOB])
        if change == "missing":
            state.clear()
        elif change == "untrusted":
            policy.sender = CAROL
        elif change == "archived":
            policy.content["archived"] = True
        elif change == "banned":
            policy.content["banned"] = [room_access]
        else:
            policy.content["kind"] = "text"
        configured = KoderaPolicy(
            {"agent_user_id": AGENT, "room_access_user_id": room_access}, FakeApi({ROOM: state})
        )
        assert run(configured.user_may_invite(AGENT, room_access, ROOM)) == FORBIDDEN


@pytest.mark.parametrize("audience,read_only", [("listed", False), ("all", True), ("listed", True)])
@pytest.mark.parametrize("kind", ["audio", "text"])
def test_active_audio_occupancy_is_scoped_to_room_access(audience, read_only, kind):
    from kodera_synapse_policy import OCCUPANCY

    room_access = "@rooms:" + AGENT.split(":", 1)[1]
    state = governed(audience=audience, read_only=read_only, members=[BOB])
    state[("io.kodera.room.policy", "")].content.update(kind=kind, local_members=[BOB])
    state[("m.room.power_levels", "")].content["users"][room_access] = 10
    configured = KoderaPolicy(
        {"agent_user_id": AGENT, "room_access_user_id": room_access}, FakeApi({ROOM: state})
    )
    for sender, event_type, state_key, is_state in (
        (room_access, OCCUPANCY, "", True), (BOB, OCCUPANCY, "", True),
        (room_access, OCCUPANCY, "other", True),
        (room_access, OCCUPANCY, "", False),
        (room_access, "m.room.message", "", False),
    ):
        message = event(event_type, sender, state=is_state)
        message.state_key = state_key
        message.room_id = ROOM
        allowed = kind == "audio" and sender == room_access and event_type == OCCUPANCY and state_key == "" and is_state
        assert run(configured.check_event_allowed(message, state))[0] is allowed
        assert run(configured.check_event_for_spam(message)) == (ALLOWED if allowed else FORBIDDEN)
