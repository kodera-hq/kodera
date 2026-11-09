"""The lease keeper: one thread per claimed job that renews its lease (JOB_QUEUE.md §5.1).

It renews every 30 seconds. A renewal the database refuses (`renew_lease` returns False: the fence
moved or the lease is gone) is definitive and sets `lost` at once. A renewal that fails (a database
error, its budget spent) counts as one failure, a renewal that succeeds clears the count, and the
second failure in a row sets `lost`. A keeper thread that dies of anything else sets `lost` too,
unless the runner asked it to stop: a lease nobody renews is not held.

The thread is not trusted to notice on its own. A renewal can block in the kernel on a half-open
TCP connection, where no database timeout fires, so `is_lost()` also holds the lease to its own
clock: `last_renewed` is the monotonic time each successful renewal was *asked* (never answered,
which is later), and once `last_renewed + lease_s - margin_s` has passed the lease is lost whatever
the thread is doing. The runner reads `is_lost()`, never the thread, before each step and while it
waits on one (worker/child.py). The libpq keepalives and `tcp_user_timeout` of the worker's database
profile (config/deploy_environment.py) then end the blocked call itself; `stop()` waits for it
`stop_join_s` at most, and never for ever.

After `stop()` the keeper issues no renewal: it reads the stop request just before each one. What
remains: a renewal already in flight when `stop()` gives up can still land, and extend by one lease
a job the runner has let go. That job then stays leased to a runner that no longer renews it, until
that lease ends and the sweep holds it for reconciliation (JOB_QUEUE.md §5.2): a delay, never a
write by the runner, which writes nothing after it let the job go.

`LEASE_S` is the database's lease: tests/worker/test_worker_execution.py holds it to every
`interval` the queue's SQL sets `lease_expires_at` with (apps/jobs/sql.py).

When the lease is lost the runner stops starting work, kills the step's process group, reaps it and
releases its live locks (JOB_CATALOGUE.md §1): it never goes on without a lease. The thread uses its
own database connection and closes it when it stops.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

from apps.jobs.types import Claim

from . import mutants

RENEW_EVERY_S = 30.0
FAILED_RENEWALS_LOST = 2
# The database's lease (apps/jobs/_runner.py: clock_timestamp() + 120 s).
LEASE_S = 120.0
# The runner gives its lease up this long before the database ends it: the claim's own round trip,
# and a renewal's, are spent before `last_renewed` is read, never after.
LEASE_MARGIN_S = 15.0
# How long stop() waits for a keeper blocked in a renewal; the daemon thread is then abandoned to
# the connection's own keepalive and timeout.
STOP_JOIN_S = 5.0


def _close_connection() -> None:
    from django.db import connection

    connection.close()


class Lease:
    def __init__(  # noqa: PLR0913 - each bound is a parameter a test shortens
        self,
        claim: Claim,
        *,
        renew: Callable[[Claim], bool],
        every_s: float = RENEW_EVERY_S,
        lease_s: float = LEASE_S,
        margin_s: float = LEASE_MARGIN_S,
        since: float | None = None,
        stop_join_s: float = STOP_JOIN_S,
        on_stop: Callable[[], None] = _close_connection,
    ) -> None:
        self.claim = claim
        self.lost = threading.Event()
        self.failures = 0
        # Monotonic: when the lease was last known to run its full length from. `since` is the time
        # the claim was asked, before the claim's own round trip.
        self.last_renewed = time.monotonic() if since is None else since
        self._renew = renew
        self._every_s = every_s
        self._lease_s = lease_s
        self._margin_s = margin_s
        self._stop_join_s = stop_join_s
        self._on_stop = on_stop
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"lease-{claim.job_id}", daemon=True)

    def start(self) -> Lease:
        self._thread.start()
        return self

    def stop(self) -> None:
        """Stop renewing. Waits `stop_join_s` at most for a keeper blocked in a renewal."""
        self._stop.set()
        waits_for_ever = mutants.on("lease_stop_waits_on_a_blocked_renewal")
        self._thread.join(None if waits_for_ever else self._stop_join_s)

    def is_lost(self) -> bool:
        """Whether the lease is lost: given up by the keeper, or past its own end by this clock."""
        if self.lost.is_set():
            return True
        ends = self.last_renewed + self._lease_s - self._margin_s
        if time.monotonic() > ends and not mutants.on("lease_ignores_its_deadline"):
            self.lost.set()
            return True
        return False

    def _renew_once(self) -> None:
        from django.db import Error

        if self._stop.is_set() and not mutants.on("lease_renews_after_stop"):
            return
        asked = time.monotonic()
        try:
            renewed = self._renew(self.claim)
        except Error:
            # A database that does not answer within its budget renews nothing, and says nothing
            # of the lease: one failure.
            self.failures += 1
            return
        if renewed:
            self.failures = 0
            self.last_renewed = asked
        elif mutants.on("lease_retries_a_refused_renewal"):
            self.failures += 1
        else:
            # The database answered: this claim no longer owns the job. Nothing to wait for.
            self.lost.set()

    def _run(self) -> None:
        try:
            while not self._stop.wait(self._every_s):
                self._renew_once()
                if self.lost.is_set():
                    return
                if self.failures >= FAILED_RENEWALS_LOST and not mutants.on(
                    "lease_survives_failed_renewals"
                ):
                    self.lost.set()
                    return
        finally:
            if not self._stop.is_set() and not mutants.on("lease_keeper_dies_silently"):
                # However the keeper ends, a lease it no longer renews is lost.
                self.lost.set()
            self._on_stop()
