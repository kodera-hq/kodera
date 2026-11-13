"""Commit an authorised Core cutoff or resume actual Core purge with explicit provider holds."""

import json
from datetime import datetime
from typing import Any
from uuid import UUID

from django.core.management.base import BaseCommand, CommandError, CommandParser
from django.db import DatabaseError

from apps.orgs.erasure_services import advance_erasure, begin_erasure
from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Worker-only workspace cutoff/purge; unconfigured external adapters remain held."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("operation", choices=["cutoff", "resume"])
        parser.add_argument("--organisation-id", type=UUID)
        parser.add_argument("--request-id", type=UUID)
        parser.add_argument("--actor-identity-id", type=UUID)
        parser.add_argument("--instruction-ref")
        parser.add_argument("--instruction-sha256")
        parser.add_argument("--purge-not-before", type=datetime.fromisoformat)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        try:
            if options["operation"] == "cutoff":
                required = [
                    "organisation_id",
                    "actor_identity_id",
                    "instruction_ref",
                    "instruction_sha256",
                    "purge_not_before",
                ]
                if (
                    any(options[key] is None for key in required)
                    or options["purge_not_before"].tzinfo is None
                ):
                    raise CommandError(
                        "cutoff requires explicit instruction, digest, current actor, organisation and aware recovery deadline"
                    )
                row = begin_erasure(**{key: options[key] for key in required})
                self.stdout.write(
                    json.dumps(
                        {
                            "request_id": str(row.id),
                            "cutoff_at": row.cutoff_at.isoformat(),
                            "status": row.status,
                        }
                    )
                )
            else:
                if options["request_id"] is None:
                    raise CommandError("resume requires --request-id")
                result = advance_erasure(options["request_id"], {})
                self.stdout.write(json.dumps(result, sort_keys=True))
                if not result["complete"]:
                    raise CommandError("Core purge persisted; external erasure domains remain held")
        except (DatabaseError, ValueError):
            # No customer row, SQL parameter or provider payload reaches the command output.
            raise CommandError(
                "Core erasure refused; inspect the scoped journal and named proof gates"
            ) from None
