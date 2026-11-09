"""`manage.py load_catalogue <file>`: apps/billing/catalogue, additive and idempotent."""

from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.billing.catalogue import PLACEHOLDER, CatalogueError, load, read


class Command(BaseCommand):
    help = "Load a catalogue file: create what is absent, refuse any edit of a stored row."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("path", nargs="?", type=Path, default=PLACEHOLDER)
        parser.add_argument(
            "--allow-placeholder",
            action="store_true",
            help="Load a file that declares placeholder = true (development and tests only).",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        try:
            report = load(read(options["path"]), allow_placeholder=options["allow_placeholder"])
        except (CatalogueError, OSError, ValueError, KeyError, TypeError) as refused:
            raise CommandError(f"catalogue refused: {refused}") from None
        for label in report.created:
            self.stdout.write(f"created {label}")
        for label in report.changed:
            self.stdout.write(f"changed {label}")
        self.stdout.write(
            f"{len(report.created)} created, {len(report.changed)} changed, "
            f"{len(report.unchanged)} unchanged"
        )
