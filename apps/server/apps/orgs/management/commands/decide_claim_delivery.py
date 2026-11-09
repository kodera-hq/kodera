"""Excluded pilot operator claim control with secret-free output."""

from typing import Any
from uuid import UUID

from django.core.management.base import BaseCommand, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Record the finite owner-claim operation under current staff operator authority."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--staff-identity", type=UUID, required=True)
        parser.add_argument("--delivery", type=UUID, required=True)
        parser.add_argument("--exit", choices=("resume", "fail"), required=True)
        parser.add_argument(
            "--outcome", choices=("completed", "no_effect", "partial"), required=True
        )
        from apps.orgs.realm_bootstrap import add_evidence_arguments

        add_evidence_arguments(parser, "compute-terminated", "SMTP conversation termination record")
        add_evidence_arguments(parser, "target-read", "Mail provider Message-ID record")

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from django.core.management.base import CommandError

        from apps.jobs.services import ReconciliationDecision
        from apps.orgs.claim_delivery import decide_claim_delivery, delivery_evidence_from
        from apps.orgs.owner_claims import ClaimRefusedError
        from apps.orgs.realm_bootstrap import Refused, principal_for

        try:
            principal = principal_for(options["staff_identity"])
            decision = ReconciliationDecision(
                subject_id=options["delivery"],
                exit=options["exit"],
                operation_outcome=options["outcome"],
                compute_terminated=delivery_evidence_from(options, "compute_terminated"),
                target_read=delivery_evidence_from(options, "target_read"),
            )
            reference = decide_claim_delivery(principal=principal, decision=decision)
        except (Refused, ClaimRefusedError) as refusal:
            reason = str(refusal) if isinstance(refusal, ClaimRefusedError) else "operator_refused"
            self.stdout.write(
                f"decide_claim_delivery delivery={options['delivery']} staff_identity={options['staff_identity']} outcome=refused:{reason}"
            )
            raise CommandError(reason) from None
        self.stdout.write(
            f"decide_claim_delivery delivery={options['delivery']} staff_identity={options['staff_identity']} reference={reference} outcome=decided"
        )
