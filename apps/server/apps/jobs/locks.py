"""Live advisory locks: docs/specs/JOB_QUEUE.md §4.3.

A lock's key is the two-integer form (class_code, hashtext(key::text)), class code 1 for an
organisation and 2 for a tenant. Every other taker of these locks must use exactly this key, or the
locks do not exclude each other. The locks are session locks: they survive a rollback, and stack.
"""

from collections.abc import Iterable

from django.db import connection

from .kinds import Lock

CLASS_CODE = {"organisation": 1, "tenant": 2}

# The mode pg_locks shows for each mode of a lock the queue takes.
_PG_MODE = {"exclusive": "ExclusiveLock", "shared": "ShareLock"}

_TRY = {
    "exclusive": "SELECT pg_try_advisory_lock(%s, hashtext(%s::text))",
    "shared": "SELECT pg_try_advisory_lock_shared(%s, hashtext(%s::text))",
}
_UNLOCK = {
    "exclusive": "SELECT pg_advisory_unlock(%s, hashtext(%s::text))",
    "shared": "SELECT pg_advisory_unlock_shared(%s, hashtext(%s::text))",
}
_WAIT_FOR_TRANSACTION = {
    "exclusive": "SELECT pg_advisory_xact_lock(%s, hashtext(%s::text))",
    "shared": "SELECT pg_advisory_xact_lock_shared(%s, hashtext(%s::text))",
}
_HELD = """
SELECT count(*) FROM pg_locks
WHERE locktype = 'advisory' AND objsubid = 2 AND granted AND pid = pg_backend_pid()
  AND classid::bigint = %s AND objid::bigint = (hashtext(%s::text)::bigint & 4294967295)
"""


def _key(lock: Lock) -> list[int | str]:
    return [CLASS_CODE[lock.lock_class], str(lock.key)]


def try_lock(lock: Lock) -> bool:
    """Take `lock` in its mode without waiting; False when another session holds a conflict."""
    with connection.cursor() as cursor:
        cursor.execute(_TRY[lock.mode], _key(lock))
        return bool(cursor.fetchone()[0])


def lock_for_transaction(lock: Lock) -> None:
    """Take `lock` in its mode until the current transaction ends, waiting for it.

    For a taker that is not a job and holds the lock for one database transaction only
    (JOB_CATALOGUE.md §1). It waits rather than tries: the caller bounds the wait with its own
    `lock_timeout`, whose expiry raises and rolls the transaction back.
    """
    if not connection.in_atomic_block:
        raise RuntimeError("a transaction lock needs the caller's transaction")
    with connection.cursor() as cursor:
        cursor.execute(_WAIT_FOR_TRANSACTION[lock.mode], _key(lock))


def held(lock: Lock, *, mode: str | None = None) -> bool:
    """Whether this session holds `lock`'s key, in any mode or only in `mode`."""
    statement, parameters = _HELD, _key(lock)
    if mode is not None:
        statement += " AND mode = %s"
        parameters.append(_PG_MODE[mode])
    with connection.cursor() as cursor:
        cursor.execute(statement, parameters)
        return int(cursor.fetchone()[0]) > 0


def unlock(locks: Iterable[Lock]) -> None:
    """Release one hold of each lock, in the reverse of the order they were taken."""
    with connection.cursor() as cursor:
        for lock in reversed(list(locks)):
            cursor.execute(_UNLOCK[lock.mode], _key(lock))


def unlock_all(lock: Lock) -> None:
    """Release every hold this session has of `lock` in its mode: session locks stack."""
    while held(lock, mode=lock.mode):
        unlock([lock])
