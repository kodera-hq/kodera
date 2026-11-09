"""Steps 1–6 of the pilot's realm job, one per invocation, then the hold for the trust entry:
docs/specs/FIRST_OWNER_BOOTSTRAP.md §5.5 step 1."""

from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = (
        "Record the outcome of the tooling step the organisation's realm_create job is held on, "
        "then claim the job, record the next step's dispatch and hold the job on it. Run once to "
        "begin and once after each tooling step; after step 6 it holds the job for the trust "
        "entry, which complete_realm_bootstrap ends."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        from apps.orgs.realm_bootstrap import OUTCOMES, add_common_arguments, add_evidence_arguments

        add_common_arguments(parser)
        parser.add_argument(
            "--tooling-run",
            help="The identifier of the tooling run that will run the next step",
        )
        parser.add_argument(
            "--outcome",
            choices=OUTCOMES,
            help="How the held tooling step ended: completed, no_effect or partial",
        )
        add_evidence_arguments(
            parser, "compute", "the tooling run's record that the step's run ended"
        )
        add_evidence_arguments(parser, "target", "the tooling's read of what the step made")

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.orgs import realm_bootstrap as rb

        record = rb.Record(
            command="start_realm_bootstrap",
            organisation=options["organisation"],
            staff_identity=options["staff_identity"],
        )

        def body() -> None:
            run = options.get("tooling_run")
            tooling_run = None if run is None else rb.reference(run, "--tooling-run")
            compute = rb.evidence_from(options, "compute")
            target = rb.evidence_from(options, "target")
            outcome = None
            if options.get("outcome") is not None:
                if compute is None or target is None:
                    raise rb.Refused(
                        "--outcome needs the --compute-* and --target-* evidence; nothing written"
                    )
                outcome = rb.Outcome(options["outcome"], compute, target)
            elif compute is not None or target is not None:
                raise rb.Refused("evidence was given without --outcome; nothing written")
            principal = rb.principal_for(options["staff_identity"])
            rb.start(
                record=record,
                principal=principal,
                organisation=rb.organisation_of(options["organisation"]),
                tooling_run=tooling_run,
                outcome=outcome,
            )

        try:
            rb.operate(self.stdout.write, record, body)
        except rb.Refused as refused:
            raise CommandError(str(refused)) from None
