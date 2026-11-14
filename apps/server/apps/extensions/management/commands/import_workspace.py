"""Resume a bounded source archive import as its authenticated current owner/admin."""

from pathlib import Path
from typing import Any
from uuid import UUID

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Import native docs/Collections from a local export; customer token on stdin."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--organisation", type=UUID, required=True)
        parser.add_argument("--source", choices=("slack", "discord", "notion"), required=True)
        parser.add_argument("--archive", type=Path, required=True)
        parser.add_argument("--max-objects", type=int, default=25)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        import json

        from apps.docs.errors import RefusalError
        from apps.extensions.imports import execute
        from apps.extensions.management.caller import caller
        from apps.extensions.wire import ExtensionRefusedError

        verified = caller()
        try:
            with options["archive"].open("rb") as stream:
                raw = stream.read(20 * 1024 * 1024 + 1)
            result = execute(
                verified=verified,
                organisation_id=options["organisation"],
                source=options["source"],
                raw=raw,
                limit=options["max_objects"],
            )
        except (OSError, ExtensionRefusedError, RefusalError):
            raise CommandError(
                "workspace import refused; inspect bounded local input and current authority"
            ) from None
        self.stdout.write(json.dumps(result, sort_keys=True))
