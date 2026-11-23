"""Operator/worker drain for queued Matrix channel imports and live coexistence deliveries."""

from typing import Any
from uuid import UUID

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Drain bounded queued Matrix history imports and inbound/outbound coexistence queues."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--once", action="store_true", required=True)
        parser.add_argument("--organisation", type=UUID, default=None)
        parser.add_argument("--max-jobs", type=int, default=25)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        import json

        from apps.extensions import coexistence, imports

        max_jobs = options["max_jobs"]
        if type(max_jobs) is not int or not 1 <= max_jobs <= 100:
            raise CommandError("max-jobs must be between 1 and 100")

        org_id: UUID | None = options["organisation"]
        synapse_url = getattr(settings, "KODERA_SYNAPSE_URL", None)
        synapse_token = getattr(settings, "KODERA_SYNAPSE_ADMIN_TOKEN", None)
        synapse_server = str(getattr(settings, "KODERA_SYNAPSE_SERVER_NAME", "") or "")
        transport_factory = getattr(settings, "KODERA_MATRIX_REPLAY_TRANSPORT_FACTORY", None)

        matrix_transport = None
        if callable(transport_factory):
            matrix_transport = transport_factory()
        elif (
            isinstance(synapse_url, str)
            and synapse_url
            and isinstance(synapse_token, str)
            and synapse_token
        ):
            matrix_transport = imports.SynapseReplayTransport(
                synapse_url, synapse_token, synapse_server
            )

        summary: dict[str, Any] = {
            "imports": {"replayed": 0, "skipped_unready": 0, "obsoleted": 0},
            "inbound": {"delivered": 0, "retryable": 0, "obsoleted": 0},
            "outbound": coexistence.drain_coexistence_outbound(
                organisation_id=org_id, limit=max_jobs
            ),
        }
        if matrix_transport is not None:
            summary["imports"] = imports.drain_queued_matrix_imports(
                matrix_transport=matrix_transport,
                organisation_id=org_id,
                limit=max_jobs,
            )
            summary["inbound"] = coexistence.drain_coexistence_inbound(
                matrix_transport=matrix_transport,
                organisation_id=org_id,
                limit=max_jobs,
            )
        self.stdout.write(json.dumps(summary, sort_keys=True))
