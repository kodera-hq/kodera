"""Record an operator-proven community realm binding and emit current engine membership."""

from uuid import UUID

from django.core.exceptions import ObjectDoesNotExist
from django.core.management.base import BaseCommand, CommandError
from django.db import IntegrityError

from apps.orgs.community import bind_community_identity


class Command(BaseCommand):
    help = "Bind a proven community realm subject to an existing person's membership"

    def add_arguments(self, parser):
        parser.add_argument("--user-id", required=True)
        parser.add_argument("--subject", required=True)

    def handle(self, *args, **options):
        try:
            bind_community_identity(user_id=UUID(options["user_id"]), subject=options["subject"])
        except (ValueError, ObjectDoesNotExist, IntegrityError):
            raise CommandError(
                "Community identity binding refused; inspect account proof and existing bindings"
            ) from None
        self.stdout.write(self.style.SUCCESS("Community identity bound and membership queued"))
