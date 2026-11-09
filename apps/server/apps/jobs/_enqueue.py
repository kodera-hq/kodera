"""Creating a job: docs/specs/JOB_QUEUE.md §4.1.

The row insert is shared by enqueue_job and start_sub_job; everything else here is enqueue_job's.
Every instant is the database's clock_timestamp(), never the statement's start or Python's clock.
"""

from collections.abc import Callable
from datetime import UTC, datetime
from uuid import UUID

from django.db import connection

from apps.audit.services import record_job_event
from core.db.ids import new_uuid7

from . import mutants
from .kinds import KINDS
from .models import JobStep
from .transactions import queue_atomic
from .types import Enqueued, IdempotencyKeyReuse, JobRequest

EPOCH = datetime(1970, 1, 1, tzinfo=UTC)

_INSERT_JOB = """
INSERT INTO jobs_job (id, organisation_id, tenant_id, kind, idempotency_key, desired_spec_hash,
                      status, max_attempts, depends_on_job_id, parent_job_id, actor_type, actor_id,
                      request_id, not_before)
VALUES (%(id)s, %(organisation_id)s, %(tenant_id)s, %(kind)s, %(idempotency_key)s,
        %(desired_spec_hash)s, 'queued', %(max_attempts)s, %(depends_on_job_id)s,
        %(parent_job_id)s, %(actor_type)s, %(actor_id)s, %(request_id)s,
        COALESCE(%(not_before)s::timestamptz, clock_timestamp()))
"""
_CLAIM_KEY = "ON CONFLICT (idempotency_key) DO NOTHING"

_EXISTING = "SELECT id, desired_spec_hash FROM jobs_job WHERE idempotency_key = %s"

# §5.3: the promotion's predicate, on this one row.
_PLACE = """
UPDATE jobs_job SET lock_requested_at = clock_timestamp()
WHERE id = %s AND parent_job_id IS NULL AND not_before <= clock_timestamp()
"""
_PLACE_DEPENDENCY = """
  AND (depends_on_job_id IS NULL
       OR depends_on_job_id IN (SELECT id FROM jobs_job WHERE status = 'succeeded'))
"""


def insert_job(
    *,
    request: JobRequest,
    max_attempts: int,
    not_before: datetime | None,
    parent_job_id: UUID | None = None,
) -> UUID | None:
    """Insert a queued job claiming its idempotency key; None when the key already exists."""
    statement = _INSERT_JOB
    if not mutants.on("no_dedupe"):
        statement += _CLAIM_KEY
    job_id = new_uuid7()
    with connection.cursor() as cursor:
        cursor.execute(
            statement + " RETURNING id",
            {
                "id": job_id,
                "organisation_id": request.organisation_id,
                "tenant_id": request.tenant_id,
                "kind": request.kind,
                "idempotency_key": request.idempotency_key,
                "desired_spec_hash": request.desired_spec_hash,
                "max_attempts": max_attempts,
                "depends_on_job_id": request.depends_on_job_id,
                "parent_job_id": parent_job_id,
                "actor_type": request.actor_type,
                "actor_id": request.actor_id,
                "request_id": request.request_id,
                "not_before": not_before,
            },
        )
        return job_id if cursor.fetchone() is not None else None


def insert_steps(job_id: UUID, kind: str) -> None:
    """The kind's registry steps, seq from 1, all pending."""
    JobStep.objects.bulk_create(
        JobStep(
            job_id=job_id,
            seq=seq,
            name=step.name,
            status="pending",
            retry_class=step.retry_class,
            conditional=step.conditional,
            timeout_s=step.timeout_s,
        )
        for seq, step in enumerate(KINDS[kind].steps, start=1)
    )


def audit_created(request: JobRequest, job_id: UUID) -> None:
    record_job_event(
        action="job.created",
        job_id=job_id,
        organisation_id=request.organisation_id,
        actor_type=request.actor_type,
        actor_id=request.actor_id,
        request_id=request.request_id,
        metadata={"kind": request.kind},
    )


def enqueue_job(*, request: JobRequest, apply_desired_state: Callable[[], None]) -> Enqueued:
    """§4.1, in its order, in one transaction (a savepoint inside the caller's)."""
    if request.kind not in KINDS:
        raise ValueError(f"{request.kind!r} is not a job kind")
    spec = KINDS[request.kind]
    not_before = request.not_before
    if not_before is None and mutants.on("none_not_before_not_now"):
        not_before = EPOCH
    with queue_atomic("enqueue_job"):
        job_id = insert_job(request=request, max_attempts=spec.max_attempts, not_before=not_before)
        if job_id is None:
            if mutants.on("apply_state_on_duplicate"):
                apply_desired_state()
            with connection.cursor() as cursor:
                cursor.execute(_EXISTING, [request.idempotency_key])
                row = cursor.fetchone()
            if row is None:
                raise RuntimeError("a key the insert found taken names no committed job")
            existing, desired_spec_hash = row
            if desired_spec_hash != request.desired_spec_hash and not mutants.on(
                "reuse_not_refused"
            ):
                raise IdempotencyKeyReuse(request.idempotency_key)
            return Enqueued(job_id=existing, created=False)
        apply_desired_state()
        if mutants.on("steps_after_audit"):
            JobStep.objects.filter(job_id=job_id).exists()
        else:
            insert_steps(job_id, request.kind)
        if not mutants.on("audit_second_txn"):
            audit_created(request, job_id)
        if mutants.on("steps_after_audit"):
            insert_steps(job_id, request.kind)
        place = _PLACE
        if not mutants.on("dependent_gets_request_time"):
            place += _PLACE_DEPENDENCY
        with connection.cursor() as cursor:
            cursor.execute(place, [job_id])
    if mutants.on("audit_second_txn"):
        with queue_atomic("enqueue_job"):
            audit_created(request, job_id)
    return Enqueued(job_id=job_id, created=True)
