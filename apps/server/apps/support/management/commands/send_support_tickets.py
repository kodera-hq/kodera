"""`manage.py send_support_tickets --once`: hand each support ticket's mail to the outbox
(docs/specs/SUPPORT_TICKETS.md §6). `run_deliveries` sends it."""

from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.outbox.sender import SenderUnavailableError
from apps.support.ticket_mail import SupportMailUnavailableError, run_support_ticket_mails


class Command(BaseCommand):
    help = (
        "Settle the support tickets whose mail ended, erase the text of those past retention, "
        "then enqueue the mail of each ticket not yet mailed, once. Enqueueing needs "
        "KODERA_SUPPORT_MAILBOX, KODERA_OUTBOX_SEAL_KEY and the mail transport."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--once", action="store_true", help="Run one pass and exit")
        parser.add_argument("--limit", type=int, default=50)

    def handle(self, *args: Any, **options: Any) -> None:
        if not options["once"]:
            raise CommandError("send_support_tickets runs only with --once")
        if not 1 <= options["limit"] <= 500:
            raise CommandError("--limit must be 1 to 500")
        try:
            report = run_support_ticket_mails(limit=options["limit"])
        except (SupportMailUnavailableError, SenderUnavailableError) as unavailable:
            raise CommandError(f"support ticket mails refused: {unavailable}") from None
        self.stdout.write(
            f"enqueued={len(report.enqueued)} skipped={len(report.skipped)}"
            f" held_for_approval={report.held_for_approval} delivered={report.delivered}"
            f" retried={report.retried} erased_undelivered={report.erased_undelivered}"
        )
        if report.skipped:
            raise CommandError(f"{len(report.skipped)} support ticket mails could not be enqueued")
