# Job queue

**Status:** Proposed · implemented · **Owner:** Worker seat

This is the implementation contract for work item A3, the Postgres-backed job queue of accepted
ADR-0004 (issue kodera-core#21). It fixes the records, the service functions and the transaction,
lock and lease rules the queue MUST provide, and the acceptance tests that check them. What a job
kind does — its steps, lock modes, retry classes and compensation — is
[`../domain/JOB_CATALOGUE.md`](../domain/JOB_CATALOGUE.md); this document does not repeat it and
never overrides it. Field-level shapes and physical column names live in
[`../domain/MODEL.md`](../domain/MODEL.md) §8.

The terms MUST, MUST NOT, SHOULD and MAY are normative.

**Implemented** in `apps.jobs`, `apps.outbox` and `apps.audit` (issue kodera-core#21). Every
acceptance test in `tests/job_queue/` passes against the real queue, and §9.2's gate runs in CI's
`Tests` job: each mutant flag of `tests/job_queue/mutants.toml` is run against the real queue and
must be caught by its owning test with its exact message.
§9 says how a reader can tell that each test fails against a broken queue for the reason it names
rather than for any reason at all, and §9.3 lists, item by item, the requirements that have no row,
each with its reason.

## 1. Exit criterion

A3 is done when issue #21's criterion and the delivery table's hold, on real PostgreSQL:

1. A process killed between the desired-state change and the audit row leaves neither committed.
2. A duplicate idempotency key returns the original job.
3. The desired-state change, the job with its idempotency key and ordered steps, and its audit row
   commit in one transaction; a claim's lease is renewed, and every write under it is refused once
   it expires or is superseded, including across a process killed in the middle of a step.

and every acceptance test of §9 passes plainly, with its inventory row moved to `pass` in the same
change, and the merge criterion of §9.2 is met.

## 2. Scope

In A3:

- the records `Job`, `JobStep`, `JobLockReservation`, `JobDispatch` and `JobReconciliationDecision`
  in `apps.jobs`; `OutboxDelivery` and `OutboxDeliveryReconciliationDecision` in `apps.outbox`; and
  `AuditEvent` in `apps.audit` with every column of
  [`../domain/AUDIT_TAXONOMY.md`](../domain/AUDIT_TAXONOMY.md) §1 except the tamper-evidence chain
  (`hash_prev`, `hash_self`), so a later item adds columns to that append-only table and never
  reshapes one;
- the kind registry the queue reads (§3.5);
- the service functions of §4 and their transaction, lock and lease rules;
- the `job.*` audit writer (§6);
- the delivery reconciliation decision and the database guards on a delivery (§7). A3 does not
  create or execute deliveries.

Not in A3, each owned by a later item:

- the worker process, its runner loop, step execution against fake or real tooling, running
  compensation, timeouts and per-job credential loading (A7, A8);
- enqueuing compensation jobs, and dispatching a compensation effect. A3's sweep and decisions
  enqueue nothing, and A3 runs no compensation. The change that adds the compensation kind to
  `JOB_CATALOGUE.md` §2 amends §5.2 and §5.4 so the writers that fail a job with a compensating step
  enqueue it, and the change that runs compensation extends the step machine so a compensation
  effect leaves a fenced dispatch (§5.5);
- the allocation ledger, `JobAttempt`, `RunnerSession`, receipts, `CommandDispatch` and
  `CommandTerminal` of [`ENVIRONMENT_ALLOCATION.md`](ENVIRONMENT_ALLOCATION.md), and their lock
  classes 3 to 5. When that specification lands, `JobDispatch` is extended or replaced by its dispatch
  records, and the sweep of §5.2 gains its precondition that the sweep holds the expired attempt's
  `attempt_fence` lock before it ends the attempt (§3.3 there);
- creating and executing outbox deliveries, and the lock rules a delivery follows while it runs;
- the HTTP surface (`202` with the `Job`, `GET /jobs/{id}`), the request-level replay of
  [`../api/CONVENTIONS.md`](../api/CONVENTIONS.md) §8, and contract 0.12.0's `JobStatus`;
- the audit tamper-evidence chain, redaction pipeline, retention job and export (AUDIT_TAXONOMY §4
  to §6);
- cancellation, maintenance-window overrides, and the alert and runbook owed for
  `needs_reconciliation`;
- any real provider effect: that stays behind [`ENVIRONMENT_ALLOCATION.md`](ENVIRONMENT_ALLOCATION.md)
  §6's gates, which this item does not change.

## 3. Records

### 3.1 Placement and names

The models pin `db_table` and `db_column`, and the physical names are the ones MODEL.md §8 lists:
`jobs_job`, `jobs_jobstep`, `jobs_joblockreservation`, `jobs_jobdispatch`,
`jobs_jobreconciliationdecision`, `outbox_outboxdelivery`, `outbox_deliverydecision` and
`audit_auditevent`. The acceptance tests read exactly those names by SQL, so they are part of this
contract. So are the constraint and trigger names the migrations create, and the index names the
models pin, which MODEL.md §8 lists in its closing table: the tests read the constraint names a
refusal carries, and the mutant flags of §9.2 disarm guards by name. The migrations create seventeen
more indexes, which Django names itself, one for each foreign-key column the models declare without
a database constraint (`jobs_job_parent_job_id_6a488359` and its like). Those names are not pinned,
nothing reads them, and the table does not list them.

`apps.jobs`, `apps.outbox` and `apps.audit` are installed by a settings profile of their own,
`config.settings.job_queue`: the customer schema profile `config.settings.persistence` plus these
three applications. `config.settings.test` loads it. Of the two profiles the API image is started
with, `config.settings.dev` installs none of them. `config.settings.customer_http` installs
`apps.jobs` and `apps.audit`, not `apps.outbox`, since the first route that enqueues a job,
`createOrganisation` ([`ORGANISATION_INTAKE.md`](ORGANISATION_INTAKE.md) §4); `getWorkspace` and
`initialiseWorkspace` ([`PILOT_WORKSPACE_ONBOARDING.md`](PILOT_WORKSPACE_ONBOARDING.md)) read the
latest realm job and write audit events through them as well. The image's build allowlist
(`.dockerignore`) admits only the queue modules those routes import, without migrations or
commands. Until the intake, the image carried no queue package, because a profile that installed
one would stop the image at start-up with nothing in CI to see it; the item that adds a route
decides what more the image carries. `tests/test_development_boundary.py` holds the gate: it copies the files the allowlist and
the Dockerfile admit, starts each of the two profiles on those files alone, and fails when one
needs a file the image does not carry. A schema command that must see the queue names the profile,
`--settings=config.settings.job_queue`; `scripts/ci/check-migrations-complete.py` refuses
`config.settings.persistence` alone.

`Job.organisation_id` is a restrictive foreign key to `orgs.Organisation`. `Job.tenant_id` is a UUID
without a foreign key until the `Tenant` record exists (A4), which adds it; a `CHECK` requires it null
exactly for `realm_create` and `realm_update`. `Job.not_before` is `NOT NULL` with `DEFAULT
clock_timestamp()`: a job that is not deferred is due from the instant it was created (§4.1).

### 3.2 What is immutable, and what a test session may write

A job's specification — `id`, `organisation_id`, `tenant_id`, `kind`, `idempotency_key`,
`desired_spec_hash`, `max_attempts`, `actor_type`, `actor_id`, `parent_job_id`, `depends_on_job_id`,
`request_id`, `created_at` — and a step's specification — `id`, `job_id`, `seq`, `name`,
`retry_class`, `conditional`, `timeout_s` — never change after insert, and no `Job` or `JobStep` row
is ever deleted; row triggers refuse both, with SQLSTATE `23514`. `TRUNCATE` passes a row trigger:
it is refused by privilege, because the production role holds no `TRUNCATE` privilege on any table
of this document, and not by a `BEFORE TRUNCATE` trigger, which would break a test database's flush.
`not_before` is written once, at creation, and no function of §4 changes it afterwards. The status,
the place in request order (`lock_requested_at`), lease, fence, attempt and resolution columns are
an operational projection that only the service functions of §4 update. A step's success and its
failure are each also an audit row, `job.step_succeeded` or `job.step_failed`, whichever writer
records them (§4.2, §4.4, §5.4); no other step transition — to `running`, back to `pending`, to
`skipped` or to `compensated` — is audited, because the taxonomy has no action for it.
`JobLockReservation` changes only by setting `ended_at` once. `JobDispatch` changes only by setting
`operation_ref` through `retarget_dispatch` while it is open, and `closed_at`, `terminal_outcome`
and `terminal_evidence_ref` once. `JobReconciliationDecision`,
`OutboxDeliveryReconciliationDecision` and `AuditEvent` never change, and the database enforces it:
a row trigger on each of the three tables refuses every `UPDATE` and `DELETE` with SQLSTATE `23514`
— `jobs_jobreconciliationdecision_immutable` (§5.4), `outbox_deliverydecision_immutable` (§7) and
the audit table's (§6). A decision row is the record the owner's decision requires, and the delivery
guards of §7 and the resolution cycle of §4.4 both read it after it was written: a decision that
could be rewritten would defeat them.

The acceptance tests write these directly from a session of their own, and nothing else. A3 adds no
trigger that would refuse them:

| Write | Test | Why no service function can stand in |
|---|---|---|
| seed an obsolete `JobStep.error_code` on a running step | completed-dispatch recovery acceptance | proves successful atomic reporting clears retained step error along with copying proof; no production writer creates this historical fixture |
| set a running parent's status to leased with its lease retained; move a retained naming dispatch to another valid job/step pair; set its child association to another retained job or NULL; close it once with completed outcome and nonempty synthetic proof | A3-29 | independently makes exactly one parent-condition predicate false after a valid child claim; all FKs and guards remain intact, closed rows are not reopened, and fresh fixtures supply positive controls |
| back-date `jobs_job.lease_expires_at` or `not_before` | many | PostgreSQL's clock cannot be moved |
| set `jobs_job.fence` one higher on a running parent | A3-10, A3-29 | makes a parent run under a fence other than its sub-job's dispatch, to prove the claim and the stranding pass read the dispatch fence |
| set `jobs_job.status` and `lease_expires_at` on a row the session holds | A3-16 | plays a sweep's transaction at the lease's last instant, and a lease ending while a write waits, neither of which a real sweep or clock can be paused at |
| insert a competing `jobs_jobreconciliationdecision` row and, in the same transaction, set `jobs_job.status`, `error_code` and `reconciliation_decision_ref` on a job in `needs_reconciliation` the session holds | A3-12 | plays another writer moving the job, with a decision of its own, while a decision waits on its row |
| insert `jobs_jobreconciliationdecision` rows — valid ones, one with a `decided_txid` of its own, and try one decided after its insert and one before its job's latest dispatch; try to move a job out of `needs_reconciliation` bare, on a decision of an earlier transaction, on another job's, on the reference it already carried, and to a status its decision does not map to; move it out on a decision of its transaction and back into `needs_reconciliation` | A3-12 | the job path's insert and exit triggers are what these writes prove (§5.4); each refused one writes nothing |
| close a dispatch naming a live sub-job | A3-22 | reaches, as a defence in depth, the state a parent that closed its sub-job's dispatch would leave |
| make a sub-job terminal while the dispatch naming it stays open | A3-09 | every writer that ends a sub-job closes that dispatch (§3.3), so only this write shows the sweep counts an open dispatch naming a sub-job on its own, apart from its non-terminal-sub-job clause |
| set `jobs_job.lease_expires_at` a few seconds ahead on claimed jobs | A3-16 | a lease of 120 seconds cannot be waited out; the test then waits on the database clock, holding the rows, until those leases have passed |
| move `jobs_job.not_before` of a job that holds a place to a later instant | A3-18 | no function of §4 moves `not_before`; a later item's backoff will, and the claim's own clause (§4.2 step 1) must hold by then |
| insert, update and try to delete `outbox_outboxdelivery` rows; insert, and try to update and to delete, `outbox_deliverydecision` rows, some under a savepoint | A3-13 | A3 creates no delivery, and the database's own guards are what these writes prove (§7) |
| try to update and to delete a recorded `jobs_jobreconciliationdecision` row, and to insert one that resumes a partial effect | A3-12, A3-19 | the database's own guards on the decision record are what these writes prove (§5.4); each is refused, so none of them writes anything |
| try to insert a realm job with a tenant and a tenant job without one; try to clear a running job's lease, to give a succeeded job a lease or an error code, to clear a failed job's error code, and to clear a reconciling job's unresolved step or operation | A3-12, A3-13, A3-14 | the table's own `CHECK`s are what these writes prove (§3.1, §3.3); each is refused, so none of them writes anything |
| try to rewrite a closed dispatch's `closed_at`, `terminal_outcome` and `terminal_evidence_ref` and an ended reservation's `ended_at`; try to clear a job's `lock_requested_at` and to move it earlier | A3-14, A3-18 | the database's own write-once guards are what these writes prove (§3.2); each is refused, so none of them writes anything |
| hold a job row, or a delivery row, `FOR KEY SHARE` while a runner write or a decision runs; hold a delivery row `FOR UPDATE` and move the delivery out with a decision of the session's own, while a decision on it waits | A3-13, A3-25 | the lock an uncommitted insert naming the row holds, and another writer's move, cannot be produced on demand by any function of §4 |
| try to change each specification column of a job and of a step, to delete a job and a step, and to update and to delete an audit row | A3-01 | the database's own guards on the specification and on the audit record are what these writes prove (§3.2, §6); each is refused, so none of them writes anything |

A later production guard on these columns MUST keep a test-only path that allows exactly these
writes, and that path MUST NOT be usable by the production role
([`../testing/first-slice-acceptance-harness.md`](../testing/first-slice-acceptance-harness.md),
Known limits).

### 3.3 Status and error codes

`Job.status` is ADR-0004's closed set. The allowed transitions are closed:

| From | To | Writer |
|---|---|---|
| `queued` | `leased` | a claim |
| `queued` | `failed` | a claim finding the job's prerequisite did not succeed (`prerequisite_failed`); the sweep's stranding pass (`parent_not_running`) |
| `leased` | `running` | the first step recorded `running` |
| `leased`, `running` | `succeeded`, `failed` | the owning claim finishing the job |
| `leased`, `running` | `needs_reconciliation` | the owning claim holding its open dispatch, or the sweep (§5.2) |
| `leased`, `running` | `orphaned` | the sweep |
| `leased`, `running` | `failed` | the sweep: `orphaned_exhausted` |
| `orphaned` | `leased` | a claim |
| `orphaned` | `failed` | the sweep's stranding pass (`parent_not_running`) |
| `needs_reconciliation` | `queued`, `failed` | an operator's decision, `resume` or `fail` (§5.4) |
| `queued`, `leased`, `running`, `orphaned`, `needs_reconciliation` | `cancelled` | future retention deletion-supersession writer only; absent from A3 |

`cancelled` is in the enum and has no writer in A3. The retention follow-up must add one narrowly
authorised deletion-supersession writer. For an accepted tenant `delete`, it may cancel only (a) an
`export` selected by the same tenant, or (b) that tenant exit's `decommission`, from `queued`,
`leased`, `running`, `orphaned` or `needs_reconciliation`. The cutoff transaction only fences
effects, sets `cancellation_requested_by_job_id` on those non-terminal jobs and creates the parent
obligation plus one cancel-and-reconcile child per selected non-terminal job. It also creates a
reap-only job child for each relevant terminal export/decommission with any unended claim session
or exact live lock across all historical fences. Under the same no-new-claim fence, every job child
gets one session-reconciliation row per relevant `JobClaimSession`, or exactly one null-session
`never_claimed` sentinel when durable history proves none ever existed;
it never pretends to release a live session lock or know an external outcome. After the supervisor
records a closed outcome for every session child and fresh reads prove every exact session and all
of its job/fence locks absent, finalization clears the lease, ends the reservation, transfers any open
dispatch to that job's child, records
`Job.superseded_by_job_id` and permanently refuses resume. Both links identify the accepted
same-tenant `delete`; `superseded_by_job_id` is non-null exactly for `cancelled`. A failed
decommission remains failed and unreserved, and lifecycle may continue to delete without retrying
it. The separate obligation writer later resolves transferred effects without resuming the job.
The acceptance/mutation suite must cover both job kinds, at least two concurrent exports plus
decommission, one job child and at most one transferred dispatch per job, one session child per
historical live/unended claim across distinct fences, cross-child refusal, every claim-session
identity component, a terminal commit paused before unlock, reap-only terminal jobs, concurrent old
shared session locks, exact-cutoff races, pre-marker supervisor takeover, two-phase destruction close, a long post-destruction
evidence outage and unavailable evidence services; until it lands no runtime path may produce
`cancelled`.
`error_code` is non-null exactly when `status = failed`, from the closed set `step_failed`,
`compensation_failed`, `prerequisite_failed`,
`orphaned_exhausted`, `reconciliation_failed`, `parent_not_running` and `allocation_stale`.

Every writer that makes a sub-job terminal — `finish_job`, the sweep failing it `orphaned_exhausted`,
a `fail` decision, and the stranding pass — closes the parent's dispatch naming it in the same
transaction, `completed` when the sub-job `succeeded` and `failed` otherwise: `completed` for
`finish_job(succeeded)` alone, and `failed` for `finish_job(failed)`, the sweep, the stranding pass
and the `fail` decision. Each of them writes, as `terminal_evidence_ref`, the dispatch's own
`operation_ref`: the reference to the sub-job, whose terminal record is the proof. The outcome
matters beyond bookkeeping: `completed` is what the next claim reads to complete a class `C` step
(§4.2).

A `CHECK` requires `lease_expires_at` non-null exactly when the status is `leased` or `running`, and
`unresolved_step_id` and `unresolved_operation_ref` non-null whenever the status is
`needs_reconciliation`. Both stay recorded after a decision, as its history.

`JobStep.status` has these writers: `pending` at creation, and again when an orphaning or a
`no_effect` resume returns an unfinished step; `running`, `succeeded` and `failed` by the owning
claim; `skipped` by the owning claim, only from `pending`, only for a step the kind registry marks
conditional and only when every lower step is `succeeded` or `skipped`; `succeeded` by a claim, for a
retry class `C` step whose dispatch in the current resolution cycle closed `completed` (§4.2); and
`succeeded` by a `resume` decision whose outcome is `completed` (§5.4). The sweep never marks a step
`succeeded`. `compensated` is in the enum and has no writer in A3: no A3 path runs a compensation, and
the change that does adds the writer together with the dispatch it runs under (§5.5). The steps of a
job that the sweep fails `orphaned_exhausted`, the stranding pass fails, or a `fail` decision fails
are left as they were, a `running` step included: they are evidence of where the job stopped, and a
failed job is never claimed again.

A refused decision (§5.4, §7) carries one of these reasons, the first that applies in this order:
`not_in_reconciliation`, `sub_job_not_terminal` (jobs only), `role_missing`, `evidence_missing`,
`evidence_out_of_order`, `partial_resume`.

### 3.4 Idempotency key

`Job.idempotency_key` and `Job.desired_spec_hash` are 64 lower-case hexadecimal characters, each a
SHA-256 digest. The key is unique for the life of the row, never only for a replay window: the
request-level replay cache expires after 24 hours, the job it created does not. The key is derived,
never supplied verbatim:

| Job | The array that is hashed |
|---|---|
| created by an API request | `[principal_urn, method, path, kind, request_key, n]`, where `n` is the job's position, from 0, among the jobs of the same kind that request creates |
| a sub-job | `["sub", parent_job_id, dispatch_id]`, with the dispatch that starts it |
| a compensation job | `["compensate", failed_job_id, seq]`, with the compensated step's `seq` |
| created by a scheduler | `["schedule", kind, target_urn, scheduled_for]`, with `scheduled_for` the slot's instant in RFC 3339 UTC |
| pilot realm requeue | `["requeue", replaced_job_id]`, where the predecessor is the organisation's latest failed or cancelled `realm_create`; each terminal replacement has its own successor key (`FIRST_OWNER_BOOTSTRAP.md` §5.7) |

The key is `sha256` over the UTF-8 bytes of that array as canonical JSON — Python's
`json.dumps(array, separators=(",", ":"), ensure_ascii=True)` — with identifiers as lower-case
hyphenated strings and `n` and `seq` as JSON integers. A delimiter-joined string is not used: a
`principal_urn`, a path or a client key may contain any delimiter, so two different requests could
join to one string, and a JSON array cannot. `n` follows the handler's enqueue order, which MUST be a
deterministic function of the request: a replay that built the same jobs in another order would
derive other keys and raise `IdempotencyKeyReuse`.

The inputs are pinned, because a refactor that respelled one would derive another key for the same
request and create every job twice: `method` is the HTTP method in upper case; `path` is the request's
path exactly as it was received — percent-encoding untouched, no normalisation — without the query
string; `scheduled_for` is the slot's UTC instant in whole seconds, spelled
`YYYY-MM-DDTHH:MM:SSZ`, with `Z` and never `+00:00` or a fraction; and `n` and `seq` are Python `int`s
and never `bool`s or strings — `0`, `"0"` and `False` hash to three different keys. The function that
derives the key raises for a `bool`, for an `int` subclass other than `int` and for any type but
`str`, `int` and `UUID`. It cannot tell which part is `n` or `seq`, since a string is a legal part
elsewhere, so a string given there derives another key rather than raising: keeping those two
`int`s is the callers' duty.

### 3.5 The kind registry

The queue reads, for each kind, the organisation-lock and tenant-lock modes of `JOB_CATALOGUE.md` §1
and §2, `max_attempts`, and the ordered steps with their timeout, retry class and whether they are
conditional. A step is conditional when the catalogue runs it only for some tenants, such as
`add_domain` step 7, `sync_media_cert` (media role only). They live as data in `apps/jobs/kinds.py`,
one entry per kind, in the catalogue's order. Which source the offline catalogue check compares with
the catalogue — a real GFM parser or a machine-readable §2 — is open decision OD7; A3 does not
settle it.

## 4. Service functions

Every function is keyword-only and typed, in `apps.jobs.services`, and uses the calling thread's
database connection. Every business transaction runs at exactly `READ COMMITTED`. A runner's
connection is a dedicated, non-pooled session
for the whole claim, as ENVIRONMENT_ALLOCATION §3 requires of coordinator sessions: live advisory
locks belong to that session. The names and signatures below are what the acceptance tests call.

After existing argument and caller-transaction validation, each business transaction or service
savepoint reads `SHOW transaction_isolation` before its first queue statement. Any value other
than `read committed`, including `read uncommitted`, raises `TransactionManagementError` with
`<function> requires READ COMMITTED (JOB_QUEUE.md §4); actual=<level>`. This is a programming or
configuration precondition, not a queue refusal reason. It never changes isolation or retries.
The actual transaction is checked, not a configured/default value; no result is cached across
transactions or reconnects. A caller can catch the error outside the service savepoint and keep
using its own transaction at its unchanged isolation.

This read-only preflight is the sole exception to the first-statement ordering below: after it,
the first queue-table statement and all existing domain refusal ordering remain as specified.
Promotion keeps its own checked transaction and commits before later checked scan/claim/sweep
transactions. If a later transaction has unsupported isolation, prior valid promotion remains
committed; when the initial transaction is unsupported, no promotion occurs. Explicit live-lock
release and error/cancellation cleanup are exempt so an isolation error cannot prevent cleanup.
This does not establish physical-session ownership of a retained Claim (§9.3).

```python
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


# apps.identity.staff.StaffPrincipal, re-exported: a stored staff identity, built only by
# resolve_staff_principal(verified, lane) from a verified staff token (STAFF_IDENTITY.md §5).
class StaffPrincipal:
    identity_id: UUID
    issuer: str


@dataclass(frozen=True)
class Evidence:
    provider: str
    resource_id: str
    request_id: str
    observed_at: datetime


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


class IdempotencyKeyReuse(Exception): ...


def enqueue_job(*, request: JobRequest, apply_desired_state: Callable[[], None]) -> Enqueued: ...
def claim_job(*, runner_id: str, job_id: UUID | None = None) -> Claim | ClaimRefused | None: ...
def renew_lease(*, claim: Claim) -> bool: ...
def record_step(
    *,
    claim: Claim,
    seq: int,
    status: str,
    error_code: str | None = None,
    output_ref: str | None = None,
) -> bool: ...
def record_dispatch(*, claim: Claim, seq: int, operation_ref: str) -> UUID | None: ...
def retarget_dispatch(*, claim: Claim, dispatch_id: UUID, operation_ref: str) -> bool: ...
def start_sub_job(*, claim: Claim, seq: int, kind: str, desired_spec_hash: str) -> UUID | None: ...
def close_dispatch(*, claim: Claim, dispatch_id: UUID, outcome: str, evidence_ref: str) -> bool: ...
def hold_for_reconciliation(*, claim: Claim, dispatch_id: UUID) -> bool: ...
def finish_job(*, claim: Claim, status: str, error_code: str | None = None) -> bool: ...
def release_live_locks(*, claim: Claim) -> None: ...
def sweep_expired_leases() -> None: ...
def record_reconciliation_decision(
    *, principal: StaffPrincipal, decision: ReconciliationDecision
) -> DecisionRecorded | DecisionRefused: ...
def record_delivery_reconciliation_decision(
    *, principal: StaffPrincipal, decision: ReconciliationDecision
) -> DecisionRecorded | DecisionRefused: ...
```

The principal is `StaffPrincipal` of `apps.identity.staff`, which `apps.jobs.services` re-exports
with the request-path constructor, `resolve_staff_principal(verified, lane)`
([`STAFF_IDENTITY.md`](STAFF_IDENTITY.md) §5). It is a stored staff identity — an `Identity` with no
organisation, in the staff realm — resolved from a token verified on the staff lane, from the one
staff issuer `KODERA_STAFF_ISSUER`, whose `amr` names a second factor (`AUTHZ.md` §3). It carries the identity
and its issuer, and no role: a staff role is a `StaffRole` grant (`AUTHZ.md` §4), and a decision
reads the grant itself, in its own transaction (§5.4). Calling the class raises, and an instance
cannot be changed. Both decision functions raise `TypeError` for any other object passed as the
principal, before anything else, as they raise `ValueError` for a decision outside its closed sets.
A token from a customer realm therefore never reaches `role_missing`: no principal is built from it,
whatever roles it names, and the decision tables' restrictive `decided_by_identity_id` always names a
staff identity.

The ratified command-only pilot exception PC-1 also admits
`apps.identity.command_principal.staff_principal_for_command(identity_id)`
(`STAFF_IDENTITY.md` §5, `FIRST_OWNER_BOOTSTRAP.md` §3.7). That module is absent from the API
image. The identity is asserted through database access rather than a verified token, carries no
role, and every queue decision still reads its current grant in its own transaction. This
exception and its end conditions do not extend the request resolver or change queue checks.

A function that refuses a write returns `False`, `None`, a `ClaimRefused` or a `DecisionRefused` and
writes nothing, with two exceptions: the promotion of §5.3, which every claim and sweep commits first
on its own, and a claim that finds a failed prerequisite, which fails the job (§4.2). Functions raise
only for a programming/configuration error (including the isolation precondition above) or
`IdempotencyKeyReuse`. The arguments §4.4 lists as never accepted by
`record_step`, `finish_job` and `close_dispatch` are such errors: each function raises `ValueError`
for them, before any statement. A runner write's `False` is therefore one of the refusals §4.4
describes for that write, never that the call sent one of those arguments. A refusal is a returned
refusal with its reason, never a raised database error: each function checks what it refuses itself, and does not lean
on a constraint or a trigger raising, even where the database guards the same rule independently
(§7). `ClaimRefused.reason` is one of `not_claimable`,
`waiting_on_dependency`, `prerequisite_failed`, `session_holds_lock`, `reservation_conflict`,
`delivery_in_flight`, `earlier_request`, `live_lock_busy` and `parent_not_running`;
`DecisionRefused.reason` is one of §3.3's. `not_claimable` covers four causes — a status other than
`queued` or `orphaned`, a `not_before` still ahead, a row another transaction holds, and a top-level
job with no place yet — and telling them apart in the reason is left to the implementation change
(§9.3). A `ReconciliationDecision` whose `exit` or `operation_outcome` is outside its closed set is a
programming error: the decision functions raise `ValueError` for it, before anything else, and
return no refusal.

`enqueue_job` and the two decision functions may be called inside a caller's transaction, where
their own transaction is a savepoint (§4.1, §5.4). `claim_job`, `sweep_expired_leases` and every
runner write MUST be called with no transaction open on the connection: inside a caller's `atomic()`
the promotion's "commit" would be a savepoint release, invisible to every other session, while the
live advisory locks were already held. Each refuses such a call before any statement, raising
`TransactionManagementError` with the message `<function> must be called with no transaction open
(JOB_QUEUE.md §4)`.

### 4.1 Creating a job: one transaction

`enqueue_job` opens a transaction, or a savepoint inside the caller's, and in it, in this order:

1. inserts the `Job` row, claiming the idempotency key (`INSERT … ON CONFLICT (idempotency_key) DO
   NOTHING`), with `not_before` the request's, or `clock_timestamp()` when the request's is `None`;
2. if the key already existed: with the same `desired_spec_hash`, returns that job with
   `created = False`, writes nothing and does **not** call `apply_desired_state`; with a different
   hash, raises `IdempotencyKeyReuse` and writes nothing. A concurrent duplicate waits on the first
   transaction's uncommitted key and then takes the same branch;
3. calls `apply_desired_state()`, the caller's desired-state change;
4. inserts the job's `JobStep` rows from the kind registry, `seq` from 1, all `pending`;
5. inserts the `job.created` `AuditEvent`;
6. sets `lock_requested_at` if the job is a top-level job claimable now (§5.3).

The order is part of the contract: it is what makes "killed between the state change and the audit
row" a point that exists, and the acceptance test crashes there and at the steps before it. Nothing in
the function commits separately, uses a second connection, or defers any of these writes to a later
transaction. A domain `AuditEvent` of the caller's own is written by the caller inside
`apply_desired_state` and commits with the rest.

### 4.2 Claiming

`claim_job` first commits the promotion of §5.3. It then claims the named job, or with no `job_id`
**scans**: it reads the rows with `status IN ('queued', 'orphaned')` and `not_before <=
clock_timestamp()` and `cancellation_requested_by_job_id IS NULL`, ordered
`(parent_job_id IS NULL, lock_requested_at NULLS FIRST, id)`, runs the
claim below on each in turn, and returns the first claim that succeeds, or `None` when none does.
That order reads sub-jobs first: they take no lock, and their parent is holding its locks for them.
It then reads the top-level rows that hold no place — a dependent whose dependency is not terminal
is refused and passed over, and one whose dependency failed is failed `prerequisite_failed` by this
read, which is how such a job ever gets its `job.failed` — and last the placed rows in request
order. A refusal never ends the scan. A scan costs one claim transaction per waiting dependent
before it reaches a placed row; an implementation MAY leave out rows a claim would refuse without
writing anything, provided what callers and the tables observe is the same. A claim of one job is one
transaction that:

1. locks the job's row (`FOR NO KEY UPDATE SKIP LOCKED`) and refuses it `not_claimable` unless its
   status is `queued` or `orphaned` and `not_before <= clock_timestamp()`. No function of §4 moves
   `not_before` after creation, so under A3's writers alone a top-level job that is not yet due has
   no place and step 3 would refuse it too; the clause stands on its own because a later item's
   backoff moves `not_before` of a job that already holds a place, and a claim by id must not start
   such a job early. A row another transaction
   holds, the promotion's included, is refused `not_claimable` without waiting, and the caller
   retries. The lock is `FOR NO KEY UPDATE` wherever this document locks a job row — here, the
   promotion, the runner writes, the sweep and the decisions — because no key of `jobs_job` is ever
   updated or deleted, and `FOR UPDATE SKIP LOCKED` would skip a row merely referenced by an
   uncommitted insert: the foreign-key check of an `enqueue_job` of a dependent, or of any row that
   names the job, holds `FOR KEY SHARE` on it. Before it allocates the next fence, reservation or
   `JobClaimSession`, the same locked read also refuses `cancellation_requested` when
   `cancellation_requested_by_job_id` is non-null. The cutoff writer holds this row lock while it
   sets that write-once field and enumerates all earlier claim sessions, so a racing claim either
   commits its registered session first and is enumerated or observes the fence and creates none;
2. for a job with a dependency: refuses while the dependency is not terminal
   (`waiting_on_dependency`); when the dependency ended in any status but `succeeded`, fails the job
   `prerequisite_failed`, emits `job.failed`, commits, and returns `prerequisite_failed`, before any
   lock check;
3. for a top-level job, refuses it `not_claimable` while `lock_requested_at` is null;
4. for a sub-job: §4.3's sub-job rule instead of the checks; otherwise runs the checks of §4.3;
5. updates the row conditionally on the status and fence it read **and
   `cancellation_requested_by_job_id IS NULL`**: `status = leased`,
   `lease_expires_at = clock_timestamp() + 120 s`, `fence` one higher, `attempt` one higher unless
   this is the first claim after a `resume` decision, which no budget counts (§5.4), and
   `runner_id`; ends the job's own earlier reservation if a `resume` left one; writes one
   `JobLockReservation` per organisation and tenant lock of its set, bound to the new fence; marks
   `succeeded`, without a new dispatch, each `pending` step of retry class `C` whose latest dispatch
   in the current resolution cycle closed `completed` — no other step, whatever its dispatches say —
   copying its usable retained `terminal_evidence_ref` to `output_ref` and clearing `error_code`
   before emitting `job.step_succeeded` for each step it marks; emits `job.started` on the job's first
   claim only. The cycle is the one §4.4 defines, in the same words: a dispatch belongs to the
   step's current resolution cycle when it was recorded — its `dispatched_at` — after the
   `decided_at` of the step's latest `resume` decision with outcome `no_effect`, or when the step
   has no such decision. A dispatch recorded before that decision belongs to an earlier cycle and
   completes nothing, whenever and however it was closed. That case is reachable, not a defence in
   depth: a sub-job's terminal write closes its parent's dispatch `completed` while the parent is
   held for reconciliation, and the operator, whose target read finds the sub-job's result gone,
   decides `resume` with `no_effect`; the step must then run again;
6. commits.

In step 5 the same locked transaction also recovers a `pending` class `C` step whose latest
dispatch in that current cycle is closed `failed`: mark the step `failed`, copy the dispatch's
`terminal_evidence_ref` to its `output_ref`, and emit `job.step_failed` with the step, sequence
and that evidence. A different outcome, an open dispatch or an earlier cycle cannot fail a step.
Only a changed pending step emits the audit, so a later claim never duplicates it. Recovery never
rewrites the dispatch, its operation reference, original fence or terminal proof, and starts no
provider call. The worker encounters this failed step before writing `running` or dispatching and
finishes the job `failed` with `step_failed` under its new claim and fence. Death after that
projection is safe to resume in the same way. The existing attempt budget and exhausted-orphan
rule (§5.2) still take precedence over a new claim; recovery does not override exhaustion.

The real-worker acceptance in `tests/worker/test_failed_dispatch_recovery.py` kills a synthetic
backup worker after failed-dispatch closure and again after claim recovery, and must prove
convergence without another provider call. The gap `worker:resume-failed-dispatch` remains listed until that
PostgreSQL, SIGKILL and recovery-removal acceptance has passed in CI. This source change binds no
production kind; the other G1.5-C gaps and empty production registry remain in force.

The live advisory locks a claim takes stay held by the calling session until the runner calls
`release_live_locks` or finishes the job, or the session ends. On any exit that does not commit a
claim — a refusal, an error, a cancelled statement — the function calls `pg_advisory_unlock` for
every live lock it took in this call before it returns or raises: a refusal by check 3 or check 4
unlocks what it took before the transaction rolls back, and a `finally`, after the rollback,
unlocks whatever an error or a cancelled statement left held.

The future retention migration extends step 5, on the same dedicated connection, to generate a
non-reusable `JobClaimSession.id`, set `application_name = 'kodera-job:' || id`, read that backend's
database OID, PID and `pg_stat_activity.backend_start`, and insert the immutable session identity
bound to the job and new fence before any external effect. The complete tuple, never `runner_id` or
PID alone, is the cutoff reaper authority. Acceptance must pause a live claim, attempt reuse of each
individual identity component, and prove that only an exact tuple may be terminated and subsequently
proved absent with all job/fence advisory locks gone. Normal lock release marks this session ended
only after unlock. A crash between a terminal commit and that release therefore leaves an unended
session for the cutoff's reap-only child instead of an invisible terminal live lock.

### 4.3 Claim checks, in order

The catalogue's four checks (`JOB_CATALOGUE.md` §1, **Claims**), made executable, after checks of
the session itself and the future cutoff-ownership fence. A refusal carries the reason named in parentheses.

0. **No reentrancy.** The calling session holds no live lock of the set already
   (`session_holds_lock`): a session's advisory locks stack, so a second claim on the same session
   would release nothing the first did not. Because nearly every kind takes its organisation's lock,
   this means one job per organisation, and per tenant, on one runner session at a time.
0.5. **No cutoff owner.** `cancellation_requested_by_job_id` is still null
   (`cancellation_requested`). This is checked on the locked row before live locks, repeated in
   step 5's final conditional update while live locks are held, and backed by the database trigger;
   losing the race releases every lock and writes no fence, session or reservation.
1. **Reservations, whole set first.** No unended reservation of another job conflicts with any lock of
   the set; two locks conflict when either is exclusive (`reservation_conflict`). Then, for
   `realm_create` and `realm_update`, no `OutboxDelivery` of the organisation with `changes_realm` is
   `in_flight` or `needs_reconciliation` (`delivery_in_flight`). The reservations are read before the
   deliveries, here and in check 4. No live lock is taken until this has passed for every lock of the
   set.
2. **Request order.** No top-level job with an earlier `(lock_requested_at, id)` that is still
   claimable and unclaimed needs a lock, of either class, that conflicts with the set
   (`earlier_request`). Sub-jobs never carry `lock_requested_at` and never count here.
3. **Live locks, never waiting.** Each lock is taken with `pg_try_advisory_lock` or
   `pg_try_advisory_lock_shared`, in the fixed order organisation then tenant. If one is refused,
   every lock this claim took is released before it returns (`live_lock_busy`).
4. **Check 1 again, all of it**, with the live locks held: the reservations and, for a realm job,
   the deliveries. On a conflict the live locks are released, and the refusal is
   `reservation_conflict` or `delivery_in_flight` as in check 1. This closes the gap between another
   claim's check and its commit: a job that was claimed, and whose runner released its live locks,
   between this claim's check 1 and its check 3 is seen only here.

A lock's advisory key is the two-integer form `(class_code, hashtext(key::text))`, with class code 1
for `organisation` and 2 for `tenant`, and the key the organisation's or tenant's UUID. Every other
taker of these locks — consuming an owner claim
([`FIRST_OWNER_BOOTSTRAP.md`](FIRST_OWNER_BOOTSTRAP.md) §8.1) and a realm-changing outbox delivery —
MUST use exactly this key function, or the locks do not exclude each other. A hash collision makes two
unrelated jobs conflict: it never lets two conflicting jobs run together, but it can hold a job back
behind an unrelated one, so fairness is per key hash, not per organisation or tenant.

Request order is by `lock_requested_at`, a timestamp, not by commit order: two requests committed
close together can be served in the order their timestamps were taken rather than the order they
committed. The inversion is transient and never lets conflicting jobs run together.

A consequence to state rather than discover: a tenant job in `needs_reconciliation` keeps its shared
organisation reservation, so a `realm_update` of that organisation, and after it in request order
every job of the organisation that conflicts with the realm job, waits until the operator decides.
The whole organisation is frozen behind one unresolved tenant operation, deliberately.

**Sub-jobs.** A sub-job — a job with `parent_job_id` — runs none of these checks, takes no live lock
and writes no reservation. Its claim succeeds only while its parent is `running` with an open
`JobDispatch` naming the sub-job at the parent's current fence (`parent_not_running`). The claim reads
its parent and that dispatch without locking either. That is safe: a parent that stops right after
the read leaves a claimed sub-job that can start nothing, because each of its effect-starting writes
checks the parent again under a lock (§4.4).

### 4.4 Runner writes

Every runner write — `renew_lease`, `record_step`, `record_dispatch`, `retarget_dispatch`,
`start_sub_job`, `close_dispatch`, `hold_for_reconciliation`, `finish_job` — is one transaction whose
**first** statement locks the job's row under the claim's conditions:

```sql
SELECT … FROM jobs_job
WHERE id = :job_id AND fence = :fence AND status IN ('leased', 'running')
  AND lease_expires_at > clock_timestamp()
FOR NO KEY UPDATE
```

and which writes nothing and returns a refusal when that finds no row. Every other statement follows
in the same transaction. A single `INSERT … SELECT … WHERE` is not enough: at `READ COMMITTED` it
takes no lock on the job row, so a write could commit after a sweep that has already moved the job
on. Every lease predicate uses `clock_timestamp()`, never `now()`, which is the start of a
transaction that may have waited on the row: a lease that expired during that wait MUST refuse the
write.

That statement alone does not deliver the last sentence. PostgreSQL evaluates the predicate before it
waits for the row, and re-evaluates it after the wait only when the transaction it waited for changed
the row. When the blocker releases the row unchanged — a sub-job's `FOR SHARE` on its parent, a sweep
whose re-check found the lease renewed — the statement returns the row although the lease expired
during the wait. So the write **re-checks after it holds the lock**: a second statement, `SELECT
lease_expires_at > clock_timestamp() FROM jobs_job WHERE id = :job_id`, or the same predicate
repeated in the statement that writes, and it refuses when that is false.

A sub-job's writes that start an effect — `record_step` to `running`, `record_dispatch`,
`retarget_dispatch` and `start_sub_job` — next lock the parent's row `FOR SHARE` and require the
parent `running` with an open dispatch naming the sub-job at the parent's current fence; otherwise
they refuse. After this parent-row wait and check, they re-check the child lease against
`clock_timestamp()` while still holding the child row, and refuse if it expired. Its other writes — `renew_lease`, `close_dispatch`, `hold_for_reconciliation`,
`finish_job`, and `record_step` to `succeeded`, `failed` or `skipped` — do not require the parent: a
sub-job must be able to report what it did, and what it did not run, after its parent stopped.
Skipping is a report, since it starts nothing. A sub-job runner that is refused an effect-starting
write MUST stop starting effects, finish the sub-job `failed` — or hold it for reconciliation when it
has an open dispatch — and stop renewing: `renew_lease` does not need the parent, so a runner that
went on renewing would hold its parent's decision back for as long as it liked (§5.4).

A write that names a step or a dispatch refuses one the job does not have: `record_step` refuses a
`seq` that is not one of the job's steps, and `retarget_dispatch`, `close_dispatch` and
`hold_for_reconciliation` refuse a `dispatch_id` that is not an open dispatch of the job.

- `renew_lease` moves `lease_expires_at` to `clock_timestamp() + 120 s` and keeps the fence.
- `record_step` moves one step: to `running` only when every lower `seq` is `succeeded` or `skipped`
  and the step is neither `succeeded`, `skipped` — a skip reports that the step will not run — nor
  `compensated` (the first step set `running` moves the job to `running`);
  to `succeeded` or `failed` only from `running`; to `skipped` only from `pending`, as §3.3 says. It
  raises `ValueError`, before any statement, for `compensated`, which has no writer in A3, and for a
  status other than `running`, `succeeded`, `failed` and `skipped`. With `succeeded` or `failed` it writes
  `output_ref`, when one is given, to `JobStep.output_ref` — a reference, never output — and emits
  `job.step_succeeded` or `job.step_failed` with the transition, carrying that reference in its
  `metadata`: a failed attempt's reference outlives a later success there. It raises `ValueError`,
  before any statement, for an `output_ref` given with `running` or `skipped`, and for an
  `error_code` given with a status other than `failed`.
- `record_dispatch` inserts an open `JobDispatch` for the step, which must be `running`, carrying the
  claim's fence and the `operation_ref`, before the operation starts. It refuses a second open
  dispatch on the job, and a dispatch of a retry-class `C` step that already has a dispatch in the
  current resolution cycle (`JOB_CATALOGUE.md` §4, rule 6). **The resolution cycle** has one
  definition, used here and by the claim (§4.2): a dispatch belongs to the step's current cycle when
  it was recorded — its `dispatched_at` — after the `decided_at` of the step's latest `resume`
  decision with outcome `no_effect`, or when the step has no such decision. The boundary cannot be
  straddled: `decided_at` is read while the decision holds the job row (§5.4), a dispatch is
  recorded only under that same row lock by a claim that owns the job, and a job in
  `needs_reconciliation` has no such claim — so every dispatch that exists when a decision is taken
  was recorded before its `decided_at`, and every later one after it.
- `retarget_dispatch` replaces an open dispatch's `operation_ref`. A step that operates on a state
  file a lock may hold records one dispatch with the lock identifier as `operation_ref` before it
  looks at the lock, and, when the lock is free, retargets that same dispatch to the apply's
  correlation before it starts the apply: the look and the apply share one dispatch, so a lock found
  held, and an apply whose outcome is lost, both leave an open dispatch to hold for reconciliation.
  It refuses a dispatch that names a sub-job, whose `operation_ref` is the sub-job's. A runner that
  is refused the retarget — a sub-job whose parent stopped between the look and the apply — started
  no apply: it closes the look's dispatch `no_effect`, with the look itself as the evidence.
- `start_sub_job` first requires the exact `(parent kind, parent step name, child kind)` in the
  closed production `SUB_JOB_RELATIONS` registry before it writes anything. That registry is empty
  while the catalogue has no sub-job producer, so every production call currently refuses. Tests
  of the generic primitive inject a test-only relation rather than authorizing a real production
  edge; a mutation bypassing the relation check must fail. Once authorized, start is a dispatch and
  a creation in one transaction: it records an open dispatch and creates the sub-job with
  `parent_job_id`, the parent's organisation and tenant, the key of §3.4 derived from that dispatch,
  and no `lock_requested_at`. The parent's lock set already covers the sub-job
  (`JOB_CATALOGUE.md` §1).
- `close_dispatch` closes one open dispatch of the job with its terminal outcome — `completed`,
  `failed` or `no_effect` — and a reference to the authenticated terminal proof. It raises
  `ValueError`, before any statement, for an outcome outside that set and for an empty or blank
  reference: a dispatch closed without proof would let the sweep orphan and re-run a job whose
  operation may still be running. It refuses a dispatch
  that names a sub-job: only the sub-job's terminal write (§3.3), the stranding pass or a decision
  closes that one. It is refused while the job is in `needs_reconciliation`, because its lock
  condition requires `leased` or `running`. The future retention migration adds a separate
  obligation writer, not `close_dispatch`: after a trusted cutoff has transferred the open
  dispatch from a cancelled export or decommission into that job's cutoff child, it may close that
  dispatch only with authenticated terminal evidence while the job stays cancelled and can never
  resume.
- `hold_for_reconciliation` moves the job to `needs_reconciliation` with the open dispatch's step and
  `operation_ref` as the unresolved step and operation, emits `job.reconciliation_required` and keeps
  the reservation. A live runner calls it when its own call ends with an unknown outcome and it cannot
  obtain terminal proof.
- The worker's private completed acknowledgement reports one direct-provider dispatch in one
  checked READ COMMITTED transaction: current job fence, live database-clock lease, job row
  `FOR NO KEY UPDATE`, then an after-lock lease recheck. It atomically closes a verified live
  reply, sets the running step succeeded with that same proof reference, clears its error and
  writes the existing success audit. A live open dispatch must belong to this claim's authoring
  fence; a newer claim cannot acknowledge an old open reply. The public `close_dispatch` and
  `record_step` APIs retain their existing rules.
  Before starting a pending/running step, the runner reads the latest dispatch in the step's
  current resolution cycle, ordered by `dispatched_at` and ID, before testing outcome or proof.
  It reports a retained, closed, direct completion under its current live claim without loading
  credentials or calling a provider. The writer re-reads the same identity, operation and usable
  evidence under the job lock; a changed or ineligible candidate refuses without provider fallback.
  An older dispatch fence is retained unchanged. Matching repeated acknowledgement of an already
  succeeded step is read-only, with no duplicate audit; conflicting or other terminal steps refuse.
  This is report authority: an already owning child can report after its parent stops, while
  effect starts and new child claims retain their parent gates. Claim-time completion remains
  class C only, including valid sub-job completion; classes A/B/D remain pending at claim.
  An exception has an unknown commit outcome and never grants replay permission. A subsequent
  legitimate claim reads retained state. Historical already-succeeded rows with absent/conflicting
  output and operator-completed history are not rewritten; exhausted-orphan policy is unchanged.
  The production registry and all gap IDs remain unchanged pending measured remote acceptance.
- `finish_job(succeeded)` requires every step `succeeded` or `skipped`, no open dispatch and no
  non-terminal sub-job. `finish_job(failed)` requires an `error_code`, no open dispatch and no
  non-terminal sub-job; with either, the runner holds for reconciliation instead. Either ends the
  job's reservation and emits `job.succeeded` or `job.failed`. When the job is a sub-job, the same
  transaction closes the parent's dispatch naming it (§3.3). After commit it releases the session's
  live locks for the job. It raises `ValueError`, before any statement, for a status other than
  `succeeded` or `failed`, for `succeeded` with an `error_code`, and for `failed` with an
  `error_code` outside `models.ERROR_CODES`, a missing one included.
- The future retention runtime does not call current `record_step` and then `finish_job` for delete
  step 9. Its dedicated `complete_delete_destruction` first-phase writer locks the cutoff parent,
  delete job, current claim session and step and requires steps 1–8 succeeded under the current
  fence. In one database transaction, while that session's live locks and durable reservation
  remain held, it marks step 9 succeeded, emits the effect audit, binds the exact claim session and
  sets parent `destruction_completed_at`. A marked delete becomes an unbounded close obligation and
  the lease sweep cannot fail or orphan it. Only after commit does the owning runner release live
  locks. A second idempotent writer records `released` and fresh job/fence lock absence, then ends
  the claim/reservation, succeeds the job and emits terminal audits. A crash after the first commit
  or after unlock is recovered by the supervisor, which records `terminated` or `already_absent`
  under complete-tuple matching, proves the exact backend and locks absent, and performs the same
  durable second phase. The finalizer requires that close proof. Kill-point tests cover both gaps
  and mutations removing the sweep and finalizer gates.
  If the owning runner disappears after steps 1–8 are durably `succeeded` but before this first
  phase, the sweep also may not fail or re-run the one-attempt delete. It routes the unchanged job,
  reservation and exact dead claim to the same unbounded obligation. After one closed reap outcome
  and fresh exact backend/lock absence proof, a trusted retention-supervisor takeover locks the same
  rows and writes only the step-9 marker and claim binding; it never repeats a destructive step.
  The ordinary second phase then succeeds the same linked delete. Acceptance covers
  crash-after-step-8, sweep, takeover, close and unique finalization, plus a mutation that restores
  the exhausted-job failure path.
- `release_live_locks` releases, on the calling session, every live lock of the claim's set it holds.
  It writes nothing to the database. A runner MUST call it after a refused renewal, after a refused
  write that tells it the claim is gone, and after `hold_for_reconciliation`; a runner that stops
  without calling it leaves its locks until its session ends.

## 5. Leases, the sweep and reconciliation

### 5.1 The lease

A claim leases for 120 seconds, and the runner renews every 30. A runner that fails to renew twice in
a row stops work, reaps what it started and releases its live locks (`JOB_CATALOGUE.md` §1); the
queue's side of that rule is that the failed renewals and every later write are refused.

### 5.2 The sweep decides from dispatch records

`sweep_expired_leases` first commits the promotion of §5.3. It then reads the jobs `leased` or
`running` whose `lease_expires_at < clock_timestamp()` and, for each, in its own transaction, locks
the row `FOR NO KEY UPDATE SKIP LOCKED` and re-checks the status, the fence it read and
`lease_expires_at < clock_timestamp()` before it reads any `JobDispatch`. It then decides, in this
order:

0. in the future retention runtime, if this is the linked tenant `delete` and steps 1–8 are durably
   `succeeded`, it sets the parent obligation's `delete_takeover_requested_at` once and leaves the
   job, steps and reservation unchanged. This branch applies whether or not
   `destruction_completed_at` already exists and precedes both dispatch and attempt-budget handling;
   the supervisor reaps the exact claim and completes the marker/close phases without replaying a
   destructive step. A repeated sweep is an idempotent no-op for that obligation;
0a. if `cancellation_requested_by_job_id` names an accepted same-tenant cutoff delete, the sweep
   leaves status, steps, lease, dispatch and reservation unchanged and routes the exact job/fence
   session to its existing cutoff job/session children. It cannot orphan, fail, release or resume
   cutoff-owned work. This branch precedes open-dispatch and attempt-budget handling and is an
   idempotent no-op once every relevant session child already exists;
1. if the job has an open `JobDispatch`, or any sub-job that is not terminal whatever its dispatch
   record says (ADR-0004: a non-terminal sub-job counts as an open dispatch of its parent), the job
   becomes `needs_reconciliation`: `unresolved_step_id` and `unresolved_operation_ref` are those of
   the earliest open dispatch or, when none is open, of the dispatch naming the non-terminal sub-job;
   `job.reconciliation_required` is emitted with both in its metadata; its reservation stays. This
   comes before the budget: an exhausted job with an unknown outcome still waits for an operator;
2. otherwise, if `attempt >= max_attempts`, the job becomes `failed` with `error_code =
   orphaned_exhausted`, its reservation ends, `job.failed` is emitted and, for a sub-job, the parent's
   dispatch naming it is closed `failed`;
3. otherwise it becomes `orphaned`, its reservation ends and `job.orphaned` is emitted. Its
   `lock_requested_at` is kept, so it is served before later requests. Every `running` step returns to
   `pending`; the sweep never marks a step `succeeded` or `failed` from terminal dispatch proof.
   The next claim projects a class `C` step's `succeeded` or `failed` result when §4.2 says so.
   The runner finishes on a failed step before starting more work, otherwise resuming at the
   first step that is not `succeeded` or `skipped`.

Last, the **stranding pass**: for each `queued` or `orphaned` sub-job, locked `FOR NO KEY UPDATE SKIP
LOCKED`, whose parent is not `running` with an open dispatch naming it at the parent's current fence,
the sweep fails the sub-job `parent_not_running` and closes that dispatch `failed`, in one
transaction. A leased sub-job stranded that way is orphaned by the rules above once its lease expires
and failed by this pass in the same sweep. There is deliberately no separate rule failing an expired
sub-job directly: no test could tell it apart from this pass, and a rule no test can tell apart is not
proven.

The sweep never reads a heartbeat, a session or an advisory lock to decide: an expired lease, a stale
heartbeat or a lock nobody holds establishes nothing about an operation.

### 5.3 `lock_requested_at` and the promotion

`lock_requested_at` is written once, with `clock_timestamp()`, and never set to an earlier instant or
cleared. It is written by the creating transaction for a top-level job claimable at creation, and
otherwise by the **promotion**: one statement that every claim and every sweep commits on its own
before anything else,

```sql
WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS at)
UPDATE jobs_job SET lock_requested_at = instant.at
FROM instant
WHERE id IN (
  SELECT id FROM jobs_job
  WHERE status = 'queued' AND parent_job_id IS NULL AND lock_requested_at IS NULL
    AND not_before <= (SELECT at FROM instant)
    AND (depends_on_job_id IS NULL
         OR depends_on_job_id IN (SELECT id FROM jobs_job WHERE status = 'succeeded'))
  FOR NO KEY UPDATE SKIP LOCKED
)
```

The instant is read once, so the jobs one statement promotes — every `provision` waiting on one
`realm_create`, every upgrade at a window's opening — tie, and the `id` tie-break of request order
(§4.3) serves them in `id` order: a deterministic order, not a creation order (ADR-0009). A
`clock_timestamp()` per row would give each its own instant, in executor order, which is no order
anyone chose. Whether a job is due is measured against that same instant, not against a second
reading of the clock: a row that became due after the instant was read would otherwise be given a
place earlier than its own `not_before`, depending on the plan. No job is ever placed before it is
due. `not_before` is never null (§3.1), so the predicate has no `IS NULL` arm. The promotion never
waits: a row another transaction holds is skipped and promoted by the next claim or sweep.

It is the one write a refused claim makes. A job whose dependency ended in any other status never
gets one: the next claim that reads it — a claim by id, or a scan, which reads unplaced rows (§4.2) —
fails it `prerequisite_failed`, and check 2 never counts it. Sub-jobs never get one.

### 5.4 Leaving `needs_reconciliation`

In current A3 only `record_reconciliation_decision` moves a job out of this state, and only under the owner's
decision `external-execution-stop-evidence` (`JOB_CATALOGUE.md` §1). The future retention migration
adds exactly one alternative: after cutoff, the trusted retention writer may transfer the unresolved
dispatch to the matching `ExitCutoffJobReconciliation` and move the selected export or decommission
to `cancelled`, but only after one closed reap outcome (`terminated`, `already_absent`, or
`never_claimed` only on the single sentinel with durable no-session history) for every session child,
plus fresh database reads that prove all complete session tuples and their live locks absent. It neither closes
the dispatch nor resumes the job; the later obligation writer closes it only with authenticated
terminal evidence. Every omitted/mismatched role, tenant, job kind, delete link, parent/child
obligation, dispatch-transfer, claim-session identity or reaper-evidence predicate is
refused by the amended trigger and must have its own mutation. `record_reconciliation_decision`'s first queue-table statement locks the job
row `FOR NO KEY UPDATE` with `status = 'needs_reconciliation'` in its condition, and waits for it. The
function may run inside a caller's transaction — an atomic request, or the staff endpoint that writes
its own audit row around it — where its own transaction is a savepoint. It refuses, writing nothing
and returning the reason in brackets (§3.3), the first that applies:

- a job not in `needs_reconciliation` (`not_in_reconciliation`);
- a non-null `cancellation_requested_by_job_id` (`cutoff_owned`): only the trusted matching cutoff
  writer may transfer the dispatch and cancel the job; an operator cannot `resume`, `fail` or close
  it through this function;
- a job with a sub-job that is not terminal (`sub_job_not_terminal`). A stranded `queued` or
  `orphaned` sub-job is ended by the next sweep (§5.2), and a leased one once its lease expires, which
  §4.4's runner rule bounds; but a sub-job that is itself in `needs_reconciliation` holds its
  parent's decision back until that sub-job's own decision is recorded, however long that takes;
- a principal whose staff identity holds no current `staff_operator` grant (ADR-0010, `AUTHZ.md`
  §4) (`role_missing`): a `StaffRole` row of that identity, of that role, not revoked, of an
  enabled, not deleted identity of an enabled, not deleted person, read in the decision's own
  transaction and locked `FOR SHARE` until it commits (`STAFF_IDENTITY.md` §5). A grant revoked, or
  an identity or person retired, after the principal was resolved decides nothing, and a revocation
  racing the decision waits for it or is seen by it. A job's decision names the grant in its
  `job.reconciliation_decided` row (`staff_role_grant_ref`). The role is never read from the
  request, nor from the token;
- a decision missing either piece of evidence, or with an empty `provider`, `resource_id` or
  `request_id` in either (`evidence_missing`);
- evidence out of time order (`evidence_out_of_order`): it requires `dispatched_at - 5 min <
  compute_terminated.observed_at <= target_read.observed_at <= decided_at + 5 min`, where
  `dispatched_at` is the unresolved dispatch's and `decided_at` is `clock_timestamp()` read once,
  **after the function holds the job row**, never before it waited for it: it is the value compared
  here, the value written to the decision row, and the boundary of the resolution cycle (§4.4). A
  `decided_at` read before the wait could precede a write that committed during it. `observed_at` is
  the provider's or the operator tooling's clock, so its comparisons with database time allow a
  tolerance of 5 minutes each way; the two `observed_at` values are compared with each other
  exactly;
- `operation_outcome = partial` with `exit = resume` (`partial_resume`): a partial effect is only
  ever failed.

There is no field for a lease, a heartbeat or a lock: none of them counts. What the two pieces of
evidence are when the unresolved dispatch names a sub-job is `JOB_CATALOGUE.md` §1's to say, and it
does. The queue checks that both pieces are present, that no field of either is empty and that they
are in time order, and nothing else: never the format of a reference, and never that what it refers
to exists or is authentic.

Otherwise, in one transaction, it inserts the `JobReconciliationDecision` with the principal's
identity, emits `job.reconciliation_decided` with a `staff` actor,
closes the unresolved dispatch, if it is still open, with the target-read reference and the outcome
the decision states — `completed` for `completed`, `no_effect` for `no_effect`, and `failed` for
`partial`, which a dispatch's closed set does not have — and:

- `resume`: the unresolved step becomes `succeeded` when the outcome is `completed`, which emits
  `job.step_succeeded`, and `pending` when it is `no_effect`, which also opens a new resolution cycle
  for a class `C` step (§4.4); the job
  returns to `queued` keeping its reservation and its `lock_requested_at`; its next claim takes a
  higher fence, counts no attempt, and replaces the reservation;
- `fail`: the job becomes `failed` with `error_code = reconciliation_failed`, and its reservation
  ends. For a sub-job, the parent's dispatch naming it is closed `failed` (§3.3).

The update that moves the job out of `needs_reconciliation` also sets `reconciliation_decision_ref`
to the decision: the exit trigger below reads both in one row change.

The unresolved dispatch may already be closed when the decision is taken: a sub-job's terminal write
closes its parent's dispatch without needing the parent (§3.3), so a parent held for reconciliation
can find its dispatch closed `completed` or `failed` by the time the operator decides. The
operator's `operation_outcome` may then contradict it — the sub-job succeeded, and the operator's
target read finds its result gone. The owner's decision makes the operator's evidence the authority,
so: the decision governs the step, exactly as above; the dispatch keeps the outcome its closer wrote,
because a dispatch is closed once (§3.2); and the decision row records both, its own
`operation_outcome` and, in `dispatch_outcome_at_decision`, the outcome the dispatch already carried,
null when the decision itself closed it.

The database guards the decision record independently of the function, each refusal SQLSTATE `23514`
under the constraint name in brackets. A row trigger, `jobs_jobreconciliationdecision_immutable`,
refuses every `UPDATE` and `DELETE` of a decision row
(`jobs_jobreconciliationdecision_immutable`): the evidence, the outcome and
`dispatch_outcome_at_decision` are the record the owner's decision requires, and `decided_at` bounds
the resolution cycle. A `CHECK` requires `operation_outcome <> 'partial' OR exit = 'fail'`
(`jobs_jobreconciliationdecision_partial_only_fails`), which the function already refuses as
`partial_resume`.

The job path carries the delivery path's two other guards (§7), so a writer that bypasses the
function can neither choose the clock that bounds the resolution cycle nor move a job out with a bare
update:

- a `BEFORE INSERT` trigger on `jobs_jobreconciliationdecision`,
  `jobs_jobreconciliationdecision_valid`, forces `decided_txid` — a `bigint`, `NOT NULL` — to
  `txid_current()`, overwriting whatever the insert supplied, and refuses
  (`jobs_jobreconciliationdecision_valid`) a `decided_at` later than `clock_timestamp()` or earlier
  than the job's latest `dispatched_at`. It validates `decided_at` and never forces it: the function
  reads that instant once it holds the job row, and a trigger that overwrote it would hide a function
  that read its clock too early;
- current A3's trigger on `jobs_job`, `jobs_job_reconciliation_exit`, refuses any update that moves a job out of
  `needs_reconciliation` (`jobs_job_reconciliation_exit`) unless the same update sets
  `reconciliation_decision_ref` to a decision that is for that job and no other, was inserted in the
  same transaction (`decided_txid = txid_current()`, for the reasons §7 gives), is not the reference
  the job already carried, and maps to the new status: `queued` for `resume`, `failed` for `fail`.
  The future retention migration amends this same trigger with only §5.4's fully predicated
  dispatch-transfer-to-cancelled alternative; it does not weaken the decision path.

Neither the entry nor either exit counts against `max_attempts`. Verifying that the referenced
evidence is authentic is the operator tooling's, not the queue's, and stays out of A3. Recording a
decision allows no real provider effect: [`ENVIRONMENT_ALLOCATION.md`](ENVIRONMENT_ALLOCATION.md) §6's
gates still apply.

### 5.5 Compensation is not enqueued by A3

`JOB_CATALOGUE.md` says that a `provision` failed at or after step 9 — step 9 no longer `pending` —
with no runner to compensate it enqueues a compensation job for step 9, with the same lock set,
claimed in request order, under the key of §3.4. A3's sweep and decisions enqueue nothing: that kind
is not in the catalogue's §2 yet, and no `provision` with a real provider effect runs before it is.
The change that adds it amends §5.2 step 2 and §5.4's `fail` exit to enqueue it in the transaction
that fails the job.

Running a compensation is owed too, and not only its enqueuing. Under the interface A3 fixes, a
compensation effect could leave no dispatch: `record_dispatch` requires the step `running`, a step
never returns to `running` once it `succeeded`, and compensation runs in reverse over steps that
`succeeded` or `failed`. A `tofu destroy` run that way would start with no fenced dispatch, against
ADR-0004, and a runner killed in the middle of it would be swept to `orphaned` and re-run while the
destroy might still be running. A3 runs no compensation, so it does not meet the case. The change
that runs compensation (A7, A8) MUST extend the step machine so that a compensation effect is
dispatched under a recorded, fenced dispatch, and adds the writer of `compensated` with it (§3.3).

## 6. Audit

The queue writes `AuditEvent` rows with `action`, `actor_type`, `actor_id`, `actor_label`,
`organisation_id`, `target_urn` (the job), `job_id`, `occurred_at`, `request_id`,
`retention_class = standard` and `metadata`, in the transaction of the change they record, and only
actions of [`../domain/AUDIT_TAXONOMY.md`](../domain/AUDIT_TAXONOMY.md) §3's `job.*` rows. The table
refuses `UPDATE` and `DELETE` by row trigger, with SQLSTATE `23514`, and `TRUNCATE` by privilege
(§3.2).

A step's success has three writers and each emits `job.step_succeeded`: `record_step`, a claim
completing a class `C` step (§4.2), and a `resume` decision with outcome `completed` (§5.4). A step's
failure has one, `record_step`, which emits `job.step_failed`. No other step transition is audited
(§3.2).

## 7. Outbox delivery record

`OutboxDelivery` and `OutboxDeliveryReconciliationDecision` (MODEL.md §8) exist in A3 because a realm
job's claim reads a delivery (§4.3 check 1), and because an unresolved delivery must not leave
`needs_reconciliation` on weaker evidence than a job. A3 creates and executes no delivery; the
acceptance test writes delivery rows directly.

`record_delivery_reconciliation_decision` follows §5.4 for a delivery: its first queue-table statement locks the
delivery row `FOR NO KEY UPDATE` with `status = 'needs_reconciliation'` in its condition; it may run
inside a caller's transaction; it takes the same principal and applies the same role, evidence,
tolerance and time-order rules, with the delivery's `started_at` as the dispatch instant and, as in
§5.4, a `decided_at` of its own read after it holds the row — the decision row's `decided_at` is the
insert trigger's, an instant later — and returns the same refusals (§3.3); `partial` only with
`fail`. A start later than that under-lock database clock returns `evidence_out_of_order`,
after status, role and evidence presence have been checked and before partial-resume refusal.
The five-minute evidence tolerance does not permit deciding before the delivery starts. Refusal
leaves the delivery and decisions unchanged, and its caller may continue and commit unrelated writes.
`resume` with `completed` makes the delivery
`succeeded`, `resume` with `no_effect` makes it `pending`, and `fail` makes it `failed`, each in the
transaction that inserts the decision and sets `reconciliation_decision_ref`. The function checks all
of that itself and returns a refusal: it never relies on one of the guards below raising. In the
same transaction, after the decision row and before the delivery's exit, it writes one
`outbox_delivery.reconciliation_decided` audit row (AUDIT_TAXONOMY), as a job's decision writes
`job.reconciliation_decided`: the actor is the deciding staff identity, the organisation is the
delivery's, the target is the delivery, and `metadata` carries the exit, the
`reconciliation_decision_ref` and the `staff_role_grant_ref` of the `staff_operator` grant the role
check read and holds `FOR SHARE` (STAFF_IDENTITY.md §5), never the evidence's content. A refusal
writes none, since its block is rolled back.

The database guards the delivery independently of that function. Each refusal below is SQLSTATE
`23514` and carries the constraint name given in brackets:

- a `CHECK` on `outbox_outboxdelivery` requires `status NOT IN ('in_flight', 'needs_reconciliation')
  OR started_at IS NOT NULL` (`outbox_delivery_started_when_in_flight`): a delivery that never started
  is never in flight and never unresolved, so every unresolved delivery has the dispatch instant a
  decision's evidence must follow, and none is left with no exit;
- a trigger on `outbox_outboxdelivery`, `outbox_delivery_reconciliation_exit`, refuses any update that
  moves a delivery out of `needs_reconciliation` (`outbox_delivery_reconciliation_exit`) unless the
  same update sets `reconciliation_decision_ref` to a decision that is for that delivery and no
  other, was inserted in the same transaction, is not the reference the delivery already carried, has
  `decided_at >= started_at`, and maps to the new status: `succeeded` for `resume` with `completed`,
  `pending` for `resume` with `no_effect`, `failed` for `fail`. Each of the three is bound: a valid
  `fail` decision cannot carry a delivery to `pending`, which would run a partial effect again, or to
  `succeeded`; a `completed` one cannot return it to `pending`; and a `no_effect` one cannot mark it
  `succeeded`. No other pair exists to map: `resume` with `partial` is refused on insert, below. The
  reference clause is not implied by the transaction clause: inside one transaction a delivery could
  leave on a decision, return to `needs_reconciliation`, and leave again on that same decision.
  `decided_at >= started_at` is reachable although `decided_at` is forced, below: a delivery whose
  `started_at` lies less than ten minutes ahead of the database clock — a writer's clock, not
  PostgreSQL's, and the two tolerances together — passes the insert trigger and is stopped here;
- the same trigger refuses `DELETE` of a delivery that is `in_flight` or `needs_reconciliation`
  (`outbox_delivery_delete_refused`), and any change to `changes_realm`, `category`,
  `organisation_id` or `started_at` while it is in either state (`outbox_delivery_frozen`).
  `started_at` is frozen with the other three because the time order is measured from it: a writer
  that could move it earlier could pass evidence observed before the real dispatch. `TRUNCATE` is
  refused by privilege (§3.2);
- `outbox_deliverydecision` has the `CHECK` `outbox_deliverydecision_evidence_present`, that each of
  the six evidence fields is non-empty; the `CHECK` `outbox_deliverydecision_partial_only_fails`,
  `operation_outcome <> 'partial' OR exit = 'fail'`; and a `BEFORE INSERT` trigger,
  `outbox_deliverydecision_valid`, which first forces `decided_at` to `clock_timestamp()` and
  `decided_txid` to `txid_current()`, overwriting whatever the insert supplied for either, and then
  refuses (`outbox_deliverydecision_valid`) a decision whose delivery is not in
  `needs_reconciliation`, or whose evidence breaks any of the three comparisons of §5.4's time order,
  measured against the forced `decided_at`. A writer that could supply `decided_at` would supply the
  clock its own evidence is checked against. The trigger reads the delivery's status without locking
  its row. `record_delivery_reconciliation_decision` holds that row before it inserts, so its insert
  cannot race; an insert made outside it can read `needs_reconciliation` while another transaction
  moves the delivery out, and commit after it. The row it leaves moves no delivery: the exit trigger
  accepts only a decision inserted in the exiting transaction (§9.3 says why the read takes no lock);
- a row trigger on `outbox_deliverydecision`, `outbox_deliverydecision_immutable`, refuses every
  `UPDATE` and `DELETE` of a decision row (`outbox_deliverydecision_immutable`). The exit trigger
  trusts what the insert trigger checked and forced, and that holds only while the row cannot change
  afterwards: a decision committed as `fail` with `partial`, rewritten later to `resume` with
  `completed` and the current `txid_current()`, would otherwise carry its delivery to `succeeded`.

**"Inserted in the same transaction"** is measured by a column, not by the row's `xmin`.
`outbox_deliverydecision.decided_txid` is a `bigint` that the `BEFORE INSERT` trigger forces to
`txid_current()`, the 64-bit identifier of the top-level transaction, overwriting any value the
insert supplied, as it does for `decided_at`; the exit trigger requires `decided_txid =
txid_current()`. A row's `xmin` cannot carry the rule: a row inserted under a savepoint carries the
subtransaction's identifier, never the top-level one, so a decision function called inside a
caller's transaction — where its own transaction is a savepoint — would have its legitimate exit
refused; and `xmin` is 32 bits wide where `txid_current()` is 64, so comparing the two breaks after
2^32 transactions. Both sides of this comparison are 64-bit and neither changes under a savepoint.

A bare status update is therefore refused, whoever makes it, and an exit is the decided one, whoever
makes it.

## 8. Operations the acceptance tests rely on

Beyond the functions of §4, the tests observe PostgreSQL itself, from separate sessions: the
advisory locks a backend holds (`pg_locks`), the tables a blocked backend's open transaction has
already written — the lock mode a write takes, so a table it only read does not count — those it has
read, and which backend blocks which (`pg_blocking_pids`). They crash a real child process with
`SIGKILL`, end or cancel a runner's database session, and hold locks from a session of their own: a
job row exclusively, several at once, a job row `FOR KEY SHARE` as the foreign-key check of an
uncommitted insert holds it, a table against writes, and `outbox_outboxdelivery` against reads, to
stop a realm job's claim between its reservation read and its delivery read. They wait on the
database's clock, in the database, never on the host's. They make only the direct writes §3.2 lists.
None of that is an interface the implementation provides; it is what makes the tests' observations
independent of the implementation's account.

## 9. Acceptance tests

`tests/job_queue/test_job_queue_acceptance.py` holds the tests; `tests/job_queue/acceptance.toml` is
their inventory, with a state — `pass` for every row since A3 was implemented — the gap an `xfail`
row is red on, and the exact assertion each of two counterexample queues must fail. `tests/job_queue/conftest.py` binds every row:

- an `xfail` row is a strict expected failure: in every phase, the only accepted outcome is a call
  that raises exactly `QueueGapError` with the row's gap. The gap must be one of the harness's closed
  list, raised by the harness's own gap probe — the innermost frame of the exception is in
  `queue_harness.py` — and not while another exception was being handled; and it is measured again
  before the report is accepted, so a gap that no longer exists fails the run. The origin test reads
  a file name, so a test body that calls the harness's own raiser satisfies it (§9.1, point 5);
- a `pass` row runs plainly, and a skip or an expected failure of it in any phase fails the run;
- **collection:** a collector under `tests/job_queue/` that is skipped or fails — a module-level
  `pytest.skip`, a failing `pytest.importorskip`, an import error — fails the run by its own sentence,
  in a repository-root run as much as in a run of the directory. Whether the directory was in a run's
  scope is read from the collection reports, not from the items collected: a module that yields no
  test would otherwise silence every row. The directory holds two test files, the acceptance module
  and the self-test; any other test item under it is refused;
- **call reports:** every inventory row must produce a call report. When some do not, the run fails
  if the environment variable `CI` is set, or if the run narrowed nothing — no `-k`, `-m`,
  `--deselect`, `--lf`, `--ff`, no node id or path narrower than the directory, no stop by `-x` or
  `--maxfail`. Otherwise — a developer's `pytest -k something` at the repository root — it prints one
  notice line and does not fail. Both lines name the remedy: run the directory `tests/job_queue`.
  `--collect-only` fails under neither rule.

A pass of an `xfail` row, any other exception, a gap raised by a fixture, a gap raised from a test
body's own frame or relabelled from a failure, a row bound to a gap the harness never raises, a skip,
`pytest.xfail()`, an extra `xfail` or `skip` marker, `--runxfail` and `-p no:skipping` each fail the
run by name.

| Id | Asserts | Kills a process |
|---|---|---|
| `A3-01` | Killed after the desired-state change and before the audit row — and at the job row and at the change itself — nothing is committed, and the job, the change and the steps were written before the audit row; uncrashed, all of it is committed, once | yes |
| `A3-02` | A duplicate idempotency key, sequential or concurrent, returns the original job and repeats no write; a different hash under the same key is refused | no |
| `A3-03` | A live claim renews its lease; a superseded fence cannot step, dispatch, retarget, start a sub-job, close, hold, finish or renew while the current claim holds the job; and an expired lease cannot do any of the eight under the current fence | no |
| `A3-04` | A reservation outlives the database session that claimed it, and an orphaned job keeps its place | yes |
| `A3-05` | A claim takes no live lock while any lock of its set conflicts, and checks every reservation before the first live lock | no |
| `A3-06` | Claims are served in request order, on both lock classes | no |
| `A3-07` | A job waits on its realm job, holds no place meanwhile, and fails `prerequisite_failed` when that failed | no |
| `A3-08` | A process killed mid-step leaves a job the sweep orphans; the next claim takes a higher fence, emits no second `job.started`, and resumes at its first unfinished step | yes |
| `A3-09` | The sweep decides from dispatch records alone — an open dispatch naming an ended sub-job included — and returns every running step to `pending`; the next claim completes only a class `C` step closed `completed`, and audits it | no |
| `A3-10` | A sub-job, keyed by its dispatch and due from the instant it is started, claims with no lock and no reservation only under its running parent's dispatch fence, and the stranding pass reads the same fence | no |
| `A3-11` | An orphaning past `max_attempts` fails the job `orphaned_exhausted` and leaves its steps as they were, but an open dispatch still wins | no |
| `A3-12` | A decision leaves `needs_reconciliation` through `resume` or `fail`, with the step and its audit row, the dispatch closed with the outcome decided — `completed`, `no_effect`, and `failed` for `partial` — the null `dispatch_outcome_at_decision` of a dispatch the decision closed itself, the reservation, the attempt and, for `fail`, the steps left as they were; a runner's hold is audited; a refusal carries its reason, the job's status before the role; the decision waits on the job row, and is refused once another writer moved the job out with a decision of its own; a recorded decision is neither rewritten nor deleted; a job leaves `needs_reconciliation` only on a decision of its own, of its own transaction, not the reference it already carried, mapped to its new status; and a decision row's `decided_txid` is forced and its `decided_at` bounded by the job's latest dispatch and the insert | no |
| `A3-13` | A realm job waits for realm-changing deliveries and for no other. A delivery is not recorded in flight or unresolved without a start, and in either state is neither deleted nor given another identity — column by column while in flight, as a whole while unresolved. It leaves `needs_reconciliation` only on a decision that is for that delivery, inserted in its own transaction, not used for an exit before, decided no earlier than its start, and mapped to its new status, each of the three mappings refusing a wrong one. A decision row has a forced `decided_txid` and `decided_at`, complete evidence in time order, never resumes a partial effect, and is neither rewritten nor deleted. The function checks the status, the role, the evidence, its order and a partial resume itself, returning a reason, the first in the fixed order when two apply, refuses a future start without breaking its caller’s transaction, and moves the delivery through each of its three exits; a recorded decision, `resume` or `fail`, leaves one `outbox_delivery.reconciliation_decided` audit row naming its staff identity, organisation, exit and decision, no refused one leaves any, and a process killed while it writes that row commits nothing of the decision | no |
| `A3-14` | A job finishes `succeeded` only with every step done and no open dispatch, `failed` only with no open dispatch, and with no other status, `finish_job` itself raising for another status and for an error code it never writes; a step's success and its failure are audited, and its output reference recorded, never with `running`, and no error code recorded with `succeeded`, `record_step` itself raising for both, a failed attempt's reference kept in its `job.step_failed` row; a dispatch is not closed without a reference to its terminal proof, and `close_dispatch` itself refuses an outcome outside its closed set | no |
| `A3-15` | A class `C` step is dispatched once per resolution cycle, which a new claim of the orphaned job does not restart, a job holds one open dispatch at a time — each by `record_dispatch` and by `start_sub_job` alike — and only an open dispatch is retargeted | no |
| `A3-16` | A runner write waits on the job row and is refused once the job has left its claim, or once its lease expired while it waited: when the transaction it waited for changed the row, shown through `record_dispatch`, and when it released the row unchanged, shown through each of the eight runner writes | no |
| `A3-17` | A parent's decision waits for its sub-jobs, and says so before it reads the role; a sub-job cannot start an effect under a stopped parent — a step, a dispatch, a retarget, a sub-job of its own — but can report through each of its five other writes: renew, end a step, close its dispatch, hold it and finish; and each of the five terminal writers closes the parent's dispatch with the sub-job's outcome, `completed` only for a sub-job that succeeded, and with the reference to the sub-job as its evidence; the stranding pass leaves the sub-job's steps as they were | no |
| `A3-18` | A job with no `not_before` is due from the instant it was created; a scheduled job that became due is promoted into request order before a later request is served, and not before it is due; a placed job whose `not_before` is moved later is not claimed by id; jobs promoted together share one instant | no |
| `A3-19` | A decision needs a current `staff_operator` grant of the principal's identity, both structured pieces of evidence in time order, and never resumes a partial effect; each refusal carries its reason, and of two defects the first in §3.3's order — role, presence, order, partial resume; the decision table itself refuses a row that resumes a partial effect | no |
| `A3-20` | A runner releases its live locks on demand, a session cannot claim twice on one tenant or organisation, and a cancelled claim keeps no lock | no |
| `A3-21` | Only a `pending` step the kind marks conditional is skipped, never with an output reference, a skipped step is never set `running`, no step is recorded `compensated` or with a status `record_step` never writes, each of those three arguments raising, and a step that is not `running` is recorded neither `succeeded` nor `failed` | no |
| `A3-22` | A parent cannot close or retarget its sub-job's dispatch, finish while the sub-job lives, or be orphaned past it | no |
| `A3-23` | A class `C` step whose sub-job completed it in an earlier resolution cycle runs again after an operator's `no_effect` resume: the decision governs the step, the dispatch keeps its closer's outcome, the decision records both, and it dates itself after a dispatch that closed while it waited for the job row; after a second cycle that ended the same way, the next claim still leaves the step `pending`, its cycle starting at the step's latest `no_effect` resume, and the step starts its sub-job again in each new cycle | no |
| `A3-24` | A scanning claim reads sub-jobs first, then the jobs that hold no place — passing over one still waiting and failing one whose dependency failed — then request order | no |
| `A3-25` | No claim, promotion, sweep or stranding pass waits on a job row another transaction holds — the sweep and the stranding pass pass it over and act once it is released; and a job an uncommitted insert merely references is neither passed over by a claim, the promotion, the sweep or the stranding pass, nor waited for by `renew_lease` or a job's decision | no |
| `A3-26` | A claim reads the reservations before the deliveries, and runs its reservation check again once it holds its live locks: a realm job stopped between its reservation read and its delivery read is refused for a reservation written meanwhile | no |
| `A3-27` | A class `C` step resumed twice with `no_effect` is dispatched again after the second decision, and once only: its resolution cycle starts at its latest such decision, not its first | no |
| `A3-28` | Each of the four effect-starting sub-job writes re-checks its lease after waiting for its parent row, refuses without changing queue or audit records once expired, and succeeds with a live lease on the same fixture | no |
| `A3-29` | Each child effect writer refuses a non-running parent or a dispatch with wrong owner, wrong/missing child association, closed state or stale parent fence, without queue/audit changes; intact positive controls persist all four effects | no |
| `A3-30` | Unsupported actual transaction isolation is refused before queue writes or desired-state callback; READ COMMITTED retains successful enqueue | no |
| `A3-31` | No staff principal is resolved from a customer-lane token, from a customer issuer presented on the staff lane, from a staff token presented on another lane, from a staff token whose `amr` names no second factor, or for a subject with no stored staff identity, for a job's decision or a delivery's; a resolved principal decides a job or a delivery only while its own identity, enabled and not deleted, of a person enabled and not deleted, holds a current `staff_operator` grant — not another identity's, not one revoked after it was resolved — and a job's or a delivery's decision names that identity and, in its audit row, that grant | no |

### 9.1 How a reader can tell each test fails against a broken queue

A strict expected failure proves only that something is missing. What the committed self-test
(`tests/job_queue/test_job_queue_selftest.py`, run by CI) proves:

1. **Two counterexample queues.** `tests/job_queue/counterexamples.py` binds the test interface to two
   broken queues over tables of the same names in a scratch schema. The *permissive* queue commits
   every statement on its own and checks no guard at all; the *inert* queue writes nothing and
   refuses everything. Every acceptance test must fail against both with the exact assertion message
   its inventory row names — never a gap, never another exception.
2. **The named assertion is the one that fails.** For every test, the self-test deletes the one assertion
   the permissive queue is named to fail and re-runs it: it must no longer fail with that message.
3. **Per-property ownership, checked textually and structurally.** `tests/job_queue/mutants.toml`
   names, for each property of §9.3, its owning tests and the single-guard mutants of a conforming
   queue that break it, each with the acceptance test that must catch it and the exact assertion
   message. Every row disables one guard or one clause of a guard, for one writer, with the
   exceptions the table's header lists, each with its reason: a guard read at two sites where
   either site alone is masked by the other; a read a claim makes at both of its checks; one
   statement moved; a function's clause together with the database guard that would refuse what its
   mutant then writes; a check whose clauses are not split yet; a path replaced; and one site that
   several callers reach. The self-test derives two of those lists from the code and fails on a row
   left out of either: the flags read both in the code and in the database, and the flags read at
   more than one place in the code. Beside the paths replaced, the header lists two groups a name
   identifies, the rows that replace a lock mode and the rows that swap two checks; the self-test
   checks those two lists against the rows of that name, and the count of each of the three
   against its list. It says that other rows also substitute and are not listed. The other lists
   are kept by hand, and §9.3 says which site, caller or clause each of their rows leaves
   unprobed. The self-test
   fails when a row's owning test does not exist; when its message is not the literal message of an
   `assert` that test always runs and that can fail it — a statement of its own body, of a `with`
   block, or of a `try` body or `finally`; never of a branch, a loop, an exception handler, an `else`
   or a nested function; never after a `return`, a `raise` or a skip at the same level; never inside
   `suppress(AssertionError)`, `pytest.raises` of it, or a `try` whose handler catches it; when that
   assert's operands are all constants, or a bare fixture; when two tests assert the message, or two
   rows name it; when a property of §9.3 has no row or names no owning test; when a row's test is not
   among its property's owning tests; and when a property names an owning test none of its rows
   uses. Each refusal is shown on a mutated input. This check reads the source; it cannot show that a
   mutant is caught, and a row pointed at a later assertion its mutant never reaches first passes it.
   Nor does it see every way of disarming an assert. It accepts an `if` whose body returns before
   the assert, a test that ends in `or True`, an assignment expression, `suppress` or the fixture
   under another name, a tuple of exception types bound to a name, and a decorator that swallows the
   assertion. No more work is planned on it: each of those forms makes its row's mutant survive,
   and §9.2 is the gate that reports that.
4. **Harness controls.** Each observation the tests rest on is shown to see both outcomes: a kill at a
   table-lock barrier discards an open transaction but not an earlier commit, and the tables the
   killed backend had already written are read correctly in both cases, while a table it only read is
   not reported as written; a killed session's advisory locks match the observer's key arithmetic, for
   negative and positive hashes, and then disappear; a call that never reaches a barrier is reported,
   as a harness error and not as an assertion about the queue; a child's reply to a timed-out request
   never reaches the next call, and a stray line on a child's standard output neither ends its
   replies nor goes unmentioned when a call then times out.
5. **Measured gaps and a strict binding.** The gap names a missing application, module or function,
   and disappears when a synthetic module provides it, for each of the three kinds; a report whose
   gap has been provided is refused. A child run over a disposable copy of the directory shows each
   of these failing the run by its own sentence while the untouched tests stay expected failures: a
   moved gap, a pass, a real failure, a non-assertion exception, a skip, a `skipif` marker,
   `pytest.xfail()`, an extra non-strict `xfail` marker, an `xfail(run=False)` marker (refused as a
   marker of its own, so the `[NOTRUN]` report path is proven by a unit case, not by this run), a
   gap raised by a fixture, a forged `QueueGapError` subclass, a gap forged for the real binding
   only, a failure relabelled as the gap, a row bound to a gap that will never exist, a row
   deselected under `CI`, and a skip and an expected failure in a `pass` row. One forgery is
   accepted, and said here rather than discovered: a test body that calls the harness's own raiser —
   `unwrap`, or `RealBinding().require` — or compiles a `raise` under the harness's file name
   produces a gap whose innermost frame is the harness's, for any gap of the closed list. It hides
   nothing while no row is `xfail`, as since A3 was implemented, because it cannot survive into a
   `pass` row, which nothing excuses; closing it is owed (§9.3). Further child runs show: a module-level skip, a failing `importorskip` and an import
   error, in the acceptance module and in the self-test, each failing a run shaped like CI's
   repository-root run; a narrowed run outside `CI` getting the notice and exit status 0; an
   unnarrowed run with uncalled rows failing, with a stray marked test and a test in a sub-directory
   refused; `--collect-only` with a selection exiting 0 under `CI`; `--runxfail` refused for every
   row; and `-p no:skipping` refused for every row by a sentence, not by an internal error. A real
   collection shows each `xfail` row bound as exactly one strict expected failure on
   `QueueGapError` and each `pass` row bound to none, and a collection of the copy, where every row
   is `xfail` on a gap no tree provides, shows the strict binding for all of them. These child runs
   bind every row of the copy to that absent gap, so they keep proving the binding with every real
   row at `pass`.

6. **Every mutant is caught on the real queue.** For each row of `tests/job_queue/mutants.toml`, the
   runner (`test_every_mutant_flag_is_caught_by_its_owning_test_on_the_real_queue`, one case per
   flag) enables that one flag on `apps.jobs` — a database flag disarms its trigger clause, rewrites
   its `CHECK` or drops its constraint — runs the row's owning test against the real queue, and
   requires it to fail with an `AssertionError` whose first line is the row's message; it then
   restores the database and requires the guards it snapshotted back. Its own proofs show it failing
   a flag that disables nothing, a flag caught with another message, and a database mutant left
   installed. The registered flags are exactly the rows' flags; each is read by a literal
   `mutants.on("<flag>")` in the queue's code or is a database mutant, and `mutants.on` raises for a
   name that is no flag; every `/*guard:<flag>*/` marker of the live guards is a database flag. The
   unflagged queue passes every acceptance test in the same run.

Database mutation recipes, guard snapshots, installers and restore helpers live only in
`tests/job_queue/database_mutants.py`. Runtime `apps.jobs.mutants` exposes the inert flag registry
and permission/refusal API; it does not expose the database machinery. A child-process check and
its exposed-installer mutation prove that boundary. Static import checks cover module-level and
function-local imports from test helpers, and Outbox imports of Jobs except the existing inert
`apps.jobs.mutants` API used by its selectors. Outbox decision writes accept scalar fields supplied
by the Jobs orchestrator, without importing its decision or principal types. These checks do not
claim to detect arbitrary computed imports or establish deployment artifact readiness.

What the committed self-test does not prove: that a guard with no row is present. The runner re-runs
only the rows that exist, so a requirement with no row is one an implementation could leave out.
§9.3's owed list names the ones found so far, each with why it has no row; it is not a proof that
no other requirement is unowned, and says so itself. Its **Not covered by a deterministic test**
list names the two guards of claim check 4 that a test-only pause would reach (§9.2). Nor can the
conftest see a run that never reports a collector from inside the directory: an
`--ignore=tests/job_queue` from a parent directory, when it is not loaded at all, or a
`python_files` pattern or a rename that leaves the directory with no test module, when it is loaded
and told nothing. `tests/test_job_queue_inventory.py`, outside the directory, covers the tracked
half of that: it reads the inventory and the acceptance module's syntax tree without importing
either, and refuses, each on a mutated input, a row count or an identifier that moved, a row whose
function is missing or unmarked, a marked test the inventory does not list, a test module renamed
away, and a `python_files`, `testpaths`, `norecursedirs`, `addopts`, rival configuration file,
`collect_ignore` or `pytest_ignore_collect` visible from the repository root that would keep pytest
out. It does not cover an `--ignore` given on a command line or in `PYTEST_ADDOPTS`, which no
tracked file shows. CI's `Tests` job covers that half: pytest writes a JUnit report, and
`scripts/ci/check-job-queue-rows.py`, with its self-test, requires each inventory row in it
exactly once, under the acceptance module, with the outcome the row's state gives; a skip is not a
call report. It also requires, passed, each row's self-test proofs: its runs against the permissive
and the inert queue, the deletion of its named assertion, and the mutant-row check. A run that never
entered the directory, left a row out, or dropped its proofs fails there. And under a distributed
runner the call-report rule's records would live in each worker while the summary runs on the
controller, so that rule must be revisited before `pytest-xdist` is added, which it is not today.

Two wall-clock sensitivities are worth stating; neither ever gives a false green. Leases are 120
seconds, and the tests never sleep on the host's clock; but a stall longer than a lease between a
claim and the assertions that rely on it being live gives a false red, and in A3-03 it would let the
expired lease, not the fence, refuse the stale writes, which §9.2's gate would report as mutants not
caught. The tightest is A3-16's unchanged-row case: eight leases are shortened to 3 seconds, and the
eight writes must all be waiting on their rows before those leases pass. A runner that stalls longer
than that between the shortening and the last write's first statement has that write refused by its
first predicate, without waiting: a false red by "a runner write did not wait on the job row held past
its lease", and for a mutant a wrong message, which §9.2 reports as not exact. The wait itself is on
the database's clock.

### 9.2 Merge criterion for the implementation

The change that implements A3 MUST, in the same change:

- implement every mutant of `tests/job_queue/mutants.toml` as a committed flag on `apps.jobs` — a
  test-only setting that disables exactly that guard and nothing else;
- add a CI self-test that runs every flag against the real queue, requires each to be caught by its
  owning test with its exact message, and requires the unflagged queue to pass every acceptance test;
- have that CI job assert that `JOB_QUEUE_EXTRA_BINDINGS` is unset, so no binding outside the
  repository stands in for the real queue;
- make the flags impossible to enable in production. Each flag disables a guard of ADR-0004, so a
  flag reachable from production configuration is a standing bypass. The flags MUST NOT be
  enableable under production settings — not from an environment variable, not from a settings
  value, not from any other input the production settings module reads — and the implementation
  ships a check, with its self-test mutation, that production settings refuse every flag of
  `mutants.toml`.

- give every item of §9.3's **Owed by the implementation PR** list a row in `mutants.toml` and an
  owning assertion, or state in that list, item by item, why none can exist. §9.2 re-runs only the
  rows that exist, so a guard with no row is a guard an implementation may leave out: that list is
  what keeps the guards this specification names, and no test owns yet, from being left out;
- keep the CI job that runs the acceptance rows asserting, from outside `tests/job_queue/`, the
  number of inventory rows that produced a call report — thirty-one today. The conftest cannot see
  a run that never enters the directory, and `tests/test_job_queue_inventory.py` cannot see a
  command-line `--ignore` (§9.1). `scripts/ci/check-job-queue-rows.py` does it today; it
  requires the outcome each row's state gives, so a row moved to `pass` must be reported passed.

A mutant no test catches is a missing test, and the implementation does not merge until it has one.

The implementation SHOULD also expose a test-only pause inside a claim, between its live locks and
its second check, absent from production builds and refused under production settings exactly as the
flags are: an in-process pause is not a database privilege, so no role can be what keeps it out.
With it, the two items §9.3 lists as beyond a deterministic test today — check 4 for a tenant job,
and check 4's delivery re-read — each get a row and an owning test in the same change. A3's
implementation does not add it; kodera-core#106 does.

### 9.3 Properties

Each property has at least one row in `tests/job_queue/mutants.toml`, whose `[property]` table names
the property's owning tests; each row names one of these identifiers.

| Id | Property | Section |
|---|---|---|
| `JQ-P01` | The desired-state change, job, steps and audit row commit in one transaction | §4.1 |
| `JQ-P02` | A duplicate key returns the original job; a reused key with another hash is refused | §3.4, §4.1 |
| `JQ-P03` | A superseded fence writes nothing | §4.4 |
| `JQ-P04` | An expired lease writes nothing through any of the eight runner writes, even under the current fence; a lease that expires while a write waits refuses it — when the row changed meanwhile, shown through `record_dispatch`, and when it was released unchanged, through each of the eight | §4.4 |
| `JQ-P05` | A reservation outlives the claiming session; an orphaned job keeps its place | §4.2, §5.2 |
| `JQ-P06` | No claim holds a live lock while a lock of its set conflicts; reservations are checked for the whole set first, before the deliveries, and again once the live locks are held | §4.3 |
| `JQ-P07` | Claims are served in request order on both lock classes | §4.3 |
| `JQ-P08` | A dependency is waited on, holds no place, and a failed one fails the job | §4.2, §5.3 |
| `JQ-P09` | A resumed job continues at its first unfinished step, never re-runs a succeeded one, skips only `pending` conditional steps and never with an output reference, never records `compensated`, ends a step only from `running`, and emits `job.started` once | §3.3, §4.2, §4.4 |
| `JQ-P10` | The sweep decides from dispatch records, never completes a step, and the next claim completes, and audits, only a class `C` step closed `completed` | §4.2, §5.2 |
| `JQ-P11` | A sub-job is keyed by its dispatch and claims only under its running parent's dispatch fence, with no lock or reservation; the stranding pass reads the same fence | §3.4, §4.3, §5.2 |
| `JQ-P12` | The orphan budget fails an exhausted job, after open dispatches are considered, and leaves its steps as they were | §5.2 |
| `JQ-P13` | A decision locks the job row first and reads the status before the role; its exits set the job, step, its audit row, the dispatch and its closing outcome, the record of an outcome the dispatch already carried, reservation, attempt and steps as specified; a runner's hold is audited; a decision row is immutable | §5.4 |
| `JQ-P14` | Realm jobs wait for realm-changing deliveries and no others; a delivery leaves `needs_reconciliation` only through a checked decision of its own, of its own transaction, used once, that maps to its new status, taken under a lock on the delivery row that waits for another writer and not for an uncommitted insert naming it, and audited in the same transaction; a decision row is immutable; and each guard, clause, state and column holds | §4.3, §7 |
| `JQ-P15` | A job finishes only when its steps and dispatches allow it, and only `succeeded` or `failed`; a step's success and its failure are audited, and its output reference recorded with either, never with `running`, a failed attempt's kept in its `job.step_failed` row; a dispatch closes only with an outcome of its closed set, refused by the function itself, and a reference to its terminal proof | §4.4, §6 |
| `JQ-P16` | A class `C` step is dispatched once per cycle, which starts at its latest `no_effect` resume and which a new claim does not restart; one open dispatch per job; `record_dispatch` and `start_sub_job` each hold every one of those rules; retargeting replaces an open dispatch's operation and nothing else | §4.4 |
| `JQ-P17` | A runner write locks the job row first and cannot commit after the job left its claim | §4.4 |
| `JQ-P18` | Sub-jobs block their parent's decision, before its role is read, cannot start effects under a stopped parent or a dispatch with wrong owner, wrong/missing child association, closed state or stale parent fence through any of the four writes that start one, can still report through each of the five that do not, and each of the five terminal writers closes the parent's dispatch with their outcome and the reference to them; the stranding pass leaves the steps of the sub-job it fails as they were | §3.3, §4.4, §5.2, §5.4 |
| `JQ-P19` | A job or a sub-job with no `not_before` is due at creation; a due scheduled job, and only a due one, is promoted into request order, by a claim and by a sweep each, or claimed by id, and jobs promoted together share one instant | §4.1, §5.3 |
| `JQ-P20` | A job's or a delivery's decision needs a grant of the `staff_operator` role, both structured pieces of evidence in time order, and never resumes a partial effect, which the table refuses too; of two defects it names the first in the fixed order | §5.4, §7 |
| `JQ-P21` | Live locks are released on demand, on a cancelled claim, by `finish_job` of a top-level job once it committed, and never stacked by one session | §4.2, §4.3, §4.4 |
| `JQ-P22` | A parent cannot close or retarget its sub-job's dispatch, finish past it, or be orphaned while it lives | §4.4, §5.2 |
| `JQ-P23` | A claim completes a class `C` step only from a dispatch of the current resolution cycle, which starts at the step's latest `no_effect` resume and not at its first; a decision governs the step even against the outcome its dispatch was already closed with, leaves that outcome as its closer wrote it, records both, and reads its `decided_at` once it holds the job row | §4.2, §5.4 |
| `JQ-P24` | A scanning claim reads sub-jobs first, then unplaced jobs, failing one whose dependency failed, then request order | §4.2 |
| `JQ-P25` | No claim, promotion, sweep or stranding pass waits on a held job row; none of them passes over, and none of the eight runner writes nor a job's decision waits for, a row an uncommitted insert references | §4.2, §5.2, §5.3 |
| `JQ-P26` | A live claim's renewal succeeds and moves the lease later | §4.4, §5.1 |
| `JQ-P27` | A job's and a step's specification never change, and no job, step or audit row is deleted; an audit row never changes; a reservation ends once, a dispatch is closed once, and a place in request order is never cleared or moved earlier | §3.2, §6 |
| `JQ-P28` | The job row's status invariants hold in the table itself: a tenant exactly for the tenant kinds, a lease exactly while `leased` or `running`, the unresolved step and operation while in `needs_reconciliation`, an error code exactly when `failed` | §3.1, §3.3 |
| `JQ-P29` | `claim_job`, `sweep_expired_leases` and the eight runner writes refuse a call made inside a transaction its caller opened | §4 |
| `JQ-P30` | A job leaves `needs_reconciliation` only in an update that sets its decision reference to a decision of its own, inserted in the same transaction, not the reference it already carried, and mapped to its new status; a job decision's transaction identifier is forced, and its `decided_at` lies between the job's latest dispatch and its insert | §5.4 |
| `JQ-P31` | A sub-job effect-starting write re-checks its live lease after the parent-row wait | §4.4 |
| `JQ-P32` | Each queue business transaction checks actual READ COMMITTED before queue statements, preserving caller validation, commit boundaries and cleanup | §4 |
| `JQ-P33` | A job's or a delivery's decision is taken only by a staff principal, a stored staff identity resolved from a staff-lane token with a second factor, whose own `staff_operator` grant is current when the decision reads it, and which the decision's audit row names | §4, §5.4, §7 |

**Not covered by a deterministic test**, each for the reason given. None of these has a row: a row no
test can catch proves nothing.

- **Claim check 4 for a tenant job.** A3-26 asserts check 4's reservation re-read on a realm job,
  whose first check reads a table — the deliveries — that a test session can hold against reads. A tenant
  job's claim touches no table between its check 1 and its check 3, and an advisory try-lock never
  waits, so no barrier can pause it there. The one flag, `check4_skips_reservations`, is owned
  through the realm job.
- **Check 4's delivery re-read.** Pausing a claim between its two delivery reads would need a lock on
  a table the claim has not touched yet, and by then it has read every table it reads before it
  writes. Measured locally on PostgreSQL 16: `LOCK TABLE … IN ACCESS EXCLUSIVE MODE NOWAIT` on a
  table the claim's transaction already read is refused, and with a waiting barrier queued behind it
  the claim's second read of that table still returns at once, because a lock a transaction already
  holds is granted again without queueing.
- **The sweep's re-check under its row lock** (§5.2): the status, the fence it read and the expiry,
  read again once the row is held. It matters when a runner renews, or another sweep moves the job,
  between the sweep's read of its candidates and its lock. That window cannot be held open: the
  sweep touches no table between the two that a test session could lock, and `SKIP LOCKED` means a
  held row is passed over, not waited for. Measured locally, on a reference queue this repository
  does not carry: without the re-check it passed all twenty-six tests of that time; no run here
  shows it. The expiry's other site, the read of the candidates, is masked the same way by the
  re-check, which is why the row `sweep_unexpired` disables the expiry at both.
- **A top-level claim refused for a null `lock_requested_at`.** The window is real and opens in normal
  operation — `not_before` passing, or a dependency succeeding, between the promotion's statement and
  the claim's step 1 — but it cannot be held open from outside: every lock that makes the promotion
  pass over the row makes step 1 pass over it too, a table barrier that stops step 1 stops the
  promotion, and nothing runs between the promotion's commit and step 1. Both refusals return
  `not_claimable`, so a reached step 3 could not be told from step 1 either.
- **The resolution cycle's per-step key.** The cycle is bounded by the *step's* latest `resume`
  decision with `no_effect` (§4.4). A queue that read the *job's* latest such decision, on whichever
  step, cannot be told apart through the functions of §4: steps run in order, a job holds one open
  dispatch, and a decision names the step of an open dispatch, so no class `C` step is ever
  `pending` or `running` with a dispatch of its own while another step of the same job is decided.
  The key stays the step, the natural one, and the day a later item lets two steps of one job be
  unresolved in turn it becomes load-bearing; it is on the owed list for that day.
- **The promotion's second reading of the clock** (§5.3). "Due" is measured against the instant the
  statement writes. A queue that read `clock_timestamp()` again places a row at most microseconds
  before its own `not_before`, and only when the executor reads the two in one order: no test can
  make that happen on demand.

**Owed by the implementation PR.** Guards and rules this document states that no assertion of
`tests/job_queue/` owned before A3 was implemented. §9.2 makes the list binding: the change that
implements A3 gives each item a row and an owning assertion, or says here why none can exist, and
each item below now says which. It is the list two adversarial
reviews and the rounds that answered them arrived at, not a proof that nothing else is unowned — the
sentence that once claimed that was false, and is deleted. Whoever finds another unowned requirement
adds it here or gives it a row.

Database guards:

- the row triggers refusing a change of a `Job`'s or a `JobStep`'s specification, and the deletion of
  either row (§3.2): **owned**, one row per column and per deletion, all by A3-01 —
  `job_spec_mutable_<column>` for the thirteen columns, `job_delete_allowed`,
  `step_spec_mutable_<column>` for the seven, `step_delete_allowed`;
- the audit table's trigger refusing `UPDATE` and `DELETE` (§6): **owned**, `audit_update_allowed`
  and `audit_delete_allowed`, by A3-01;
- a closed dispatch carrying a reference to its terminal proof (§4.4): `close_dispatch`'s refusal
  of an empty or blank reference is **owned**, `close_accepts_blank_evidence`, by A3-14. The table
  itself has **no row in A3**: a `CHECK` requiring a non-blank `terminal_evidence_ref` on a closed
  dispatch would refuse by an error what the four `*_closes_without_evidence_ref` rows of A3-17 must
  catch at an assertion, and mask them; owed with a two-site row for each;
- the delivery decision's insert trigger reading its delivery's status under a row lock (§7): **no
  row in A3**, and the read takes no lock. A3-13 races a decision against a transaction that moves
  the delivery out, and `delivery_decide_without_row_lock`, the function reading the status without
  its row lock, must lose that race at an assertion; a trigger that locked the row would refuse it by
  an error first and mask that row. The deciding function locks the row before its insert, so only an
  insert made outside it can race; the row it leaves moves no delivery. Owed to the item that writes
  decisions outside that function, with a two-site row for the pair;
- the three `CHECK`s on `Job`: `tenant_id` null exactly for the two realm kinds (§3.1);
  `lease_expires_at` non-null exactly while `leased` or `running`; and the two `unresolved_*`
  columns non-null in `needs_reconciliation` (§3.3); and `error_code` non-null exactly when `failed`:
  **owned**, one row per named `CHECK`, each dropped by its mutant — `jobs_job_tenant_null_for_realm_kinds`
  and `jobs_job_tenant_set_for_tenant_kinds` by A3-13, `jobs_job_lease_while_claimed`,
  `jobs_job_no_lease_unless_claimed`, `jobs_job_error_code_when_failed` and
  `jobs_job_no_error_code_unless_failed` by A3-14, `jobs_job_unresolved_step_when_reconciling` and
  `jobs_job_unresolved_operation_when_reconciling` by A3-12;
- the columns written once (§3.2, §5.3): **owned**, one row per clause of the write-once triggers —
  `reservation_end_rewritable`, `dispatch_closed_at_rewritable`, `dispatch_outcome_rewritable` and
  `dispatch_evidence_rewritable` by A3-14, `place_may_be_cleared` and `place_may_move_earlier` by
  A3-18. `Job.not_before` has **no row, and none can exist**: a trigger on it would refuse the
  test-session writes this section's table promises (`make_due`, `defer`), and "no function of §4
  writes it after creation" is the absence of a writer, not a guard a single mutant could disable;
- the 5-minute tolerance of the insert trigger `outbox_deliverydecision_valid` (§7): **owned**,
  `decision_trigger_no_start_tolerance` and `decision_trigger_no_future_tolerance`, by A3-13, whose
  test session inserts a decision row within each tolerance and requires it accepted;
- the freeze of a delivery column by column while it is *unresolved*: A3-13 now probes the four
  columns one by one in both states. **No row of its own**: the freeze is one state clause and one
  column clause per column, each shared by both states and each already owned
  (`freeze_skips_<column>` in flight, `freeze_in_flight_only` unresolved); a mutant per state and per
  column would not be the deletion of one guard of this trigger;
- `TRUNCATE` refused by privilege (§3.2): **no row in A3**. It is a statement about grants no check
  verifies, and tests run as a superuser. Its owner is the provisioning of the production role,
  which does not exist in this repository, and the check belongs with it. The same holds for
  ownership: a role that owns these tables can disable or drop every trigger this document relies
  on, so each immutability claim here, `THREAT_MODEL.md`'s repudiation row among them, holds only
  while the runtime role owns none of them, and no check verifies that either.

Locks and transactions:

- `FOR NO KEY UPDATE` for the seven runner writes other than `renew_lease`: **owned** by A3-25,
  which sends each under a live claim while its session holds the job row `FOR KEY SHARE` —
  `step_locks_for_update`, `dispatch_locks_for_update`, `retarget_locks_for_update`,
  `subjob_start_locks_for_update`, `close_locks_for_update`, `hold_locks_for_update`,
  `finish_locks_for_update`; and the mode and the wait of
  `record_delivery_reconciliation_decision`'s lock on the delivery row: **owned** by A3-13 —
  `delivery_decide_locks_for_update` (a session holding the row `FOR KEY SHARE` is not waited for)
  and `delivery_decide_without_row_lock` (a decision waits for a writer that moves the delivery out
  with a decision of its own, then is refused);
- the post-lock lease re-check is owned for all eight runner writes, on a row released unchanged;
  only `record_dispatch` is probed against a row that *changed* while it waited. **No row for the
  seven others**: when the blocker changed the row, PostgreSQL re-evaluates the first statement's
  predicate itself, so the changed-row case exercises the one shared predicate builder, whose clock
  `lease_uses_now` already owns, not a per-writer guard;
- a sub-job's parent check, writer by writer (§4.4): **owned** by A3-17, one row per writer, as
  the other clauses of a runner write's lock condition are. Under a parent swept to
  `needs_reconciliation`, the four writes that start an effect are each refused —
  `subjob_writes_ignore_parent` (`record_step` to `running`), `dispatch_ignores_parent`,
  `retarget_ignores_parent`, `subjob_start_ignores_parent` — and the five reports are each
  accepted — `subjob_reports_need_parent` (`record_step`'s three reports, probed with
  `succeeded`), `renew_needs_parent`, `close_needs_parent`, `hold_needs_parent`,
  `finish_needs_parent`;
- the rules of a dispatch through `start_sub_job` (§4.4), which records one as `record_dispatch`
  does: **owned**, one row per rule — `subjob_start_second_open_dispatch`,
  `subjob_start_class_c_unlimited` and `subjob_start_class_c_cycle_restarts_at_claim` by A3-15,
  `subjob_start_class_c_never_again` and `subjob_start_cycle_from_first_resume` by A3-23. Before
  these rows one flag per rule covered both writers and only `record_dispatch` was probed;
- the promotion committed first by a claim and by a sweep (§5.3): **owned**, one row per function,
  by A3-18 — `claim_skips_promotion` and `no_promotion`, which is now the sweep's alone. The four
  clauses of the statement itself are one site, whichever function commits it;
- `finish_job` releasing the session's live locks after its commit (§4.4): **owned**,
  `finish_keeps_live_locks`, by A3-14, which reads the runner session's advisory locks once a
  top-level job finished `failed`; A3-06 still shows it for `finish_job(succeeded)`;
- `claim_job`, `sweep_expired_leases` and the runner writes refusing to run inside an open
  transaction (§4): they raise `TransactionManagementError`; **owned** by A3-20, one row per
  function — `claim_inside_transaction_allowed`, `sweep_inside_transaction_allowed` and
  `<writer>_inside_transaction_allowed` for `renew`, `step`, `dispatch`, `retarget`,
  `subjob_start`, `close`, `hold` and `finish`;
- the decision functions and `enqueue_job` called under a caller's transaction (§4.1, §5.4):
  asserted — A3-01 enqueues inside a caller's transaction and requires the change, the job and the
  probe committed with it; A3-12 has a decision refused inside one and requires that nothing was
  written once the caller committed. **No row**: the savepoint is Django's `atomic` nesting, and a
  mutant would have to replace it by a second connection — a rewrite, not the deletion of a guard.

Decisions:

- the order of refusal reasons in `record_delivery_reconciliation_decision` (§7): **owned** by
  A3-13, pair by pair as the job function's is by A3-19 — `delivery_evidence_checked_before_role`,
  `delivery_order_checked_before_presence`, `delivery_partial_checked_before_order`;
- whether `role_missing` should be decided before the row lock: **decided**, the status first,
  under the lock, then the role (§5.4). A principal without the role waits on a held job row before
  it is refused, which is the price of naming the status first. Pinned by the rows that already own
  that order, `role_checked_before_status` (A3-12) and `role_checked_before_subjobs` (A3-17);
- binding `staff_operator` to the staff realm (§4): **owned**, by A3-31, `JQ-P33`. The decision's
  grant read has seven clauses, each a row of A3-31 for each decision function but the role's: the
  grant's identity (`role_of_any_identity`, `delivery_role_of_any_identity`), its revocation
  (`revoked_role_decides`, `delivery_revoked_role_decides`), the identity enabled and not deleted
  and the person enabled and not deleted (`disabled_staff_identity_decides`,
  `deleted_staff_identity_decides`, `disabled_staff_person_decides`, `deleted_staff_person_decides`
  and their `delivery_` counterparts), probed through principals resolved before the change; and
  the grant's role, which `any_role` (A3-19) and `delivery_decision_ignores_role` (A3-13) disable
  alone. The grant named in the job decision's audit row is `decision_audit_omits_staff_grant`'s.
  The `FOR SHARE` lock has **no row**: no A3 test holds a decision open across another session's
  revocation. It is owned instead by the two-session tests of `tests/test_staff_principal.py`. The resolver's own refusals — lane,
  the staff issuer, second factor, stored staff identity — are asserted by A3-31 through the harness and
  have **no row**: the resolver is `apps.identity`'s, which reads no queue flag. Each is owned
  instead by `tests/test_staff_principal.py`, which runs the resolver's source with that one clause
  deleted and requires its own refusal case to fail. The decision functions' `TypeError` for an
  object the resolver did not build has no row either, as the other programming errors below: it is
  unit-tested in the same module, and the grant read refuses such an object's identity anyway unless
  it holds a current grant;
- the job path's database guards against the delivery path's (§7): **owned**, both added (§5.4),
  by A3-12 — `job_exit_unguarded`, `job_exit_any_transaction`, `job_exit_accepts_other_job`,
  `job_exit_reuses_reference`, `job_exit_resume_unbound`, `job_exit_fail_unbound`,
  `job_decided_txid_not_forced`, `job_decided_at_future` and `job_decided_at_before_dispatch`. The
  insert trigger validates `decided_at` within the job's latest dispatch and the insert instead of
  forcing it, which would overwrite the function's under-lock read and hide `decided_at_before_lock`;
- the delivery function's `no_effect` and `fail` exits (§7): **owned** by A3-13, which calls all
  three exits through the function — `delivery_decide_no_effect_maps_succeeded` and
  `delivery_decide_fail_maps_pending`, two substitutions of the exit's mapping, listed as such in
  `mutants.toml`'s header. The audit row of a delivery's reconciliation decision (§7): **owned**,
  `delivery_decision_unaudited` and, for its transaction, `delivery_decision_audit_second_txn`
  (a process killed while it writes the row) by A3-13, and the grant it names,
  `delivery_decision_audit_omits_staff_grant`, by A3-31;
- the steps of a sub-job the stranding pass fails, left as they were (§3.3): **owned**,
  `stranding_resets_steps`, by A3-17, whose stranded sub-job keeps the step it reported succeeded
  while orphaned; the sweep's and the `fail` decision's were owned already;
- the resolution cycle's per-step key: **no row**, for the reason under "Not covered" above —
  unreachable through §4 while a job holds one open dispatch. The item that makes it reachable
  gives it a row;
- a class `C` step's cycle kept across a new claim: **owned**, `class_c_cycle_restarts_at_claim`,
  by A3-15, which dispatches a class `C` step, closes it `no_effect`, lets the lease expire, claims
  the orphaned job again and requires `record_dispatch` of that step refused.

Functions and records:

- `finish_job(succeeded)` on a sub-job closing the parent's dispatch with the reference to it
  (§3.3): asserted by A3-17. **No row of its own**: the parent-dispatch close is one call for both
  of `finish_job`'s paths, and its flag `finish_closes_without_evidence_ref` is owned on the
  `failed` path;
- `record_step` given an `output_ref` with `running` or `skipped`: raises `ValueError` (§4.4), **owned** —
  `output_ref_accepted_with_running` by A3-14 and `output_ref_accepted_with_skipped` by A3-21; a
  step that failed, ran again and succeeded keeps the failed attempt's reference in its
  `job.step_failed` row, **owned**, `step_failed_audit_drops_output_ref`, by A3-14; and a `skipped`
  step is never set `running` (§4.4), **owned**, `run_skipped_step`, by A3-21. `compensated` set
  `running` has **no row**: no function of A3 writes `compensated`, so no test can reach a
  `compensated` step through §4;
- `record_step` ending a step only from `running` (§4.4): **owned**, `step_ends_from_any_status`,
  by A3-21, which sends `succeeded` and then `failed` for a step still `pending` and requires each
  refused and the step unchanged. One clause serves both statuses, so one row; its message is the
  `succeeded` one. Before this row the two lines could be deleted and the suite stayed green;
- `close_dispatch` raising `ValueError` for an outcome outside its closed set (§4.4): **owned**,
  `close_accepts_any_outcome`, by A3-14, which sends `partial` and reads what the call raised: the
  function's own `ValueError`, not the error of the table's `CHECK`
  `jobs_jobdispatch_terminal_outcome_valid`, which refuses the same value once the function does
  not;
- `finish_job` refusing a status other than `succeeded` or `failed` (§4.4): **owned**,
  `finish_accepts_any_status`, by A3-14, which sends `cancelled` — a status of the enum, which no
  `CHECK` of the table would refuse — once nothing else stands between the claim and a finish, and
  requires the function's own `ValueError` and the job unchanged;
- the other arguments `record_step` and `finish_job` never accept (§4.4), each raising `ValueError`
  before any statement: **owned**, each by a row that reads what the call raised, as
  `close_accepts_any_outcome` does — `step_accepts_unknown_status` by A3-21, which sends
  `cancelled` for a running step; `step_error_code_without_failed` by A3-14, an `error_code` with
  `succeeded` and with `running`; `finish_succeeded_with_error_code` by A3-14, an `error_code`
  with `succeeded`; and `finish_error_code_outside_set` by A3-14, `failed` with an unknown code and
  with none. With its flag set, `step_accepts_unknown_status` would meet the `CHECK`
  `jobs_jobstep_status_valid`;
  `finish_succeeded_with_error_code` would meet `jobs_job_no_error_code_unless_failed`; and
  `finish_error_code_outside_set` would meet `jobs_job_error_code_valid` for an unknown code and
  `jobs_job_error_code_when_failed` for none. That is why each of these rows reads the function's
  own error, not only that the call failed. `step_error_code_without_failed` meets no `CHECK`: the
  step would be recorded `succeeded` carrying the code;
- the other programming errors a function refuses before any statement: a decision whose `exit` or
  `operation_outcome` is outside its closed set, raising `ValueError` from either decision function
  (§4); and a kind the registry of §3.5 does not hold, which `enqueue_job` and `start_sub_job` each
  raise `ValueError` for. **No row, and no assertion sends such a value.** Each of these values is
  refused a second time by a named `CHECK` of the table it would reach — the two decision tables'
  `_exit_valid` and `_operation_outcome_valid`, `jobs_job_kind_valid` — so what is unowned is that
  the function refuses it first and in the way §4 says, not that the value is kept out. A row for
  each reads what the call raised, as `close_accepts_any_outcome` does; owed;
- `not_claimable` covering four causes (§4): **one reason, kept**. Every cause asks the caller for
  the same thing — try later, and a scan moves on — and "Not covered" above shows a refusal at step
  3 cannot be told from one at step 1 by any test;
- the pinned inputs of the idempotency key (§3.4) — the method's case, the path's form,
  `scheduled_for`'s spelling, `n` and `seq` as `int`s: the type check ships in `keys.py`, where a
  key part that is not a `str`, an `int` itself — never a `bool` or another `int` subclass — or a
  `UUID` raises `TypeError`, unit-tested in `tests/test_job_queue_kinds.py`. **No row**: no function
  of §4 derives a key with `n` or `seq` in A3, and the other inputs' tests belong to the change that
  adds the first handler and the first scheduler;
- what the queue's audit rows carry beyond `action`, `job_id` and the actor's type (§6), and
  `Job.runner_id`, `JobLockReservation.reserved_at` and the 120 seconds of a lease: asserted — A3-01
  reads `job.created`'s `target_urn`, `retention_class` and `actor_label`, A3-09
  `job.reconciliation_required`'s metadata, A3-03 a claim's lease within 120 seconds ± 5, A3-04
  `reserved_at` between the job's creation and the read, A3-02 the claiming runner's `runner_id`.
  **No row**: each is a value one statement writes, not a guard a mutant could disable. The label is
  `system` or the identity's URN, not yet `AUDIT_TAXONOMY.md` §4's pseudonym, which needs the
  pepper the audit item brings.

Rows that act at more than one site or on more than one clause. The header of `mutants.toml` lists
every row that acts at more than one site or for more than one caller, and the rows known to cover
several clauses of one check; this is what each leaves unowned, and why:

- **a claim's reads at check 1, alone.** `no_reservation_check`, `no_delivery_check`,
  `delivery_in_flight_only` and `delivery_check_ignores_changes_realm` each disable one read, or one
  clause of it, at check 1 and at check 4, because their owning tests read that the claim is
  refused, which either check alone still does. Check 4's reservation read alone is **owned**,
  `check4_skips_reservations`, by A3-26, and check 4's delivery read alone is under "Not covered"
  above. Check 1's two reads alone have **no row**. Measured on this queue with check 4 left
  whole: without check 1's reservation read, A3-05 fails at "the claim reached a live lock before
  checking every reservation of its set" and A3-26 at "a realm job's claim reached its delivery
  read before it had read the reservations"; without check 1's delivery read, A3-26 fails at "a
  realm job's claim never waited at its read of the organisation's deliveries". So each is seen,
  but at an assertion another row owns or no row names, and a message has one row. A row for each
  needs an assertion of its own that tells a missing check 1 from the mutants those assertions
  already own. Owed;
- **the fields of a decision's evidence, in the two functions.** The job function's presence check
  has `decide_either_evidence`, probed with a blank `compute_terminated.provider`, and
  `structured_evidence_unchecked`, which keeps each piece's provider and drops its `resource_id`
  and `request_id` and is probed on `target_read.resource_id` alone. The delivery function's has
  `delivery_decision_ignores_compute` and `delivery_decision_ignores_target`, one piece of three
  fields each, probed on `compute_terminated.request_id` and on `target_read.resource_id`. **No row
  per field** in either function: the delivery decision table's `CHECK` has one per column, six,
  and the functions are owed the same, with a refused decision per field;
- **the two tolerances of a decision's time order, in the two functions.** `no_clock_tolerance` and
  `delivery_no_clock_tolerance` each remove the 5 minutes from both comparisons, the start and the
  decision, and one probe needs both. **No row per comparison**: each accepted probe is a decision
  that takes its subject out of `needs_reconciliation`, so a probe per tolerance needs a subject
  per probe; the insert trigger's two tolerances have a row each. Owed;
- **`no_dedupe` through `start_sub_job`.** The insert that claims the key is one statement for
  `enqueue_job` and `start_sub_job`. **No row for the second, and none can exist**: a sub-job's key
  is derived from the dispatch the same call records (§3.4), so no function of §4 can make
  `start_sub_job` meet a key that exists;
- **a sub-job's claim through step 5 of §4.2.** The update, the class `C` completion, the attempt
  and `job.started` are one function for a top-level job and for a sub-job, and its seven rows are
  probed through top-level jobs. **No row per kind of job**: there is one site, and a mutant of the
  sub-job's path alone would be a second implementation of the step, not the deletion of a guard;
- `delivery_decide_any_status` disabled the status condition and the row lock of the delivery
  decision's first statement together. It now keeps the lock and drops the status alone; the lock
  alone was and is `delivery_decide_without_row_lock`'s row.

The harness:

- a gap forged through the harness's own raiser (§9.1, point 5): **no row**, harness integrity, not
  a queue guard. No row is `xfail` once A3 is implemented, so a forged gap has nothing to hide. The
  close the reviewer proposed — the actor core stamps a token on a gap it measured, and the verdict
  checks the token instead of a file name — is owed to the next item that adds an `xfail` row;
- the conftest's exit status when a row produced no call report: **fixed** before A3's
  implementation. It sets the status to 1 only over a status of 0 or 5, so an interrupted run's 2,
  an internal error's 3 and a usage error's 4 are kept. **No row**: harness, not a queue guard.

The sub-job parent wait is owned by A3-28, one row per effect-starting writer:
`step_no_recheck_after_parent`, `dispatch_no_recheck_after_parent`,
`retarget_no_recheck_after_parent`, and `subjob_start_no_recheck_after_parent`.
The existing child-row lease check still applies to every runner write. Once the parent row
is held and its dispatch checked, each effect-starting write reads the child lease against
`clock_timestamp()` again before writing. Reports retain their existing parent-independent rule.
A3-28 holds four parent rows unchanged, observes each child's row-lock wait while its lease
is still live, waits on the database clock for expiry, then releases the parents. It asserts
all four refusals and no queue/audit changes, and allows all four on the same fixtures with
live leases. This does not certify a later external operation's lease or ownership.
A3-29 independently owns the shared parent-status predicate and the dispatch owner, child,
open-state and current-fence predicates through five `parent_write_ignores_*` rows. Each case
prepares all four effect writers with live claims, changes exactly one predicate with intact
schema guards, and observes their refusals before checking complete queue/audit equality.
Four fresh intact controls observe the actual persisted effects. Missing association uses a
retained dispatch naming another job or NULL; no physical deletion or missing-parent FK
corruption is claimed. A3-17 still owns per-writer parent routing/reporting and A3-28 owns
lease expiry after parent wait. These proofs do not settle broader claim/stranding debt,
lock ownership, migration compatibility, staff identity or deployment readiness in issue #112.

### 9.4 Running them

```sh
make test-db
DATABASE_URL=postgres://kodera:kodera@127.0.0.1:5434/kodera_server uv run pytest tests/job_queue
```

Run the directory. CI's `Tests` job runs it with the rest of the suite, where `CI` is set and any
row without a call report fails the run. On a developer's machine a run narrowed by `-k`, `-m`,
`--deselect`, `--lf`, `--ff`, a node id or a path inside the directory, or stopped by `-x` or
`--maxfail`, prints a notice naming the rows it did not call and does not fail for them: a
repository-root `pytest -k test_runtime` exits 0. In CI the same narrowing, on the command line or
in `PYTEST_ADDOPTS`, fails the row check that reads the job's JUnit report (§9.1). A run that
narrows nothing and still leaves a row uncalled fails, and so does any run in which a module of the
directory is skipped or broken at collection. `--collect-only` never fails for either reason.
[`../dev/TESTING.md`](../dev/TESTING.md) §5.1 says the same for whoever meets the notice first.

## 10. Recorded tensions

- `MODEL.md` §1 listed `Job` and `JobStep` among rows that are never mutated, while ADR-0004 gives a
  job a status, a lease and a fence that change. §3.2 states the split, and MODEL.md §1 now says the
  same.
- The delivery table lists `Job`, `JobStep` and `AuditEvent` under A4. The lead ruled that A3 owns the
  job records and creates `AuditEvent` with every non-chain column, and A4 keeps `Tenant` and `Order`.
- `JOB_CATALOGUE.md` §1 cites `CommandDispatch` and `CommandTerminal` of the Proposed
  `ENVIRONMENT_ALLOCATION.md` as the dispatch records of an Accepted decision. A3's `JobDispatch`
  carries the rule without the Proposed receipt machinery (§2).

## Changelog

- Records the pilot realm requeue's immediate-predecessor key and the already ratified PC-1
  command-only staff constructor. The queue protocol and decision checks are unchanged.

- First version: the records, service functions, claim checks, sweep and reconciliation exits of
  accepted ADR-0004 for work item A3, with thirteen acceptance tests held as strict expected failures
  and proven against two counterexample queues.
- Review round one. Every runner write locks the job row first under its lease and fence conditions,
  at `READ COMMITTED`, with `clock_timestamp()`, and the sweep re-checks under the same lock. Sub-jobs
  block their parent's decision, cannot write under a stopped parent, never enter request order, close
  their parent's dispatch when they end, and are failed `parent_not_running` when stranded. A delivery
  leaves `needs_reconciliation` only through a recorded decision, guarded by a trigger. Claims lock
  their own row, refuse reentrancy and release live locks in a `finally`; `release_live_locks` is
  added; `close_dispatch` is fenced; `finish_job(failed)` waits for open dispatches and sub-jobs. One
  promotion statement writes `lock_requested_at`. A decision needs `staff_operator`, structured
  evidence in time order, and fails any partial effect. A class `C` step is dispatched once per
  resolution cycle, one dispatch is open per job, and a step closed `completed` is not re-run. Physical
  names are pinned; the idempotency key includes the kind and an ordinal; `AuditEvent` gets every
  non-chain column; `OutboxDelivery` moves to `apps.outbox`. Seven tests are added, the property list
  and its mutant table become CI-checked, and the implementation's merge criterion is stated.
- Review round two. A parent cannot close its sub-job's dispatch or finish while the sub-job lives,
  and the sweep counts any non-terminal sub-job as open. The sweep never completes a step; only the
  next claim completes a class `C` step closed `completed` in its cycle, and a state-file look and its
  apply share one dispatch through `retarget_dispatch`. Every terminal writer of a sub-job closes the
  parent's dispatch with its outcome, and only effect-starting sub-job writes need a running parent;
  the sub-job key derives from its dispatch. The promotion takes `not_before IS NULL`, locks what it
  promotes `SKIP LOCKED`, and a top-level claim needs a place. Decisions lock their row first and take
  a verified principal, with a 5-minute tolerance on provider clocks; the bound on a parent blocked by
  a sub-job in reconciliation and the evidence for a sub-job dispatch are stated. Delivery guards
  refuse deletion and changes of identity while in flight or unresolved, and check decisions on
  insert. A3 enqueues no compensation, and the change adding that kind amends §5.2 and §5.4. The
  test-session writes are listed. Two tests are added; `pass` rows, missing call reports and
  provided gaps are refused; the mutant check requires direct, non-constant asserts, unique messages
  and property ownership; §9.2 requires committed mutant flags run in CI without extra bindings.
- Review round three. `not_before` is not null: `None` means the creating transaction's clock, and the
  promotion has no null arm. The claim's class `C` completion reads the current cycle, which a
  sub-job's terminal write under a held parent makes reachable, and a decision that contradicts a
  dispatch already closed governs the step while the dispatch keeps its closer's outcome and the
  decision records both. "Inserted in the same transaction" is a trigger-forced `decided_txid`, not
  `xmin`; a delivery in flight or unresolved has a non-null, frozen `started_at`; and its exit must be
  the one its decision maps to. Scan mode is defined: sub-jobs first, then unplaced rows, so a
  dependency-failed job is read and failed, then request order. A runner write re-checks its lease
  once it holds the row. Check 4 re-runs all of check 1, reservations before deliveries. Job rows are
  locked `FOR NO KEY UPDATE`, and the promotion reads one instant per statement. Keys hash a canonical
  JSON array. Decisions return a refusal with its reason and may run inside a caller's transaction.
  Step success and failure are audited by all three writers, and `record_step` writes `output_ref`.
  `retarget_dispatch` refuses a sub-job's dispatch; `skipped` is a report; `compensated` has no writer
  in A3, and dispatching a compensation effect is owed with running one. `TRUNCATE` is refused by
  privilege. Mutant flags must be impossible to enable in production. The sub-job evidence rule moves
  to `JOB_CATALOGUE.md` §1, and the queue says what it does not check. Four tests are added — the
  current cycle, scan mode, never waiting on a held row, and check 4, which a realm job makes
  deterministic — and the table has one row per guard or clause, none compound. A module that yields
  no test fails the run; the call-report rule fails under `CI` or in an unnarrowed run and otherwise
  gives a notice; a gap is accepted only from the harness's probe and its closed list; and the
  structural check refuses asserts that never run, cannot fail, or read nothing.
- Review round four. Both reconciliation-decision tables refuse `UPDATE` and `DELETE` by a named row
  trigger and carry a `CHECK` that a `partial` outcome only fails; the delivery decision's insert
  trigger forces `decided_at` as it forces `decided_txid`, and the exit trigger's
  `decided_at >= started_at` keeps an owner in a delivery whose start lies ahead of the database
  clock. The exit trigger binds each of the three mappings, requires the decision to be for the
  delivery that leaves, and its reference clause is shown not to be implied by the transaction
  clause. The resolution cycle has one definition, a dispatch's `dispatched_at` against a
  `decided_at` read under the job-row lock. The promotion measures "due" against the instant it
  writes. A decision closes its dispatch `failed` for `partial`; a sub-job's closers record the
  reference to it; claim step 1's `not_before` clause is kept for a later item's backoff and tested.
  The idempotency key's inputs are pinned; a decision outside its closed sets raises; the functions
  that must not run inside a transaction are named. The sentence claiming every other requirement
  had an owning assertion is deleted, and §9.3 lists what is owed instead, which §9.2 makes binding,
  with a count of the rows asserted from outside the directory. Rows are added for every guard this
  round adds or changes and for the survivors of the round-three review; whole-guard rows that hid
  a state or a mapping are split; the post-lock re-check is probed through all eight runner writes;
  `no_check4` becomes `check4_skips_reservations`. An inventory test outside the directory refuses
  a configuration that would keep pytest out of it; `-p no:skipping` ends in a sentence; and §9.1
  says which forms the structural check and the gap-origin test cannot see.
- Claims narrowed to what the assertions and the runs in this repository show. The tests check the
  rules rather than prove them, and §9's column says what each asserts; the first entry above means
  the tests fail against the two counterexample queues, not that they are proven. A3-19 and `JQ-P20`
  no longer claim a verified principal, which no test presents unverified (§3); A3-17 and `JQ-P18`
  no longer claim the sub-job reference from `finish_job(succeeded)`, which is added to the owed
  list. The sweep re-check's measurement is labelled local, on a reference queue this repository
  does not carry, and mutant rows name the test that must catch them, not one that owns a catch.
- A3-27 added: a class `C` step resumed twice with `no_effect` is dispatched once in the cycle its
  second decision opens. A queue that bounded the cycle by the step's first such decision would
  keep the second cycle's dispatch in the current one and refuse the third; the mutant row
  `cycle_from_first_resume` names the assertion that must catch it. Two class `C` steps in one job
  stay on the owed list, unreachable through the functions of §4. The inventory now holds
  twenty-seven rows; the sweep re-check's local measurement is kept at the twenty-six tests it
  was taken against.
- The collection false green is closed in CI. A run that never enters `tests/job_queue/` because of
  an `--ignore`, a `-k` or a `--deselect` on the command line or in `PYTEST_ADDOPTS` exited 0: the
  conftest cannot see it and the inventory test reads tracked files only. CI's `Tests` job now
  writes a JUnit report, and `scripts/ci/check-job-queue-rows.py`, proved able to fail by its
  self-test, requires every inventory row in it once, with the outcome its state gives, and each
  row's self-test proofs passed. §9.1 and §9.2 say so; §9.2 keeps the count as a duty of the
  implementation's CI job.
- Review round five. The row check's self-test built each case's root from its label, so every
  failing case passed on a missing file: each case now names its fixture and the sentence it
  expects. The check also requires each row's self-test proofs, passed, and reads a failure or an
  error before a skip. A3-23 reads the sub-job's dispatch while the parent's row is held; A3-25
  asserts the renewal it sends succeeds; A3-12's decisions on a job outside reconciliation go
  through `try_call`, so a queue that raises fails at the named assertion, not in the harness. The
  promotion's tie is an `id` order, not a creation order (ADR-0009). `finish_job`'s lock release and
  a class `C` cycle kept across a new claim join the owed list.
- Verification at `bc06c92`. Three owed items are recorded instead of left implicit: the staff
  realm binding of `staff_operator`, which `StaffPrincipal` cannot carry (§4); the job path's
  missing insert and exit triggers, which the delivery path has (§7); and trigger removal by a table
  owner, beside `TRUNCATE`'s grant. The conftest's exit status on an interrupted run joins the
  harness's owed list, and the harness's staff principal no longer claims to be what token
  verification would build.
- Implementation (A3). The queue is implemented in `apps.jobs`, `apps.outbox` and `apps.audit`; every
  acceptance row is `pass`, and the status line says so while the specification's acceptance stays
  its owner's call. §9.2's gate is in place: every flag of `mutants.toml` is committed on
  `apps.jobs`, production settings refuse every one, and §9.1's new point 6 says what the runner that
  CI runs over them proves, and what it cannot: a guard with no row. The job path gains the delivery
  path's insert and exit triggers (§5.4: `decided_txid`, `jobs_jobreconciliationdecision_valid`,
  `jobs_job_reconciliation_exit`), and the decision's exit update sets its reference itself. §3.1
  pins the constraint, trigger and index names, which MODEL.md §8 lists. §3.4 says what the key
  function checks and what it cannot tell; §4.2 says where a refused claim unlocks. §7 says the delivery decision's insert trigger reads
  the status without a row lock, and §9.3 why. `close_dispatch` refuses a blank proof reference
  (§4.4, `JQ-P15`). §3.2's table names the
  direct writes the new rows make; §4 names the `TransactionManagementError` a function refuses a
  caller's transaction with; §4.4 refuses `skipped` and `compensated` steps set `running` and an
  `output_ref` given with `running` or `skipped`. §9.3 adds `JQ-P27` to `JQ-P30`, widens the
  properties the new rows own, and gives every owed item its row or its reason. §9.2's optional
  test-only pause is not added; kodera-core#106 tracks it.
- Fix round after three reviews of the implementation. The queue's three applications leave
  `config.settings.persistence` for a profile of their own, `config.settings.job_queue`, which the
  API image's profiles do not load, and a gate starts those profiles on the image's files alone
  (§3.1). The one flag that covered both the claim's resolution cycle and the dispatch check
  becomes two, and A3-23 closes a dispatch `completed` between two `no_effect` resumes of one step.
  A sub-job's parent check has a row per write, nine, each probed by A3-17. The rules of a dispatch
  through `start_sub_job`, and the promotion a claim commits, get rows of their own, and
  `delivery_decide_any_status` keeps the row lock. The header of `mutants.toml` lists every row
  that acts at more than one site, for more than one writer or on several clauses, with two of its
  lists derived from the code, and §9.3 says what each of those rows leaves unowned. Three rules no
  test sent a value against are owned — a step ended from `pending`, a dispatch closed with an
  outcome outside its set, a job finished with another status — and the rest of that class is
  listed as owed. §9.1 no longer says the owed list names every unowned requirement, and §3.1 no
  longer says MODEL.md lists every index the migrations create.
- `record_step` and `finish_job` raise `ValueError`, before any statement, for an argument they
  never accept, as `close_dispatch` already did: an unknown status, `compensated`, an `output_ref`
  with `running` or `skipped`, an `error_code` with a status other than `failed`; for `finish_job`, a
  status other than `succeeded` or `failed`, an `error_code` with `succeeded`, and `failed` with an
  `error_code` outside `models.ERROR_CODES` or none. They returned `False`, which left a runner
  unable to tell a malformed call from a claim that is gone; §4.4's "returning `False`" for an
  `output_ref` with `running` or `skipped` is withdrawn. A3-14 and A3-21 read each function's own
  error. Four arguments no row sent a value for get a row each — `step_accepts_unknown_status`,
  `step_error_code_without_failed`, `finish_succeeded_with_error_code`,
  `finish_error_code_outside_set` — and §9.3 no longer lists `finish_job`'s among the owed ones. §4
  says a runner write's `False` is one of the refusals §4.4 describes for that write, never one of
  these arguments.
- `staff_operator` is bound to the staff realm. The principal is `apps.identity.staff.StaffPrincipal`, built only by `resolve_staff_principal` from a staff-lane token of the one staff issuer, `KODERA_STAFF_ISSUER`, with a second factor, for a stored staff identity; it carries no role (§4). `role_missing` reads the identity's current `StaffRole` grant in the decision's transaction, as `AUTHZ.md` §4 stores staff roles, instead of a role set carried by the principal (§5.4). A3-31 and `JQ-P33` own the binding, with four rows for the grant read's identity and revocation clauses on each decision function; `any_role` and `delivery_decision_ignores_role` now disable the role clause alone; the harness's operator is a stored staff identity with a grant, and §9.3's owed item is closed. The grant read also requires the identity and person to be current and locks the grant `FOR SHARE`; the job decision's audit row names the grant (`staff_role_grant_ref`).

### Isolation enforcement proof

A3-30 owns the shared isolation predicate with `isolation_unchecked`, both counterexample
bindings and assertion-deletion proof. `tests/test_job_queue_isolation.py` additionally exercises
all thirteen public business calls, each separate transaction boundary, session and driver
isolation, nested actual/default disagreement, caller commit/rollback, reconnect, validation
precedence, cleanup and first queue-statement ordering. Its semantic omission controls must fail
at their named assertions. These are isolation proofs, not parent-session or provider-stop proof.
- A delivery's reconciliation decision writes `outbox_delivery.reconciliation_decided` in the decision's transaction, naming the deciding staff identity, the delivery's organisation, the exit, the decision and the `staff_operator` grant it relied on (§7), as a job's decision does. A3-13 asserts the row for the `resume` and `fail` exits, and that a process killed while it writes the row commits nothing of the decision; A3-31 asserts the grant. `delivery_decision_unaudited` and `delivery_decision_audit_second_txn` (`JQ-P14`) and `delivery_decision_audit_omits_staff_grant` (`JQ-P33`) are its rows, and §9.3 no longer lists it as owed.
