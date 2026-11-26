"""Bounded operator retry of due VIES consultations; no customer-request dependency."""

from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Retry due VIES consultations with bounded exponential outage backoff."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--limit", type=int, default=50)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.billing.vies import ViesRefusedError, retry_due_consultations

        try:
            rows = retry_due_consultations(limit=options["limit"])
        except ViesRefusedError:
            raise CommandError("VIES retry configuration refused") from None
        self.stdout.write(f"VIES consultations processed: {len(rows)}")
