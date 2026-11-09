"""The decision on the held verify, the verify, and the end of the pilot's realm job:
docs/specs/FIRST_OWNER_BOOTSTRAP.md §5.5 step 3."""

from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = (
        "With the identity operator's test sign-in result, read the realm's discovery document and "
        "key set, record the decision on the job held for the trust entry, claim it, verify the "
        "realm against the trust configuration, and end the job: succeeded, with the realm-ready "
        "fact, or failed on a definite mismatch."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        from apps.orgs.realm_bootstrap import (
            SIGN_IN_RESULTS,
            add_common_arguments,
            add_evidence_arguments,
        )

        add_common_arguments(parser)
        parser.add_argument("--sign-in-result", choices=SIGN_IN_RESULTS)
        parser.add_argument("--sign-in-evidence", help="A reference to the test sign-in's record")
        add_evidence_arguments(
            parser, "compute", "the record that the work the hold awaited has ended"
        )

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.orgs import realm_bootstrap as rb

        record = rb.Record(
            command="complete_realm_bootstrap",
            organisation=options["organisation"],
            staff_identity=options["staff_identity"],
        )

        def body() -> None:
            result, evidence = options.get("sign_in_result"), options.get("sign_in_evidence")
            if result is None or evidence is None:
                raise rb.Refused(
                    "--sign-in-result and --sign-in-evidence are both required; nothing written"
                )
            sign_in_evidence = rb.reference(evidence, "--sign-in-evidence")
            compute = rb.evidence_from(options, "compute")
            principal = rb.principal_for(options["staff_identity"])
            rb.complete(
                record=record,
                principal=principal,
                organisation=rb.organisation_of(options["organisation"]),
                sign_in_result=result,
                sign_in_evidence=sign_in_evidence,
                compute_terminated=compute,
            )

        try:
            rb.operate(self.stdout.write, record, body)
        except rb.Refused as refused:
            raise CommandError(str(refused)) from None
