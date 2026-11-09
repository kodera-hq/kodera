"""The job queue reads only the worker's runner makes (G1.5-B): which due jobs it may claim, and
what it reads of a job it holds. A module of its own because the API image carries
apps/jobs/selectors.py and not apps/jobs/sql.py (.dockerignore); the worker image carries both.
Nothing here locks or writes.
"""

from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID

from django.db import connection

from . import sql
from .models import Job, JobStep

# The three clauses of the runner's ownership rule, one text each (apps/jobs/sql.py).
OWNED = {
    "status": sql.RUNNER_OWNED_STATUS,
    "fence": sql.RUNNER_OWNED_FENCE,
    "lease": sql.RUNNER_OWNED_LEASE,
}


def claimable_job_ids(*, kinds: Collection[str]) -> list[UUID]:
    """The queued or orphaned due jobs of `kinds`, in the claim scan's order (JOB_QUEUE.md §4.2):
    what a runner that serves only these kinds offers `claim_job` one by one. Locks nothing."""
    if not kinds:
        return []
    statement = sql.SCAN.format(only="AND kind = ANY(%s)", sub_jobs=sql.SCAN_SUB_JOBS_FIRST)
    with connection.cursor() as cursor:
        cursor.execute(statement, [sorted(kinds)])
        return [job_id for (job_id,) in cursor.fetchall()]


@dataclass(frozen=True, slots=True)
class RunnerJob:
    id: UUID
    kind: str
    organisation_id: UUID
    tenant_id: UUID | None


def runner_job(job_id: UUID) -> RunnerJob | None:
    """What a runner reads of the job it claimed."""
    row = Job.objects.filter(pk=job_id).values_list("id", "kind", "organisation_id", "tenant_id")
    found = row.first()
    return None if found is None else RunnerJob(*found)


def step_statuses(job_id: UUID) -> dict[int, str]:
    """Each step's status by seq."""
    return dict(JobStep.objects.filter(job_id=job_id).values_list("seq", "status"))


@dataclass(frozen=True, slots=True)
class CompletionRow:
    step_id: UUID
    status: str
    output_ref: str | None
    error_code: str | None
    dispatch_id: UUID | None
    job_id: UUID | None
    dispatch_step_id: UUID | None
    fence: int | None
    operation_ref: str | None
    sub_job_id: UUID | None
    closed_at: datetime | None
    outcome: str | None
    evidence_ref: str | None


@dataclass(frozen=True, slots=True)
class CompletionRead:
    kind: Literal["absent", "not_completed", "completed", "ineligible"]
    row: CompletionRow | None
    reason: str | None = None


def classify_completion(job_id: UUID, row: CompletionRow | None) -> CompletionRead:
    """An exhaustive advisory classification, never permission to write or replay."""
    if row is None:
        return CompletionRead("ineligible", None, "missing step")
    if row.dispatch_id is None:
        return CompletionRead("absent", row)
    if row.job_id != job_id or row.dispatch_step_id != row.step_id:
        return CompletionRead("ineligible", row, "dispatch relationship")
    if row.sub_job_id is not None:
        return CompletionRead("ineligible", row, "sub-job dispatch")
    if row.closed_at is None:
        if row.outcome is not None or row.evidence_ref is not None:
            return CompletionRead("ineligible", row, "open terminal evidence")
        return CompletionRead("not_completed", row)
    if row.outcome not in ("completed", "failed", "no_effect"):
        return CompletionRead("ineligible", row, "closed outcome")
    if not row.evidence_ref or not row.evidence_ref.strip(sql.EVIDENCE_WHITESPACE):
        return CompletionRead("ineligible", row, "missing terminal evidence")
    return CompletionRead("completed" if row.outcome == "completed" else "not_completed", row)


def completion_read(job_id: UUID, seq: int) -> CompletionRead:
    """Latest dispatch in this step's current resolution cycle, without locks or outcome filters."""
    statement = sql.COMPLETION_READ.format(cycle=sql.CYCLE.format(bound=sql.CYCLE_FROM_LATEST))
    with connection.cursor() as cursor:
        cursor.execute(statement, {"job": job_id, "seq": seq})
        found = cursor.fetchone()
    return classify_completion(job_id, None if found is None else CompletionRow(*found))


@dataclass(frozen=True, slots=True)
class JobOwnership:
    """Each clause of the runner's ownership rule, as the database reads it now."""

    running: bool
    current_fence: bool
    lease_live: bool


def job_ownership(job_id: UUID, fence: int) -> JobOwnership | None:
    """Whether the job is running, at `fence`, under a lease clock_timestamp() has not ended; None
    when the job is gone. Read, never locked: the writes that follow are fenced themselves."""
    with connection.cursor() as cursor:
        cursor.execute(sql.RUNNER_OWNERSHIP.format(**OWNED), {"job": job_id, "fence": fence})
        found = cursor.fetchone()
    return None if found is None else JobOwnership(*(bool(clause) for clause in found))


def open_dispatch(job_id: UUID, fence: int) -> tuple[UUID, str] | None:
    """The job's one open dispatch at `fence`, as (id, operation_ref), and only while that fence
    owns a running job under a live lease (the runner's ownership rule); None when there is none,
    more than one, or the job is no longer the fence's to run."""
    with connection.cursor() as cursor:
        cursor.execute(sql.RUNNER_OPEN_DISPATCH.format(**OWNED), {"job": job_id, "fence": fence})
        rows = cursor.fetchall()
    return (rows[0][0], rows[0][1]) if len(rows) == 1 else None
