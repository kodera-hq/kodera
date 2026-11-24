"""Operator command running isolated restore rehearsal guards before opening readiness."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import UUID

from django.apps import apps as registry
from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.restore_rehearsal import RestoreRehearsalError, execute_restore_guards

REQUIRED_REHEARSAL_APPS = (
    "apps.jobs",
    "apps.audit",
    "apps.orgs",
    "apps.identity",
    "apps.extensions",
    "apps.notifications",
    "apps.outbox",
    "apps.media",
    "apps.support",
    "apps.billing",
    "apps.e2ee",
)


def _require_rehearsal_profile() -> None:
    if not all(registry.is_installed(app) for app in REQUIRED_REHEARSAL_APPS):
        raise CommandError(
            "restore rehearsal requires jobs, audit, extensions, notifications, outbox, and media installed: "
            "run with --settings config.settings.deploy_operator; nothing written"
        )


class Command(BaseCommand):
    help = (
        "Disarm outbound side-effects, replay post-backup Art. 17 erasures, "
        "and reconcile S3 attachment inventory in an isolated rehearsal database."
    )
    stealth_options = ("_backend_factory",)

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument(
            "--disarm-outbound",
            action="store_true",
            help="Neutralize active extension/coexistence endpoints, push outbox, and mail outbox.",
        )
        parser.add_argument(
            "--erasure-ledger",
            type=Path,
            default=None,
            help="Path to post-backup GDPR Art. 17 erasure ledger JSON.",
        )
        parser.add_argument(
            "--s3-manifest",
            type=Path,
            default=None,
            help="Path to S3 object inventory manifest JSON for attachment reconciliation.",
        )
        parser.add_argument(
            "--actor-identity-id",
            type=UUID,
            default=None,
            help="Optional staff_operator identity UUID authorizing replayed erasures.",
        )
        parser.add_argument(
            "--json",
            action="store_true",
            help="Emit structured JSON report (default output format).",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        backend_factory = options.get("_backend_factory")
        if backend_factory is None:
            _require_rehearsal_profile()

        kwargs: dict[str, Any] = {
            "disarm_outbound": bool(options.get("disarm_outbound")),
            "erasure_ledger_path": options.get("erasure_ledger"),
            "s3_manifest_path": options.get("s3_manifest"),
            "actor_identity_id": options.get("actor_identity_id"),
        }
        if backend_factory is not None:
            kwargs["backend_factory"] = backend_factory

        try:
            report = execute_restore_guards(**kwargs)
        except RestoreRehearsalError as err:
            suffix = (
                f" [unresolved_domains={','.join(err.unresolved_domains)}]"
                if err.unresolved_domains
                else ""
            )
            raise CommandError(f"restore rehearsal guard refused ({err.code}){suffix}") from None

        self.stdout.write(json.dumps(report.to_dict(), sort_keys=True))
