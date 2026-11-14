"""Persist bounded due proposals; no delivery or tenant transition is inferred."""

from typing import Any
from uuid import UUID

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Advance one subscription's overdue state and persist its next supervised proposal."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--subscription", type=UUID, required=True)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.billing.dunning import DunningRefusedError
        from apps.billing.dunning_scheduler import schedule_subscription
        from apps.billing.models import Subscription
        from apps.billing.switch import billing_enabled

        if not billing_enabled():
            raise CommandError("billing disabled; nothing written")
        try:
            action = schedule_subscription(options["subscription"])
        except (DunningRefusedError, Subscription.DoesNotExist) as refused:
            raise CommandError(f"dunning refused: {refused}") from None
        self.stdout.write(
            "dunning held_or_cleared"
            if action is None
            else f"dunning action={action.id} step={action.step} state={action.state}"
        )
