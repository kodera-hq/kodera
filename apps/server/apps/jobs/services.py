"""The job queue's service functions: docs/specs/JOB_QUEUE.md §4.

Every function is keyword-only and uses the calling thread's connection. Business transactions
assert actual READ COMMITTED after argument/nesting validation and before queue statements;
unsupported isolation raises TransactionManagementError without changing it. Lock cleanup is exempt. A
refusal the specification names — a claim refused, a runner write refused as §4.4 describes, a
decision refused — is returned, not raised. Otherwise a call the specification forbids
raises: inside a caller's transaction (TransactionManagementError), with an unknown kind, a
decision's exit or outcome outside its closed set, or an argument record_step, finish_job or
close_dispatch never accepts (ValueError), or reusing an idempotency key for another request
(IdempotencyKeyReuse). The names below are what the acceptance tests call.

A decision's principal comes from `resolve_staff_principal`, re-exported here from apps.identity.staff
for request tokens. FIRST_OWNER_BOOTSTRAP.md PC-1 also permits the pilot's command-only
staff_principal_for_command builder outside the API image; any other object passed as a principal
raises TypeError.
"""

from apps.identity.staff import StaffPrincipal, StaffPrincipalError, resolve_staff_principal

from ._claim import claim_job, release_live_locks
from ._decisions import (
    record_delivery_reconciliation_decision,
    record_reconciliation_decision,
)
from ._enqueue import enqueue_job
from ._runner import (
    close_dispatch,
    finish_job,
    hold_for_reconciliation,
    record_dispatch,
    record_step,
    renew_lease,
    retarget_dispatch,
    start_sub_job,
)
from ._sweep import sweep_expired_leases
from .delivery_lock import release_realm_delivery_lock, try_realm_delivery_lock
from .types import (
    Claim,
    ClaimRefused,
    DecisionRecorded,
    DecisionRefused,
    Enqueued,
    Evidence,
    IdempotencyKeyReuse,
    JobRequest,
    ReconciliationDecision,
)

__all__ = [
    "Claim",
    "ClaimRefused",
    "DecisionRecorded",
    "DecisionRefused",
    "Enqueued",
    "Evidence",
    "IdempotencyKeyReuse",
    "JobRequest",
    "ReconciliationDecision",
    "StaffPrincipal",
    "StaffPrincipalError",
    "claim_job",
    "close_dispatch",
    "enqueue_job",
    "finish_job",
    "hold_for_reconciliation",
    "record_delivery_reconciliation_decision",
    "record_dispatch",
    "record_reconciliation_decision",
    "record_step",
    "release_live_locks",
    "release_realm_delivery_lock",
    "renew_lease",
    "resolve_staff_principal",
    "retarget_dispatch",
    "start_sub_job",
    "sweep_expired_leases",
    "try_realm_delivery_lock",
]
