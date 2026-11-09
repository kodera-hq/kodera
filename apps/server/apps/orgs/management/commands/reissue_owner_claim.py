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

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.orgs import owner_claims as claims

        def body(principal, organisation_id, request_id):
            return claims.reissue_owner_claim(
                principal=principal, organisation_id=organisation_id, request_id=request_id
            ), "issued"

        claims.run_claim_command("reissue_owner_claim", options, self.stdout.write, body)
