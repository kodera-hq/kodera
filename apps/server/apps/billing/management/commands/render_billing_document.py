"""Render one frozen legal document offline; publish only after independent conformance passes."""

from pathlib import Path
from typing import Any
from uuid import UUID

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Publish one independently validated PDF/A-3b + EN16931 invoice or credit note."

    def add_arguments(self, parser: CommandParser) -> None:
        target = parser.add_mutually_exclusive_group(required=True)
        target.add_argument("--invoice", type=UUID)
        target.add_argument("--credit-note", type=UUID)
        parser.add_argument("--verapdf", type=Path, required=True)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.billing.artifacts import publish
        from apps.billing.integrity import IntegrityRefusedError
        from apps.billing.rendering import OfflineRenderer, OfflineValidator

        try:
            artifact = publish(
                document_id=options["invoice"] or options["credit_note"],
                credit_note=options["credit_note"] is not None,
                renderer=OfflineRenderer(),
                validator=OfflineValidator(verapdf=options["verapdf"]),
                validator_ref="verapdf-1.30.2/factur-x-7.9/saxonche-13.1.1/en16931",
            )
        except IntegrityRefusedError as refused:
            raise CommandError(f"billing document refused: {refused}") from None
        except Exception:
            raise CommandError(
                "billing document renderer or validation unavailable; nothing published"
            ) from None
        self.stdout.write(
            f"billing document verified artifact={artifact.id} pdf_sha256={artifact.pdf_sha256} xml_sha256={artifact.xml_sha256}"
        )
