"""Idempotency keys: docs/specs/JOB_QUEUE.md §3.4.

A key is sha256 over one canonical JSON array, never a delimiter-joined string: a principal URN, a
path or a client key may contain any delimiter, and a JSON array cannot collide that way.
"""

import hashlib
import json
from collections.abc import Sequence
from uuid import UUID


def _part(part: object) -> str | int:
    # bool is an int subclass: 0, "0" and False must be three keys, so only int itself passes.
    if type(part) is int or isinstance(part, str):
        return part
    if isinstance(part, UUID):
        return str(part)
    raise TypeError(f"a key part is a str, an int or a UUID, not {type(part).__name__}")


def derive_key(parts: Sequence[str | int | UUID]) -> str:
    """sha256 of json.dumps(list, separators=(",", ":"), ensure_ascii=True); UUIDs as str(uuid);
    a bool, or an int subclass other than int, raises TypeError."""
    array = [_part(part) for part in parts]
    return hashlib.sha256(
        json.dumps(array, separators=(",", ":"), ensure_ascii=True).encode()
    ).hexdigest()


def sub_job_key(parent_job_id: UUID, dispatch_id: UUID) -> str:
    """The key of the sub-job a dispatch starts: ["sub", parent_job_id, dispatch_id]."""
    return derive_key(["sub", parent_job_id, dispatch_id])
