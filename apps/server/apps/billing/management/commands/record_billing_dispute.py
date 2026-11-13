"""Link an amount to an existing billing support ticket under current staff authority."""

from datetime import datetime
from typing import Any
from uuid import UUID

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Record one bounded invoice dispute hold; no financial correction."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--staff-identity", type=UUID, required=True)
        parser.add_argument("--invoice", type=UUID, required=True)
        parser.add_argument("--ticket", type=UUID, required=True)
        parser.add_argument("--amount-minor", type=int, required=True)
        parser.add_argument("--hold-until", type=datetime.fromisoformat, required=True)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.billing.dunning import DunningRefusedError
        from apps.billing.dunning_scheduler import record_dispute
        from apps.billing.models import Invoice
        from apps.orgs.realm_bootstrap import Refused, principal_for

        try:
            row = record_dispute(
                principal=principal_for(options["staff_identity"]),
                invoice_id=options["invoice"],
                ticket_id=options["ticket"],
                amount_minor=options["amount_minor"],
                hold_until=options["hold_until"],
            )
        except (Refused, DunningRefusedError, Invoice.DoesNotExist) as refused:
            raise CommandError(f"dunning dispute refused: {refused}") from None
        self.stdout.write(f"dunning dispute={row.id} invoice={row.invoice_id}")
