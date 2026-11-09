"""`manage.py load_legal_documents <file>`: apps/legal, additive and idempotent."""

from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.legal.services import PLACEHOLDER, LegalDocumentsError, load_documents, read_documents


class Command(BaseCommand):
    help = "Publish the legal documents a file names; refuse any edit of a published one."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("path", nargs="?", type=Path, default=PLACEHOLDER)
        parser.add_argument(
            "--allow-placeholder",
            action="store_true",
            help="Load a file that declares placeholder = true (development and tests only).",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        try:
            created, unchanged = load_documents(
                read_documents(options["path"]), allow_placeholder=options["allow_placeholder"]
            )
        except (LegalDocumentsError, OSError, ValueError, KeyError, TypeError) as refused:
            raise CommandError(f"legal documents refused: {refused}") from None
        self.stdout.write(f"{created} created, {unchanged} unchanged")
