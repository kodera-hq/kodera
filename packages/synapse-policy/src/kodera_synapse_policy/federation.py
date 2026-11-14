"""Exact public homeserver names and immutable room federation modes; no network access."""

import re
from collections.abc import Mapping
from typing import Any

MODE = "io.kodera.room.federation"
MAX_SERVERS = 32
PUBLIC_SERVER = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z")
PRIVATE_SUFFIXES = (".local", ".localhost", ".internal", ".invalid", ".test", ".example", ".onion")


def public_server(value: Any) -> bool:
    return isinstance(value, str) and len(value) <= 253 and PUBLIC_SERVER.fullmatch(value) is not None and not value.endswith(PRIVATE_SUFFIXES)


def server_list(value: Any, *, empty: bool = False) -> tuple[str, ...] | None:
    if not isinstance(value, (list, tuple)) or len(value) > MAX_SERVERS or (not value and not empty):
        return None
    if not all(public_server(item) for item in value) or len(set(value)) != len(value):
        return None
    return tuple(sorted(value))


def acl(server: str, partners: tuple[str, ...] = ()) -> dict[str, Any]:
    return {"allow": sorted({server, *partners}), "deny": [], "allow_ip_literals": False}


def creation_mode(content: Any) -> str | None:
    if not isinstance(content, Mapping):
        return None
    if content.get(MODE) == "partner" and content.get("m.federate") is True:
        return "partner"
    if content.get(MODE) == "internal" and content.get("m.federate") is False:
        return "internal"
    return None


def acl_matches(content: Any, expected: dict[str, Any]) -> bool:
    return (isinstance(content, Mapping) and set(content) == set(expected)
            and content.get("allow_ip_literals") is False
            and isinstance(content.get("allow"), (list, tuple))
            and tuple(content["allow"]) == tuple(expected["allow"])
            and isinstance(content.get("deny"), (list, tuple)) and not content["deny"])
