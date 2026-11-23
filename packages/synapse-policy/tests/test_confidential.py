"""Confidential timeline payloads never reach storage through either event callback."""

from types import MappingProxyType, SimpleNamespace

import pytest
from kodera_synapse_policy.confidential import CONFIDENTIAL
from synapse.module_api.errors import ConfigError, SynapseError
from test_community import governed
from test_policy import (
    AGENT,
    ALICE,
    ALLOWED,
    BOB,
    FORBIDDEN,
    FakeApi,
    KoderaPolicy,
    event,
    run,
)

ROOM = "!confidential:acme-sa.kodera.io"
MLS = "io.kodera.mls.v1"
MEGOLM = "m.megolm.v1.aes-sha2"


def confidential(algorithm=MLS):
    state = governed()
    state[("m.room.create", "")] = SimpleNamespace(
        sender=AGENT, content={CONFIDENTIAL: algorithm, "m.federate": False}
    )
    state[("m.room.encryption", "")] = SimpleNamespace(
        sender=AGENT, content={"algorithm": algorithm}
    )
    return state


def encrypted(algorithm=MLS, sender=ALICE, **changes):
    content = {"algorithm": algorithm, "ciphertext": "c2l4dGVlbi1ieXRlcy1vci1tb3Jl"}
    content.update(
        {"epoch": 1, "sender_device_key": "public-key"}
        if algorithm == MLS
        else {
            "sender_key": "public-key",
            "device_id": "device-1",
            "session_id": "session-1",
        }
    )
    content.update(changes)
    return event("m.room.encrypted", sender, state=False, **content)


def callbacks(state, incoming):
    incoming.room_id = ROOM
    policy = KoderaPolicy({"agent_user_id": AGENT}, FakeApi({ROOM: state}))
    return run(policy.check_event_allowed(incoming, state))[0], run(
        policy.check_event_for_spam(incoming)
    )


@pytest.mark.parametrize("algorithm", [MLS, MEGOLM])
def test_matching_confidential_ciphertext_is_accepted_on_both_callbacks(algorithm):
    assert callbacks(confidential(algorithm), encrypted(algorithm)) == (True, ALLOWED)


@pytest.mark.parametrize("sender", [AGENT, ALICE])
@pytest.mark.parametrize(
    "kind",
    [
        "m.room.message",
        "m.sticker",
        "m.reaction",
        "custom.cleartext",
        "m.room.redaction",
    ],
)
def test_no_cleartext_timeline_type_or_agent_exemption(sender, kind):
    assert callbacks(
        confidential(), event(kind, sender, state=False, body="sensitive text")
    ) == (False, FORBIDDEN)


@pytest.mark.parametrize(
    "changes",
    [
        {"body": "sensitive text"},
        {"ciphertext": "not ciphertext!"},
        {"ciphertext": "YQ"},
        {"epoch": True},
        {"epoch": -1},
        {"epoch": 2**64},
        {"sender_device_key": ""},
        {"algorithm": MEGOLM},
        {"ciphertext": "a" * 131_076},
    ],
)
def test_ciphertext_envelope_refuses_plaintext_fields_malformed_or_unbounded_data(
    changes,
):
    assert callbacks(confidential(), encrypted(**changes)) == (False, FORBIDDEN)


@pytest.mark.parametrize(
    "field",
    [
        "create_author",
        "missing_encryption",
        "wrong_encryption",
        "encryption_author",
        "malformed_marker",
    ],
)
def test_incomplete_or_untrusted_confidential_state_fails_closed(field):
    state = confidential()
    if field == "create_author":
        state[("m.room.create", "")].sender = ALICE
    elif field == "missing_encryption":
        del state[("m.room.encryption", "")]
    elif field == "wrong_encryption":
        state[("m.room.encryption", "")].content["algorithm"] = MEGOLM
    elif field == "encryption_author":
        state[("m.room.encryption", "")].sender = ALICE
    else:
        state[("m.room.create", "")].content[CONFIDENTIAL] = None
    assert callbacks(state, encrypted()) == (False, FORBIDDEN)


def test_ciphertext_is_never_an_ordinary_room_or_state_event():
    assert callbacks(governed(), encrypted()) == (False, FORBIDDEN)
    incoming = encrypted()
    incoming.is_state = lambda: True
    assert callbacks(confidential(), incoming) == (False, FORBIDDEN)


def test_ciphertext_algorithm_cannot_be_relabelled_with_original_schema():
    incoming = encrypted()
    incoming.content["algorithm"] = MEGOLM
    assert callbacks(confidential(), incoming) == (False, FORBIDDEN)


@pytest.mark.parametrize(
    "kind",
    ["m.room.message", "m.sticker", "m.reaction", "custom.cleartext", "m.room.topic"],
)
def test_state_key_cannot_smuggle_plaintext_timeline_payload(kind):
    assert callbacks(confidential(), event(kind, AGENT, body="private message")) == (
        False,
        FORBIDDEN,
    )


def test_ciphertext_obeys_mute_and_read_only_policies():
    state = confidential()
    state[("io.kodera.room.policy", "")].content["read_only"] = True
    assert callbacks(state, encrypted()) == (False, FORBIDDEN)
    assert callbacks(state, encrypted(sender=BOB)) == (True, ALLOWED)
    state[("io.kodera.room.policy", "")].content["read_only"] = False
    state[("io.kodera.room.policy", "")].content["muted_until"] = {
        ALICE: "9999-01-01T00:00:00Z"
    }
    assert callbacks(state, encrypted()) == (False, FORBIDDEN)


def test_confidential_state_cannot_enable_a_different_algorithm_or_untrusted_writer():
    for sender, algorithm in ((AGENT, MEGOLM), (ALICE, MLS)):
        assert callbacks(
            confidential(), event("m.room.encryption", sender, algorithm=algorithm)
        ) == (False, FORBIDDEN)
    assert callbacks(
        confidential(), event("m.room.encryption", AGENT, algorithm=MLS)
    ) == (True, ALLOWED)
    assert callbacks(governed(), event("m.room.encryption", AGENT, algorithm=MLS)) == (
        False,
        FORBIDDEN,
    )


@pytest.mark.parametrize("algorithm", [MLS, MEGOLM])
def test_only_trusted_agent_can_create_algorithm_bound_confidential_room(algorithm):
    configured = KoderaPolicy({"agent_user_id": AGENT}, FakeApi())
    request = {
        "creation_content": {CONFIDENTIAL: algorithm},
        "initial_state": [
            {
                "type": "m.room.encryption",
                "state_key": "",
                "content": {"algorithm": algorithm},
            }
        ],
    }
    requester = SimpleNamespace(user=SimpleNamespace(to_string=lambda: AGENT))
    run(configured.on_create_room(requester, request, True))
    assert run(configured.user_may_create_room(AGENT, request)) == ALLOWED
    assert run(configured.user_may_create_room(ALICE, request)) == FORBIDDEN
    request["initial_state"][0]["content"]["algorithm"] = "unsupported"
    with pytest.raises(SynapseError, match="Confidential rooms require"):
        run(configured.on_create_room(requester, request, True))


def test_frozen_confidential_state_has_the_same_refusal_boundary():
    state = confidential()
    for value in state.values():
        value.content = MappingProxyType(value.content)
    assert callbacks(state, encrypted()) == (True, ALLOWED)
    assert callbacks(state, event("m.room.message", state=False, body="private")) == (
        False,
        FORBIDDEN,
    )


def test_ai_user_ids_configuration_validates_distinct_matrix_identifiers():
    default_cfg = KoderaPolicy.parse_config({"agent_user_id": AGENT})
    assert default_cfg.get("ai_user_ids", []) == []
    configured = KoderaPolicy.parse_config(
        {"agent_user_id": AGENT, "ai_user_ids": [" @Custom-Scribe:acme-sa.kodera.io "]}
    )
    assert configured["ai_user_ids"] == ["@custom-scribe:acme-sa.kodera.io"]
    for invalid in (
        ("@custom-scribe:acme-sa.kodera.io",),
        ["bad-id"],
        [AGENT],
        [AGENT.upper()],
        ["@dup:acme-sa.kodera.io", "@DUP:acme-sa.kodera.io"],
        [f"@bot-{idx}:acme-sa.kodera.io" for idx in range(33)],
    ):
        with pytest.raises(ConfigError, match="ai_user_ids"):
            KoderaPolicy.parse_config({"agent_user_id": AGENT, "ai_user_ids": invalid})


def test_ai_actors_are_refused_in_confidential_dm_and_ai_disabled_rooms():
    configured_ai = "@Custom-Scribe:acme-sa.kodera.io"
    prefixed_ai = "@Kodera-AI-Transcriber:acme-sa.kodera.io"
    suffixed_ai = "@Summary_Bot:acme-sa.kodera.io"
    dm_room = "!dm:acme-sa.kodera.io"
    disabled_room = "!disabled:acme-sa.kodera.io"
    enabled_room = "!enabled:acme-sa.kodera.io"
    conf_ai_room = "!conf-ai:acme-sa.kodera.io"
    bad_flag_room = "!bad-flag:acme-sa.kodera.io"

    dm_state = {
        ("m.room.create", ""): SimpleNamespace(sender=ALICE, content={"m.federate": False}),
        ("m.room.member", ALICE): SimpleNamespace(sender=ALICE, content={"membership": "join"}),
        ("m.room.member", configured_ai): SimpleNamespace(
            sender=configured_ai, content={"membership": "join"}
        ),
        ("m.room.member", prefixed_ai): SimpleNamespace(
            sender=prefixed_ai, content={"membership": "join"}
        ),
        ("m.room.member", suffixed_ai): SimpleNamespace(
            sender=suffixed_ai, content={"membership": "join"}
        ),
    }
    disabled_state = governed()
    enabled_state = governed()
    enabled_state[("io.kodera.room.policy", "")].content["ai_enabled"] = True
    enabled_state[("m.room.member", configured_ai)] = SimpleNamespace(content={"membership": "join"})
    enabled_state[("m.room.member", prefixed_ai)] = SimpleNamespace(content={"membership": "join"})
    enabled_state[("m.room.member", suffixed_ai)] = SimpleNamespace(content={"membership": "join"})
    conf_ai_state = confidential()
    conf_ai_state[("io.kodera.room.policy", "")].content["ai_enabled"] = True
    bad_flag_state = governed()
    bad_flag_state[("io.kodera.room.policy", "")].content["ai_enabled"] = "yes"

    api = FakeApi(
        {
            dm_room: dm_state,
            disabled_room: disabled_state,
            enabled_room: enabled_state,
            conf_ai_room: conf_ai_state,
            bad_flag_room: bad_flag_state,
        }
    )
    policy = KoderaPolicy(
        KoderaPolicy.parse_config({"agent_user_id": AGENT, "ai_user_ids": [configured_ai]}),
        api,
    )

    # Non-boolean ai_enabled fails governance validation even for human members.
    bad_msg = event("m.room.message", ALICE, state=False, body="hello")
    bad_msg.room_id = bad_flag_room
    assert run(policy.check_event_allowed(bad_msg, bad_flag_state))[0] is False

    for ai_user in (configured_ai, prefixed_ai, suffixed_ai):
        # DM creation with AI creator or invitee is forbidden.
        dm_req = {
            "is_direct": True,
            "invite": [ALICE],
            "preset": "private_chat",
            "visibility": "private",
        }
        assert run(policy.user_may_create_room(ai_user, dm_req)) == FORBIDDEN
        assert (
            run(
                policy.user_may_create_room(
                    ALICE,
                    {
                        "is_direct": True,
                        "invite": [ai_user],
                        "preset": "private_chat",
                        "visibility": "private",
                    },
                )
            )
            == FORBIDDEN
        )

        # dm_member_joined never admits an AI subject.
        assert run(policy.dm_member_joined(AGENT, dm_room, ai_user)) is False

        # AI actor never invites anyone.
        assert run(policy.user_may_invite(ai_user, ALICE, enabled_room)) == FORBIDDEN

        # Even AGENT cannot invite AI into confidential, DM/unclassified, or ai_enabled=False rooms.
        for forbidden_room in (dm_room, disabled_room, conf_ai_room, bad_flag_room):
            assert run(policy.user_may_invite(AGENT, ai_user, forbidden_room)) == FORBIDDEN
            assert run(policy.user_may_join_room(ai_user, forbidden_room, True)) == FORBIDDEN

        # AGENT may invite AI and AI may join only when room is non-confidential with ai_enabled=True.
        assert run(policy.user_may_invite(AGENT, ai_user, enabled_room)) == ALLOWED
        assert run(policy.user_may_join_room(ai_user, enabled_room, True)) == ALLOWED

        # Timeline events and membership target events are refused everywhere except enabled_room (and own leave).
        for room_id, state in (
            (dm_room, dm_state),
            (disabled_room, disabled_state),
            (conf_ai_room, conf_ai_state),
        ):
            msg = event("m.room.message", ai_user, state=False, body="summary")
            msg.room_id = room_id
            assert run(policy.check_event_allowed(msg, state))[0] is False
            assert run(policy.check_event_for_spam(msg)) == FORBIDDEN

            agent_invite = event("m.room.member", AGENT, membership="invite")
            agent_invite.state_key = ai_user
            agent_invite.room_id = room_id
            assert run(policy.check_event_allowed(agent_invite, state))[0] is False

        own_leave = event("m.room.member", ai_user, membership="leave")
        own_leave.state_key = ai_user
        own_leave.room_id = disabled_room
        assert run(policy.check_event_allowed(own_leave, disabled_state))[0] is True

        ok_msg = event("m.room.message", ai_user, state=False, body="summary")
        ok_msg.room_id = enabled_room
        assert run(policy.check_event_allowed(ok_msg, enabled_state))[0] is True
        assert run(policy.check_event_for_spam(ok_msg)) == ALLOWED
        ok_invite = event("m.room.member", AGENT, membership="invite")
        ok_invite.state_key = ai_user
        ok_invite.room_id = enabled_room
        assert run(policy.check_event_allowed(ok_invite, enabled_state))[0] is True
