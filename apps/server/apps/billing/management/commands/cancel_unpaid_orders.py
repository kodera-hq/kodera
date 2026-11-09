"""`manage.py cancel_unpaid_orders`: cancel every order whose invoice is unpaid past its due date.

docs/domain/BILLING_MODEL.md §4.1. Run by the operator under a profile that installs billing
(`--settings config.settings.job_queue`). Not scheduled until the legal lane clears the lapse of
an unpaid order (§4.1). Each order is cancelled as the `system`, in its own transaction, its
invoice credited in full by a credit note. An order a payment holds is left and counted as held.
`withdraw_cancelled_links` then withdraws the cancelled orders' payment links at their provider.
"""

from typing import Any

from django.apps import apps as registry
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "Cancel every order whose invoice is unpaid past its due date."

    def handle(self, *args: Any, **options: Any) -> None:
        if not registry.is_installed("apps.billing"):
            raise CommandError(
                "billing is not installed: run with --settings config.settings.job_queue"
            )
        if not getattr(settings, "KODERA_UNPAID_LAPSE_ENABLED", False):
            # It ends contracts and issues numbered credit notes on a legal basis not yet ruled.
            raise CommandError(
                "the lapse of unpaid orders is not enabled (KODERA_UNPAID_LAPSE_ENABLED=1)"
            )
        from apps.billing.services import cancel_unpaid_orders

        cancelled, held = cancel_unpaid_orders()
        self.stdout.write(f"cancel_unpaid_orders cancelled={cancelled} held={held}")
