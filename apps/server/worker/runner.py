"""The job runner (G1.5-B): claim, renew, run each step in its own process group, reap.

`Runner.run_once()` sweeps expired leases, claims the first claimable job of a kind its registry
serves (worker/registry.py; never a realm kind before G1.5-C, lane decision W4), starts a lease
keeper (worker/lease.py) and runs the job's steps from the first that is not `succeeded` or
`skipped`, finishing a recovered `failed` step before any more work. Each runnable step is
`record_step(running)`, `record_dispatch` before the call, the call in a
child process (worker/child.py) with the step's credential loaded for that call alone, and then
what `settle()` makes of the answer (worker/convergence.py): authenticated terminal proof closes the
dispatch and moves the step; anything else holds the job for reconciliation. A lost response may be
replayed once, under the same open dispatch with the same `operation_ref` and payload, when the
step registers a safe-convergence contract; a replay is never a new dispatch.

When the lease is lost (worker/lease.py: refused, failed twice, its keeper dead, or past its own
end by the runner's clock), the runner kills the step's process group, reaps the step, writes
nothing more and releases its live locks: an expired lease with an open dispatch is the sweep's to
hold for reconciliation, with the reservation kept (JOB_QUEUE.md §5.2). A refused write ends the
job's run the same way. After `hold_for_reconciliation` the runner releases its live locks; `finish_job` releases
them itself.

**No provider call starts unless the database says this claim owns a runnable job** (`_owned`): the
job is `running`, at the claim's fence, under a lease clock_timestamp() has not ended. The worker's
own lease clock is not enough: a sweep on another connection can hold a running job for
reconciliation, its dispatch left open, before the keeper notices. The rule is asked before each
call, first or replayed, and again immediately before the spawn, after the step's credential was
loaded, under the job's row lock through the spawn and the request's send (worker/handoff.py,
worker/child.py); a refusal starts nothing and ends the run `refused`, never replayed and
never settled, the job left as the sweep left it. The replay's own read of the open dispatch
requires the same rule (apps/jobs/runner_selectors.py `open_dispatch`).

A step whose call cannot be prepared (worker/child.py, `not_started`) or whose stdout overflowed
(`overflow`) is not replayed: it is held. A lease lost while the step's credential was loading
starts no child (worker/child.py reads the lease again before the spawn and before the send).
A runner whose registry hands a step a credential realm needs a credential source, and is refused
at construction without one.

**Database timeouts (decided in G1.5-B).** The worker keeps the API's budget, a 2 s
`connect_timeout` and a 2 s `statement_timeout`, for every statement, claim, renewal and sweep
included. Each queue statement locks or reads a handful of rows without waiting (`SKIP LOCKED`), so 2
s is generous; and a longer budget would only let a renewal hang closer to the end of its lease.
Neither bounds a call blocked on a half-open TCP connection, where the server never answers, so the
worker's profile adds libpq keepalives and `tcp_user_timeout` (config/deploy_environment.py), and
the lease keeps its own clock besides (worker/lease.py). `database_budget_refusals()` holds the
arithmetic: two failed renewals, each waiting its interval plus a full connect budget and the
longest of the statement budget, the keepalive's detection and `tcp_user_timeout`, are detected
inside the part of the 120 s lease the runner keeps (the lease less its margin).
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Mapping
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, Protocol
from uuid import UUID

from apps.jobs.kinds import KINDS, StepSpec
from apps.jobs.types import Claim
from core import faults

from . import mutants
from .child import NOT_OWNED, NOT_STARTED, OVERFLOW, ChildResult, run_child
from .convergence import Convergence, Dispatched, payload_hash, settle
from .jobdir import JobDirectory, JobRoot
from .lease import FAILED_RENEWALS_LOST, LEASE_MARGIN_S, LEASE_S, RENEW_EVERY_S, Lease
from .proof import Provider, TerminalProof
from .registry import JobContext, Registry, StepPlan

if TYPE_CHECKING:
    from apps.jobs.runner_selectors import JobOwnership

# A step whose response was lost is replayed at most this many times under its dispatch.
REPLAYS = 1
JOB_ROOT = Path(tempfile.gettempdir()) / "kodera-worker-jobs"
NO_KIND_SERVED = "this worker serves no job kind: no step is bound to a provider before G1.5-C, so it claims no job"

Ending = Literal["succeeded", "failed", "held", "lost", "refused"]


class Credential(Protocol):
    @property
    def secret(self) -> str: ...


class CredentialSource(Protocol):
    def load(self, realm: str) -> AbstractContextManager[Credential]: ...


@dataclass(frozen=True)
class JobResult:
    job_id: UUID
    ending: Ending


def _emit_stderr(event: str, fields: Mapping[str, Any]) -> None:
    print(json.dumps({"event": event, **fields}, default=str), file=sys.stderr, flush=True)


class Runner:
    def __init__(
        self,
        *,
        runner_id: str,
        registry: Registry,
        provider: Provider | None,
        credentials: CredentialSource | None = None,
        job_root: Path = JOB_ROOT,
        renew_every_s: float = RENEW_EVERY_S,
        emit: Callable[[str, Mapping[str, Any]], None] = _emit_stderr,
    ) -> None:
        if registry.kinds and provider is None:
            raise ValueError("a runner that serves a kind needs the provider its steps call")
        if credentials is None and not mutants.on("runner_starts_without_its_credentials"):
            for plan in registry.plans():
                if plan.credential_realm is not None:
                    raise ValueError(
                        f"{plan.kind} step {plan.seq} is handed a {plan.credential_realm} "
                        "credential, and the runner has no credential source"
                    )
        self.runner_id = runner_id
        self.registry = registry
        self.provider = provider
        self.credentials = credentials
        self.job_root = job_root
        self.renew_every_s = renew_every_s
        self.emit = emit
        self.convergence = Convergence()
        self._jobs: JobRoot | None = None
        self._swept: list[str] = []

    # --------------------------------------------------------------------------- the loop ----

    def start(self) -> list[str]:
        """Open this runner's job directory (worker/jobdir.py), refusing to start on a job root that
        is not its own, and sweep what a killed run left; once. The paths swept."""
        if self._jobs is None:
            self._jobs = JobRoot(self.job_root, self.runner_id)
            self._swept = self._jobs.sweep()
        return self._swept

    def serve(self, stop: threading.Event, *, poll_s: float = 1.0) -> None:
        """Claim and run jobs until `stop` is set; it is read between jobs, never during one.

        Crash-only. Nothing here survives an exception or a kill, and nothing has to: a lease the
        runner stops renewing ends in the database, the sweep holds what it left open for
        reconciliation, and a restarted runner sweeps its job directories (`start()`). What
        restarts the runner is the container's restart policy (compose.yaml's `restart:`, Fleet's
        in production), never this loop.

        A SIGTERM sets `stop`, and the job in hand runs on until its step ends, which can take the
        step's whole catalogue timeout: far longer than a container's stop grace period (10 s by
        default), after which the runtime's SIGKILL ends the worker mid-step, the crash this design
        already absorbs. Whether a stop should instead drain (finish the step, or give the lease
        back first) is a policy G1.5-C decides before it binds a kind.
        """
        self.emit("started", {"runner_id": self.runner_id, "swept": self.start()})
        try:
            while not stop.is_set():
                if self.run_once() is None:
                    stop.wait(poll_s)
        finally:
            if self._jobs is not None:
                self._jobs.close()
                self._jobs = None
        self.emit("stopped", {"runner_id": self.runner_id})

    def run_until_idle(self) -> list[JobResult]:
        results = []
        while (result := self.run_once()) is not None:
            results.append(result)
        return results

    def run_once(self) -> JobResult | None:
        from apps.jobs._sweep import sweep_expired_leases

        self.start()
        sweep_expired_leases()
        claimed = self._claim()
        if claimed is None:
            return None
        claim, asked = claimed
        self.emit("claimed", {"job_id": claim.job_id, "fence": claim.fence})
        ending = self._run(claim, asked)
        self.emit("ended", {"job_id": claim.job_id, "ending": ending})
        return JobResult(claim.job_id, ending)

    def _claim(self) -> tuple[Claim, float] | None:
        """The claim, and the monotonic time it was asked: its lease runs from no later."""
        from apps.jobs._claim import claim_job
        from apps.jobs.runner_selectors import claimable_job_ids

        for job_id in claimable_job_ids(kinds=self.registry.kinds):
            asked = time.monotonic()
            result = claim_job(runner_id=self.runner_id, job_id=job_id)
            if isinstance(result, Claim):
                return result, asked
        return None

    # ------------------------------------------------------------------------- one job ----

    def _run(self, claim: Claim, asked: float) -> Ending:
        from apps.jobs._claim import release_live_locks
        from apps.jobs._runner import renew_lease
        from apps.jobs.runner_selectors import runner_job

        found = runner_job(claim.job_id)
        if found is None:
            raise RuntimeError(f"claimed job {claim.job_id} has no row")
        job = JobContext(found.id, found.kind, found.organisation_id, found.tenant_id)
        lease = Lease(
            claim,
            renew=lambda held: renew_lease(claim=held),
            every_s=self.renew_every_s,
            since=asked,
        ).start()
        assert self._jobs is not None  # noqa: S101 - run_once() started the runner
        ending: Ending = "refused"
        try:
            with self._jobs.job(claim.job_id) as directory:
                ending = self._steps(claim, job, directory, lease)
        finally:
            lease.stop()
            if ending in ("held", "lost", "refused"):
                release_live_locks(claim=claim)
        return ending

    def _steps(
        self, claim: Claim, job: JobContext, directory: JobDirectory, lease: Lease
    ) -> Ending:
        from apps.jobs._runner import _acknowledge_completed_dispatch, finish_job, record_step
        from apps.jobs.runner_selectors import completion_read, step_statuses

        statuses = step_statuses(claim.job_id)
        faults.reach("worker:after-completion-claim-projection")
        for seq, spec in enumerate(KINDS[job.kind].steps, start=1):
            if statuses.get(seq) in ("succeeded", "skipped"):
                continue
            if lease.is_lost():
                return "lost"
            if statuses.get(seq) == "failed":
                # Claim recovered a closed failed dispatch, or a prior run died after that
                # projection. Finish under this claim without running or dispatching the step.
                faults.reach("worker:after-recovered-failed-step")
                ended = finish_job(claim=claim, status="failed", error_code="step_failed")
                return "failed" if ended else "refused"
            retained = completion_read(claim.job_id, seq)
            if retained.kind == "ineligible":
                self.emit(
                    "completion_refused",
                    {"job_id": claim.job_id, "seq": seq, "reason": retained.reason},
                )
                return "refused"
            if retained.kind == "completed":
                row = retained.row
                assert row is not None and row.dispatch_id is not None  # noqa: S101
                assert row.operation_ref is not None and row.evidence_ref is not None  # noqa: S101
                if not _acknowledge_completed_dispatch(
                    claim=claim,
                    seq=seq,
                    dispatch_id=row.dispatch_id,
                    operation_ref=row.operation_ref,
                    evidence_ref=row.evidence_ref,
                ):
                    return "refused"
                continue
            plan = self.registry.plan(job.kind, seq)
            if not record_step(claim=claim, seq=seq, status="running"):
                return "refused"
            ending = self._step(claim, job, plan, spec, directory, lease)
            if ending != "succeeded":
                return ending
        if lease.is_lost():
            return "lost"
        return "succeeded" if finish_job(claim=claim, status="succeeded") else "refused"

    def _step(  # noqa: PLR0911 - one return per way a step ends
        self,
        claim: Claim,
        job: JobContext,
        plan: StepPlan,
        spec: StepSpec,
        directory: JobDirectory,
        lease: Lease,
    ) -> Ending:
        from apps.jobs._runner import (
            _acknowledge_completed_dispatch,
            close_dispatch,
            finish_job,
            hold_for_reconciliation,
            record_dispatch,
            record_step,
        )
        from apps.jobs.runner_selectors import open_dispatch

        assert self.provider is not None  # noqa: S101 - checked at construction
        operation_ref = plan.operation_ref(job.id)
        digest = payload_hash(plan.payload(job))
        dispatch_id = record_dispatch(claim=claim, seq=plan.seq, operation_ref=operation_ref)
        if dispatch_id is None:
            return "refused"
        self.convergence.record(Dispatched(dispatch_id, operation_ref, digest))
        try:
            attempt = 1
            result = self._call(
                claim, plan, spec, dispatch_id, operation_ref, digest, attempt, directory, lease
            )
            if result.killed == NOT_OWNED:
                return "refused"
            while (
                _no_proof(result)
                and _replayable(result)
                and not lease.is_lost()
                and attempt <= REPLAYS
            ):
                again = Dispatched(
                    dispatch_id, plan.operation_ref(job.id), payload_hash(plan.payload(job))
                )
                refusals = self.convergence.replay_refusals(
                    plan, again, open_dispatch(claim.job_id, claim.fence)
                )
                if refusals:
                    self.emit("replay_refused", {"dispatch_id": dispatch_id, "reasons": refusals})
                    break
                attempt += 1
                self.emit("replay", {"dispatch_id": dispatch_id, "attempt": attempt})
                result = self._call(
                    claim,
                    plan,
                    spec,
                    dispatch_id,
                    again.operation_ref,
                    again.payload_hash,
                    attempt,
                    directory,
                    lease,
                )
                if result.killed == NOT_OWNED:
                    return "refused"
            if lease.is_lost():
                return "lost"
            settlement = settle(
                _proof(result),
                dispatch_id=dispatch_id,
                operation_ref=operation_ref,
                verify=self.provider.verify,
            )
            self.emit(
                "settled",
                {
                    "dispatch_id": dispatch_id,
                    "action": settlement.action,
                    "reason": settlement.reason,
                },
            )
            if settlement.action == "hold":
                held = hold_for_reconciliation(claim=claim, dispatch_id=dispatch_id)
                return "held" if held else "refused"
            assert settlement.outcome is not None and settlement.evidence_ref is not None  # noqa: S101
            if settlement.outcome == "completed":
                moved = _acknowledge_completed_dispatch(
                    claim=claim,
                    seq=plan.seq,
                    dispatch_id=dispatch_id,
                    operation_ref=operation_ref,
                    evidence_ref=settlement.evidence_ref,
                )
                return "succeeded" if moved else "refused"
            if not close_dispatch(
                claim=claim,
                dispatch_id=dispatch_id,
                outcome=settlement.outcome,
                evidence_ref=settlement.evidence_ref,
            ):
                return "refused"
            faults.reach("worker:after-failed-dispatch-close-before-step-record")
            if not record_step(
                claim=claim, seq=plan.seq, status="failed", output_ref=settlement.evidence_ref
            ):
                return "refused"
            ended = finish_job(claim=claim, status="failed", error_code="step_failed")
            return "failed" if ended else "refused"
        finally:
            self.convergence.forget(dispatch_id)

    def _owned(self, claim: Claim) -> bool:
        """The one authorisation a provider call needs, read from the database by its own clock:
        `ownership_refusals()` of what apps/jobs/runner_selectors.py `job_ownership` reads."""
        from apps.jobs.runner_selectors import job_ownership

        if mutants.on("provider_call_without_db_ownership"):
            return True
        refusals = ownership_refusals(job_ownership(claim.job_id, claim.fence))
        if refusals:
            self.emit("not_owned", {"job_id": claim.job_id, "reasons": refusals})
        return not refusals

    def _hand_off(self, claim: Claim, write: Callable[[], bool]) -> bool:
        from .handoff import WRITTEN, hand_off

        ending = hand_off(claim.job_id, claim.fence, write)
        if ending != WRITTEN:
            # After the commit: nothing is emitted under the handoff's lock.
            self.emit("not_owned", {"job_id": claim.job_id, "reasons": [ending]})
        return ending == WRITTEN

    def _call(  # noqa: PLR0913 - the claim, the step and where its call runs
        self,
        claim: Claim,
        plan: StepPlan,
        spec: StepSpec,
        dispatch_id: UUID,
        operation_ref: str,
        digest: str,
        attempt: int,
        directory: JobDirectory,
        lease: Lease,
    ) -> ChildResult:
        assert self.provider is not None  # noqa: S101 - checked at construction
        if not self._owned(claim):
            return ChildResult(0, None, None, NOT_OWNED)
        request = self.provider.request(
            dispatch_id=str(dispatch_id),
            operation_ref=operation_ref,
            payload_hash=digest,
            step=plan.name,
            attempt=attempt,
        )
        loaded: AbstractContextManager[Credential | None] = nullcontext(None)
        if plan.credential_realm is not None:
            assert self.credentials is not None  # noqa: S101 - checked at construction
            loaded = self.credentials.load(plan.credential_realm)
        with loaded as credential:
            result = run_child(
                request,
                directory=directory.path,
                directory_fd=directory.fd,
                secret=None if credential is None else credential.secret,
                lost=lease.is_lost,
                timeout_s=float(spec.timeout_s),
                started=lambda pid: self.emit(
                    "child", {"dispatch_id": dispatch_id, "attempt": attempt, "pid": pid}
                ),
                # After the credential loaded, which can block: the request is written under the
                # job's row lock, the ownership rule re-read under it (worker/handoff.py).
                hand_off=lambda write: self._hand_off(claim, write),
            )
        self.emit(
            "reaped",
            {
                "dispatch_id": dispatch_id,
                "pid": result.pid,
                "returncode": result.returncode,
                "killed": result.killed,
            },
        )
        return result


def _replayable(result: ChildResult) -> bool:
    """A call that never started, or whose answer overflowed, is held, never replayed: the first
    sent nothing to replay, and the second's step says more than any answer may. A call refused
    for want of ownership is neither replayed nor settled (`_step` ends the run at once)."""
    return result.killed not in (NOT_STARTED, OVERFLOW, NOT_OWNED)


def ownership_refusals(found: JobOwnership | None) -> list[str]:
    """Why this claim may not start a provider call, from each clause the database read, or []."""
    if found is None:
        return ["the job is gone"]
    refusals = []
    if not found.running and not mutants.on("ownership_ignores_status"):
        refusals.append("the job is not running")
    if not found.current_fence and not mutants.on("ownership_ignores_fence"):
        refusals.append("the job's fence has moved past this claim")
    if not found.lease_live and not mutants.on("ownership_ignores_lease"):
        refusals.append("the job's lease has ended by the database's clock")
    return refusals


def _no_proof(result: ChildResult) -> bool:
    return result.killed is not None or _proof(result) is None


def _proof(result: ChildResult) -> TerminalProof | None:
    if result.answer is None or not isinstance(result.answer.get("answer"), dict):
        return None
    try:
        return TerminalProof.from_wire(result.answer["answer"])
    except (KeyError, ValueError, TypeError):
        return None


# ------------------------------------------------------------------ the database budget ----

STATEMENT_TIMEOUT = re.compile(r"(?:^|\s)-c\s*statement_timeout=(\d+)(?:ms)?(?:\s|$)")


def _positive(options: Mapping[str, Any], name: str) -> int | None:
    value = options.get(name)
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def database_budget_refusals(
    options: Mapping[str, Any],
    *,
    renew_every_s: float = RENEW_EVERY_S,
    lease_s: float = LEASE_S,
    margin_s: float = LEASE_MARGIN_S,
) -> list[str]:
    """Why these database OPTIONS let a lost lease go unnoticed past the part of it the runner
    keeps, or []. A call blocked on a half-open connection is bounded by the client alone: by its
    TCP keepalives (idle, then `count` probes `interval` apart) and by `tcp_user_timeout`."""
    refusals = []
    connect = _positive(options, "connect_timeout")
    found = STATEMENT_TIMEOUT.search(str(options.get("options", "")))
    idle, interval, count = (
        _positive(options, name)
        for name in ("keepalives_idle", "keepalives_interval", "keepalives_count")
    )
    user_timeout = _positive(options, "tcp_user_timeout")
    if connect is None:
        refusals.append("the worker's database has no connect_timeout")
    if found is None or int(found.group(1)) <= 0:
        refusals.append("the worker's database has no statement_timeout")
    if options.get("keepalives") != 1 or idle is None or interval is None or count is None:
        refusals.append("the worker's database has no TCP keepalives")
    if user_timeout is None:
        refusals.append("the worker's database has no tcp_user_timeout")
    if refusals:
        return refusals
    assert found is not None and connect is not None and user_timeout is not None  # noqa: S101
    assert idle is not None and interval is not None and count is not None  # noqa: S101
    blocked = max(int(found.group(1)) / 1000, user_timeout / 1000, idle + interval * count)
    per_renewal = renew_every_s + connect + blocked
    kept = lease_s - margin_s
    if FAILED_RENEWALS_LOST * per_renewal >= kept:
        refusals.append(
            f"two failed renewals take {FAILED_RENEWALS_LOST * per_renewal:g} s to notice, "
            f"not less than the {kept:g} s of the lease the runner keeps"
        )
    return refusals
