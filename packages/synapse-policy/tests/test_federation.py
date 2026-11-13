"""Internal isolation precedes trusted-agent reconciliation and stale remote membership."""

from types import SimpleNamespace

import pytest
from synapse.module_api.errors import ConfigError, SynapseError

from test_policy import (
    AGENT,
    ALICE,
    BOB,
    OUTSIDER,
    ALLOWED,
    FORBIDDEN,
    FakeApi,
    KoderaPolicy,
    event,
    run,
)

ROOM = "!boundary:acme-sa.kodera.io"


def room_policy(**changes):
    content = {
        "version": 1,
        "kind": "text",
        "read_only": False,
        "audience": "all",
        "members": [],
        "exempt": [],
        "local_only": True,
        "allow_member_invites": False,
        "allow_federated_invites": False,
    }
    content.update(changes)
    return {
        ("m.room.create", ""): SimpleNamespace(
            sender=AGENT, content={"m.federate": False}
        ),
        ("io.kodera.room.policy", ""): SimpleNamespace(sender=AGENT, content=content),
        ("m.room.member", ALICE): SimpleNamespace(content={"membership": "join"}),
        ("m.room.member", OUTSIDER): SimpleNamespace(content={"membership": "join"}),
    }


def callbacks(state, incoming):
    incoming.room_id = ROOM
    configured = KoderaPolicy({"agent_user_id": AGENT}, FakeApi({ROOM: state}))
    return run(configured.check_event_allowed(incoming, state))[0], run(
        configured.check_event_for_spam(incoming)
    )


def test_agent_cannot_invite_remote_users_into_internal_rooms():
    configured = KoderaPolicy({"agent_user_id": AGENT}, FakeApi({ROOM: room_policy()}))
    assert run(configured.user_may_invite(AGENT, OUTSIDER, ROOM)) == FORBIDDEN
    assert run(configured.user_may_invite(AGENT, BOB, ROOM)) == ALLOWED


@pytest.mark.parametrize(
    "kind,state",
    [
        ("m.room.message", False),
        ("m.reaction", False),
        ("m.sticker", False),
        ("m.room.topic", True),
        ("m.room.redaction", False),
    ],
)
def test_previously_joined_remote_sender_cannot_post_inside_internal_room(kind, state):
    assert callbacks(room_policy(), event(kind, OUTSIDER, state=state)) == (
        False,
        FORBIDDEN,
    )


def test_local_only_is_enforced_without_other_governance_fields():
    state = room_policy()
    state[("io.kodera.room.policy", "")].content = {
        "version": 1,
        "kind": "text",
        "local_only": True,
    }
    configured = KoderaPolicy({"agent_user_id": AGENT}, FakeApi({ROOM: state}))
    assert run(configured.user_may_join_room(OUTSIDER, ROOM, True)) == FORBIDDEN
    assert callbacks(state, event("m.room.message", OUTSIDER, state=False)) == (
        False,
        FORBIDDEN,
    )


def test_federation_policy_must_be_authored_by_trusted_agent_even_without_governance():
    state = room_policy()
    state[("io.kodera.room.policy", "")] = SimpleNamespace(
        sender=ALICE,
        content={
            "version": 1,
            "kind": "text",
            "allow_member_invites": True,
            "allow_federated_invites": True,
        },
    )
    configured = KoderaPolicy({"agent_user_id": AGENT}, FakeApi({ROOM: state}))
    assert run(configured.user_may_invite(ALICE, OUTSIDER, ROOM)) == FORBIDDEN


@pytest.mark.parametrize("membership", ["invite", "join", "knock"])
def test_agent_event_bypass_never_admits_remote_membership_to_internal_room(membership):
    incoming = event("m.room.member", AGENT, membership=membership)
    incoming.state_key = OUTSIDER
    assert callbacks(room_policy(), incoming) == (False, FORBIDDEN)


def test_internal_boundary_preserves_local_agent_control_and_remote_cleanup():
    state = room_policy()
    for kind in ("io.kodera.room.policy", "m.room.power_levels", "m.room.topic"):
        assert callbacks(state, event(kind, AGENT)) == (True, ALLOWED)
    for membership in ("leave", "ban"):
        incoming = event("m.room.member", AGENT, membership=membership)
        incoming.state_key = OUTSIDER
        assert callbacks(state, incoming) == (True, ALLOWED)


PARTNER = "@partner:partner.example.org"
PARTNERS = ["partner.example.org"]


def partner_state():
    from kodera_synapse_policy.federation import MODE, acl

    state = room_policy(
        local_only=False,
        allow_member_invites=True,
        allow_federated_invites=True,
        federation_servers=PARTNERS,
    )
    state[("m.room.create", "")].content = {"m.federate": True, MODE: "partner"}
    state[("m.room.server_acl", "")] = SimpleNamespace(
        sender=AGENT, content=acl(AGENT.partition(":")[2], tuple(PARTNERS))
    )
    state[("m.room.member", PARTNER)] = SimpleNamespace(content={"membership": "join"})
    return state


def configured_partner(state):
    return KoderaPolicy(
        {"agent_user_id": AGENT, "federation_domain_allowlist": PARTNERS},
        FakeApi({ROOM: state}),
    )


def test_trusted_bounded_partner_room_admits_remote_invite_join_and_timeline():
    state = partner_state()
    configured = configured_partner(state)
    for inviter in (AGENT, ALICE, PARTNER):
        assert run(configured.user_may_invite(inviter, PARTNER, ROOM)) == ALLOWED
    assert run(configured.user_may_join_room(PARTNER, ROOM, True)) == ALLOWED
    incoming = event("m.room.message", PARTNER, state=False)
    incoming.room_id = ROOM
    assert run(configured.check_event_allowed(incoming, state))[0]
    assert run(configured.check_event_for_spam(incoming)) == ALLOWED
    assert run(configured.user_may_invite(AGENT, OUTSIDER, ROOM)) == FORBIDDEN


@pytest.mark.parametrize(
    "field,value",
    [
        ("local_only", True),
        ("local_only", "false"),
        ("allow_member_invites", False),
        ("allow_federated_invites", False),
        ("allow_federated_invites", 1),
        ("read_only", True),
        ("audience", "listed"),
        ("kind", "audio"),
        ("version", True),
        ("archived", True),
        ("federation_servers", []),
        ("federation_servers", ["*.example.org"]),
        ("federation_servers", ["127.0.0.1"]),
        ("federation_servers", ["partner.example.org:8448"]),
        ("federation_servers", ["unlisted.example.org"]),
        ("federation_servers", ["partner.example.org"] * 2),
    ],
)
def test_partner_policy_field_mutations_fail_closed(field, value):
    state = partner_state()
    state[("io.kodera.room.policy", "")].content[field] = value
    configured = configured_partner(state)
    assert run(configured.user_may_invite(AGENT, PARTNER, ROOM)) == FORBIDDEN
    assert run(configured.user_may_join_room(PARTNER, ROOM, True)) == FORBIDDEN
    incoming = event("m.room.message", PARTNER, state=False)
    assert not run(configured.check_event_allowed(incoming, state))[0]


@pytest.mark.parametrize(
    "mutation",
    [
        "author",
        "creator",
        "immutable-mode",
        "immutable-disabled",
        "acl-missing",
        "acl-wide",
        "global-disabled",
    ],
)
def test_partner_author_creation_acl_and_global_boundaries_are_independent(mutation):
    state = partner_state()
    if mutation == "author":
        state[("io.kodera.room.policy", "")].sender = ALICE
    elif mutation == "creator":
        state[("m.room.create", "")].sender = ALICE
    elif mutation == "immutable-mode":
        state[("m.room.create", "")].content.pop("io.kodera.room.federation")
    elif mutation == "immutable-disabled":
        state[("m.room.create", "")].content["m.federate"] = False
    elif mutation == "acl-missing":
        state.pop(("m.room.server_acl", ""))
    elif mutation == "acl-wide":
        state[("m.room.server_acl", "")].content["allow"] = ["*"]
    configured = (
        configured_partner(state)
        if mutation != "global-disabled"
        else KoderaPolicy({"agent_user_id": AGENT}, FakeApi({ROOM: state}))
    )
    assert run(configured.user_may_invite(AGENT, PARTNER, ROOM)) == FORBIDDEN
    incoming = event("m.room.message", PARTNER, state=False)
    assert not run(configured.check_event_allowed(incoming, state))[0]


@pytest.mark.parametrize(
    "servers",
    [
        None,
        "partner.example.org",
        ["*"],
        ["partner.local"],
        ["partner.test"],
        ["partner.internal"],
        ["[::1]"],
        ["127.0.0.1"],
        ["partner.example.org:8448"],
        ["partner.example.org"] * 2,
        [f"p{i}.example.org" for i in range(33)],
    ],
)
def test_public_server_allowlist_configuration_refusals_name_boundary(servers):
    with pytest.raises(ConfigError, match="federation_domain_allowlist"):
        KoderaPolicy.parse_config(
            {"agent_user_id": AGENT, "federation_domain_allowlist": servers}
        )


def requester(user):
    return SimpleNamespace(user=SimpleNamespace(to_string=lambda: user))


def test_creation_defaults_to_immutable_internal_mode_and_local_acl():
    from kodera_synapse_policy.federation import MODE, acl

    request = {"preset": "private_chat", "creation_content": {"m.federate": True}}
    configured = configured_partner({})
    run(configured.on_create_room(requester(AGENT), request, True))
    assert request["creation_content"] == {
        "m.federate": False,
        MODE: "internal",
        "io.kodera.room.initial_partner_servers": [],
    }
    assert request["initial_state"] == [
        {
            "type": "m.room.server_acl",
            "state_key": "",
            "content": acl(AGENT.partition(":")[2]),
        }
    ]


def partner_creation():
    return {
        "preset": "private_chat",
        "visibility": "private",
        "creation_content": {
            "m.federate": True,
            "io.kodera.room.federation": "partner",
        },
        "initial_state": [
            {
                "type": "io.kodera.room.policy",
                "state_key": "",
                "content": dict(partner_state()[("io.kodera.room.policy", "")].content),
            }
        ],
    }


def test_explicit_partner_creation_has_pinned_mode_policy_and_server_acl():
    from kodera_synapse_policy.federation import acl

    request = partner_creation()
    run(configured_partner({}).on_create_room(requester(AGENT), request, True))
    assert request["creation_content"]["m.federate"] is True
    assert (
        request["creation_content"]["io.kodera.room.initial_partner_servers"]
        == PARTNERS
    )
    assert request["initial_state"][-1]["content"] == acl(
        AGENT.partition(":")[2], tuple(PARTNERS)
    )


@pytest.mark.parametrize(
    "mutation",
    [
        "non-agent",
        "no-policy",
        "private-audience",
        "readonly",
        "public",
        "no-marker",
        "wide-acl",
    ],
)
def test_partner_creation_refusals_have_expected_diagnostic(mutation):
    request = partner_creation()
    user = AGENT
    if mutation == "non-agent":
        user = ALICE
    elif mutation == "no-policy":
        request["initial_state"] = []
    elif mutation == "private-audience":
        request["initial_state"][0]["content"]["audience"] = "listed"
    elif mutation == "readonly":
        request["initial_state"][0]["content"]["read_only"] = True
    elif mutation == "public":
        request["visibility"] = "public"
    elif mutation == "no-marker":
        request["creation_content"].pop("io.kodera.room.federation")
    elif mutation == "wide-acl":
        request["initial_state"].append(
            {"type": "m.room.server_acl", "state_key": "", "content": {"allow": ["*"]}}
        )
    diagnostic = (
        "Members may create only validated local direct messages"
        if mutation == "non-agent"
        else "Internal rooms cannot enable partner federation"
        if mutation == "no-marker"
        else "Room server ACL"
        if mutation == "wide-acl"
        else "Partner federation requires"
    )
    with pytest.raises(SynapseError, match=diagnostic) as refusal:
        run(
            configured_partner({}).on_create_room(
                requester(user), request, user == AGENT
            )
        )
    assert refusal.value.code == 403


def test_frozen_partner_state_preserves_bounded_federation():
    from types import MappingProxyType

    state = partner_state()
    for kind in ("io.kodera.room.policy", "m.room.server_acl"):
        item = state[(kind, "")]
        item.content = MappingProxyType(
            {
                key: tuple(value) if isinstance(value, list) else value
                for key, value in item.content.items()
            }
        )
    assert (
        run(configured_partner(state).user_may_invite(AGENT, PARTNER, ROOM)) == ALLOWED
    )


def test_internal_mode_cannot_be_upgraded_by_valid_mutable_partner_policy():
    state = partner_state()
    state[("m.room.create", "")].content = {
        "m.federate": False,
        "io.kodera.room.federation": "internal",
    }
    incoming = event("io.kodera.room.policy", AGENT)
    incoming.content = dict(partner_state()[("io.kodera.room.policy", "")].content)
    assert not run(configured_partner(state).check_event_allowed(incoming, state))[0]


def test_agent_acl_write_cannot_widen_exact_partner_boundary():
    state = partner_state()
    incoming = event("m.room.server_acl", AGENT)
    incoming.content = {"allow": ["*"], "deny": [], "allow_ip_literals": False}
    assert not run(configured_partner(state).check_event_allowed(incoming, state))[0]


def test_partner_join_rule_is_invite_only_even_for_agent():
    state = partner_state()
    incoming = event("m.room.join_rules", AGENT)
    incoming.content = {"join_rule": "public"}
    assert not run(configured_partner(state).check_event_allowed(incoming, state))[0]
    incoming.content = {"join_rule": "invite"}
    assert run(configured_partner(state).check_event_allowed(incoming, state))[0]


def test_initial_acl_bootstrap_uses_trusted_immutable_servers_without_remote_admission():
    from kodera_synapse_policy.federation import acl

    state = partner_state()
    state.pop(("io.kodera.room.policy", ""))
    state.pop(("m.room.server_acl", ""))
    state[("m.room.create", "")].content["io.kodera.room.initial_partner_servers"] = (
        PARTNERS
    )
    incoming = event("m.room.server_acl", AGENT)
    incoming.content = acl(AGENT.partition(":")[2], tuple(PARTNERS))
    configured = configured_partner(state)
    assert run(configured.check_event_allowed(incoming, state))[0]
    assert run(configured.user_may_invite(AGENT, PARTNER, ROOM)) == FORBIDDEN
    for change in (
        "untrusted-creator",
        "missing-servers",
        "global-disabled",
        "wide-acl",
    ):
        altered = partner_state()
        altered.pop(("io.kodera.room.policy", ""))
        altered[("m.room.create", "")].content[
            "io.kodera.room.initial_partner_servers"
        ] = PARTNERS
        candidate = event("m.room.server_acl", AGENT)
        candidate.content = dict(incoming.content)
        instance = configured_partner(altered)
        if change == "untrusted-creator":
            altered[("m.room.create", "")].sender = ALICE
        elif change == "missing-servers":
            altered[("m.room.create", "")].content.pop(
                "io.kodera.room.initial_partner_servers"
            )
        elif change == "global-disabled":
            instance = KoderaPolicy({"agent_user_id": AGENT}, FakeApi())
        elif change == "wide-acl":
            candidate.content["allow"] = ["*"]
        assert not run(instance.check_event_allowed(candidate, altered))[0], change


def test_raw_dm_validation_precedes_injected_acl_projection():
    from kodera_synapse_policy.federation import acl

    configured = configured_partner({})
    raw = {
        "is_direct": True,
        "invite": [BOB],
        "preset": "private_chat",
        "visibility": "private",
    }
    for extra in (
        [
            {
                "type": "m.room.server_acl",
                "state_key": "",
                "content": acl(AGENT.partition(":")[2]),
            }
        ],
        [{"type": "m.room.topic", "state_key": "", "content": {}}],
    ):
        forged = {**raw, "initial_state": extra}
        with pytest.raises(SynapseError, match="validated local direct messages"):
            run(configured.on_create_room(requester(ALICE), forged, False))
    run(configured.on_create_room(requester(ALICE), raw, False))
    assert run(configured.user_may_create_room(ALICE, raw)) == ALLOWED
