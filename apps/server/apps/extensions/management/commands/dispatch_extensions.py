"""Dispatch bounded durable extension jobs using a fresh explicitly configured secret port."""

from typing import Any

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Dispatch a bounded batch; unconfigured key provider refuses before claim."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--once", action="store_true", required=True)
        parser.add_argument("--max-jobs", type=int, default=25)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.extensions.dispatcher import claim, dispatch_claim

        factory = getattr(settings, "KODERA_EXTENSION_SECRET_PROVIDER_FACTORY", None)
        if not callable(factory) or not 1 <= options["max_jobs"] <= 100:
            raise CommandError("explicit per-job app-secret provider and max-jobs1..100 required")
        processed = 0
        for _ in range(options["max_jobs"]):
            job = claim()
            if job is None:
                break
            provider = None
            try:
                provider = factory(job.installation_id)
            except Exception:
                dispatch_claim(job, None)
                raise CommandError(
                    "per-job app-secret provider unavailable; no request attempted"
                ) from None
            try:
                dispatch_claim(job, provider)
                processed += 1
            finally:
                del provider
        self.stdout.write(f"extension jobs processed={processed}")
