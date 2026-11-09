"""Grant a staff role, two-person: docs/specs/STAFF_IDENTITY.md §4."""

import uuid
from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.identity.models import STAFF_ROLES
from apps.identity.staff_roles import StaffRoleError, grant_staff_role


class Command(BaseCommand):
    help = (
        "Grant a staff role to the staff identity of a subject of KODERA_STAFF_ISSUER, storing "
        "the identity first if it does not exist. --staff-identity is the acting staff identity: "
        "it holds a current staff_operator grant and is not the grantee."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--staff-identity", required=True, type=uuid.UUID)
        parser.add_argument("--subject", required=True)
        parser.add_argument("--role", required=True, choices=STAFF_ROLES)
        parser.add_argument(
            "--email", default="", help="Contact address, needed only for a new staff identity"
        )

    def handle(self, *args: Any, **options: Any) -> None:
        try:
            grant = grant_staff_role(
                acting_identity_id=options["staff_identity"],
                subject=options["subject"],
                email=options["email"],
                role=options["role"],
            )
        except StaffRoleError as error:
            raise CommandError(str(error)) from None
        verb = "granted" if grant.created else "already held"
        self.stdout.write(f"{grant.role} {verb} by staff identity {grant.identity_id}")
