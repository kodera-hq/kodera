"""Dispatch a bounded batch of payload-free Web Push jobs from a separate worker."""

from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.notifications import push
from apps.notifications.dispatcher import claim, dispatch_claim, finish


class Command(BaseCommand):
    help = __doc__

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--key-file", type=Path, required=True)
        parser.add_argument("--subject", required=True)
        parser.add_argument("--max-jobs", type=int, default=100)

    def handle(self, *args: Any, **options: Any) -> None:
        if not 1 <= options["max_jobs"] <= 1000:
            raise CommandError("max-jobs is between 1 and 1000")
        processed = 0
        for _ in range(options["max_jobs"]):
            job = claim()
            if job is None:
                break
            try:
                # This mounted application key is worker-only and reloaded per job.
                with options["key_file"].open("rb") as source:
                    raw = source.read(16385)
                if len(raw) > 16384:
                    raise ValueError
                signer = serialization.load_pem_private_key(raw, password=None)
                del raw
                if not isinstance(signer, ec.EllipticCurvePrivateKey):
                    raise ValueError
                curve = signer.curve
                if not isinstance(curve, ec.SECP256R1):
                    raise ValueError
            except (OSError, ValueError, TypeError):
                finish(job, push.Result("retry", 60))
                raise CommandError("the worker VAPID key is unavailable") from None
            try:
                dispatch_claim(job, signer, options["subject"])
                processed += 1
            finally:
                del signer
        self.stdout.write(f"Processed {processed} push outbox jobs")
