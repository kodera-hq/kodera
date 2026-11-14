"""Dispose bounded expired extension payloads; never attest an external receiver's erasure."""

from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Purge at most a bounded number of expired nonstatutory payloads, retaining hashes."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--limit", type=int, default=100)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.extensions.retention import purge_due
        from apps.extensions.wire import ExtensionRefusedError

        try:
            count = purge_due(limit=options["limit"])
        except ExtensionRefusedError:
            raise CommandError("extension purge bound refused") from None
        self.stdout.write(f"extension payloads purged={count} external_absence_verified=false")
