"""Confidential timeline payloads never reach storage through either event callback."""

from types import MappingProxyType, SimpleNamespace

import pytest
from kodera_synapse_policy.confidential import CONFIDENTIAL
from synapse.module_api.errors import SynapseError
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
