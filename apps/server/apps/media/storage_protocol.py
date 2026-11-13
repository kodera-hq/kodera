"""Bounded private RPC primitives, with no credential loader or worker entry point."""

from typing import Any

from .storage import StorageRefusedError

MAX_RPC_BYTES = 16384


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for name, value in pairs:
        if name in result:
            raise StorageRefusedError()
        result[name] = value
    return result
