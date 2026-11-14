"""Offline/read-only reconciliation; source evidence cannot authorize ledger corrections."""

import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser


class Command(BaseCommand):
    help = "Report ledger/provider discrepancies without changing money or invoking a provider."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument(
            "--observations",
            type=Path,
            help="Sanitized provider snapshot; never a credential file.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        from apps.billing.integrity import IntegrityRefusedError
        from apps.billing.reconciliation import findings

        path = options.get("observations")
        try:
            observations = None
            if path is not None:
                with path.open("rb") as stream:
                    raw = stream.read(2_000_001)
                if len(raw) > 2_000_000:
                    raise IntegrityRefusedError("reconciliation_observations_bound")
                observations = json.loads(raw)
            report = findings(observations=observations)
        except (IntegrityRefusedError, ValueError, OSError) as refused:
            raise CommandError(
                f"billing reconciliation refused: {type(refused).__name__}"
            ) from None
        self.stdout.write(
            json.dumps(
                {"read_only": True, "findings": [asdict(row) for row in report]}, sort_keys=True
            )
        )
        if report:
            raise CommandError(f"billing reconciliation requires review findings={len(report)}")
