"""Set only the authenticated current member's optional digest consent."""

from typing import Any
from uuid import UUID

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Update your own digest consent; customer access token on stdin."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--organisation", type=UUID, required=True)
        consent = parser.add_mutually_exclusive_group(required=True)
        consent.add_argument("--enable", action="store_true")
        consent.add_argument("--disable", action="store_true")
        parser.add_argument("--locale", choices=("en", "fr"), default="en")

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.docs.errors import RefusalError
        from apps.extensions.digest import set_consent
        from apps.extensions.management.caller import caller
        from apps.extensions.wire import ExtensionRefusedError

        try:
            row = set_consent(
                verified=caller(),
                organisation_id=options["organisation"],
                enabled=options["enable"],
                locale=options["locale"],
            )
        except (RefusalError, ExtensionRefusedError):
            raise CommandError("digest consent refused") from None
        self.stdout.write(f"digest consent={row.id} enabled={row.enabled} version={row.version}")
