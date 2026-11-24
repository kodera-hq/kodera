"""Operator/worker drain for due Send Later scheduled Matrix messages."""

from typing import Any
from uuid import UUID

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Drain bounded due Send Later scheduled messages with delivery-time policy revalidation."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--once", action="store_true", required=True)
        parser.add_argument("--organisation", type=UUID, default=None)
        parser.add_argument("--max-jobs", type=int, default=25)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        import importlib
        import json

        from apps.workspaces import scheduled_dispatcher

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
        matrix_client = None
        if callable(transport_factory):
            matrix_client = transport_factory()
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
            matrix_client = factory()
        elif (
            isinstance(synapse_url, str)
            and synapse_url
            and isinstance(synapse_token, str)
            and synapse_token
        ):
            matrix_client = scheduled_dispatcher.MatrixReplayClient(
                synapse_url, synapse_token, synapse_server
            )

        if matrix_client is None:
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

        summary = scheduled_dispatcher.dispatch_scheduled_messages(
            matrix_client=matrix_client,
            organisation_id=org_id,
            max_jobs=max_jobs,
        )
        self.stdout.write(json.dumps(summary, sort_keys=True))
