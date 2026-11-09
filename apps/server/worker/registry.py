"""Which job kinds this worker serves, and how each step of them reaches its provider.

A runner claims only the kinds its registry serves (worker/runner.py), so a kind no registry names
stays queued for whoever does serve it. Each step of a served kind has a `StepPlan`: the operation
reference its dispatch carries, the payload whose hash the convergence registry pins
(worker/convergence.py), whether a registered safe-convergence contract lets the current runner
replay it under its still-open dispatch (JOB_CATALOGUE.md §1, recovery path 2), and the realm whose
credential the step is handed for the length of one provider call, if any.

`PRODUCTION` is empty in G1.5-B: no kind's steps are bound to a provider yet, so the deployed worker
claims nothing. The realm kinds are refused outright until G1.5-C binds them (lane decision W4: the
worker does not claim the `realm_create` jobs operator bootstrap enqueues).
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from apps.jobs.kinds import KINDS, REALM_KINDS

from . import mutants


class RegistryError(ValueError):
    """A registry that would serve a kind wrongly, or not at all."""


@dataclass(frozen=True)
class JobContext:
    """What a step's plan reads of its job: never its desired state, which C binds."""

    id: UUID
    kind: str
    organisation_id: UUID
    tenant_id: UUID | None


@dataclass(frozen=True)
class StepPlan:
    kind: str
    seq: int
    name: str
    # A registered safe-convergence contract: the current runner may replay the same request under
    # the same open dispatch when the response is lost (JOB_CATALOGUE.md §1, recovery path 2).
    convergent: bool
    credential_realm: str | None = None

    def operation_ref(self, job_id: UUID) -> str:
        return f"urn:kodera:worker:{job_id}:{self.seq}:{self.name}"

    def payload(self, job: JobContext) -> Mapping[str, Any]:
        return {
            "kind": job.kind,
            "step": self.name,
            "seq": self.seq,
            "organisation_id": str(job.organisation_id),
            "tenant_id": None if job.tenant_id is None else str(job.tenant_id),
        }


class Registry:
    """The step plans of every kind served, each kind complete and in the catalogue's order."""

    def __init__(self, plans: Iterable[StepPlan]) -> None:
        by_kind: dict[str, dict[int, StepPlan]] = {}
        for plan in plans:
            if plan.kind not in KINDS:
                raise RegistryError(f"{plan.kind!r} is not a job kind")
            if plan.kind in REALM_KINDS and not mutants.on("registry_admits_realm_kinds"):
                raise RegistryError(
                    f"{plan.kind} is not served before G1.5-C binds its steps (lane decision W4)"
                )
            steps = by_kind.setdefault(plan.kind, {})
            if plan.seq in steps:
                raise RegistryError(f"{plan.kind} step {plan.seq} has two plans")
            steps[plan.seq] = plan
        for kind, steps in by_kind.items():
            names = [spec.name for spec in KINDS[kind].steps]
            planned = [
                steps[seq].name if seq in steps else None for seq in range(1, len(names) + 1)
            ]
            if planned != names or len(steps) != len(names):
                raise RegistryError(f"{kind}'s plans are not its catalogue steps, in order")
        self._plans = by_kind

    @property
    def kinds(self) -> frozenset[str]:
        return frozenset(self._plans)

    def plan(self, kind: str, seq: int) -> StepPlan:
        return self._plans[kind][seq]

    def plans(self) -> Iterator[StepPlan]:
        for kind in sorted(self._plans):
            yield from (self._plans[kind][seq] for seq in sorted(self._plans[kind]))


# The runner's known gaps, each a defect a production kind would meet; G1.5-C closes them. While one
# is open the deployed worker serves no kind: tests/worker/test_worker_execution.py refuses a
# non-empty PRODUCTION until this tuple is empty, and deleting an id is the act that says it closed.
G15C_GAPS: tuple[str, ...] = (
    # A class-C step whose dispatch closed `failed` before record_step(failed) is not resumed.
    "worker:resume-failed-dispatch",
    # The kill reaches the step's process group only: a setsid() descendant escapes it. With it,
    # PR_SET_DUMPABLE 0 in boot.enter().
    "worker:kill-all-descendants",
    # A kind-filtered claim can starve behind an unserved earlier kind of the same organisation.
    "worker:kind-claim-starvation",
    # A dispatch closed `completed` whose record_step is then refused: the queue spec's gap.
    "worker:completed-dispatch-step-refused",
    # A provider call duplicated when a worker dies after its send (the handoff's lock ends at the
    # send, the call runs on) is closed only by provider-side idempotency keyed by (job, step),
    # never by the fence, which a reclaim moves.
    "worker:provider-idempotency",
)

# G1.5-B binds no kind: the deployed worker serves nothing until G1.5-C binds the first slice's.
PRODUCTION = Registry(())
