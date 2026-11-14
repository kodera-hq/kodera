"""Confirm actual delivery evidence as current staff; never performs an external operation."""

from datetime import datetime
from typing import Any
from uuid import UUID

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Attest a prepared dunning delivery or verify its completed tenant transition job."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--staff-identity", type=UUID, required=True)
        parser.add_argument("--action", type=UUID, required=True)
        parser.add_argument("--delivered-at", type=datetime.fromisoformat, required=True)
        parser.add_argument("--receipt-at", type=datetime.fromisoformat)
        parser.add_argument("--evidence-ref", required=True)
        parser.add_argument("--job", type=UUID)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.billing.dunning import DunningRefusedError
        from apps.billing.dunning_scheduler import confirm_action
        from apps.billing.models import DunningAction
        from apps.orgs.realm_bootstrap import Refused, principal_for

        try:
            action = confirm_action(
                principal=principal_for(options["staff_identity"]),
                action_id=options["action"],
                delivered_at=options["delivered_at"],
                receipt_at=options["receipt_at"],
                evidence_ref=options["evidence_ref"],
                job_id=options["job"],
            )
        except (Refused, DunningRefusedError, DunningAction.DoesNotExist) as refused:
            raise CommandError(f"dunning refused: {refused}") from None
        self.stdout.write(f"dunning action={action.id} step={action.step} state={action.state}")
