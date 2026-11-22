"""Purge bounded expired uncompleted upload tickets after signed S3 DELETE + HEAD 404."""

from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Purge expired uncompleted attachment upload tickets after verifying S3 object absence."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--limit", type=int, default=100)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.media.services import reap_expired_uploads

        try:
            purged = reap_expired_uploads(limit=options["limit"])
        except ValueError as error:
            raise CommandError(str(error)) from None
        self.stdout.write(f"expired attachment uploads purged={purged}")
