"""Immutable, agent-authored confidential-room boundary; no decryption or key storage."""

import base64
import binascii
from collections.abc import Mapping
from typing import Any

CONFIDENTIAL = "io.kodera.room.confidential"
ALGORITHMS = frozenset({"m.megolm.v1.aes-sha2", "io.kodera.mls.v1"})
MAX_CIPHERTEXT = 131_072
METADATA_STATE = frozenset(
    {
        "m.room.create",
        "m.room.member",
        "m.room.power_levels",
        "m.room.join_rules",
        "m.room.history_visibility",
        "m.room.server_acl",
        "m.room.name",
        "m.room.topic",
        "m.room.avatar",
        "m.room.canonical_alias",
        "m.room.guest_access",
        "io.kodera.room.policy",
        "io.kodera.room.occupancy",
    }
)


def requested_algorithm(config: Any) -> str | None:
    if not isinstance(config, Mapping):
        return None
    creation = config.get("creation_content")
    if not isinstance(creation, Mapping):
        return None
    value = creation.get(CONFIDENTIAL)
    return value if isinstance(value, str) and value in ALGORITHMS else None


def valid_initial_encryption(config: Any) -> bool:
    algorithm = requested_algorithm(config)
    initial = config.get("initial_state") if isinstance(config, Mapping) else None
    if algorithm is None or not isinstance(initial, list):
        return False
    encryption = [
        item
        for item in initial
        if isinstance(item, Mapping) and item.get("type") == "m.room.encryption"
    ]
    return (
        len(encryption) == 1
        and encryption[0].get("state_key", "") == ""
        and encryption[0].get("content") == {"algorithm": algorithm}
    )


def _ciphertext(content: Any, algorithm: str) -> bool:
    if not isinstance(content, Mapping) or content.get("algorithm") != algorithm:
        return False
    fields = (
        {"algorithm", "ciphertext", "sender_key", "device_id", "session_id"}
        if algorithm == "m.megolm.v1.aes-sha2"
        else {"algorithm", "ciphertext", "epoch", "sender_device_key"}
    )
    if set(content) != fields:
        return False
    encoded = content.get("ciphertext")
    if not isinstance(encoded, str) or not 1 <= len(encoded) <= MAX_CIPHERTEXT:
        return False
    try:
        raw = base64.b64decode(encoded + "=" * (-len(encoded) % 4), validate=True)
    except (ValueError, binascii.Error):
        return False
    if len(raw) < 16:
        return False
    if algorithm == "io.kodera.mls.v1":
        return (
            type(content.get("epoch")) is int
            and 0 <= content["epoch"] < 2**64
            and _bounded_string(content.get("sender_device_key"), 128)
        )
    return all(
        _bounded_string(content.get(field), 256)
        for field in ("sender_key", "device_id", "session_id")
    )


def _bounded_string(value: Any, limit: int) -> bool:
    return (
        isinstance(value, str)
        and 1 <= len(value) <= limit
        and not any(char.isspace() for char in value)
    )


def event_allowed(event: Any, state: Any, agent: str) -> bool:
    create = state.get(("m.room.create", ""))
    creation = getattr(create, "content", None)
    marker = creation.get(CONFIDENTIAL) if isinstance(creation, Mapping) else None
    if not isinstance(creation, Mapping) or CONFIDENTIAL not in creation:
        return event.type not in {"m.room.encryption", "m.room.encrypted"}
    if (
        not isinstance(marker, str)
        or marker not in ALGORITHMS
        or getattr(create, "sender", None) != agent
    ):
        return False
    if event.type == "m.room.encryption":
        return (
            event.is_state()
            and getattr(event, "state_key", "") == ""
            and event.sender == agent
            and event.content == {"algorithm": marker}
        )
    # Confidentiality covers timeline payloads, including reactions and custom event
    # types. Native membership and policy state still pass the ordinary governance gate.
    if event.is_state():
        return event.type in METADATA_STATE and not {
            "body",
            "formatted_body",
        }.intersection(event.content)
    encryption = state.get(("m.room.encryption", ""))
    if getattr(encryption, "sender", None) != agent or getattr(
        encryption, "content", None
    ) != {"algorithm": marker}:
        return False
    return event.type == "m.room.encrypted" and _ciphertext(event.content, marker)
