"""Reads of the job queue for other applications' services: docs/dev/PROJECT_LAYOUT.md §2.

A service that enqueued a job, or that answers for one, reads it here rather than through the
queue's models. Nothing here locks or writes.
"""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from .models import Job, JobDispatch, JobStep


@dataclass(frozen=True, slots=True)
class JobSummary:
    id: UUID
    organisation_id: UUID
    kind: str
    status: str
    desired_spec_hash: str
    created_at: datetime


_FIELDS = ("id", "organisation_id", "kind", "status", "desired_spec_hash", "created_at")


def job_by_idempotency_key(key: str) -> JobSummary | None:
    """The job that claimed this derived idempotency key (JOB_QUEUE.md §3.4), or None."""
    row = Job.objects.filter(idempotency_key=key).values_list(*_FIELDS).first()
    return None if row is None else JobSummary(*row)


def job_summary(job_id: UUID) -> JobSummary | None:
    row = Job.objects.filter(id=job_id).values_list(*_FIELDS).first()
    return None if row is None else JobSummary(*row)


@dataclass(frozen=True, slots=True)
class JobState:
    """Public bootstrap status, without a desired-spec fingerprint or payload."""

    id: UUID
    status: str


def latest_job_state(*, organisation_id: UUID, kind: str) -> JobState | None:
    """Latest id/status using the existing replacement and time-tie ordering."""
    row = (
        Job.objects.filter(organisation_id=organisation_id, kind=kind)
        .order_by("-created_at", "-id")
        .values_list("id", "status")
        .first()
    )
    return None if row is None else JobState(*row)


def latest_job_status(*, organisation_id: UUID, kind: str) -> str | None:
    """The status of the organisation's most recent job of `kind`, or None when it has none.

    The most recent is the last enqueued: a replaced job stays as history and the bootstrap reads
    its replacement (FIRST_OWNER_BOOTSTRAP.md §5.7). Ties on the database clock are broken by the
    time-ordered id.
    """
    status: str | None = (
        Job.objects.filter(organisation_id=organisation_id, kind=kind)
        .order_by("-created_at", "-id")
        .values_list("status", flat=True)
        .first()
    )
    return status


def jobs_newest_first(*, organisation_id: UUID, kind: str) -> tuple[JobSummary, ...]:
    """The organisation's jobs of `kind`, the most recent first, ordered as `latest_job_status`
    orders them."""
    return tuple(
        JobSummary(*row)
        for row in Job.objects.filter(organisation_id=organisation_id, kind=kind)
        .order_by("-created_at", "-id")
        .values_list(*_FIELDS)
    )


@dataclass(frozen=True, slots=True)
class StepProgress:
    seq: int
    name: str
    status: str
    dispatched: bool  # a dispatch was ever recorded for the step


@dataclass(frozen=True, slots=True)
class JobProgress:
    """What the queue recorded of one job, for an operator command that resumes it from there
    (FIRST_OWNER_BOOTSTRAP.md §5.5, re-entry)."""

    id: UUID
    organisation_id: UUID
    kind: str
    status: str
    lease_expires_at: datetime | None
    unresolved_seq: int | None
    unresolved_operation_ref: str | None
    steps: tuple[StepProgress, ...]

    def first_unfinished(self) -> StepProgress | None:
        """The first step that has not succeeded, in order, or None."""
        return next((step for step in self.steps if step.status != "succeeded"), None)


def job_progress(job_id: UUID) -> JobProgress | None:
    row = (
        Job.objects.filter(id=job_id)
        .values_list(
            "id",
            "organisation_id",
            "kind",
            "status",
            "lease_expires_at",
            "unresolved_step_id",
            "unresolved_operation_ref",
        )
        .first()
    )
    if row is None:
        return None
    job_id_, organisation_id, kind, status, lease, unresolved_step_id, operation_ref = row
    dispatched = set(
        JobDispatch.objects.filter(job_id=job_id).values_list("step_id", flat=True).distinct()
    )
    steps = []
    unresolved_seq = None
    for step_id, seq, name, step_status in (
        JobStep.objects.filter(job_id=job_id)
        .order_by("seq")
        .values_list("id", "seq", "name", "status")
    ):
        steps.append(StepProgress(seq, name, step_status, step_id in dispatched))
        if step_id == unresolved_step_id:
            unresolved_seq = seq
    return JobProgress(
        id=job_id_,
        organisation_id=organisation_id,
        kind=kind,
        status=status,
        lease_expires_at=lease,
        unresolved_seq=unresolved_seq,
        unresolved_operation_ref=operation_ref,
        steps=tuple(steps),
    )


def succeeded_tenant_transition(
    *,
    job_id: UUID,
    organisation_id: UUID,
    tenant_id: UUID | None,
    kind: str,
    not_before: datetime,
    not_after: datetime,
) -> bool:
    """Recorded completion evidence within the caller's exact delivery interval."""
    return Job.objects.filter(
        id=job_id,
        organisation_id=organisation_id,
        tenant_id=tenant_id,
        kind=kind,
        status="succeeded",
        finished_at__gte=not_before,
        finished_at__lte=not_after,
    ).exists()
