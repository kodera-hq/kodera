"""Revoke a staff role grant, two-person: docs/specs/STAFF_IDENTITY.md §4."""

import uuid
from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.identity.models import STAFF_ROLES
from apps.identity.staff_roles import StaffRoleError, revoke_staff_role


class Command(BaseCommand):
    help = (
        "Revoke the current grant of a staff role to the staff identity of a subject of "
        "KODERA_STAFF_ISSUER. The grant is kept, with the time it was revoked. "
        "--staff-identity is the acting staff identity: it holds a current staff_operator grant "
        "and is not the one whose grant is revoked."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--staff-identity", required=True, type=uuid.UUID)
        parser.add_argument("--subject", required=True)
        parser.add_argument("--role", required=True, choices=STAFF_ROLES)

    def handle(self, *args: Any, **options: Any) -> None:
        try:
            grant_id = revoke_staff_role(
                acting_identity_id=options["staff_identity"],
                subject=options["subject"],
                role=options["role"],
            )
        except StaffRoleError as error:
            raise CommandError(str(error)) from None
        self.stdout.write(f"{options['role']} revoked: grant {grant_id}")
