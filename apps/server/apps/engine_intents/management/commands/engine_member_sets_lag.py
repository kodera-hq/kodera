"""Exit 1, listing them, when an agent has not applied its organisation's latest member set within
the hour, or a set could not carry everyone (`services.anomalies`): ADR-0016. Meant for the
alerting that runs it; it changes nothing."""

from typing import Any

from django.core.management.base import BaseCommand, CommandError

from apps.engine_intents.services import anomalies, lagging


class Command(BaseCommand):
    help = "Report agents that have not applied their organisation's latest member set in time."

    def handle(self, *args: Any, **options: Any) -> None:
        late = lagging()
        for lag in late:
            self.stdout.write(
                f"credential {lag.credential_id} organisation {lag.organisation_id} {lag.kind}: "
                f"applied {lag.applied_revision}, latest {lag.head_revision}, "
                f"behind since {lag.behind_since.isoformat()}"
            )
        found = anomalies()
        for anomaly in found:
            self.stdout.write(
                f"organisation {anomaly.organisation_id} revision {anomaly.revision}: "
                f"{anomaly.problem}"
            )
        if late or found:
            raise CommandError(
                f"{len(late)} agent(s) behind their organisation's member set, "
                f"{len(found)} member-set problem(s)"
            )
        self.stdout.write("every agent has applied its organisation's latest member set")
