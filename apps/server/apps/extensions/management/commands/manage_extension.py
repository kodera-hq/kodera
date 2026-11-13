"""Current owner/admin installation, queue and dead-letter management with a token on stdin."""

import json
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Manage one scoped installation; customer access token on stdin, never app secrets."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument(
            "action", choices=("install", "rotate", "revoke", "inspect", "enqueue", "reconcile")
        )
        parser.add_argument("--organisation", type=UUID, required=True)
        parser.add_argument("--installation", type=UUID)
        parser.add_argument("--name")
        parser.add_argument("--endpoint")
        parser.add_argument("--events", nargs="+", default=[])
        parser.add_argument("--grace-expires-at", type=datetime.fromisoformat)
        parser.add_argument("--event-key")
        parser.add_argument("--event-type")
        parser.add_argument("--data", type=Path)
        parser.add_argument("--delivery", type=UUID)
        parser.add_argument("--observed", choices=("applied", "not_applied", "abandon"))
        parser.add_argument("--evidence-ref")

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.docs.errors import RefusalError
        from apps.extensions import services
        from apps.extensions.management.caller import caller
        from apps.extensions.wire import ExtensionRefusedError
        from apps.media.outbound import BlockedTargetError

        verified = caller()
        common = {"verified": verified, "organisation_id": options["organisation"]}
        action = options["action"]
        result: Any
        try:
            if action == "install":
                if not options["name"] or not options["endpoint"]:
                    raise ValueError
                result = services.install(
                    **common,
                    name=options["name"],
                    endpoint=options["endpoint"],
                    events=options["events"],
                )
            else:
                if options["installation"] is None:
                    raise ValueError
                common["installation_id"] = options["installation"]
                if action == "rotate":
                    if options["grace_expires_at"] is None:
                        raise ValueError
                    result = services.rotate(**common, grace_expires_at=options["grace_expires_at"])
                elif action == "revoke":
                    result = services.revoke(**common)
                elif action == "inspect":
                    result = services.inspect(**common)
                elif action == "reconcile":
                    if any(
                        options[key] is None for key in ("delivery", "observed", "evidence_ref")
                    ):
                        raise ValueError
                    result = services.reconcile(
                        **common,
                        delivery_id=options["delivery"],
                        observed=options["observed"],
                        evidence_ref=options["evidence_ref"],
                    )
                else:
                    if (
                        options["data"] is None
                        or options["event_key"] is None
                        or options["event_type"] is None
                    ):
                        raise ValueError
                    with options["data"].open("rb") as stream:
                        raw = stream.read(131073)
                    if len(raw) > 131072:
                        raise ValueError
                    result = services.enqueue(
                        **common,
                        event_key=options["event_key"],
                        event_type=options["event_type"],
                        data=json.loads(raw),
                    )
        except (
            ValueError,
            TypeError,
            OSError,
            RefusalError,
            ExtensionRefusedError,
            BlockedTargetError,
        ):
            raise CommandError(
                "extension command refused; check input and current workspace authority"
            ) from None
        from apps.extensions.models import Installation

        value: Any
        if isinstance(result, Installation):
            value = {
                "id": str(result.id),
                "generation": str(result.generation),
                "previous_generation": str(result.previous_generation)
                if result.previous_generation
                else None,
                "grace_expires_at": result.grace_expires_at.isoformat()
                if result.grace_expires_at
                else None,
            }
        else:
            value = (
                result
                if isinstance(result, list)
                else {"id": str(result.id)}
                if result is not None
                else {"revoked": True}
            )
        self.stdout.write(json.dumps(value, sort_keys=True))
