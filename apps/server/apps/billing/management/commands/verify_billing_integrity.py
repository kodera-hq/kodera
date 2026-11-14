"""Verify gapless invoice/AV series and immutable artifact digests; never repairs records."""

from typing import Any

from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "Read-only series, snapshot and artifact integrity verification."

    def handle(self, *args: Any, **options: Any) -> None:
        from apps.billing.artifacts import verify_artifact
        from apps.billing.integrity import IntegrityRefusedError, verify_database_series
        from apps.billing.models import BillingArtifact

        try:
            verify_database_series()
            count = 0
            for row in BillingArtifact.objects.iterator(chunk_size=100):
                verify_artifact(row)
                count += 1
        except IntegrityRefusedError as refused:
            raise CommandError(f"billing integrity refused: {refused}") from None
        self.stdout.write(f"billing integrity verified artifacts={count}")
