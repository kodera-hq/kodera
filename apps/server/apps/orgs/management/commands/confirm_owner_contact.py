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
        parser.add_argument("--claim", type=UUID, required=True)
        parser.add_argument("--evidence-ref", required=True)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.orgs import owner_claims as claims

        def body(principal, organisation_id, request_id):
            from apps.orgs.claim_confirmation import confirm_owner_contact

            changed = confirm_owner_contact(
                principal=principal,
                organisation_id=organisation_id,
                claim_id=options["claim"],
                evidence_ref=options["evidence_ref"],
                request_id=request_id,
            )
            return options["claim"], "confirmed" if changed else "already_confirmed"

        claims.run_claim_command("confirm_owner_contact", options, self.stdout.write, body)
