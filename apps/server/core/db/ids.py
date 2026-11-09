"""Process-local UUIDv7 serialization, without a cross-process ordering promise."""

import os
import threading
from uuid import UUID

import uuid6

_generation_lock = threading.Lock()


def _reset_child_lock() -> None:
    global _generation_lock
    _generation_lock = threading.Lock()


os.register_at_fork(after_in_child=_reset_child_lock)


def new_uuid7() -> UUID:
    """Return a UUIDv7 while serializing the dependency's mutable clock state."""
    with _generation_lock:
        return uuid6.uuid7()
