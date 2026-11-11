"""Provision the first-party workspace without contacting infrastructure."""

from uuid import UUID

from django.conf import settings
from django.core.exceptions import ObjectDoesNotExist
from django.core.management.base import BaseCommand, CommandError

from apps.orgs.community import bootstrap_community_workspace


class Command(BaseCommand):
    help = "Create the canonical community workspace using an existing owner user"

    def add_arguments(self, parser):
        parser.add_argument("--owner-user-id")

    def handle(self, *args, **options):
        raw = options["owner_user_id"] or settings.KODERA_DEFAULT_COMMUNITY_OWNER_USER_ID
        try:
            workspace = bootstrap_community_workspace(owner_user_id=UUID(raw) if raw else None)
        except (ValueError, ObjectDoesNotExist) as error:
            raise CommandError(str(error)) from None
        self.stdout.write(self.style.SUCCESS(f"Community workspace configured: {workspace.id}"))
