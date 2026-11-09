"""`manage.py send_order_confirmations`: enqueue each order's confirmation once (CGV 5.3), and the
termination notice of each cancelled order whose confirmation was sent."""

from typing import Any

from django.core.management.base import BaseCommand, CommandError

from apps.billing.confirmations import (
    ConfirmationsUnavailableError,
    SenderUnavailableError,
    enqueue_order_confirmations,
)


class Command(BaseCommand):
    help = "Enqueue the confirmation of each order with an accepted DPA and none yet."

    def handle(self, *args: Any, **options: Any) -> None:
        try:
            report = enqueue_order_confirmations()
        except (ConfirmationsUnavailableError, SenderUnavailableError) as unavailable:
            raise CommandError(f"order confirmations refused: {unavailable}") from None
        self.stdout.write(
            f"enqueued={len(report.enqueued)} notified={len(report.notified)}"
            f" credit_notes={len(report.credit_notes)} skipped={len(report.skipped)}"
        )
        if report.skipped:
            raise CommandError(
                f"{len(report.skipped)} confirmations or notices could not be enqueued"
            )
