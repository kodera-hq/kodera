"""Grant the first two staff operators, once: docs/specs/STAFF_IDENTITY.md §4."""

from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.identity.staff_roles import StaffRoleError, bootstrap_staff_roles


class Command(BaseCommand):
    help = (
        "Grant staff_operator to exactly two distinct staff identities of KODERA_STAFF_ISSUER, "
        "storing them first if needed, in one transaction. Refused once any staff role has been "
        "granted: it runs once, ever."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument(
            "--operator",
            required=True,
            nargs=2,
            action="append",
            metavar=("SUBJECT", "EMAIL"),
            help="Given twice: the subject and contact address of each first operator",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        try:
            granted = bootstrap_staff_roles(
                operators=[(subject, email) for subject, email in options["operator"]]
            )
        except StaffRoleError as error:
            raise CommandError(str(error)) from None
        for grant in granted:
            self.stdout.write(
                f"{grant.role} granted by bootstrap to staff identity {grant.identity_id}"
            )
