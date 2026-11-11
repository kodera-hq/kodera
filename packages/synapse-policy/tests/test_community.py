"""Community policy remains effective even with permissive native room power levels."""

from types import SimpleNamespace, MappingProxyType

import pytest

from test_policy import AGENT, ALICE, BOB, CAROL, ALLOWED, FORBIDDEN, FakeApi, KoderaPolicy, event, run

ROOM = "!community:example.test"


def governed(*, read_only=False, audience="all", members=None, exempt=None, sender=AGENT):
    return {
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
