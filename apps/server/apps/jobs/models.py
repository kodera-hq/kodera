"""Job-queue records: docs/domain/MODEL.md §8 and docs/specs/JOB_QUEUE.md §3.

Every foreign key is declared without a database constraint and added by name in 0002_guards, with
the row triggers of §3.2. Every instant the queue writes defaults to clock_timestamp(): Django's
auto_now fields take the Python clock and its Now() the statement's start, and neither is ever
compared with a lease.
"""

from django.db import models
from django.db.models import Q

from core.db.functions import ClockTimestamp
from core.db.ids import new_uuid7

from .types import DECIDING_ROLE, DECISION_EXITS, OPERATION_OUTCOMES

KINDS = (
    "bootstrap_verify",
    "provision",
    "upgrade",
    "backup",
    "restore",
    "rotate_secret",
    "add_domain",
    "remove_domain",
    "suspend",
    "resume",
    "decommission",
    "export",
    "delete",
    "drift_check",
    "realm_create",
    "realm_update",
)
REALM_KINDS = ("realm_create", "realm_update")
STATUSES = (
    "queued",
    "leased",
    "running",
    "succeeded",
    "failed",
    "orphaned",
    "needs_reconciliation",
    "cancelled",
)
CLAIMED = ("leased", "running")
ERROR_CODES = (
    "step_failed",
    "compensation_failed",
    "prerequisite_failed",
    "orphaned_exhausted",
    "reconciliation_failed",
    "parent_not_running",
    "allocation_stale",
)
ACTOR_TYPES = ("staff", "tenant", "agent", "system")
STEP_STATUSES = ("pending", "running", "succeeded", "failed", "skipped", "compensated")
RETRY_CLASSES = ("A", "B", "C", "D")
LOCK_CLASSES = ("organisation", "tenant", "target")
LOCK_MODES = ("shared", "exclusive")
DISPATCH_OUTCOMES = ("completed", "failed", "no_effect")
HEX64 = r"^[0-9a-f]{64}$"


class Job(models.Model):
    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    organisation = models.ForeignKey(
        "orgs.Organisation", models.RESTRICT, db_constraint=False, related_name="+"
    )
    tenant_id = models.UUIDField(null=True)
    kind = models.TextField()
    idempotency_key = models.TextField()
    desired_spec_hash = models.TextField()
    status = models.TextField(default="queued")
    lease_expires_at = models.DateTimeField(null=True)
    runner_id = models.TextField(null=True)  # noqa: DJ001 - null is "no claim", not an empty name
    fence = models.BigIntegerField(default=0, db_default=0)
    unresolved_step = models.ForeignKey(
        "jobs.JobStep", models.RESTRICT, null=True, db_constraint=False, related_name="+"
    )
    unresolved_operation_ref = models.TextField(null=True)  # noqa: DJ001 - null until reconciling
    reconciliation_decision = models.ForeignKey(
        "jobs.JobReconciliationDecision",
        models.RESTRICT,
        null=True,
        db_constraint=False,
        db_column="reconciliation_decision_ref",
        related_name="+",
    )
    lock_requested_at = models.DateTimeField(null=True)
    depends_on_job = models.ForeignKey(
        "self", models.RESTRICT, null=True, db_constraint=False, related_name="+"
    )
    attempt = models.IntegerField(default=0, db_default=0)
    max_attempts = models.IntegerField()
    not_before = models.DateTimeField(db_default=ClockTimestamp())
    actor_type = models.TextField()
    actor_id = models.UUIDField(null=True)
    parent_job = models.ForeignKey(
        "self", models.RESTRICT, null=True, db_constraint=False, related_name="+"
    )
    request_id = models.TextField(null=True)  # noqa: DJ001 - null when no API request created it
    started_at = models.DateTimeField(null=True)  # written by a later item
    finished_at = models.DateTimeField(null=True)  # written by a later item
    error_code = models.TextField(null=True)  # noqa: DJ001 - non-null exactly when failed
    artefact_refs = models.JSONField(
        default=list, db_default=models.Value([], output_field=models.JSONField())
    )
    created_at = models.DateTimeField(db_default=ClockTimestamp())
    updated_at = models.DateTimeField(db_default=ClockTimestamp())  # written by a later item

    class Meta:
        db_table = "jobs_job"
        constraints = [
            models.UniqueConstraint(
                fields=["idempotency_key"], name="jobs_job_idempotency_key_unique"
            ),
            models.CheckConstraint(name="jobs_job_kind_valid", condition=Q(kind__in=KINDS)),
            models.CheckConstraint(name="jobs_job_status_valid", condition=Q(status__in=STATUSES)),
            models.CheckConstraint(
                name="jobs_job_hashes_valid",
                condition=Q(idempotency_key__regex=HEX64, desired_spec_hash__regex=HEX64),
            ),
            models.CheckConstraint(
                name="jobs_job_actor_type_valid", condition=Q(actor_type__in=ACTOR_TYPES)
            ),
            # One named CHECK per clause, so a database mutant drops exactly one clause.
            models.CheckConstraint(
                name="jobs_job_tenant_null_for_realm_kinds",
                condition=~Q(kind__in=REALM_KINDS) | Q(tenant_id__isnull=True),
            ),
            models.CheckConstraint(
                name="jobs_job_tenant_set_for_tenant_kinds",
                condition=Q(kind__in=REALM_KINDS) | Q(tenant_id__isnull=False),
            ),
            models.CheckConstraint(
                name="jobs_job_lease_while_claimed",
                condition=~Q(status__in=CLAIMED) | Q(lease_expires_at__isnull=False),
            ),
            models.CheckConstraint(
                name="jobs_job_no_lease_unless_claimed",
                condition=Q(status__in=CLAIMED) | Q(lease_expires_at__isnull=True),
            ),
            models.CheckConstraint(
                name="jobs_job_unresolved_step_when_reconciling",
                condition=~Q(status="needs_reconciliation") | Q(unresolved_step__isnull=False),
            ),
            models.CheckConstraint(
                name="jobs_job_unresolved_operation_when_reconciling",
                condition=~Q(status="needs_reconciliation")
                | Q(unresolved_operation_ref__isnull=False),
            ),
            models.CheckConstraint(
                name="jobs_job_error_code_when_failed",
                condition=~Q(status="failed") | Q(error_code__isnull=False),
            ),
            models.CheckConstraint(
                name="jobs_job_no_error_code_unless_failed",
                condition=Q(status="failed") | Q(error_code__isnull=True),
            ),
            models.CheckConstraint(
                name="jobs_job_error_code_valid",
                condition=Q(error_code__isnull=True) | Q(error_code__in=ERROR_CODES),
            ),
        ]
        indexes = [
            models.Index(
                fields=["status", "not_before"],
                name="jobs_job_claimable_idx",
                condition=Q(status__in=("queued", "orphaned")),
            ),
            models.Index(fields=["lock_requested_at", "id"], name="jobs_job_request_order_idx"),
            models.Index(fields=["parent_job"], name="jobs_job_parent_idx"),
            models.Index(fields=["depends_on_job"], name="jobs_job_depends_on_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.kind} {self.id}"


class JobStep(models.Model):
    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    job = models.ForeignKey(Job, models.RESTRICT, db_constraint=False, related_name="+")
    seq = models.IntegerField()
    name = models.TextField()
    status = models.TextField(default="pending", db_default="pending")
    retry_class = models.TextField()
    conditional = models.BooleanField(default=False, db_default=False)
    attempt = models.IntegerField(default=0, db_default=0)  # written by a later item
    started_at = models.DateTimeField(null=True)  # written by a later item
    finished_at = models.DateTimeField(null=True)  # written by a later item
    timeout_s = models.IntegerField()
    output_ref = models.TextField(null=True)  # noqa: DJ001 - an object-storage reference or none
    error_code = models.TextField(null=True)  # noqa: DJ001 - null unless the step failed

    class Meta:
        db_table = "jobs_jobstep"
        constraints = [
            models.UniqueConstraint(fields=["job", "seq"], name="jobs_jobstep_seq_unique"),
            models.CheckConstraint(
                name="jobs_jobstep_status_valid", condition=Q(status__in=STEP_STATUSES)
            ),
            models.CheckConstraint(
                name="jobs_jobstep_retry_class_valid", condition=Q(retry_class__in=RETRY_CLASSES)
            ),
        ]

    def __str__(self) -> str:
        return f"{self.job_id} #{self.seq} {self.name}"


class JobLockReservation(models.Model):
    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    job = models.ForeignKey(Job, models.RESTRICT, db_constraint=False, related_name="+")
    fence = models.BigIntegerField()
    lock_class = models.TextField()
    lock_key = models.UUIDField()
    mode = models.TextField()
    reserved_at = models.DateTimeField(db_default=ClockTimestamp())
    ended_at = models.DateTimeField(null=True)

    class Meta:
        db_table = "jobs_joblockreservation"
        constraints = [
            models.UniqueConstraint(
                fields=["job", "fence", "lock_class", "lock_key"],
                name="jobs_joblockreservation_claim_unique",
            ),
            models.CheckConstraint(
                name="jobs_joblockreservation_lock_class_valid",
                condition=Q(lock_class__in=LOCK_CLASSES),
            ),
            models.CheckConstraint(
                name="jobs_joblockreservation_mode_valid", condition=Q(mode__in=LOCK_MODES)
            ),
        ]
        indexes = [
            models.Index(
                fields=["lock_class", "lock_key"],
                name="jobs_reservation_unended_idx",
                condition=Q(ended_at__isnull=True),
            ),
        ]

    def __str__(self) -> str:
        return f"{self.lock_class} {self.lock_key} ({self.mode})"


class JobDispatch(models.Model):
    """A started operation. No database rule limits a job to one open dispatch, and none ties the
    evidence to closed_at: the functions check both (§4), and a database rule would make their
    mutants raise instead of failing an assertion."""

    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    job = models.ForeignKey(Job, models.RESTRICT, db_constraint=False, related_name="+")
    step = models.ForeignKey(JobStep, models.RESTRICT, db_constraint=False, related_name="+")
    fence = models.BigIntegerField()
    operation_ref = models.TextField()
    sub_job = models.ForeignKey(
        Job, models.RESTRICT, null=True, db_constraint=False, related_name="+"
    )
    dispatched_at = models.DateTimeField(db_default=ClockTimestamp())
    closed_at = models.DateTimeField(null=True)
    terminal_outcome = models.TextField(null=True)  # noqa: DJ001 - null while open
    terminal_evidence_ref = models.TextField(null=True)  # noqa: DJ001 - null while open

    class Meta:
        db_table = "jobs_jobdispatch"
        constraints = [
            models.CheckConstraint(
                name="jobs_jobdispatch_terminal_outcome_valid",
                condition=Q(terminal_outcome__isnull=True)
                | Q(terminal_outcome__in=DISPATCH_OUTCOMES),
            ),
        ]
        indexes = [
            models.Index(
                fields=["job"],
                name="jobs_jobdispatch_open_idx",
                condition=Q(closed_at__isnull=True),
            ),
            models.Index(fields=["sub_job"], name="jobs_jobdispatch_sub_job_idx"),
            models.Index(fields=["step", "dispatched_at"], name="jobs_jobdispatch_step_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.job_id} {self.operation_ref}"


class JobReconciliationDecision(models.Model):
    """An operator's decision. No CHECK requires the evidence: the function checks it (§5.4), and a
    CHECK would make its mutants raise instead of failing an assertion. decided_txid is forced by
    the insert trigger, whatever the insert supplied, so the model declares no default for it;
    decided_at is the function's, which the trigger validates and never overwrites."""

    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    job = models.ForeignKey(Job, models.RESTRICT, db_constraint=False, related_name="+")
    exit = models.TextField()
    operation_outcome = models.TextField()
    compute_terminated_provider = models.TextField()
    compute_terminated_resource_id = models.TextField()
    compute_terminated_request_id = models.TextField()
    compute_terminated_observed_at = models.DateTimeField()
    target_read_provider = models.TextField()
    target_read_resource_id = models.TextField()
    target_read_request_id = models.TextField()
    target_read_observed_at = models.DateTimeField()
    unresolved_step = models.ForeignKey(
        JobStep, models.RESTRICT, db_constraint=False, related_name="+"
    )
    unresolved_operation_ref = models.TextField()
    dispatch_outcome_at_decision = models.TextField(null=True)  # noqa: DJ001 - null: decision closed it
    decided_by_identity = models.ForeignKey(
        "identity.Identity", models.RESTRICT, db_constraint=False, related_name="+"
    )
    decided_by_role = models.TextField()
    decided_at = models.DateTimeField(db_default=ClockTimestamp())
    decided_txid = models.BigIntegerField()

    class Meta:
        db_table = "jobs_jobreconciliationdecision"
        constraints = [
            models.CheckConstraint(
                name="jobs_jobreconciliationdecision_exit_valid",
                condition=Q(exit__in=DECISION_EXITS),
            ),
            models.CheckConstraint(
                name="jobs_jobreconciliationdecision_operation_outcome_valid",
                condition=Q(operation_outcome__in=OPERATION_OUTCOMES),
            ),
            models.CheckConstraint(
                name="jobs_jobreconciliationdecision_dispatch_outcome_valid",
                condition=Q(dispatch_outcome_at_decision__isnull=True)
                | Q(dispatch_outcome_at_decision__in=DISPATCH_OUTCOMES),
            ),
            models.CheckConstraint(
                name="jobs_jobreconciliationdecision_role_valid",
                condition=Q(decided_by_role=DECIDING_ROLE),
            ),
            models.CheckConstraint(
                name="jobs_jobreconciliationdecision_partial_only_fails",
                condition=~Q(operation_outcome="partial") | Q(exit="fail"),
            ),
        ]
        indexes = [
            models.Index(
                fields=["unresolved_step", "decided_at"],
                name="jobs_decision_step_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.job_id} {self.exit}"
