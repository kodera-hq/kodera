"""The queue's sweep as an operator command: docs/specs/FIRST_OWNER_BOOTSTRAP.md §5.5 step 4.

The invited pilot runs no worker and so no sweeper. This runs `sweep_expired_leases`
(docs/specs/JOB_QUEUE.md §5.2) unchanged: every event it writes keeps the `system` actor the queue
gives it, and it reads no claim. Every operator command of the pilot runs the same sweep first; the
deployment may also schedule this one, which is why it names no staff identity.
"""

from typing import Any

from django.apps import apps as registry
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = (
        "Run the job queue's sweep once: an expired lease with an open dispatch goes to "
        "needs_reconciliation, one without becomes orphaned."
    )

    def handle(self, *args: Any, **options: Any) -> None:
        if not all(
            registry.is_installed(app) for app in ("apps.jobs", "apps.outbox", "apps.audit")
        ):
            raise CommandError(
                "the queue is not installed: run with --settings config.settings.job_queue"
            )
        from apps.jobs.services import sweep_expired_leases

        sweep_expired_leases()
        self.stdout.write("sweep_jobs outcome=swept")
