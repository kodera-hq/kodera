"""`manage.py run_operator_schedule`: the operator's periodic runs in one supported process
(docs/specs/OPERATOR_SCHEDULE.md).

Each pass runs, in order, the realm deliveries, revocation included (`run_realm_deliveries`), the
invitation mails (`send_invitations`), the support ticket mails (`send_support_tickets`) and the
message deliveries (`run_deliveries`, within a time budget), each with `--once`, then sleeps until the next pass is due. It replaces the hand-made units that ran
each `--once` command on a timer.

A run that refuses or fails is logged with its name and its own message, and the next run of the
pass still goes: an outage of the mail relay must not hold back a revocation. The process exits
only on SIGTERM or SIGINT, after the run in progress, or when `--passes` is reached. It prints each
run's line of counts and never an address, a token or a secret.
"""

import logging
import signal
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from io import StringIO
from typing import Any

from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError, CommandParser
from django.db import close_old_connections

from apps.orgs.management.operator import require_operator_profile

LOG = logging.getLogger("apps.orgs.operator_schedule")

# In the order a pass runs them. The realm comes first: revocation has a minute
# (MEMBERSHIP_LIFECYCLE.md §6.1.8), and its access pass is bounded by RUN_BOUND_S. An invitation or
# support ticket mail enqueued by the second or third run is sent by the last in the same pass, and the mail run claims nothing new
# once its budget is spent, so a slow relay cannot hold back the next pass's revocation.
DELIVERY_BUDGET_S = 20
RUNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("run_realm_deliveries", ("--once",)),
    ("send_invitations", ("--once",)),
    ("send_support_tickets", ("--once",)),
    ("run_deliveries", ("--once", "--budget-s", str(DELIVERY_BUDGET_S))),
)
MIN_INTERVAL_S = 10
MAX_INTERVAL_S = 3600


@dataclass
class PassReport:
    ok: int = 0
    failed: int = 0


class Command(BaseCommand):
    help = (
        "Run run_realm_deliveries, send_invitations, send_support_tickets and run_deliveries "
        "with --once every "
        "--interval seconds until stopped. Needs each run's own settings."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--interval", type=int, default=60, help="Seconds between passes")
        parser.add_argument(
            "--passes", type=int, default=0, help="Stop after this many passes (0: never)"
        )

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        interval, passes = options["interval"], options["passes"]
        if not MIN_INTERVAL_S <= interval <= MAX_INTERVAL_S:
            raise CommandError(f"--interval must be {MIN_INTERVAL_S} to {MAX_INTERVAL_S} seconds")
        if passes < 0:
            raise CommandError("--passes must be 0 or more")
        stop = _Stop()
        done = 0
        while not stop.requested:
            started = time.monotonic()
            report = self.run_pass(stop)
            done += 1
            # The time is what an alert on a stale or absent pass reads.
            at = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
            self.stdout.write(f"pass {done} ok={report.ok} failed={report.failed} at={at}")
            if passes and done >= passes:
                break
            stop.wait(started + interval - time.monotonic())

    def run_pass(self, stop: "_Stop", run: Callable[..., object] = call_command) -> PassReport:
        report = PassReport()
        for name, arguments in RUNS:
            if stop.requested:
                break
            out = StringIO()
            try:
                run(name, *arguments, stdout=out, stderr=out)
            except CommandError as refused:
                report.failed += 1
                LOG.error("%s refused: %s", name, refused)
            except Exception as failure:
                report.failed += 1
                LOG.error("%s failed: %s", name, type(failure).__name__)
            else:
                report.ok += 1
            finally:
                # A connection broken by one run must not fail the next.
                close_old_connections()
            for line in out.getvalue().splitlines():
                self.stdout.write(f"{name}: {line}")
        return report


class _Stop:
    """SIGTERM and SIGINT end the loop after the run in progress."""

    def __init__(self) -> None:
        self.requested = False
        for number in (signal.SIGTERM, signal.SIGINT):
            signal.signal(number, self._request)

    def _request(self, *_: object) -> None:
        self.requested = True

    def wait(self, seconds: float) -> None:
        deadline = time.monotonic() + max(0.0, seconds)
        while not self.requested and time.monotonic() < deadline:
            time.sleep(min(1.0, deadline - time.monotonic()))
