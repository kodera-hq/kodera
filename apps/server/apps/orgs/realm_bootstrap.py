"""The operator-run realm step of the invited pilot: docs/specs/FIRST_OWNER_BOOTSTRAP.md §§5.5, 5.7.

Three operator commands complete, or replace, the `realm_create` job the intake enqueued:
`start_realm_bootstrap` (steps 1–6, then the hold for the trust entry), `complete_realm_bootstrap`
(the decision on that hold, the verify, the end of the job and the realm-ready fact) and
`requeue_realm_bootstrap` (a failed or cancelled job replaced). They hold no identity-provider
credential: the identity operator's tooling makes every change in the realm, and the commands record
its results through the queue's own functions, used unchanged. No lease spans manual work: each
invocation claims, records one dispatch, holds the job on it and lets its claim go.

Every command, before it acts: refuses, writing nothing, unless `KODERA_INTAKE_ADMITTED` is `1`
(§3.8); builds its principal from `--staff-identity` with `staff_principal_for_command` and refuses,
writing nothing, unless that identity holds a current `staff_operator` grant (§3.7, PC-1); then runs
the queue's sweep (§5.5, "Sweep first"). Each prints one line recording what it did — command,
organisation, job, step, staff identity, outcome — and never an address or a token.

This module is not in the API image, as the commands are not.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from functools import wraps
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

from django.conf import settings
from django.db import connection, transaction
from django.utils import timezone

from apps.audit.services import record_realm_event
from apps.identity.command_principal import staff_principal_for_command
from apps.identity.selectors import current_staff_grant
from apps.identity.staff import StaffPrincipal, StaffPrincipalError, is_staff_principal
from apps.jobs.keys import derive_key
from apps.jobs.selectors import (
    JobProgress,
    JobSummary,
    job_by_idempotency_key,
    job_progress,
    jobs_newest_first as _jobs_newest_first,
)
from apps.jobs.services import (
    Claim,
    ClaimRefused,
    DecisionRefused,
    Evidence,
    JobRequest,
    ReconciliationDecision,
    claim_job,
    close_dispatch,
    enqueue_job,
    finish_job,
    hold_for_reconciliation,
    record_dispatch,
    record_reconciliation_decision,
    record_step,
    release_live_locks,
    sweep_expired_leases,
)
from core.db.ids import new_uuid7
from services.identity.access_tokens import IssuerKeySnapshot, TokenVerificationError

from .models import Organisation
from .realm_readiness import record_realm_ready

REALM_JOB = "realm_create"
OPERATOR = "staff_operator"
TOOLING_STEPS = range(1, 7)
VERIFY = 7
# The planned holds' operation references (§5.5, "The planned hold"): the prefix tells a planned
# hold from a lost response.
TOOLING_HOLD = "awaiting tooling step {seq} run {run}"
TOOLING_HOLD_PATTERN = re.compile(r"awaiting tooling step ([1-6]) run \S+\Z")
TRUST_HOLD = "awaiting trust entry"
# The verify's own dispatch, under complete_realm_bootstrap's claim; a fetch that does not complete
# holds the job on it (§5.5 step 3.4).
VERIFY_DISPATCH = "verify {issuer}"
OUTCOMES = ("completed", "no_effect", "partial")
SIGN_IN_RESULTS = ("ok", "failed")
STILL_CLAIMED = frozenset({"leased", "running"})
REPLACEABLE = frozenset({"failed", "cancelled"})
# A tooling run's identifier and every evidence reference: a reference, never a sentence, an address
# or a secret's value (§5.5 step 1.1). Core does not check that it is authentic.
REFERENCE = re.compile(r"[^\s@]{1,512}\Z")
FETCH_TIMEOUT_S = 10
FETCH_MAX_BYTES = 256 * 1024


class Refused(Exception):  # noqa: N818 - a refusal the command reports, not a defect
    """The command refused, or stopped; the message says why and what was written."""

    def __init__(self, message: str, *, outcome: str = "refused") -> None:
        super().__init__(message)
        self.outcome = outcome


@dataclass
class Record:
    """The one-line record of an operator command (§3.7, control 3): never an address or a token."""

    command: str
    organisation: str
    staff_identity: UUID
    job: UUID | None = None
    step: int | None = None
    outcome: str = "refused"

    def line(self) -> str:
        return (
            f"{self.command} organisation={self.organisation} "
            f"job={self.job or '-'} step={self.step or '-'} "
            f"staff_identity={self.staff_identity} outcome={self.outcome}"
        )


@dataclass(frozen=True)
class Outcome:
    """An operator's record of how a held step's operation ended (§5.5 step 1.1)."""

    operation_outcome: str
    compute_terminated: Evidence
    target_read: Evidence


# ------------------------------------------------------------------------------ preamble ----


def reference(value: str, name: str) -> str:
    if not REFERENCE.match(value or ""):
        raise Refused(
            f"{name} must be a reference of 1 to 512 characters with no space and no '@'; "
            "nothing written"
        )
    return value


def observed_at(value: str, name: str) -> datetime:
    try:
        instant = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        instant = None
    if instant is None or instant.tzinfo is None:
        raise Refused(f"{name} must be an ISO 8601 instant with its UTC offset; nothing written")
    return instant


def principal_for(identity_id: UUID) -> StaffPrincipal:
    """§3.8's gate and §3.7's asserted principal. The operation rechecks and holds its grant
    before the sweep or any effect, so this preamble never authorizes later work on its own."""
    if getattr(settings, "KODERA_INTAKE_ADMITTED", False) is not True:
        raise Refused(
            "KODERA_INTAKE_ADMITTED is not 1: this database's cutover is not declared final "
            "(FIRST_OWNER_BOOTSTRAP.md §3.8); nothing written"
        )
    try:
        principal = staff_principal_for_command(identity_id)
    except StaffPrincipalError:
        raise Refused(
            "--staff-identity names no enabled staff identity of the staff issuer; nothing written"
        ) from None
    with transaction.atomic():
        grant = current_staff_grant(identity_id=principal.identity_id, role=OPERATOR)
    if grant is None:
        raise Refused("--staff-identity holds no current staff_operator grant; nothing written")
    return principal


@contextmanager
def operator_authorization(principal: StaffPrincipal) -> Iterator[None]:
    """Hold the current grant, identity and person on an explicit private connection. The queue
    retains its default connection and never inherits a caller transaction from this guard."""
    if not is_staff_principal(principal):
        raise TypeError("operator authorization requires a StaffPrincipal")
    guard = connection.copy(alias="operator_authorization")
    try:
        guard.ensure_connection()
        guard.set_autocommit(False)
        grant = current_staff_grant(
            identity_id=principal.identity_id,
            role=OPERATOR,
            database=guard,
            lock_principal=True,
        )
        if grant is None:
            raise Refused("--staff-identity holds no current staff_operator grant; nothing written")
        yield
        guard.commit()
    except BaseException:
        if guard.connection is not None:
            guard.rollback()
        raise
    finally:
        guard.close()


def _authorized(function: Callable[..., None]) -> Callable[..., None]:
    @wraps(function)
    def call(*, principal: StaffPrincipal, **options: Any) -> None:
        with operator_authorization(principal):
            sweep_expired_leases()
            function(principal=principal, **options)

    return call


def organisation_of(slug: str) -> Organisation:
    found = Organisation.objects.filter(slug=slug, deleted_at__isnull=True).first()
    if found is None:
        raise Refused("no organisation has that slug; nothing written")
    return found


def jobs_newest_first(organisation_id: UUID) -> tuple[JobSummary, ...]:
    return _jobs_newest_first(organisation_id=organisation_id, kind=REALM_JOB)


def latest_progress(organisation: Organisation) -> JobProgress:
    jobs = jobs_newest_first(organisation.id)
    if not jobs:
        raise Refused("the organisation has no realm_create job; nothing written")
    progress = job_progress(jobs[0].id)
    if progress is None:
        raise RuntimeError("a job the organisation's list named has no row")
    return progress


def refuse_unless_open(progress: JobProgress, record: Record) -> None:
    """The statuses no command acts on: a live claim, and a job that has ended."""
    if progress.status in STILL_CLAIMED:
        raise Refused(
            f"the job is claimed until {progress.lease_expires_at:%Y-%m-%dT%H:%M:%SZ}: an earlier "
            "command still runs or died; run this again once that lease has expired; nothing "
            "written"
        )
    if progress.status == "succeeded":
        raise Refused("the realm job has already succeeded; nothing written")
    if progress.status in REPLACEABLE:
        raise Refused(
            f"the realm job is {progress.status}: replace it with requeue_realm_bootstrap; "
            "nothing written"
        )


def runner_id(principal: StaffPrincipal) -> str:
    return f"operator:{principal.identity_id}:{new_uuid7()}"


def claimed(job_id: UUID, principal: StaffPrincipal) -> Claim:
    result = claim_job(runner_id=runner_id(principal), job_id=job_id)
    if isinstance(result, ClaimRefused) or result is None:
        reason = "not_claimable" if result is None else result.reason
        raise Refused(f"the job could not be claimed ({reason}); run this again")
    return result


def kept(written: bool | UUID | None, what: str) -> None:
    """A runner write the queue refused: the claim is no longer this command's."""
    if written is None or written is False:
        raise Refused(
            f"the queue refused {what}: this command's claim was lost; the sweep releases it "
            "once its lease expires; run this again then",
            outcome="claim_lost",
        )


def decide(
    principal: StaffPrincipal,
    job_id: UUID,
    exit_: str,
    outcome: Outcome,
    also: Callable[[], None] | None = None,
) -> None:
    """The queue's decision on the held job, with `also` in the same transaction."""
    with transaction.atomic():
        result = record_reconciliation_decision(
            principal=principal,
            decision=ReconciliationDecision(
                subject_id=job_id,
                exit=exit_,
                operation_outcome=outcome.operation_outcome,
                compute_terminated=outcome.compute_terminated,
                target_read=outcome.target_read,
            ),
        )
        if isinstance(result, DecisionRefused):
            raise Refused(f"the queue refused the decision ({result.reason}); nothing written")
        if also is not None:
            also()


# ------------------------------------------------------------------ start_realm_bootstrap ----


def _held_tooling_step(progress: JobProgress) -> int | None:
    found = TOOLING_HOLD_PATTERN.match(progress.unresolved_operation_ref or "")
    if found is None or progress.unresolved_seq != int(found.group(1)):
        return None
    return int(found.group(1))


def _step7_dispatched(progress: JobProgress) -> bool:
    return any(step.seq == VERIFY and step.dispatched for step in progress.steps)


@_authorized
def start(
    *,
    record: Record,
    principal: StaffPrincipal,
    organisation: Organisation,
    tooling_run: str | None,
    outcome: Outcome | None,
) -> None:
    """§5.5 step 1: the held step's outcome, when the job is held on one; then the claim, the next
    step's dispatch and the hold on it. Every refusal before the decision writes nothing."""
    progress = latest_progress(organisation)
    record.job = progress.id
    decision: tuple[str, Outcome, int] | None = None
    if progress.status == "needs_reconciliation":
        held = _held_tooling_step(progress)
        if held is None:
            record.step = progress.unresolved_seq
            raise Refused(
                f"the job is held on step {progress.unresolved_seq} for "
                f"'{progress.unresolved_operation_ref}', which is not a tooling step: run "
                "complete_realm_bootstrap; nothing written"
            )
        record.step = held
        if outcome is None:
            raise Refused(
                f"the job is held on tooling step {held}: give its --outcome and the run's "
                "--compute-* and --target-* evidence; nothing written"
            )
        if outcome.operation_outcome == "partial":
            decision = ("fail", outcome, held)
            following = None
        else:
            decision = ("resume", outcome, held)
            following = held + 1 if outcome.operation_outcome == "completed" else held
    elif progress.status in {"queued", "orphaned"}:
        step = progress.first_unfinished()
        if step is None:
            raise Refused("every step has succeeded: run complete_realm_bootstrap; nothing written")
        if step.seq == VERIFY and _step7_dispatched(progress):
            record.step = VERIFY
            raise Refused("step 7 is complete_realm_bootstrap's: run it; nothing written")
        following = step.seq
    else:
        refuse_unless_open(progress, record)
        raise RuntimeError(f"no rule for a job {progress.status}")
    if following is not None and following in TOOLING_STEPS and tooling_run is None:
        record.step = following
        raise Refused(
            f"step {following} is a tooling step: give the --tooling-run that will run it; "
            "nothing written"
        )

    if decision is not None:
        exit_, held_outcome, held = decision

        def created() -> None:
            if held == 1 and held_outcome.operation_outcome == "completed":
                record_realm_event(
                    action="realm.created",
                    organisation_id=organisation.id,
                    realm=organisation.realm,
                    job_id=progress.id,
                    actor_id=principal.identity_id,
                    metadata={"step": 1, "evidence_ref": held_outcome.target_read.request_id},
                )

        decide(principal, progress.id, exit_, held_outcome, also=created)
        if exit_ == "fail":
            record.outcome = "failed:reconciliation_failed"
            return

    claim = claimed(progress.id, principal)
    try:
        now = job_progress(progress.id)
        step = None if now is None else now.first_unfinished()
        if step is None:
            raise RuntimeError("a claimed realm job has no step left to dispatch")
        record.step = step.seq
        if step.seq in TOOLING_STEPS:
            if tooling_run is None:
                raise RuntimeError("the next step changed under the claim")
            operation_ref = TOOLING_HOLD.format(seq=step.seq, run=tooling_run)
        else:
            operation_ref = TRUST_HOLD
        kept(record_step(claim=claim, seq=step.seq, status="running"), f"step {step.seq} running")
        dispatch = record_dispatch(claim=claim, seq=step.seq, operation_ref=operation_ref)
        kept(dispatch, f"step {step.seq}'s dispatch")
        assert dispatch is not None  # noqa: S101 - kept() raised otherwise; for the type checker
        kept(hold_for_reconciliation(claim=claim, dispatch_id=dispatch), "the hold")
    finally:
        release_live_locks(claim=claim)
    record.outcome = "held:awaiting_trust_entry" if step.seq == VERIFY else "held:awaiting_tooling"


# --------------------------------------------------------------- complete_realm_bootstrap ----


class RealmUnreachable(Exception):  # noqa: N818 - the read did not complete; not a mismatch
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def fetch_document(url: str, request_id: str) -> dict[str, Any]:
    """GET one public JSON document, with no credential, no redirect and no cache: `https` only,
    or `http` on a loopback issuer of a profile that admits one (config.environment). Anything
    that is not a complete JSON object raises RealmUnreachable."""
    parsed = urlsplit(url)
    scheme = parsed.scheme
    loopback = getattr(settings, "KODERA_LOOPBACK_ISSUERS", False) is True
    if scheme != "https" and not (
        loopback and scheme == "http" and parsed.hostname in {"127.0.0.1", "::1", "localhost"}
    ):
        raise RealmUnreachable(f"{scheme} is not fetched")
    request = urllib.request.Request(  # noqa: S310 - the scheme is checked above
        url,
        headers={
            "Accept": "application/json",
            "Cache-Control": "no-cache",
            "X-Request-Id": request_id,
        },
    )
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=FETCH_TIMEOUT_S) as response:
            if response.status != 200:
                raise RealmUnreachable(f"status {response.status}")
            body = response.read(FETCH_MAX_BYTES + 1)
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise RealmUnreachable(type(error).__name__) from None
    if len(body) > FETCH_MAX_BYTES:
        raise RealmUnreachable("document too large")
    try:
        document = json.loads(body)
    except (ValueError, UnicodeError):
        raise RealmUnreachable("not JSON") from None
    if not isinstance(document, dict):
        raise RealmUnreachable("not a JSON object")
    return document


@dataclass(frozen=True)
class RealmRead:
    """The realm's public discovery document and key set, as read once (§5.5 step 3.1)."""

    issuer: str
    discovery: dict[str, Any]
    jwks: dict[str, Any] | None  # None when the discovery document names no key set of the issuer
    request_id: str
    observed_at: datetime = field(default_factory=timezone.now)

    def evidence(self) -> Evidence:
        """§5.5 step 3.2's `target_read`: the realm's identity service, the issuer, the read's
        correlation and its time."""
        return Evidence(
            provider=urlsplit(self.issuer).netloc,
            resource_id=self.issuer,
            request_id=self.request_id,
            observed_at=self.observed_at,
        )


def read_realm(issuer: str) -> RealmRead:
    request_id = str(new_uuid7())
    discovery = fetch_document(issuer + "/.well-known/openid-configuration", request_id)
    jwks_uri = discovery.get("jwks_uri")
    jwks = None
    if isinstance(jwks_uri, str) and jwks_uri.startswith(issuer + "/"):
        jwks = fetch_document(jwks_uri, request_id)
    return RealmRead(issuer, discovery, jwks, request_id)


def mismatch(read: RealmRead, sign_in_result: str) -> str | None:
    """§5.5 step 3.3: the first definite mismatch, or None. Each is a code, never a document."""
    if read.discovery.get("issuer") != read.issuer:
        return "discovery_issuer_differs"
    if read.jwks is None:
        return "jwks_uri_not_of_the_issuer"
    now = time.time()
    pinned = next(
        (
            entry.snapshot
            for entry in getattr(settings, "KODERA_AUTH_TRUST", ())
            if entry.lane == "customer"
            and entry.snapshot.issuer == read.issuer
            and entry.snapshot.expires_at > now
        ),
        None,
    )
    if pinned is None:
        return "issuer_not_in_trust_configuration"
    try:
        published = IssuerKeySnapshot.from_jwks(
            json.dumps(read.jwks, ensure_ascii=False, allow_nan=False).encode(),
            issuer=read.issuer,
            generation="published",
            expires_at=int(now) + 60,
        )
    except (TokenVerificationError, ValueError, TypeError):
        return "published_keys_unreadable"
    if published.signing_keys() != pinned.signing_keys():
        return "published_keys_differ_from_pinned"
    if sign_in_result != "ok":
        return "test_sign_in_failed"
    return None


def _read_or_stop(issuer: str) -> RealmRead:
    try:
        return read_realm(issuer)
    except RealmUnreachable:
        raise Refused(
            "the realm's discovery document or key set could not be read; nothing written; run "
            "this again once the realm answers"
        ) from None


@_authorized
def complete(
    *,
    record: Record,
    principal: StaffPrincipal,
    organisation: Organisation,
    sign_in_result: str,
    sign_in_evidence: str,
    compute_terminated: Evidence | None,
) -> None:
    """§5.5 step 3: the decision on the held step 7, the verify under a new claim, and the job's
    end, with the realm-ready fact when it succeeds."""
    progress = latest_progress(organisation)
    record.job = progress.id
    record.step = VERIFY
    held = progress.status == "needs_reconciliation"
    if held:
        if progress.unresolved_seq != VERIFY:
            record.step = progress.unresolved_seq
            raise Refused(
                f"the job is held on tooling step {progress.unresolved_seq}: run "
                "start_realm_bootstrap; nothing written"
            )
        if compute_terminated is None:
            raise Refused(
                "the job is held on step 7: give the --compute-* evidence that the work the hold "
                "awaited has ended; nothing written"
            )
    elif progress.status in {"queued", "orphaned"}:
        if any(step.seq < VERIFY and step.status != "succeeded" for step in progress.steps):
            raise Refused(
                "steps 1 to 6 have not all succeeded: run start_realm_bootstrap; nothing written"
            )
        if not _step7_dispatched(progress):
            raise Refused(
                "step 7 was never held for the trust entry: run start_realm_bootstrap; nothing "
                "written"
            )
    else:
        refuse_unless_open(progress, record)
        raise RuntimeError(f"no rule for a job {progress.status}")

    first = _read_or_stop(organisation.issuer)
    if held:
        assert compute_terminated is not None  # noqa: S101 - refused above otherwise
        decide(
            principal,
            progress.id,
            "resume",
            Outcome("no_effect", compute_terminated, first.evidence()),
        )

    claim = claimed(progress.id, principal)
    try:
        now = job_progress(progress.id)
        verify = None if now is None else next(s for s in now.steps if s.seq == VERIFY)
        if verify is not None and verify.status != "succeeded":
            _verify(claim, principal, organisation, sign_in_result, sign_in_evidence)
        record_realm_ready(
            organisation_id=organisation.id, job_id=progress.id, recorded_by=principal.identity_id
        )
        kept(finish_job(claim=claim, status="succeeded"), "the job's end")
    finally:
        release_live_locks(claim=claim)
    record.outcome = "succeeded"


def _verify(
    claim: Claim,
    principal: StaffPrincipal,
    organisation: Organisation,
    sign_in_result: str,
    sign_in_evidence: str,
) -> None:
    """Step 7 under the claim, ended succeeded; or the job failed on a definite mismatch, or held
    on the verify's dispatch when the read does not complete, each raising Refused."""
    issuer = organisation.issuer
    kept(record_step(claim=claim, seq=VERIFY, status="running"), "step 7 running")
    dispatch = record_dispatch(
        claim=claim, seq=VERIFY, operation_ref=VERIFY_DISPATCH.format(issuer=issuer)
    )
    kept(dispatch, "step 7's dispatch")
    assert dispatch is not None  # noqa: S101 - kept() raised otherwise
    try:
        read = read_realm(issuer)
    except RealmUnreachable:
        kept(hold_for_reconciliation(claim=claim, dispatch_id=dispatch), "the hold")
        raise Refused(
            "the realm did not answer the verify: the job is held on step 7; run "
            "complete_realm_bootstrap again once it answers",
            outcome="held:verify_unanswered",
        ) from None
    found = mismatch(read, sign_in_result)
    evidence = (
        f"verify {read.request_id} at {read.observed_at.isoformat()}; sign-in {sign_in_evidence}"
    )
    if found is None:
        kept(
            close_dispatch(
                claim=claim, dispatch_id=dispatch, outcome="completed", evidence_ref=evidence
            ),
            "the verify's close",
        )
        kept(
            record_step(claim=claim, seq=VERIFY, status="succeeded", output_ref=evidence),
            "step 7 succeeded",
        )
        return
    kept(
        close_dispatch(claim=claim, dispatch_id=dispatch, outcome="failed", evidence_ref=evidence),
        "the verify's close",
    )
    with transaction.atomic():
        record_realm_event(
            action="realm.verification_failed",
            organisation_id=organisation.id,
            realm=organisation.realm,
            job_id=claim.job_id,
            actor_id=principal.identity_id,
            metadata={"reason": found, "evidence_ref": evidence},
        )
    kept(
        record_step(
            claim=claim,
            seq=VERIFY,
            status="failed",
            output_ref=f"mismatch {found}; {evidence}",
        ),
        "step 7 failed",
    )
    kept(finish_job(claim=claim, status="failed", error_code="step_failed"), "the job's end")
    raise Refused(
        f"the verify found a mismatch ({found}): the realm job failed; replace it with "
        "requeue_realm_bootstrap",
        outcome=f"failed:{found}",
    )


# ---------------------------------------------------------------- requeue_realm_bootstrap ----


@_authorized
def requeue(*, record: Record, principal: StaffPrincipal, organisation: Organisation) -> None:
    """§5.7: one new `realm_create` job replacing the latest, failed or cancelled, under the key
    `["requeue", replaced_job_id]`; a repeat finds that job and enqueues nothing."""
    with transaction.atomic():
        if current_staff_grant(identity_id=principal.identity_id, role=OPERATOR) is None:
            raise Refused("--staff-identity holds no current staff_operator grant; nothing written")
        jobs = jobs_newest_first(organisation.id)
        if not jobs:
            raise Refused("the organisation has no realm_create job; nothing written")
        latest = jobs[0]
        if organisation.state != Organisation.State.PROSPECT:
            raise Refused(
                f"the organisation is {organisation.state}, not prospect; nothing written"
            )
        # An active replacement is the idempotent answer to the earlier requeue. A failed or
        # cancelled replacement needs its own successor, keyed by that replacement's id.
        if latest.status not in REPLACEABLE and len(jobs) > 1:
            replay = job_by_idempotency_key(derive_key(["requeue", jobs[1].id]))
            if replay is not None and replay.id == latest.id:
                record.job = latest.id
                record.outcome = "already_requeued"
                return
        if latest.status not in REPLACEABLE:
            record.job = latest.id
            raise Refused(
                f"the latest realm_create job is {latest.status}: only a failed or cancelled one "
                "is replaced; nothing written"
            )
        enqueued = enqueue_job(
            request=JobRequest(
                organisation_id=organisation.id,
                tenant_id=None,
                kind=REALM_JOB,
                idempotency_key=derive_key(["requeue", latest.id]),
                desired_spec_hash=latest.desired_spec_hash,
                actor_type="staff",
                actor_id=principal.identity_id,
            ),
            apply_desired_state=lambda: None,
        )
    record.job = enqueued.job_id
    record.outcome = "requeued" if enqueued.created else "already_requeued"


# ------------------------------------------------------------------------ the commands ----


def add_common_arguments(parser: Any) -> None:
    parser.add_argument(
        "--staff-identity",
        required=True,
        type=UUID,
        help="The acting staff identity's id: a current staff_operator (§3.7)",
    )
    parser.add_argument("--organisation", required=True, help="The organisation's slug")


EVIDENCE = ("provider", "resource_id", "request_id", "observed_at")


def add_evidence_arguments(parser: Any, prefix: str, what: str) -> None:
    for part in EVIDENCE:
        parser.add_argument(f"--{prefix}-{part.replace('_', '-')}", help=f"{what}: {part}")


def evidence_from(options: dict[str, Any], prefix: str) -> Evidence | None:
    """The evidence of `--<prefix>-*`, all four parts or none; refused when only some are given."""
    values = {part: options.get(f"{prefix}_{part}") for part in EVIDENCE}
    if all(value is None for value in values.values()):
        return None
    missing = [part for part, value in values.items() if value is None]
    if missing:
        raise Refused(
            f"--{prefix}-* needs all four of provider, resource-id, request-id and observed-at; "
            "nothing written"
        )
    given: dict[str, str] = {part: str(value) for part, value in values.items()}
    return Evidence(
        provider=reference(given["provider"], f"--{prefix}-provider"),
        resource_id=reference(given["resource_id"], f"--{prefix}-resource-id"),
        request_id=reference(given["request_id"], f"--{prefix}-request-id"),
        observed_at=observed_at(given["observed_at"], f"--{prefix}-observed-at"),
    )


def operate(write: Callable[[str], None], record: Record, body: Callable[[], None]) -> None:
    """Run `body`, then print the record, whatever the outcome; a refusal is re-raised as the
    command's error after its record is printed."""
    try:
        body()
    except Refused as refused:
        record.outcome = refused.outcome
        write(record.line())
        raise
    write(record.line())
