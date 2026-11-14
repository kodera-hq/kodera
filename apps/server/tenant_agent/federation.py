"""Operator-owned experimental partner opt-in; never inferred from channel names or users."""

import json
import re
from typing import Any
from uuid import UUID

MODE = "io.kodera.room.federation"
SERVER = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z")
PRIVATE = (".local", ".localhost", ".internal", ".invalid", ".test", ".example", ".onion")


def servers(value: Any, *, empty: bool = False) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)) or len(value) > 32 or (not value and not empty):
        raise ValueError("partner servers must be a bounded public homeserver list")
    if not all(
        isinstance(name, str)
        and len(name) <= 253
        and SERVER.fullmatch(name) is not None
        and not name.endswith(PRIVATE)
        for name in value
    ) or len(set(value)) != len(value):
        raise ValueError("partner servers must be distinct public names without ports or wildcards")
    return tuple(sorted(value))


def parse(raw: str, allowlist: tuple[str, ...] | None) -> tuple[tuple[str, tuple[str, ...]], ...]:
    if not raw:
        return ()
    if len(raw.encode()) > 32768:
        raise ValueError("partner channel configuration exceeds its bound")

    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("partner channel configuration repeats a channel")
            result[key] = value
        return result

    document = json.loads(raw, object_pairs_hook=unique)
    if not isinstance(document, dict) or len(document) > 32:
        raise ValueError("partner channel configuration must map at most 32 channel UUIDs")
    result = []
    for key, value in document.items():
        if not isinstance(key, str) or str(UUID(key)) != key:
            raise ValueError("partner channel configuration requires canonical channel UUIDs")
        names = servers(value)
        if allowlist is not None and not set(names) <= set(allowlist):
            raise ValueError("partner channel servers exceed the operator federation allowlist")
        result.append((key, names))
    return tuple(sorted(result))


def acl(server: str, partners: tuple[str, ...] = ()) -> dict[str, Any]:
    return {"allow": sorted({server, *partners}), "deny": [], "allow_ip_literals": False}


def eligible(channel: dict[str, Any]) -> bool:
    return (
        channel["kind"] == "text"
        and channel["audience"] == "all"
        and channel["read_only"] is False
        and channel["archived"] is False
        and not channel["denied"]
    )


def remote_user(user: str, partners: tuple[str, ...]) -> bool:
    localpart, separator, domain = user.partition(":")
    return bool(
        separator
        and localpart.startswith("@")
        and len(localpart) > 1
        and not any(c.isspace() for c in user)
        and domain in partners
    )
