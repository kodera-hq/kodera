"""Bounded time-driven cleanup of expired Passport magic-link tokens and rate-limit events."""

from __future__ import annotations

import json
from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.identity.passport import purge_expired_passport_tokens


class Command(BaseCommand):
    help = "Remove expired Passport magic-link tokens and rate-limit events in bounded batches."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--batch-size", type=int, default=500)
        parser.add_argument("--max-batches", type=int, default=20)

    def handle(self, *args: Any, **options: Any) -> None:
        batch_size = int(options["batch_size"])
        max_batches = int(options["max_batches"])
        if batch_size < 1 or max_batches < 1:
            raise CommandError("batch-size and max-batches must be >= 1")
        result = purge_expired_passport_tokens(batch_size=batch_size, max_batches=max_batches)
        self.stdout.write(json.dumps(result, sort_keys=True))
