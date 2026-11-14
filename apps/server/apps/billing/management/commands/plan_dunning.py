"""Read-only proposal from bounded operator evidence; never sends a notice or enqueues work."""

import json
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from django.core.management.base import BaseCommand, CommandError, CommandParser
from django.utils import timezone

from apps.billing.dunning import Debt, DeliveredStep, DunningRefusedError, propose


class Command(BaseCommand):
    help = "Inspect the next supervised dunning proposal; no delivery or tenant transition."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--snapshot", type=Path, required=True)

    def handle(self, *args: Any, **options: Any) -> None:
        try:
            with options["snapshot"].open("rb") as stream:
                raw = stream.read(32_769)
            if len(raw) > 32_768:
                raise DunningRefusedError("dunning_snapshot_bound")
            document = json.loads(raw)
            if not isinstance(document, dict) or set(document) != {
                "subscription_id",
                "debts",
                "delivered",
            }:
                raise DunningRefusedError("dunning_snapshot_schema")
            debts = tuple(
                Debt(
                    invoice_id=UUID(row["invoice_id"]),
                    due_at=datetime.fromisoformat(row["due_at"]),
                    owed_minor=row["owed_minor"],
                    disputed_minor=row.get("disputed_minor", 0),
                    dispute_hold_until=None
                    if row.get("dispute_hold_until") is None
                    else datetime.fromisoformat(row["dispute_hold_until"]),
                    processing_since=None
                    if row.get("processing_since") is None
                    else datetime.fromisoformat(row["processing_since"]),
                )
                for row in document["debts"]
            )
            delivered = tuple(
                DeliveredStep(
                    step=row["step"],
                    delivered_at=datetime.fromisoformat(row["delivered_at"]),
                    receipt_at=None
                    if row.get("receipt_at") is None
                    else datetime.fromisoformat(row["receipt_at"]),
                )
                for row in document["delivered"]
            )
            proposal = propose(
                subscription_id=UUID(document["subscription_id"]),
                debts=debts,
                delivered=delivered,
                now=timezone.now(),
            )
        except (ValueError, KeyError, TypeError, AttributeError, OSError) as refused:
            reason = (
                str(refused)
                if isinstance(refused, DunningRefusedError)
                else "dunning_snapshot_schema"
            )
            raise CommandError(f"dunning planning refused: {reason}") from None
        self.stdout.write(
            json.dumps(
                {
                    "read_only": True,
                    "evidence_verified": False,
                    "proposal": None if proposal is None else asdict(proposal),
                },
                default=str,
                sort_keys=True,
            )
        )
