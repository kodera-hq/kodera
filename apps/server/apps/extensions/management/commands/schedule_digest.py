"""Queue one opted-in aggregate digest; unapproved copy remains held on remote transport."""

from datetime import datetime
from typing import Any
from uuid import UUID

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Queue one consent-bound period; no SMTP send in this command."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--consent", type=UUID, required=True)
        parser.add_argument("--period-start", type=datetime.fromisoformat, required=True)
        parser.add_argument("--period-end", type=datetime.fromisoformat, required=True)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.extensions.digest import enqueue_digest
        from apps.extensions.models import DigestConsent
        from apps.extensions.wire import ExtensionRefusedError
        from apps.outbox.services import MessageRefusedError, SenderUnavailableError

        try:
            row = enqueue_digest(
                consent_id=options["consent"],
                period_start=options["period_start"],
                period_end=options["period_end"],
            )
        except (
            DigestConsent.DoesNotExist,
            ExtensionRefusedError,
            MessageRefusedError,
            SenderUnavailableError,
        ):
            raise CommandError(
                "digest consent, metadata or sealed outbox unavailable; nothing sent"
            ) from None
        self.stdout.write(f"digest job={row.id} state={row.state}")
