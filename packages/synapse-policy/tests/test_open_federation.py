"""Open transport never grants wildcard room membership or overrides local governance."""

import pytest
from synapse.module_api.errors import ConfigError
from test_federation import PARTNER, ROOM, partner_state, room_policy
from test_policy import (
    AGENT,
    ALLOWED,
    FORBIDDEN,
    OUTSIDER,
    FakeApi,
    KoderaPolicy,
    event,
    run,
)


def configured(state, mode="open"):
    return KoderaPolicy(
        {"agent_user_id": AGENT, "federation_mode": mode}, FakeApi({ROOM: state})
    )


def test_explicit_open_mode_admits_room_pinned_public_servers_without_global_list():
    state = partner_state()
    policy = configured(state)
    assert run(policy.user_may_invite(AGENT, PARTNER, ROOM)) == ALLOWED
    assert run(policy.user_may_join_room(PARTNER, ROOM, True)) == ALLOWED
    incoming = event("m.room.message", PARTNER, state=False)
    incoming.room_id = ROOM
    assert run(policy.check_event_allowed(incoming, state)) == (True, None)
    assert run(policy.check_event_for_spam(incoming)) == ALLOWED
    assert run(policy.user_may_invite(AGENT, OUTSIDER, ROOM)) == FORBIDDEN
    assert run(policy.user_may_join_room(OUTSIDER, ROOM, True)) == FORBIDDEN


@pytest.mark.parametrize("mode", ["closed", "partner", "typo"])
def test_other_modes_never_gain_open_transport_authority(mode):
    policy = configured(partner_state(), mode)
    assert run(policy.user_may_join_room(PARTNER, ROOM, True)) == FORBIDDEN


def test_open_transport_does_not_widen_internal_rooms_or_room_acl():
    assert (
        run(configured(room_policy()).user_may_join_room(OUTSIDER, ROOM, True))
        == FORBIDDEN
    )
    state = partner_state()
    state[("m.room.server_acl", "")].content["allow"] = ["*"]
    assert run(configured(state).user_may_join_room(PARTNER, ROOM, True)) == FORBIDDEN


@pytest.mark.parametrize(
    "names",
    [
        ["*.example.org"],
        ["127.0.0.1"],
        ["partner.internal"],
        ["partner.example.org"] * 2,
        ["partner.example.org:8448"],
    ],
)
def test_open_mode_keeps_public_name_validation_and_room_bound(names):
    state = partner_state()
    state[("io.kodera.room.policy", "")].content["federation_servers"] = names
    assert run(configured(state).user_may_join_room(PARTNER, ROOM, True)) == FORBIDDEN


@pytest.mark.parametrize(
    "config",
    [
        {"federation_mode": "typo"},
        {"federation_mode": []},
        {"federation_mode": "partner"},
        {
            "federation_mode": "closed",
            "federation_domain_allowlist": ["partner.example.org"],
        },
        {
            "federation_mode": "open",
            "federation_domain_allowlist": ["partner.example.org"],
        },
    ],
)
def test_invalid_or_ambiguous_federation_configuration_is_refused(config):
    with pytest.raises(ConfigError, match="federation_mode"):
        KoderaPolicy.parse_config({"agent_user_id": AGENT, **config})


def test_explicit_open_configuration_round_trips_without_a_global_list():
    assert (
        KoderaPolicy.parse_config({"agent_user_id": AGENT, "federation_mode": "open"})[
            "federation_mode"
        ]
        == "open"
    )
