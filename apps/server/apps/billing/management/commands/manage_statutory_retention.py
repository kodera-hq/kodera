"""Explicit source-only statutory worker actions; no provider or live-key operation."""

from datetime import datetime
from typing import Any
from uuid import UUID

from django.core.management.base import BaseCommand, CommandError, CommandParser
from django.db import DatabaseError

from apps.billing import statutory
from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Register fiscal authority, close a contract, qualify legacy accounting or purge one due record."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("operation", choices=["fiscal", "close", "qualify", "purge"])
        parser.add_argument("--source-table")
        parser.add_argument("--source-id", type=UUID)
        parser.add_argument("--issuer-siren")
        parser.add_argument("--starts-at", type=datetime.fromisoformat)
        parser.add_argument("--closed-at", type=datetime.fromisoformat)
        parser.add_argument("--timezone")
        parser.add_argument("--authority-ref")
        parser.add_argument("--event-at", type=datetime.fromisoformat)
        parser.add_argument("--reason")
        parser.add_argument("--actor-identity-id", type=UUID)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        operation = options["operation"]
        fields = {
            "fiscal": ["issuer_siren", "starts_at", "closed_at", "timezone", "authority_ref"],
            "close": ["source_id", "event_at", "reason", "authority_ref", "actor_identity_id"],
            "qualify": ["source_table", "source_id", "event_at", "authority_ref"],
            "purge": ["source_table", "source_id"],
        }[operation]
        if any(options[key] is None for key in fields):
            raise CommandError("explicit operation inputs required: " + ", ".join(fields))
        if any(
            isinstance(options[key], datetime) and options[key].tzinfo is None for key in fields
        ):
            raise CommandError("aware timestamps required; no timezone is inferred")
        try:
            if operation == "fiscal":
                row = statutory.register_fiscal_period(**{key: options[key] for key in fields})
                result = f"fiscal authority registered id={row.id}"
            elif operation == "close":
                statutory.close_contract(
                    order_id=options["source_id"],
                    ended_at=options["event_at"],
                    reason=options["reason"],
                    evidence_ref=options["authority_ref"],
                    actor_identity_id=options["actor_identity_id"],
                )
                result = "contract and linked legal clocks closed atomically"
            elif operation == "qualify":
                statutory.qualify_legacy(
                    source_table=options["source_table"],
                    source_id=options["source_id"],
                    event_at=options["event_at"],
                    evidence_ref=options["authority_ref"],
                )
                result = "legacy accounting qualified from explicit fiscal authority"
            else:
                if not statutory.purge_due(
                    source_table=options["source_table"], source_id=options["source_id"]
                ):
                    raise CommandError("source record absent or held by a later-lived dependency")
                result = "due source record and detached snapshot hard-purged"
        except DatabaseError:
            raise CommandError(
                "statutory operation refused; fiscal, authority, immutable-date or dependency proof failed"
            ) from None
        self.stdout.write(result)
