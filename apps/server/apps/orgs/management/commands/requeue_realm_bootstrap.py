"""Replace a failed or cancelled pilot realm job: docs/specs/FIRST_OWNER_BOOTSTRAP.md §5.7."""

from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = (
        "Enqueue one new realm_create job for a prospect organisation whose latest one failed or "
        'was cancelled, under the key ["requeue", replaced_job_id]. A repeat finds that job and '
        "enqueues none."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        from apps.orgs.realm_bootstrap import add_common_arguments

        add_common_arguments(parser)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.orgs import realm_bootstrap as rb

        record = rb.Record(
            command="requeue_realm_bootstrap",
            organisation=options["organisation"],
            staff_identity=options["staff_identity"],
        )

        def body() -> None:
            principal = rb.principal_for(options["staff_identity"])
            rb.requeue(
                record=record,
                principal=principal,
                organisation=rb.organisation_of(options["organisation"]),
            )

        try:
            rb.operate(self.stdout.write, record, body)
        except rb.Refused as refused:
            raise CommandError(str(refused)) from None
