"""Expired-only quota cleanup; scheduling is an independent deployment obligation."""

from django.core.management.base import BaseCommand, CommandError

from apps.identity.discovery_quotas import cleanup_expired
from services.identity.discovery_policy import DiscoveryUnavailableError


class Command(BaseCommand):
    help = "Remove expired discovery quota events; never evict live counters."

    def handle(self, *args, **options):
        try:
            removed = cleanup_expired()
        except DiscoveryUnavailableError:
            raise CommandError("discovery quota cleanup unavailable") from None
        self.stdout.write(f"expired_discovery_events_removed={removed}")
