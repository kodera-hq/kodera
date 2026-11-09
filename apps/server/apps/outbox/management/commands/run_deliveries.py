"""Send the due `message` outbox deliveries once: docs/specs/OUTBOX_MAIL_SENDER.md §7.5.

There is no worker yet: the operator, or a cron entry, runs this command. It prints one line of
counts and never a recipient, a subject, a body or a link.
"""

from typing import Any

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.outbox.mail.seal import SealError
from apps.outbox.services import DEFAULT_LIMIT, run_deliveries


def require_once(options: dict[str, Any]) -> None:
    """--once is required: there is no long-running mode until a worker exists."""
    if not options["once"]:
        raise CommandError("run_deliveries runs only with --once")


class Command(BaseCommand):
    help = (
        "Sweep, then send the due message deliveries over the configured SMTP transport, once. "
        "Needs KODERA_MAIL_SMTP_URL and KODERA_OUTBOX_SEAL_KEY."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--once", action="store_true", help="Run one pass and exit")
        parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
        parser.add_argument(
            "--budget-s", type=int, default=None, help="Claim nothing new after this many seconds"
        )

    def handle(self, *args: Any, **options: Any) -> None:
        require_once(options)
        transport = getattr(settings, "KODERA_MAIL_TRANSPORT", None)
        if transport is None:
            raise CommandError("no mail transport is configured: KODERA_MAIL_SMTP_URL")
        key = getattr(settings, "KODERA_OUTBOX_SEAL_KEY", None)
        if key is None:
            raise CommandError("no seal key is configured: KODERA_OUTBOX_SEAL_KEY")
        if options["limit"] < 1:
            raise CommandError("--limit must be at least 1")
        if options["budget_s"] is not None and options["budget_s"] < 1:
            raise CommandError("--budget-s must be at least 1")
        try:
            report = run_deliveries(
                transport, limit=options["limit"], key=key, budget_s=options["budget_s"]
            )
        except SealError as error:
            # The message names the delivery and nothing it holds.
            raise CommandError(str(error)) from None
        self.stdout.write(report.line())
