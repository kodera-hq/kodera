"""What every operator command of the invited pilot shares before it imports the queue
(docs/specs/FIRST_OWNER_BOOTSTRAP.md §3.7): the operator profile, config.settings.job_queue, which
installs the queue, the outbox its decisions import and the audit record. Under the API's profile,
which installs no outbox, the command is refused before anything is read."""

from django.apps import apps as registry
from django.core.management.base import CommandError

OPERATOR_APPS = ("apps.jobs", "apps.outbox", "apps.audit", "apps.orgs", "apps.identity")


def require_operator_profile() -> None:
    if not all(registry.is_installed(app) for app in OPERATOR_APPS):
        raise CommandError(
            "the queue, the outbox and the audit record are not all installed: run with "
            "--settings config.settings.job_queue; nothing written"
        )
