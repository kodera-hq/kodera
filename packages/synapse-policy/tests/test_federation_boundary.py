"""Unknown and foreign-homed rooms fail closed across partner and open federation modes."""

from types import SimpleNamespace

import pytest
from test_federation import PARTNER, PARTNERS, ROOM, partner_state, room_policy
from test_policy import (
    AGENT,
    ALICE,
    ALLOWED,
    BOB,
    FORBIDDEN,
    OUTSIDER,
    FakeApi,
    KoderaPolicy,
    event,
    run,
    state_of,
)


def make_policy(rooms, mode):
    config = {"agent_user_id": AGENT}
    if mode == "partner":
        config["federation_domain_allowlist"] = PARTNERS
    else:
        config["federation_mode"] = mode
    return KoderaPolicy(config, FakeApi(rooms))


@pytest.mark.parametrize("mode", ["partner", "open"])
@pytest.mark.parametrize(
    "state",
    [
        {},
        {("m.room.create", ""): SimpleNamespace(sender=PARTNER, content={"m.federate": True})},
        {("m.room.create", ""): SimpleNamespace(sender=OUTSIDER, content={"m.federate": True})},
    ],
    ids=["empty-local-state", "remote-partner-creator", "remote-outsider-creator"],
)
def test_local_member_cannot_join_unknown_or_foreign_homed_room(mode, state):
    configured = make_policy({ROOM: state}, mode)
    for invited in (False, True):
        assert run(configured.user_may_join_room(ALICE, ROOM, invited)) == FORBIDDEN
    assert run(configured.user_may_join_room(AGENT, ROOM, False)) == ALLOWED


@pytest.mark.parametrize("mode", ["partner", "open"])
def test_local_member_joins_agent_internal_and_partner_rooms_and_validated_dm(mode):
    dm = state_of(ALICE, [ALICE])
    dm[("m.room.create", "")].content = {"io.kodera.dm.invitees": [BOB]}
    dm[("m.room.member", BOB)] = SimpleNamespace(content={"membership": "invite"})
    rooms = {
        "!internal:acme-sa.kodera.io": room_policy(),
        "!partner:acme-sa.kodera.io": partner_state(),
        "!dm:acme-sa.kodera.io": dm,
    }
    configured = make_policy(rooms, mode)
    assert run(configured.user_may_join_room(ALICE, "!internal:acme-sa.kodera.io", True)) == ALLOWED
    assert run(configured.user_may_join_room(ALICE, "!partner:acme-sa.kodera.io", True)) == ALLOWED
    assert run(configured.user_may_join_room(BOB, "!dm:acme-sa.kodera.io", True)) == ALLOWED


@pytest.mark.parametrize("mode", ["partner", "open"])
def test_local_member_events_in_foreign_homed_room_are_refused(mode):
    foreign = {
        ("m.room.create", ""): SimpleNamespace(sender=PARTNER, content={"m.federate": True}),
        ("m.room.member", ALICE): SimpleNamespace(content={"membership": "join"}),
    }
    configured = make_policy({ROOM: foreign}, mode)
    msg = event("m.room.message", ALICE, state=False, body="outbound")
    msg.room_id = ROOM
    assert run(configured.check_event_allowed(msg, foreign)) == (False, None)
    assert run(configured.check_event_for_spam(msg)) == FORBIDDEN
    leave = event("m.room.member", ALICE, membership="leave")
    leave.state_key = ALICE
    leave.room_id = ROOM
    assert run(configured.check_event_allowed(leave, foreign)) == (True, None)


@pytest.mark.parametrize("sender", [ALICE, AGENT, PARTNER])
@pytest.mark.parametrize(
    "bad_state",
    [
        {},
        {("m.room.create", ""): SimpleNamespace(sender=None, content={})},
        {("m.room.create", ""): SimpleNamespace(sender="not-a-user-id", content={})},
        {("m.room.create", ""): SimpleNamespace(sender=AGENT, content=None)},
    ],
    ids=["missing-create", "null-creator", "malformed-creator", "redacted-null-content"],
)
def test_missing_or_malformed_room_create_state_fails_closed(sender, bad_state):
    configured = make_policy({ROOM: bad_state}, "partner")
    msg = event("m.room.message", sender, state=False, body="probe")
    msg.room_id = ROOM
    assert configured._governance_allows(msg, bad_state) is False
    assert run(configured.check_event_allowed(msg, bad_state)) == (False, None)
    assert run(configured.check_event_for_spam(msg)) == FORBIDDEN
    bad_room = event("m.room.message", sender, state=False, body="probe")
    bad_room.room_id = ""
    assert run(configured.check_event_for_spam(bad_room)) == FORBIDDEN
