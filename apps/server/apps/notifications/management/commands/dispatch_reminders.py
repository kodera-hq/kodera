"""Operator/worker drain for due personal message reminders."""

from typing import Any
from uuid import UUID

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Drain bounded due personal reminders into inbox notifications and push wakeups."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--once", action="store_true", required=True)
        parser.add_argument("--organisation", type=UUID, default=None)
        parser.add_argument("--max-jobs", type=int, default=25)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        import json

        from apps.notifications import reminder_dispatcher

        max_jobs = options["max_jobs"]
        if type(max_jobs) is not int or not 1 <= max_jobs <= 100:
            raise CommandError("max-jobs must be between 1 and 100")

        org_id: UUID | None = options["organisation"]
        summary = reminder_dispatcher.dispatch_reminders(
            organisation_id=org_id,
            max_jobs=max_jobs,
        )
        self.stdout.write(json.dumps(summary, sort_keys=True))
