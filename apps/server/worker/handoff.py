"""The handoff of one provider call: final authorisation, spawn and send, under the job's row lock.

The step child is already spawned, waiting on stdin with no request (worker/child.py). One short
transaction then locks the job's row FOR NO KEY UPDATE, re-reads the runner's ownership rule
(apps/jobs/sql.py `RUNNER_OWNED_*`: the job running, at the claim's fence, under a lease the
database's clock has not ended) in a fresh statement once the lock is had, and runs `write()`: the
local lease, then one non-blocking write of the request to the child's stdin. Nothing else runs
under the lock: no spawn, no logging, no event. A sweep, a fence move or a lease change on another connection cannot commit between the
authorisation and the send: the sweep's row lock skips the locked job, and any UPDATE of it waits
for the commit (apps/jobs/sql.py `RUNNER_HANDOFF`). The lock is held for the handoff alone, never
for the provider call: the transaction commits as soon as `write()` returns, and the child runs
unlocked.

The transaction is the runner thread's own, opened with no other transaction open (the runner's
writes all assert none, and none runs during the handoff); the lease keeper renews on its own
thread's connection, whose UPDATE waits at most for this commit. A job not owned, or a lock not had
within `lock_timeout`, or a clause the re-read refuses, hands nothing off: `write()` is not called.
"""

from __future__ import annotations

from collections.abc import Callable
from uuid import UUID

from . import mutants

# What became of one handoff. Only WRITTEN hands the request over; every other ending sends nothing.
WRITTEN = "written"
LOCK_TIMEOUT = "lock_timeout"  # the row lock was not had within the handoff's timeouts
NOT_OWNED = "not_owned"  # the locking SELECT found no row this fence owns
REREAD_REFUSED = "reread_refused"  # the lock was had; the re-read under it refused a clause
WRITE_REFUSED = "write_refused"  # the local lease, or a write that would block or was partial


def hand_off(job_id: UUID, fence: int, write: Callable[[], bool]) -> str:
    """What became of the handoff: WRITTEN when the job's row was locked, the ownership rule
    re-read under the lock held, and `write()` (the local lease, then one non-blocking write) was
    True; otherwise the reason nothing was sent."""
    from django.db import OperationalError, connection, transaction

    from apps.jobs import sql
    from apps.jobs._claim import require_no_transaction
    from apps.jobs.runner_selectors import OWNED
    from apps.jobs.transactions import queue_atomic

    require_no_transaction("runner_handoff", allowed=False)
    row_lock = "" if mutants.on("handoff_without_row_lock") else sql.NO_KEY_UPDATE
    parameters: dict[str, UUID | int] = {"job": job_id, "fence": fence}
    with queue_atomic("runner_handoff"):
        try:
            with transaction.atomic(), connection.cursor() as cursor:
                for setting in sql.RUNNER_HANDOFF_TIMEOUTS:
                    cursor.execute(setting)
                cursor.execute(sql.RUNNER_HANDOFF.format(**OWNED, row_lock=row_lock), parameters)
                locked = cursor.fetchone() is not None
        except OperationalError:
            # The lock was not had in time (lock_timeout, or statement_timeout): not ours now.
            return LOCK_TIMEOUT
        if not locked:
            return NOT_OWNED
        if not mutants.on("handoff_without_reread_after_lock"):
            # A fresh statement, after the lock is had. Under READ COMMITTED each statement takes
            # a new snapshot, so this one reads the row as last committed, after any wait for the
            # lock, and clock_timestamp() as of now. The locking SELECT's own WHERE was evaluated
            # before it waited: PostgreSQL re-evaluates it only when the row was updated meanwhile,
            # not when another transaction merely held it while the lease ran out.
            with connection.cursor() as cursor:
                cursor.execute(sql.RUNNER_OWNERSHIP.format(**OWNED), parameters)
                found = cursor.fetchone()
            if found is None or not all(found):
                return REREAD_REFUSED
        return WRITTEN if write() else WRITE_REFUSED
