"""The job queue's service types: docs/specs/JOB_QUEUE.md §4, names and fields verbatim."""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID


@dataclass(frozen=True)
class JobRequest:
    organisation_id: UUID
    tenant_id: UUID | None
    kind: str
    idempotency_key: str
    desired_spec_hash: str
    actor_type: str
    actor_id: UUID | None
    request_id: str | None = None
    depends_on_job_id: UUID | None = None
    # None means now: the creating transaction's clock_timestamp().
    not_before: datetime | None = None


@dataclass(frozen=True)
class Enqueued:
    job_id: UUID
    created: bool


@dataclass(frozen=True)
class Claim:
    job_id: UUID
    fence: int
    runner_id: str


@dataclass(frozen=True)
class ClaimRefused:
    job_id: UUID
    reason: str


@dataclass(frozen=True)
class Evidence:
    provider: str
    resource_id: str
    request_id: str
    observed_at: datetime


# The closed sets a reconciliation decision is checked against (§5.4), for a job and for an outbox
# delivery alike. apps/outbox/models.py repeats them for its own table's CHECKs, because a models
# module imports no other application (docs/dev/PROJECT_LAYOUT.md §2);
# tests/test_job_queue_schema.py fails if the two copies differ.
DECISION_EXITS = ("resume", "fail")
OPERATION_OUTCOMES = ("completed", "no_effect", "partial")
# The role a decision needs: a current StaffRole grant of it, read in the decision's transaction. The
# deciding principal is apps.identity.staff.StaffPrincipal, which carries no role
# (docs/specs/STAFF_IDENTITY.md §5); this module imports no other application, as models.py reads it.
DECIDING_ROLE = "staff_operator"


@dataclass(frozen=True)
class ReconciliationDecision:
    subject_id: UUID  # the job, or the outbox delivery
    exit: str  # "resume" | "fail"
    operation_outcome: str  # "completed" | "no_effect" | "partial"
    compute_terminated: Evidence
    target_read: Evidence


@dataclass(frozen=True)
class DecisionRecorded:
    decision_id: UUID


@dataclass(frozen=True)
class DecisionRefused:
    subject_id: UUID
    reason: str  # §3.3


class IdempotencyKeyReuse(Exception):  # noqa: N818 - the specification's name for it
    """An idempotency key already names a job with another desired_spec_hash (§4.1)."""
