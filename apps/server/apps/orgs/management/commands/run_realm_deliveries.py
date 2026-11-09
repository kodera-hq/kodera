"""Run the realm access deliveries once: docs/specs/MEMBERSHIP_LIFECYCLE.md §6.1.6.

Reconciles Core's suspended and removed memberships into deliveries, then turns realm users off or
on with each realm's own worker credential, at the pinned Keycloak origins, then makes sure each
invitee has a realm account with its required actions (docs/specs/INVITATIONS.md §4). It lives with the
memberships whose effect it delivers, and wires the outbox's run to the queue's organisation lock,
which the outbox does not import. Prints one line of counts and never a token, a secret or a user;
exits non-zero when anything needs an operator.
"""

from functools import partial
from pathlib import Path
from typing import Any
from uuid import UUID

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.jobs.services import release_realm_delivery_lock, try_realm_delivery_lock
from apps.orgs.management.operator import require_operator_profile
from apps.outbox.realm.keycloak import RealmOrigins, keycloak_admin
from apps.outbox.realm_access import (
    DEFAULT_LIMIT,
    OrganisationLock,
    RunReport,
    outstanding,
    reconcile,
    run_lock_verdict,
    run_realm_deliveries,
)
from apps.outbox.realm_accounts import run_realm_accounts
from worker.credentials import DirectoryCredentialSource

ORGANISATION_LOCK = OrganisationLock(
    try_take=try_realm_delivery_lock, release=release_realm_delivery_lock
)


class Command(BaseCommand):
    help = (
        "Reconcile, then disable or enable realm users for suspended, removed and reactivated "
        "memberships, once. Needs KODERA_REALM_WORKER_SECRET_DIR, "
        "KODERA_REALM_ISSUER_ORIGIN and KODERA_REALM_ADMIN_ORIGIN."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--once", action="store_true", help="Run one pass and exit")
        parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
        parser.add_argument(
            "--reconcile-only",
            action="store_true",
            help="Only enqueue what Core's memberships owe the realms, and report",
        )
        parser.add_argument(
            "--reconcile-attempt",
            type=UUID,
            metavar="DELIVERY",
            help="Decide one delivery held in needs_reconciliation from a fresh realm read",
        )
        parser.add_argument("--staff-identity", type=UUID, help="The deciding staff operator")
        from apps.orgs.realm_bootstrap import add_evidence_arguments

        add_evidence_arguments(
            parser, "compute-terminated", "Record that the runner holding the attempt has stopped"
        )
        parser.add_argument(
            "--requeue-failed",
            action="store_true",
            help="Also enqueue again each failed access_off of a membership that is still off",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        if not options["once"]:
            raise CommandError("run_realm_deliveries runs only with --once")
        if options["limit"] < 1:
            raise CommandError("--limit must be at least 1")
        if options["reconcile_only"]:
            report = RunReport(reconciled=reconcile(requeue_failed=options["requeue_failed"]))
            report.outstanding, report.oldest_outstanding_s = outstanding()
            self.stdout.write(report.line())
            if report.needs_operator:
                raise CommandError("realm access needs an operator: outstanding deliveries")
            return
        directory = getattr(settings, "KODERA_REALM_WORKER_SECRET_DIR", None)
        if not directory:
            raise CommandError("no realm worker credential source: KODERA_REALM_WORKER_SECRET_DIR")
        origins: RealmOrigins | None = getattr(settings, "KODERA_REALM_ORIGINS", None)
        if origins is None:
            raise CommandError(
                "no Keycloak origins: KODERA_REALM_ISSUER_ORIGIN and KODERA_REALM_ADMIN_ORIGIN"
            )
        source = DirectoryCredentialSource(Path(directory))
        factory = partial(keycloak_admin, source=source, origins=origins)
        if options["reconcile_attempt"] is not None:
            self._decide(options, factory, origins.issuer)
            return
        report = run_realm_deliveries(
            admin_factory=factory,
            organisation_lock=ORGANISATION_LOCK,
            origins_issuer=origins.issuer,
            limit=options["limit"],
            requeue_failed=options["requeue_failed"],
        )
        if report.already_running:
            # Another pass holds the run lock (a run can outlast the schedule's interval): this
            # one does nothing and is not a failure, unless the holder has been at it for longer
            # than twice a pass can last, which would otherwise silence every alert.
            verdict = run_lock_verdict(report.lock_holder_age_s)
            self.stdout.write(
                verdict
                if verdict == "already_running"
                else f"stuck_run held_s={int(report.lock_holder_age_s or 0)}"
            )
            if verdict == "stuck_run":
                raise CommandError("stuck_run: the run lock is held past twice the run bound")
            return
        self.stdout.write(report.line())
        # The invitees' realm accounts, with the same credentials (docs/specs/INVITATIONS.md §4).
        accounts = run_realm_accounts(
            admin_factory=factory,
            origins_issuer=origins.issuer,
            limit=options["limit"],
            setup_redirect=getattr(settings, "KODERA_REALM_SETUP_REDIRECT", None),
        )
        self.stdout.write(accounts.line())
        if report.needs_operator or accounts.needs_operator:
            raise CommandError("realm access needs an operator: see the counts and the error log")

    def _decide(self, options: dict[str, Any], factory: Any, origins_issuer: str) -> None:
        """An operator's decision on one delivery whose outcome is unknown (§6.1.4)."""
        require_operator_profile()
        from apps.orgs.owner_claims import ClaimRefusedError
        from apps.orgs.realm_access_decision import (
            RealmDecisionRefusedError,
            decide_realm_access_attempt,
        )
        from apps.orgs.realm_bootstrap import Refused, evidence_from, principal_for

        delivery = options["reconcile_attempt"]
        try:
            if options["staff_identity"] is None:
                raise Refused("--reconcile-attempt needs --staff-identity; nothing written")
            # Optional for an attempt the runner closed `ambiguous` itself (its closing record is
            # the evidence); required for an abandoned one.
            evidence = evidence_from(options, "compute_terminated")
            decided = decide_realm_access_attempt(
                principal=principal_for(options["staff_identity"]),
                delivery_id=delivery,
                compute_terminated=evidence,
                admin_factory=factory,
                origins_issuer=origins_issuer,
            )
        except (Refused, ClaimRefusedError, RealmDecisionRefusedError) as refusal:
            self.stdout.write(f"reconcile_attempt delivery={delivery} outcome=refused")
            raise CommandError(str(refusal)) from None
        observed = decided.observed
        self.stdout.write(
            f"reconcile_attempt delivery={delivery} decision={decided.decision_id} "
            f"exit={decided.exit} outcome={decided.operation_outcome} "
            f"observed=present:{observed.present},enabled:{observed.enabled},"
            f"sessions:{observed.sessions},grants:{observed.grants} "
            f"enqueued={decided.enqueued or 'none'}"
        )
