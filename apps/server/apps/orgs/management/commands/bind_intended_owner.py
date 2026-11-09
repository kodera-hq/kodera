"""Excluded pilot operator claim control with secret-free output."""

from typing import Any
from uuid import UUID

from django.core.management.base import BaseCommand, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Record the finite owner-claim operation under current staff operator authority."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--staff-identity", type=UUID, required=True)
        parser.add_argument("--organisation", required=True)
        parser.add_argument("--subject", required=True)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.orgs import owner_claims as claims

        def body(principal, organisation_id, request_id):
            import sys

            contact, record = claims.read_binding_input(sys.stdin)
            return claims.bind_intended_owner(
                principal=principal,
                organisation_id=organisation_id,
                subject=options["subject"],
                account_record=record,
                contact=contact,
                request_id=request_id,
            ), "issued"

        claims.run_claim_command("bind_intended_owner", options, self.stdout.write, body)
