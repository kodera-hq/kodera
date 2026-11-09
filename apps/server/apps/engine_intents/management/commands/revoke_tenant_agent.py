"""Revoke a tenant agent's credential (ADR-0016) under a staff operator's authority.

The agent's next pull is refused, and its undelivered commands are superseded.
"""

from typing import Any
from uuid import UUID

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Revoke one of an organisation's tenant-agent credentials."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--staff-identity", type=UUID, required=True)
        parser.add_argument("--organisation", required=True, help="the organisation's slug")
        parser.add_argument("--credential", type=UUID, required=True)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.engine_intents.enrolment import EnrolmentRefusedError, revoke_agent
        from apps.orgs.realm_bootstrap import Refused, organisation_of, principal_for

        name = "revoke_tenant_agent"
        staff = options["staff_identity"]
        organisation_id = None
        try:
            principal = principal_for(staff)
            organisation = organisation_of(options["organisation"])
            organisation_id = organisation.id
            revoke_agent(
                principal=principal,
                organisation_id=organisation.id,
                credential_id=options["credential"],
            )
        except (Refused, EnrolmentRefusedError) as refusal:
            self.stdout.write(
                f"{name} organisation={organisation_id or '-'} staff_identity={staff} "
                "outcome=refused"
            )
            raise CommandError(f"{refusal}; nothing written") from None
        self.stdout.write(
            f"{name} organisation={organisation_id} credential={options['credential']} "
            f"staff_identity={staff} outcome=revoked"
        )
