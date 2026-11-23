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
        import importlib
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

        factory_configured = callable(transport_factory) or (
            isinstance(transport_factory, str) and bool(transport_factory)
        )
        matrix_transport = None
        if callable(transport_factory):
            matrix_transport = transport_factory()
        elif isinstance(transport_factory, str) and transport_factory:
            module_name, _, attribute = transport_factory.rpartition(".")
            if not module_name or not attribute:
                raise CommandError(
                    "KODERA_MATRIX_REPLAY_TRANSPORT_FACTORY must be a dotted Python path"
                )
            try:
                factory = getattr(importlib.import_module(module_name), attribute)
            except (ImportError, AttributeError):
                raise CommandError(
                    "KODERA_MATRIX_REPLAY_TRANSPORT_FACTORY does not resolve to a dotted path"
                ) from None
            if not callable(factory):
                raise CommandError(
                    "KODERA_MATRIX_REPLAY_TRANSPORT_FACTORY does not name a callable"
                )
            matrix_transport = factory()
        elif (
            isinstance(synapse_url, str)
            and synapse_url
            and isinstance(synapse_token, str)
            and synapse_token
        ):
            matrix_transport = imports.SynapseReplayTransport(
                synapse_url, synapse_token, synapse_server
            )

        if matrix_transport is None:
            # Like dispatch_bug_reports' required flags and run_deliveries' mail transport: an
            # unconfigured run refuses before it drains anything, so an idle cron run fails
            # loudly instead of silently returning zeros. Names only, never a value.
            missing = [
                name
                for name, present in (
                    ("KODERA_SYNAPSE_URL", isinstance(synapse_url, str) and bool(synapse_url)),
                    (
                        "KODERA_SYNAPSE_ADMIN_TOKEN",
                        isinstance(synapse_token, str) and bool(synapse_token),
                    ),
                    ("KODERA_MATRIX_REPLAY_TRANSPORT_FACTORY", factory_configured),
                )
                if not present
            ]
            raise CommandError(
                "no Matrix replay transport configured (missing: "
                + ", ".join(missing)
                + "); set KODERA_SYNAPSE_URL and KODERA_SYNAPSE_ADMIN_TOKEN, or "
                "KODERA_MATRIX_REPLAY_TRANSPORT_FACTORY; nothing drained"
            )

        summary: dict[str, Any] = {
            "imports": {"replayed": 0, "skipped_unready": 0, "obsoleted": 0},
            "inbound": {"delivered": 0, "retryable": 0, "obsoleted": 0},
            "outbound": coexistence.drain_coexistence_outbound(
                organisation_id=org_id, limit=max_jobs
            ),
        }
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
