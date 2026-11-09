"""Delete the expired replay entries once, in bounded batches: docs/specs/IDEMPOTENCY_REPLAY.md §2.7.

There is no scheduler in Core: the operator's cron runs this command. It prints one line of counts
and never an entry's issuer, subject, path or key.
"""

from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from core.idempotency.store import MAX_PURGE_BATCH, PURGE_BATCH, purge_expired


class Command(BaseCommand):
    help = (
        "Delete the replay entries older than the retention, at most --batch per DELETE, each "
        "batch committed before the next, once."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--once", action="store_true", help="Run one pass and exit")
        parser.add_argument(
            "--batch",
            type=int,
            default=PURGE_BATCH,
            help=f"Entries per DELETE, 1 to {MAX_PURGE_BATCH} (default {PURGE_BATCH})",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        if not options["once"]:
            raise CommandError("purge_idempotency runs only with --once")
        if not 1 <= options["batch"] <= MAX_PURGE_BATCH:
            raise CommandError(f"--batch must be 1 to {MAX_PURGE_BATCH}")
        try:
            purged = purge_expired(batch=options["batch"])
        except RuntimeError as error:
            raise CommandError(str(error)) from None
        self.stdout.write(purged.line())
