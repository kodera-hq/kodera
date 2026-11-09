"""`manage.py withdraw_cancelled_links`: withdraw at its provider every cancelled, unexpired link.

docs/domain/BILLING_MODEL.md §4.1. A cancelled order's link is cancelled in Core's transaction,
which calls no provider; this asks the provider to close it, so the order cannot be paid through
it. Idempotent: a link already closed at the provider is answered as closed, and every run asks
again for each link still unexpired. Run by the operator, or a schedule the deployment sets, under
a profile that installs billing and the payment provider (`--settings config.settings.job_queue`).
"""

from typing import Any

from django.apps import apps as registry
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "Withdraw at their provider the cancelled payment links that have not expired."

    def handle(self, *args: Any, **options: Any) -> None:
        if not registry.is_installed("apps.billing"):
            raise CommandError(
                "billing is not installed: run with --settings config.settings.job_queue"
            )
        from apps.billing.payments.services import withdraw_cancelled_links

        asked = withdraw_cancelled_links()
        self.stdout.write(f"withdraw_cancelled_links asked={asked}")
