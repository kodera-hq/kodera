# Job catalogue

**Status:** Proposed · **Owner:** Worker seat

Every mutation of infrastructure is a job (ADR-0004). This document is the closed list of job kinds and, for each, the ordered steps, the proof that each step is idempotent, its timeout, its compensation, its retry policy and the audit events it emits. A pull request adding a job kind adds a section here, a row in the enum, and a chaos test.

## 1. Rules that hold for every job

**Creation.** The desired-state change, the `Job` row, its `JobStep` rows and the `AuditEvent` commit in **one transaction**. There is no enqueue outside that transaction, and no job exists that has no audit row.

**Claims, leases and the fence.** A runner claims a job in one transaction that sets `status = leased`, sets `lease_expires_at = clock_timestamp() + 120 s`, gives `fence` a value higher than any earlier claim of that job gave it, and writes the job's lock reservation bound to that fence (**Locks**, below). It renews every **30 seconds**, in one transaction that first locks the job's row under its fence, its `leased` or `running` status and its unexpired lease, checks the lease again once it holds the row, and then moves `lease_expires_at` and keeps the fence ([`../specs/JOB_QUEUE.md`](../specs/JOB_QUEUE.md) §4.4 says why one `UPDATE … WHERE` is not enough, and why no lease is ever compared with `now()`); a runner that fails to renew twice in a row **stops work immediately** and reaps what it started rather than continuing without a lease. Every write a runner makes to a step's state or to the job's status is conditional on the job's current fence and on the job being `leased` or `running` with a lease unexpired by database time. A command or provider call is dispatched only after that check succeeds in the same transaction that records the dispatch ([`../specs/ENVIRONMENT_ALLOCATION.md`](../specs/ENVIRONMENT_ALLOCATION.md) §3.4), so a stale runner can neither record a step nor start a new effect. The fence does not stop an operation already running: OpenTofu providers, Keycloak admin calls and SSH or Ansible cannot check it, and such an operation is covered by `needs_reconciliation`, not by the fence (ADR-0004). A job whose lease expires with no renewal is swept (§4) to `orphaned` or to `needs_reconciliation`.

**Dispatch records and the two recovery states.** Every command or provider call a step starts leaves a dispatch record, written with the fence check above and open until authenticated terminal proof closes it (`CommandDispatch` and `CommandTerminal`, [`../specs/ENVIRONMENT_ALLOCATION.md`](../specs/ENVIRONMENT_ALLOCATION.md) §2.3). A non-terminal sub-job counts as an open dispatch of its parent. A step that cannot complete, because the lease was lost or an effect's outcome is unknown, leaves the job in one of two states, decided from those records alone:

- `orphaned`: no dispatch for the current step is open — none was recorded, or each has authenticated terminal proof. The job is safe to reclaim and re-runs automatically from the first non-succeeded step (§4).
- `needs_reconciliation`: a dispatch for the current step is open, or an effect's outcome is otherwise unknown. The job is **never recovered automatically**. It records `unresolved_step` and `unresolved_operation_ref`, emits `job.reconciliation_required`, alerts, keeps its lock reservation and waits for an operator's decision. The sole future retention exception does not recover or resume it: after cutoff and proved runner-session absence, it transfers the open dispatch to that job's `ExitCutoffJobReconciliation`, cancels the job and leaves evidence sealing to the parent obligation. The alert is owed: `docs/specs/OBSERVABILITY_STACK.md` §6 and `docs/specs/RUNBOOK_INDEX.md` do not catalogue a `needs_reconciliation` alert or its runbook yet, and adding one also moves the alert-parity self-test's fixed count, so it is a follow-up.

An expired lease, a stale heartbeat or an advisory lock nobody holds does not establish that an operation stopped; only authenticated terminal proof does. Recovery follows three distinct paths:

1. **Ordinary/orphan recovery.** Authenticated terminal proof closes a dispatch. If no dispatch for the current step remains open, the sweep may classify the job `orphaned`; the job is then safe to reclaim under the ordinary automatic recovery rule above.
2. **Current fenced pre-hold replay.** When its provider response is lost or cannot confirm that the remote side stopped, a registered safe-convergence contract may authorize only the current fenced runner to replay the same logical provider request under the same still-open `JobDispatch`, the same correlation or idempotency key and an unchanged desired payload. This is transport/request replay under the existing dispatch, not a new `record_dispatch`. It does not close the dispatch, create a second dispatch, release its reservation or prove termination. `close_dispatch` requires authenticated terminal proof; only authenticated terminal proof closes the dispatch. A fresh correlated target observation establishes whether the effect is complete, absent or partial, but counts as terminal proof only when the registered provider or operator-tooling contract authenticates that it proves execution ended. Lease loss or unresolved terminality while the dispatch remains open moves the job to `needs_reconciliation`, even when replay would be duplicate-safe. Every closed dispatch remains backed by authenticated terminal proof; a crash after `close_dispatch` but before the step write can therefore lead only to ordinary/orphan recovery of an operation already proved terminal, never to a new dispatch for one that may still be running. A3-09 exercises the structural sweep distinction between open and closed dispatches, and A3-15 exercises dispatch and resolution-cycle cardinality; neither test authenticates an evidence reference.
3. **Staff decision after hold.** In the current queue, once a job is in `needs_reconciliation`, only an operator's decision takes it out. Every staff decision leaving `needs_reconciliation`, including a resume that permits redispatch, requires both authenticated stop evidence and a fresh correlated target read, as specified below. Neither a target observation alone nor safe convergence can take held work out of reconciliation. The future retention migration adds one non-resuming exit: a trusted same-tenant delete may cancel a selected export or decommission only after the unresolved dispatch is transferred to that job's durable cutoff child and the old runner session is proved absent.

Proposed ADR-0012 accepts only a signed `CommandTerminal` from the execution sink as terminal proof, which is narrower than this rule; that tension is ADR-0012's to settle before it is accepted.

**Leaving `needs_reconciliation`.** The current A3 path is only a staff operator's decision. The decision is recorded with its evidence (`JobReconciliationDecision`, [`MODEL.md`](MODEL.md) §8), referenced by `reconciliation_decision_ref` and audited as `job.reconciliation_decided`. Every ordinary exit requires that evidence to show that the unresolved operation is no longer running, and what it did. The future retention cutoff exception transfers rather than resolves the unknown effect into that job's cutoff child, and the parent obligation cannot seal without equivalent terminal evidence from every child. This two-record rule governs the held state; it does not replace ordinary/orphan recovery or the current fenced runner's registered pre-hold resolution. Which evidence counts is the decision `external-execution-stop-evidence` of ADR-0004, which the product owner has taken: a decision is recorded only with **both** of

1. authenticated provider or operator-tooling evidence identifying the compute or request that
   executed the unresolved operation and proving that execution ended, and
2. a fresh, correlated read of the target resource recording what the operation did.

An expired lease, a missed heartbeat or a released advisory lock never counts as either, and a decision lacking either is refused.

The existing structured fields retain their legacy compute-shaped names without narrowing the decision. In `compute_terminated`, `provider` identifies the evidence system — provider or operator tooling — `resource_id` identifies the compute or request subject, and `request_id` carries its correlated terminal record or operation reference. `target_read` carries the fresh correlated observation of the target. Authenticating those references is the operator tooling's responsibility; neither this catalogue nor ADR-0021 claims that the provider-specific collectors or runbooks exist.

When the unresolved dispatch names a **sub-job**, the operation that was dispatched is that sub-job, and the lead applies the decision to it as follows; this is an application of the owner's decision, not a new one. The decision on the parent is refused until the sub-job is terminal, so its terminal record exists. The evidence that the operation is no longer running is that terminal record together with the resolution of every dispatch the sub-job itself made, each closed under its own authenticated terminal proof or by its own operator decision under the same two pieces of evidence; the fresh target read is a read of what the sub-job produced. The operator records the first in the legacy-named `compute_terminated` fields and the second as `target_read`. The queue checks that both pieces are present, that none of their fields is empty and that they are in time order, and nothing else: it never checks the format of a reference, nor that what it refers to exists or is authentic.

Taking this decision does not by itself allow a job with a real provider effect to run: [`../specs/ENVIRONMENT_ALLOCATION.md`](../specs/ENVIRONMENT_ALLOCATION.md) §6's other gates still apply. The exits are closed:

| Exit | When the evidence shows | Result |
|---|---|---|
| `resume` | The compute or request that ran the operation is proved terminated, and the target read shows whether it completed or had no effect | The dispatch is closed with that evidence, unless a sub-job's terminal write had already closed it: it then keeps the outcome its closer wrote, the decision records that outcome beside its own, and the operator's evidence still governs the step — an application of the owner's decision, like the sub-job evidence rule above ([`../specs/JOB_QUEUE.md`](../specs/JOB_QUEUE.md) §5.4). The step is `succeeded` if the operation completed, and runs again if it had no effect. The job returns to `queued` still holding its reservation, and its next claim takes a higher fence |
| `fail` | The compute or request that ran the operation is proved terminated, the target read records what it did, and the job should not continue | The job becomes `failed` with `error_code = reconciliation_failed`, and its reservation ends. The decision runs no compensation itself: for a kind whose failure compensates automatically, such as `provision` step 9, the decision enqueues the compensation job once that job's kind exists (**Compensation**, below); any other remediation is the operator's, as a separate job |

Neither entering `needs_reconciliation`, nor a `resume`, nor a `fail` counts against `max_attempts`. That budget limits automatic re-runs, which this state never makes, and a kind with a budget of one, such as `restore` or `delete`, must still be able to finish once an operator has established what happened. No `tofu force-unlock` runs automatically: an operator runs it, only after that decision is recorded, with the lock identifier the job recorded, and it is audited as `job.state_force_unlocked`.

**Locks.** A job acquires its whole lock set before its first step, in one fixed order of classes, with ids sorted within each class (ADR-0004):

| Order | Lock class | Keyed on | Taken by |
|---|---|---|---|
| 1 | `organisation` | the organisation | the kinds below, in the mode below |
| 2 | `tenant` | the tenant | every tenant-scoped kind, in the mode of §2's `Lock` column |
| 3 | `allocation_generation` | the one allocation ledger | every job that carries a `JobAllocationSnapshot`, shared, and never reserved: every job takes it shared, so no two jobs conflict on it. Only an allocation change, which is not a job, takes it exclusively, and that change is held back by the rule that refuses it while any dispatch is open ([`../specs/ENVIRONMENT_ALLOCATION.md`](../specs/ENVIRONMENT_ALLOCATION.md) §3.1), not by reservations |
| 4 | `target` | the environment target | every job that carries a `JobAllocationSnapshot`, in the mode of §2's `Lock` column |
| 5 | `attempt_fence` | the job attempt | the claim that creates the attempt, and the sweep that ends it; no other job ever takes it, so it is never reserved |

The organisation lock protects the organisation's one realm (ADR-0006), which a tenant lock cannot. Its mode per kind:

| Organisation lock | Kinds | Why |
|---|---|---|
| exclusive | `realm_create`, `realm_update` | They change the realm itself |
| shared | `provision`, `upgrade`, `restore`, `rotate_secret`, `add_domain`, `remove_domain`, `suspend`, `resume`, `decommission`, `export`, `delete` | They change only this tenant's own clients in the realm, read the realm, or run a preflight that authenticates through it: they need the realm to hold still, not to themselves |
| none | `bootstrap_verify`, `backup`, `drift_check` | No step reads or changes the realm |

A tenant's own clients in the organisation's realm belong to that tenant: only that tenant's jobs create, change or remove them, under the tenant lock exclusively and at least the organisation lock shared. Everything else in the realm — the realm and its settings, its identity providers, its mail and theme settings, its `realm-management` account, and any client no single tenant owns — changes only under the organisation lock exclusively. No tenant job deletes the realm, not even the `delete` of an organisation's last tenant: removing an organisation's realm belongs to organisation offboarding, a realm job that is not yet a kind of this catalogue.

Things that are not jobs also take the organisation lock, and none writes a reservation. A realm-changing outbox delivery takes it shared for the length of its execution (**Outbox deliveries are not jobs**, below). Consuming an owner claim takes it exclusively for its one database transaction, which makes no external call ([`../specs/FIRST_OWNER_BOOTSTRAP.md`](../specs/FIRST_OWNER_BOOTSTRAP.md) §8.1), so it holds the lock for no longer than that transaction. For the invited pilot, the operator commands that bind the intended owner and reissue or revoke an owner claim take it the same way, exclusively and non-blocking for their one transaction (`FIRST_OWNER_BOOTSTRAP.md` §§5.6, 6.6), so none of them interleaves with a consume. Initialising an organisation's starter workspace (`initialiseWorkspace`) takes it exclusively for its one transaction, and whether and how long it waits for it is what [`../specs/PILOT_WORKSPACE_ONBOARDING.md`](../specs/PILOT_WORKSPACE_ONBOARDING.md) §6 step 3 says; this list does not restate it. All of them MUST take it under exactly the key function jobs use, `(class_code, hashtext(key::text))` ([`../specs/JOB_QUEUE.md`](../specs/JOB_QUEUE.md) §4.3), or the locks do not exclude each other.

**Reservations.** While a runner is live its locks are Postgres session advisory locks, and a database session that ends releases them. The lock set is therefore also reserved durably from the claim: the claim's transaction writes one `JobLockReservation` per lock of classes 1, 2 and 4, bound to that claim's fence ([`MODEL.md`](MODEL.md) §8). A reservation ends only in the transaction that also writes the job's new status, and only through one of these writers, each under its own fence or authority: the claim that owns it, when it makes the job terminal; the sweep that supersedes that claim, when it makes the job `orphaned` or fails it `orphaned_exhausted`; the job's next claim after a `resume`, which replaces it with its own; the operator's `fail` decision; the cancellation of a job that a `resume` returned to `queued`; the future retention supersession writer cancelling an export or decommission for an accepted same-tenant delete, but only after the exact runner and database session are proved absent; and the allocation writer, when it fails the job as `allocation_stale` ([`../specs/ENVIRONMENT_ALLOCATION.md`](../specs/ENVIRONMENT_ALLOCATION.md) §3.3). Every ending write is conditional on `ended_at IS NULL` and on the job's current status and fence, so no reservation is ended twice. A job in `needs_reconciliation` keeps its reservation except for that explicit cutoff supersession, a parent's reservation covers its non-terminal sub-jobs, and a job's own reservation is never a conflict for that job's claim.

One consequence is deliberate and stated here so that nobody reads it as a fault. A tenant job in `needs_reconciliation` holds its exclusive tenant reservation, so that tenant's shared `backup` and `drift_check` are not claimed until the operator decides, and `BackupStale` fires once the last verified backup passes 26 hours ([`../specs/BACKUP_AND_RESTORE.md`](../specs/BACKUP_AND_RESTORE.md)). A backup taken while an unresolved operation may still be changing the host would not be evidence of anything. In the same way, a realm job in `needs_reconciliation` holds every job of that organisation that takes the organisation lock. And a realm job that has requested its locks holds back every new realm-changing outbox delivery of its organisation, so deliveries queue behind it, and behind any delivery still in flight or in `needs_reconciliation`, until it has run.

**Claims.** Two locks conflict when either is exclusive. A claim of a job succeeds only through these checks, in this order, in one transaction:

0. The scan excludes `cancellation_requested_by_job_id IS NOT NULL`; a claim by id locks the job
   row and refuses `cancellation_requested` when that write-once field is set. The final conditional
   claim update repeats `cancellation_requested_by_job_id IS NULL` while the live locks are held.
   The cutoff writer holds the same row lock while it sets the field and enumerates every earlier
   claim session, so a racing claim either commits first and is enumerated or creates no claim,
   fence, session or reservation. A database trigger pins this rule, and a losing claimant releases
   every live lock it took before returning.
1. No unended reservation of another job conflicts with any lock of this job's set, checked for the whole set before any live lock is taken. For `realm_create` and `realm_update`, no realm-changing outbox delivery of the organisation is in flight or in `needs_reconciliation` either.
2. No job that requested its locks earlier and is still waiting to be claimed needs a lock that conflicts with this set. A job requests its locks when it first becomes claimable — `queued`, `not_before` passed, the job it waits on `succeeded` — and records that instant as `lock_requested_at`, in database time at the moment it is recorded, once, and never set to an earlier instant; ties are broken by `id`, and an `orphaned` job keeps the instant it had. Claims are therefore served in request order, and an exclusive request is not starved by a stream of later shared ones.
3. The live locks are taken in the fixed order, each with a non-blocking attempt. If one is refused, those already taken are released and the job stays unclaimed: no claim waits while it holds a lock.
4. Check 1 runs again with the live locks held, which closes the gap between another claim's check and its commit. Only then are the fence, the status and the reservation written and the transaction committed.

The sweep checks the same cutoff-ownership field before dispatch or attempt-budget handling and
cannot orphan, fail, release, resume or otherwise rewrite cutoff-owned work. Likewise, the ordinary
operator-decision writer refuses `cutoff_owned`; only the trusted matching cutoff writer may
transfer its dispatch, cancel it and release its reservation after every exact claim session and
live lock is proved absent.

A sub-job's claim runs none of these checks: it takes no lock and writes no reservation, never holds a place in request order, and succeeds only while its parent is `running` under the fence recorded on the parent's dispatch that started the sub-job. Every later write of the sub-job that starts an effect — a step set `running`, a dispatch, a retarget, a sub-job of its own — requires the same; its other writes, renewing, closing, holding, finishing and reporting a step's end, do not, so a sub-job can report what it did after its parent stopped. Every writer that makes a sub-job terminal closes the parent's dispatch that names it, in the same transaction, `completed` when the sub-job succeeded and `failed` otherwise; the parent never closes that dispatch itself, and does not finish while the sub-job is not terminal. A sub-job stranded by a parent that is no longer `running` is failed `parent_not_running` by the sweep, and an operator's decision on the parent waits until every sub-job is terminal.

The API refuses a request for a tenant-scoped job with `409 tenant-locked` only when the tenant lock it needs conflicts with an **exclusive** lock held or reserved on that tenant by a non-terminal job. A request for an exclusive lock that meets only shared holders or reservations is not refused: the job is created and waits its turn in request order (check 2), so a stream of shared jobs cannot starve it. A conflict on the organisation lock is not refused at request time either, because the contract has no problem type for it yet.

**Waiting on a realm job, and sub-jobs.** A change to the organisation's realm that a job needs is its own `realm_create` or `realm_update` job, never a sub-job. It is created before the job that needs it, which records it as `depends_on_job_id` and is not claimed until it is terminal, so no job waits on another while it holds the organisation lock shared. A job whose realm job did not succeed is failed by the claim that finds it, before any lock check and before step 1, with `error_code = prerequisite_failed` and `job.failed`; it never holds a place in request order and never reaches a step that needs the realm. A sub-job runs under its parent's locks and never takes locks or reservations of its own: the parent's set covers, in the mode each needs, every lock of every sub-job it may start, and the parent holds the set until every sub-job is terminal. No current kind starts a sub-job; in particular, recovery-window exports are independent top-level `export` jobs so `decommission` cannot retain an exclusive tenant reservation behind one.

**Outbox deliveries are not jobs.** Commercial effects (invoices, payment requests), messages (email, notifications) and user-level identity operations (invitations, enrolment, disabling a user) are not job kinds and not job steps. They are durable outbox deliveries, committed with the change they belong to and executed by the worker, which loads the credential a delivery needs for that delivery only ([`../dev/SETTINGS_AND_SECRETS.md`](../dev/SETTINGS_AND_SECRETS.md) §4). Issuing an invoice is one of them. A job step that notifies someone commits the delivery; it does not send the message. An ambiguous delivery outcome is reconciled, never retried automatically (ADR-0004). A delivery that changes an organisation's realm is not started while a job holds or has reserved that organisation's lock exclusively, nor while a `realm_create` or `realm_update` of that organisation has requested its locks and waits to be claimed, so a stream of deliveries cannot starve a realm job. It checks both, takes the organisation lock shared for the length of its execution, and checks them again, as a claim does; if the second check fails, it releases the lock and does not start. Symmetrically, a `realm_create` or `realm_update` is not claimed while such a delivery for that organisation is in flight or in `needs_reconciliation` (check 1). A delivery follows the rule a job does when its outcome is unknown: it enters its own `needs_reconciliation` state and waits for an operator's decision recorded with the same two pieces of evidence a job's decision needs (**Leaving `needs_reconciliation`**, above), and it stops blocking the realm job only once that decision is recorded.

**Steps.** Steps are ordered, named, and individually idempotent. A step's idempotency proof is one of:

| Proof | Meaning | Typical step |
|---|---|---|
| `declarative` | The tool converges: re-running produces no change | `tofu apply`, an Ansible role |
| `read-then-write` | The step reads current state and writes only a difference | Keycloak realm and client configuration |
| `natural-key` | The remote object is addressed by a key we compute, so a repeat finds the existing one | Bucket by name, restic snapshot by tag |
| `guarded` | The step checks a precondition it itself established | "add host to certificate list if absent" |
| `read-only` | The step performs no effect and deterministically verifies already-committed authority | exit-boundary verification |
| `commit-marker` | The step writes a marker on success and skips when the marker is present | Deletion evidence, `mark_ready` |
| `command-id` | The agent deduplicates by `command_id` | Every agent command |

A step with none of these is not allowed. The proof is asserted by a test that runs the step twice and diffs the world.

**Timeouts.** Every step has a wall-clock timeout. Exceeding it fails the step; it does not kill the job's lease renewal, which continues until the step's process is reaped so the job does not become `orphaned` while it is demonstrably alive. When the timed-out operation cannot be confirmed stopped, the job goes to `needs_reconciliation` instead of failing the step.

**Retry policy classes.**

| Class | Attempts | Backoff | Applies to |
|---|---|---|---|
| `A` | 5 | exponential from 30 s, cap 10 min, full jitter | Transient remote calls: provider API, DNS, ACME, Keycloak |
| `B` | 3 | exponential from 2 min, cap 15 min | Long converging steps: `tofu apply`, Ansible plays |
| `C` | 1 | none | Steps with a side effect we refuse to repeat blindly: destruction, deletion evidence |
| `D` | 10 | fixed 60 s | Polling steps: waiting for DNS, waiting for a certificate, waiting for an agent |

A job's `max_attempts` governs re-running the **job**; a step's class governs re-running the **step**. Exhausting a step exhausts the job.

**Compensation.** Compensation is per step, runs in reverse order from the last started step, and is itself idempotent. A job whose compensation fails goes to `failed` with `error_code = compensation_failed` and raises a critical alert; it is never marked `succeeded`.

**Credentials.** The worker loads a provider API key whose bearer policy is restricted to one tenant project, an SSH certificate valid at most 8 hours with a per-tenant principal, and, in `lab` and `staging` only, the shared ops age identity into memory **per job**, and drops them when the job ends (ADR-0003). The shared ops age identity is not target-isolated, so every other class, `demo-canary` and `platform-prod` included, waits for target-isolated decryption and one-job secret delivery (ADR-0003, ADR-0012). Project creation and initial IAM bootstrap occur at the separate boundary in ADR-0005. The provider key is the human-issued expiring key of that boundary, referenced by `ProjectBootstrap.secret_ref`: the worker loads it per job, drops it from memory at exit, and **never revokes it** — the same key serves every job of that tenant until its expiry, and only the operator who issued it replaces it ([`../security/THREAT_MODEL.md`](../security/THREAT_MODEL.md) §5). A step that needs a credential the job did not load fails rather than escalating.

**Audit.** Every job emits `job.created`, `job.started`, `job.step_succeeded` / `job.step_failed` per step, and, each time it stops running, one of `job.succeeded`, `job.failed`, `job.cancelled`, `job.orphaned`, `job.reconciliation_required`. An operator's decision on a job in `needs_reconciliation` emits `job.reconciliation_decided`, and a force-unlock that decision allows emits `job.state_force_unlocked`; both have a `staff` actor and nothing automatic emits either. The domain events listed per kind below are emitted **in addition**, and are the ones a customer sees.

**Scheduling.** `not_before` defers a job. Jobs that require a maintenance window (`upgrade`, and `restore` when it is not an emergency) are created with `not_before` set to the next window opening and refuse to start outside it unless `override_window` is set and recorded in `status_reason`.

## 2. The kinds

| Kind | Tenant-scoped | Lock | Drives status to | Self-service at launch | Typical duration |
|---|---|---|---|---|---|
| `bootstrap_verify` | yes | exclusive | none (`ordered` stays `ordered`) | staff only | 1–3 min |
| `provision` | yes | exclusive | `provisioning` → `ready` | staff only | 25–45 min |
| `upgrade` | yes | exclusive | `upgrading` → `active` | staff only | 10–30 min |
| `backup` | yes | shared | none | scheduled | 2–20 min |
| `restore` | yes | exclusive | `maintenance` → `active` | staff only | 10–60 min |
| `rotate_secret` | yes | exclusive | `maintenance` → `active` | staff only | 2–10 min |
| `add_domain` | yes | exclusive | `maintenance` → `active` | `org_admin` | minutes to 72 h (customer DNS) |
| `remove_domain` | yes | exclusive | `maintenance` → `active` | `org_admin` | 2–5 min |
| `suspend` | yes | exclusive | `suspended` | staff, and the dunning scheduler | 1–3 min |
| `resume` | yes | exclusive | `active` | staff | 1–3 min |
| `decommission` | yes | exclusive | `decommissioning` | staff only | 10–30 min |
| `export` | yes | shared | none | `org_owner` | 5–60 min |
| `delete` | yes | exclusive | none (durable cutoff finalizer → `deleted`) | staff, or trusted cutoff scheduler with exact `TenantExit` evidence | 10–30 min |
| `drift_check` | yes | shared | none | scheduled | 2–10 min |
| `realm_create` | no (organisation) | none | none | staff only | 1–5 min |
| `realm_update` | no (organisation) | none | none | staff only | 1–5 min |

`Lock` is the tenant lock. The organisation lock and the other lock classes are in §1, **Locks**: `realm_create` and `realm_update` take no tenant lock and hold the organisation lock exclusively.

### `bootstrap_verify`

Runs once per `ProjectBootstrap` row, enqueued by the audited action that records it, while the tenant is still `ordered`. It is the **one place** the bootstrap is verified: the API process cannot call the provider (ADR-0003), so the `ordered` → `provisioning` guard reads this job's result and `provision` step 3 only re-checks it.

| # | Step | Idempotency proof | Timeout | Retry | Compensation |
|---|---|---|---|---|---|
| 1 | `load_key` — load the key at `secret_ref` into memory; a missing or already-expired key fails closed | `guarded` | 60 s | A | none |
| 2 | `verify_identity` — the key belongs to `provider_application_id`, its fingerprint equals `access_key_fingerprint`, its expiry equals `key_expires_at` | `guarded` | 2 min | A | none |
| 3 | `verify_policy` — the live policy on `provider_policy_id` names exactly `provider_project_id` and its digest equals `policy_digest`; a wider policy fails closed | `guarded` | 2 min | A | none |
| 4 | `verify_boundary` — one declared tenant action inside the project succeeds and one read outside it is denied | `guarded` | 2 min | A | none |
| 5 | `record` — `state = verified`, `verified_at`, `Tenant.scaleway_project_id` | `commit-marker` | 30 s | C | none |

Audit: `tenant.project_bootstrap_verified`. A failed verification leaves the row `recorded` with the failing step in `job.failed`; the operator replaces the record (`tenant.project_bootstrap_replaced`) rather than editing it. `max_attempts`: 2.

### `provision`

Builds a tenant from `ordered` to `ready`. Preconditions: `DpaAcceptance` for the current DPA major, complete contacts, a published plan, quota headroom, a `ProjectBootstrap` in state `verified` whose key has not expired — verified by `bootstrap_verify` above, never by this job (ADR-0005) — and the organisation's realm. The realm is created by the organisation's `realm_create` job, which the intake creates before any tenant exists ([`../specs/FIRST_OWNER_BOOTSTRAP.md`](../specs/FIRST_OWNER_BOOTSTRAP.md) §3.1); this job never creates or changes the realm itself, and waits on a realm job when it needs one (§1).

| # | Step | Idempotency proof | Timeout | Retry | Compensation |
|---|---|---|---|---|---|
| 1 | `preflight_order` — plan, DPA, contacts, slug free, quota headroom | `guarded` | 60 s | A | none |
| 2 | `render_profile` — vendor the profile at its commit SHA, render in the sandboxed Jinja environment, validate against the deny-list schema | `declarative` (same inputs, same output) | 3 min | A | discard artefact |
| 3 | `verify_project_bootstrap` — re-check the evidence `bootstrap_verify` recorded: the live policy digest, key fingerprint and expiry must equal the `verified` row and the key must not have expired. A difference fails closed; this step never verifies a bootstrap for the first time | `guarded` | 5 min | A | none; replace the bootstrap record through its own audited action |
| 4 | `reserve_ips` — flexible IPv4 for `web` and, when the tier asks, `media`; `lifecycle = retain` | `natural-key` (tagged with the slug and role) | 3 min | A | release **only** addresses this attempt created |
| 5 | `create_host` — security group, block volume, instance, cloud-init that creates the deploy user and nothing else | `declarative` (`tofu apply`, state file `tenants/{slug}.tfstate`) | 20 min | B | `tofu destroy` limited to this job's plan |
| 6 | `create_dns` — `{slug}.visio`, `{slug}.livekit`, and `{slug}.docs` when the app is on; delegated sub-zone in the tenant project | `declarative` | 5 min | A | remove records this attempt created |
| 7 | `create_mail_domain` — TEM subdomain `{slug}.mail.kodera.io` in the tenant project, SPF, DKIM, DMARC | `natural-key` | 10 min | A | delete the subdomain |
| 8 | `create_storage` — per-tenant backup bucket with Object Lock COMPLIANCE and its lifecycle rule. It issues no key: the append-only backup key is issued at the human-controlled boundary of ADR-0005, because issuing a key needs IAM administration the worker does not hold, and this step only checks that such a key is recorded for this bucket, failing closed when none is | `natural-key` | 5 min | A | leave the bucket; buckets are never deleted by compensation |
| 9 | `create_clients` — this tenant's own clients in the organisation's realm, with PKCE, redirect URIs per declared host and logout channels. The realm itself is neither created nor changed here (§1, **Locks**) | `read-then-write` | 5 min | A | delete this tenant's own clients by natural key |
| 10 | `store_secrets` — generate values, envelope-encrypt, write `Secret` rows and their `config_ref` | `natural-key` (`tenant`, `name`, `version`) | 2 min | A | mark rows `revoked` |
| 11 | `configure_host` — Ansible: baseline, edge, application stack, resource limits, retention drop-ins | `declarative` | 25 min | B | none; step 5's compensation covers it |
| 12 | `enrol_agent` — create the `Agent` row and its enrolment token; wait for first heartbeat | `natural-key` + `command-id` | 10 min | D | revoke the token |
| 13 | `preflight_config` / `preflight_stack` / `preflight_public` — the three phases, each with its self-test mutation | `guarded` | 10 min each | A | none |
| 14 | `register_observability` — probes, status components, backup schedule, capacity alert | `natural-key` | 3 min | A | delete rows this attempt created |
| 15 | `first_backup` — one cold backup before handover | `natural-key` (snapshot tag) | 20 min | A | none |
| 16 | `mark_ready` — status to `ready`, `commit-marker`, welcome notification queued | `commit-marker` | 30 s | C | none |

Audit: `tenant.provision_requested`, `tenant.host_created`, `tenant.dns_created`, `realm.client_changed`, `tenant.secrets_created`, `tenant.agent_enrolled`, `tenant.preflight_passed` / `tenant.preflight_failed`, `tenant.ready`.
Job `max_attempts`: 3. **Compensation is not automatic past step 8, except for step 9**: a partly built tenant is left in `failed` for an operator, because destroying half a tenant is worse than leaving it inspectable. Steps 4–8 compensate automatically only when the job failed before step 9. Step 9's compensation runs automatically whenever the job fails once step 9 is no longer `pending`: it deletes only this tenant's own clients, addressed by their natural key, under the shared organisation lock, so it is idempotent and touches nothing a sibling tenant owns, and client credentials left in a shared organisation realm by a failed tenant would be attack surface. It runs in the owning claim, before that claim finishes the job `failed`. A failure no runner owns — the sweep failing the job `orphaned_exhausted`, an operator's `fail` decision, or the allocation writer failing it `allocation_stale` — instead enqueues a compensation job for step 9 with the same lock set, claimed in request order, keyed as [`../specs/JOB_QUEUE.md`](../specs/JOB_QUEUE.md) §3.4 derives it — `sha256` over the canonical JSON array `["compensate", failed_job_id, 9]`, never a delimiter-joined string — in the transaction that fails the job. That job takes a new place in request order, the latest, so every conflicting job already queued on that tenant runs before the failed tenant's clients are removed; the failed `provision` no longer holds the tenant, and nothing that runs in between depends on those clients being gone. That job's kind is owed: it enters §2 with the contract's `JobKind`, the change that adds it amends the queue's sweep and decision writers to enqueue it ([`../specs/JOB_QUEUE.md`](../specs/JOB_QUEUE.md) §5.5), and until then no `provision` with a real provider effect runs ([`../specs/ENVIRONMENT_ALLOCATION.md`](../specs/ENVIRONMENT_ALLOCATION.md) §6). The bootstrapped project is not deleted by this job.

### `upgrade`

Applies an approved `Release`. Runs inside the maintenance window unless overridden.

| # | Step | Idempotency proof | Timeout | Retry | Compensation |
|---|---|---|---|---|---|
| 1 | `check_release` — release `approved`, channel matches the tenant's wave, digests resolvable | `guarded` | 60 s | A | none |
| 2 | `maintenance_on` — edge serves 503 with `Retry-After`, collaborative provider drained | `command-id` | 2 min | A | `maintenance_off` |
| 3 | `safety_snapshot` — hot snapshot tagged with the job id | `natural-key` | 15 min | A | none (the snapshot is the compensation) |
| 4 | `pull` — pull every pinned digest | `declarative` | 15 min | B | none |
| 5 | `up` — recreate services against the new digests | `declarative` | 10 min | B | restore from step 3 |
| 6 | `migrate` — application migrations | `commit-marker` (the migration table) | 15 min | C | restore from step 3 |
| 7 | `preflight` — all three phases | `guarded` | 10 min | A | restore from step 3 |
| 8 | `maintenance_off` | `command-id` | 2 min | A | none |
| 9 | `record_release` — `TenantRelease` to `active`, previous to `superseded`, `observed.compose_digest` refreshed | `commit-marker` | 30 s | C | none |

Rollback restores the safety snapshot taken at step 3, and nothing after step 3 is allowed to be irreversible without it. That snapshot holds the database dump, the rendered configuration and the image and profile pins; restoring it returns those to the moment it was taken and discards everything written to them after it, and it does not cover object-storage bodies or the organisation's realm (ADR-0004, [`../specs/UPGRADE_PROCEDURE.md`](../specs/UPGRADE_PROCEDURE.md)). A red preflight restores and the job still ends `succeeded` with `outcome: rolled_back`; a failed **restore** ends `failed` with a critical alert.
Audit: `tenant.upgrade_requested`, `tenant.maintenance_on`, `tenant.snapshot_taken`, `tenant.release_applied` or `tenant.release_rolled_back`, `tenant.maintenance_off`.
`max_attempts`: 2.

### `backup`

Scheduled nightly and on demand.

| # | Step | Proof | Timeout | Retry | Compensation |
|---|---|---|---|---|---|
| 1 | `quiesce` — application-level dump hooks per the profile | `command-id` | 10 min | A | none |
| 2 | `snapshot` — restic to the tenant bucket with the append-only key, tagged with the job id | `natural-key` | 60 min | A | none; a partial snapshot is left for restic to reconcile |
| 3 | `record` — `Backup` row, size, snapshot id, `lock_until` | `natural-key` | 30 s | C | none |
| 4 | `verify_age` — assert the newest successful snapshot is under 26 hours old | `guarded` | 60 s | A | none |

Audit: `backup.started`, `backup.succeeded` / `backup.failed`. Pruning is a separate scheduled operation run **only from the worker** and never from a tenant VM. `max_attempts`: 3.

### `restore`

| # | Step | Proof | Timeout | Retry | Compensation |
|---|---|---|---|---|---|
| 1 | `select_snapshot` — resolve `Backup`, assert it is `succeeded` and inside its lock | `guarded` | 60 s | A | none |
| 2 | `maintenance_on` | `command-id` | 2 min | A | `maintenance_off` |
| 3 | `pre_restore_snapshot` — snapshot the current state before overwriting it | `natural-key` | 15 min | A | none |
| 4 | `stop_services` | `command-id` | 5 min | A | start services |
| 5 | `restore_data` | `command-id` | 60 min | C | restore step 3's snapshot |
| 6 | `start_services` | `command-id` | 10 min | A | — |
| 7 | `preflight` | `guarded` | 10 min | A | restore step 3's snapshot |
| 8 | `maintenance_off` | `command-id` | 2 min | A | none |

Audit: `tenant.restore_requested`, `tenant.restore_completed` / `tenant.restore_failed`. `max_attempts`: 1 — a restore is never retried automatically. A restore always takes a pre-restore snapshot first, so restoring the wrong snapshot can be undone for what the tenant's snapshot set holds ([`../specs/BACKUP_AND_RESTORE.md`](../specs/BACKUP_AND_RESTORE.md) §2). A restore does not bring back what that set excludes: the organisation's realm, whose identity-provider dump is a separate artefact (§2.1 there), ACME keys and certificates, which are re-issued, and anything written after the pre-restore snapshot was taken.

### `rotate_secret`

| # | Step | Proof | Timeout | Retry | Compensation |
|---|---|---|---|---|---|
| 1 | `generate` — new value, new `Secret` version, envelope-encrypted | `natural-key` (`tenant`, `name`, `version`) | 60 s | A | mark the new version `revoked` |
| 2 | `update_consumers` — Keycloak client secret, application configuration, media configuration, as the secret requires | `read-then-write` | 5 min | A | re-point consumers at the previous version |
| 3 | `push` — agent renders the new value locally by `config_ref`, mode 600 | `command-id` | 5 min | A | re-push the previous version |
| 4 | `reload` — reload the consuming services | `command-id` | 5 min | A | reload with the previous value |
| 5 | `verify` — a functional check per secret kind (a login round-trip, a token mint, a database connection) | `guarded` | 3 min | A | full rollback to the previous version |
| 6 | `retire` — previous version to `superseded`; agent tokens keep a one-hour overlap | `commit-marker` | 30 s | C | none |

The secret value never appears in a job artefact, a log line, an audit diff or a command payload.
Audit: `secret.rotation_requested`, `secret.rotated`, `secret.rotation_failed` — with `name` and `version`, never a value. `max_attempts`: 2.

### `add_domain` and `remove_domain`

`add_domain` implements the transitions of [`DOMAIN_STATE_MACHINE.md`](DOMAIN_STATE_MACHINE.md); the job is long-lived because it waits on the customer's DNS.

| # | Step (`add_domain`) | Proof | Timeout | Retry | Compensation |
|---|---|---|---|---|---|
| 1 | `issue_nonce` | `natural-key` (one per domain row) | 30 s | A | clear the nonce |
| 2 | `await_txt` — poll both resolvers | `guarded` | 72 h total | D | none; the TTL ends it |
| 3 | `check_caa` | `guarded` | 60 s | A | none |
| 4 | `await_target` — poll for the CNAME or A record for the role | `guarded` | remainder of the TTL | D | none |
| 5 | `add_to_cert_list` — add the host to the edge's certificate and virtual-host lists | `guarded` | 2 min | A | remove the host |
| 6 | `await_certificate` | `guarded` | 15 min | D | remove the host from the list |
| 7 | `sync_media_cert` (media role only) — copy the file, reload | `command-id` | 5 min | A | restore the previous file, reload |
| 8 | `update_application` — allowed hosts, base URL when canonical, realm client redirect URIs | `read-then-write` | 5 min | A | revert all three |
| 9 | `mark_live` | `commit-marker` | 30 s | C | none |

`remove_domain` is steps 8, 7, 5 in reverse with the same proofs, then a soft delete. It refuses to remove the last `live` canonical host for a role.
Audit: `domain.verification_started`, `domain.txt_verified`, `domain.certificate_issued`, `domain.live`, `domain.failed`, `domain.removed`. `max_attempts`: 1 for `add_domain` (re-verification is a new job), 3 for `remove_domain`.

### `suspend` and `resume`

| # | Step (`suspend`) | Proof | Timeout | Retry | Compensation |
|---|---|---|---|---|---|
| 1 | `record_reason` — reason and the notice that preceded it | `commit-marker` | 30 s | C | none |
| 2 | `disable_logins` — this tenant's clients in the organisation's realm are disabled for new authentication; the realm itself stays up for the organisation's other tenants and the console; existing sessions expire naturally so running rooms finish | `read-then-write` | 2 min | A | re-enable the clients |
| 3 | `edge_notice` — the edge serves an explanatory page on the web host; media keeps existing sessions until they end | `command-id` | 2 min | A | remove the notice |
| 4 | `pause_schedules` — probes to `degraded` reporting, capacity alerts off; **backups continue** | `read-then-write` | 60 s | A | resume schedules |
| 5 | `notify` — commit the outbox delivery that tells the owner and billing contact, with the unblocking path; the worker sends it as a delivery, not as this step (§1) | `commit-marker` | 60 s | A | none |

`resume` is the reverse, with a guard that the subscription is not `terminated`, and it completes at the latest on the next business day after payment (CGV 13.3).
Audit: `tenant.suspended` (with `reason`), `tenant.resumed`. Data is never deleted by a suspension. `max_attempts`: 3.

### `export`

The request transaction creates the `Export`, its empty immutable artefact-manifest generation and
its non-exportable outer storage key before it enqueues the job. For a recovery-window export it
also copies `TenantExit.effective_access_ends_at` into `hard_access_ends_at`. If key allocation or
the empty-manifest record fails, neither the export nor its job commits. When `publish` succeeds,
`available_until = published_at + 30 days`; `hard_access_ends_at` becomes the earlier of that
ordinary expiry and its existing exit cutoff. Accepting a validated earlier-deletion instruction
moves both exit and export hard cutoffs earlier in the same transaction.
The key/artefact service uses trusted time and the tenant deletion fence to refuse unwrap, read and
write at that instant even if no queue runner or delete worker is available.

| # | Step | Proof | Timeout | Retry | Compensation |
|---|---|---|---|---|---|
| 1 | `resolve_scope` — the requested artefact set | `guarded` | 30 s | A | none |
| 2 | `collect_users` — stream users CSV through customer encryption then the fenced outer-key service; pre-register a deterministic slot before each write and persist no raw temporary data | `natural-key` | 10 min | A | retain registered encrypted chunks for evidenced purge |
| 3 | `collect_rooms` — stream rooms and metadata JSON through the same pipeline and manifest | `natural-key` | 10 min | A | retain encrypted chunks for evidenced purge |
| 4 | `collect_documents` — stream documents as Yjs plus Markdown and drive tree through the same pipeline and manifest | `natural-key` | 60 min | A | retain encrypted chunks for evidenced purge |
| 5 | `collect_realm` — stream the realm partial export through the same pipeline and manifest | `natural-key` | 10 min | A | retain encrypted chunks for evidenced purge |
| 6 | `collect_audit` — stream the organisation's audit JSON Lines through the same pipeline and manifest | `natural-key` | 10 min | A | retain encrypted chunks for evidenced purge |
| 7 | `package` — assemble only already customer-and-outer-encrypted chunks; pre-register the final object's deterministic slot before write, then reconcile every issued slot with the artefact-service accepted-write journal and fresh store reads before sealing the manifest digest | `commit-marker` | 20 min | C | retain every sealed object version for evidenced purge |
| 8 | `publish` — `Export` to `ready`; set ordinary expiry to 30 days after publication, clip effective access at the earlier hard exit cutoff, notify | `commit-marker` | 60 s | C | none |

Audit: `export.requested`, `export.ready`, `export.collected`, `export.expired`. Collection processes bounded plaintext in memory but persists none: worker swap and core dumps are disabled, payload bytes are excluded from structured logs, and every durable byte first crosses customer encryption and the non-exportable outer-key service. Crash tests at every collection boundary scan the workspace, logs and object inventory for fixture plaintext. The download path unwraps only the outer layer and streams the still-customer-encrypted archive, independently refusing at `hard_access_ends_at`. Ordinary exports are available for at most 30 days from successful publication; recovery exports end at the earlier of that expiry and the exit cutoff. Destroying the outer key makes an unreachable retained object unreadable without claiming physical purge. `max_attempts`: 2.

### `decommission` and `delete`

The API transition-service transaction accepting termination first creates the one-per-tenant
`TenantExit`, fixes `recovery_ends_at = recovery_started_at + 90 days`, closes ordinary application
and write admission under their synchronous fences, enters `decommissioning` and enqueues
`decommission` atomically. The same locked transaction increments `Tenant.access_generation`.
Ordinary request, response-stream and realtime-session capabilities are generation-bound. Each
delivered chunk, frame or heartbeat holds the per-tenant `access-delivery` barrier shared across
generation validation and network send; termination takes it exclusive, drains bounded shared
emissions, increments the generation and commits before releasing it. A drain timeout aborts
termination, so no validation/send can straddle a committed cutoff. The front door fails closed
without the barrier or current generation; disabling clients and stopping services below are defence in depth.
The future designated-closure-principal lane uses a separate generation and delivery barrier. Its
capabilities name the exit, generation and absolute effective cutoff; every exit-export, invoice,
credit-note, closure-status or deletion-record delivery holds the barrier across trusted-time
validation and send, and the transport sink refuses bytes at or after the deadline. Natural expiry
therefore needs no worker to deny access. Earlier-instruction acceptance takes that barrier
exclusive, drains in-flight delivery, advances the generation and commits the earlier cutoff before
release; a drain timeout aborts acceptance rather than recording an unenforced cutoff.
`decommission` prepares but does not start or move that clock; `delete` destroys. They are two
kinds because the gap between them is the tenant-scoped recovery period, ending earlier only on a
validated irreversible-deletion instruction from the controller. This is separate from the
ordinary export artefact's publish-time 30-day availability above.

| # | Step (`decommission`) | Proof | Timeout | Retry | Compensation |
|---|---|---|---|---|---|
| 1 | `verify_exit_boundary` — read-only verification of the already-committed `TenantExit`, exact 90-day end, closed ordinary access/write admission and `decommissioning` status. An accepted future export request creates an independent top-level job and never becomes a child or step of this job | `read-only` | 30 s | A | none |
| 2 | `disable_clients` — this tenant's application clients in the organisation's realm; the realm and the bounded Core/Console authentication path for designated closure principals remain available, and ordinary tenant access does not (ADR-0006) | `read-then-write` | 2 min | A | none — termination never restores ordinary access |
| 3 | `stop_and_drain_services` — advance the tenant write fence, stop every remaining ordinary ingress, wait for each pre-fence DB/object/document mutation to become terminal, then record authenticated stop/quiescence evidence, a fresh target read and source high-water marks; unknown outcome enters `needs_reconciliation` | `command-id` | 10 min | A | none — termination never restarts ordinary service |
| 4 | `final_backup` — while final-backup admission and its fence remain current and trusted time is strictly before both the capability's absolute deadline and the exit's effective cutoff, write one locked cold backup from the proven quiescent state and bind its manifest to DB/object/document high-water marks covering the drain; the artefact store applies the same time checks and rejects at equality even when the expiry writer is unavailable. When a cutoff races it, stop and leave every issued slot to the cutoff obligation, which alone may later record accepted versions or canonical no-write after journal and fresh-store reconciliation | `natural-key` | 30 min | A | none |
| 5 | `mark_exit_prepared` — record `TenantExit.prepared_at` only after drain evidence and final-backup coverage (or valid no-write evidence) are durable; never rewrite either cutoff | `commit-marker` | 30 s | C | none |

The final backup uses the same write-ahead slot, slot-bound capability and accepted-write journal
discipline as export and identity artefacts. Recovery expiry or an accepted earlier-deletion
instruction closes its admission and advances its fence atomically. A post-fence write is refused;
each capability also binds the exit id and an absolute deadline no later than `recovery_ends_at`,
and every store acceptance checks trusted time against that deadline and the current effective
cutoff, so exact natural expiry refuses a stale fence-current capability without any writer;
an object accepted before the fence but acknowledged afterwards remains in the immutable backup
manifest and final purge obligation. The future runtime acceptance suite must pause an ordinary mutation across
termination, make the decommission runner unavailable, hold a capability through exact natural
expiry with the expiry writer and supervisor unavailable, move backup before drain, omit each
source high-water mark, and pause the final-backup store call across an earlier instruction. Its
mutations must catch preserved ordinary access, restarted service, missing drain/coverage evidence
and every accepted-but-unmanifested backup object. These are owed runtime checks: the current
worker and model do not implement this protocol.

At either natural recovery expiry or a validated earlier-deletion instruction, one narrow
lifecycle-supersession transaction accepts the `delete` request even if exports or `decommission`
own tenant reservations. It closes export and final-backup admission, advances both fences,
creates one parent `ExitCutoffReconciliation`, one cancel-and-reconcile
`ExitCutoffJobReconciliation` per selected non-terminal export/decommission, and one reap-only job
child per relevant terminal job with any unended claim session or live lock across all fences. Each
job child receives one session-reconciliation child per relevant exact claim, or one
`never_claimed` sentinel only when durable history proves no claim ever existed; it records
`cancellation_requested_by_job_id` on each non-terminal job and queues delete;
it does not infer an external outcome or end either live/durable lock. The retention supervisor
then reaps every session child across every fence. A closed outcome — `terminated`,
`already_absent`, or `never_claimed` only on the sentinel — plus a fresh exact-session/live-lock
absence read is required for every session child before the
trusted retention writer to transfer that job's open dispatch to its child, move a
queued/leased/running/orphaned/reconciling export or decommission to `cancelled`, set its delete
link, clear its lease and end its reservation. This is the sole future exception to the
operator-decision reconciliation trigger, and the delete remains unclaimable until all conflicting
session advisory locks are actually gone. A `failed` decommission remains immutable and unreserved;
T28 returns the tenant to `decommissioning` for delete without retrying preparation. A succeeded
decommission needs no rewrite, and cancellation can never resume.

A terminal export/decommission normally released its session locks after its terminal commit. The
cutoff nevertheless selects every `JobClaimSession` across all fences that is still unended or owns
an exact live lock — including a runner paused after terminal commit but before unlock — beneath one
reap-only job child. Each session child records `terminated` or `already_absent` plus its fresh
absence read; `never_claimed` exists only when the job has no claim history. The job child never
rewrites the terminal job or its already-ended reservation. Delete cannot claim until every
terminal-session child is reaped too.

External evidence is deliberately a later phase. The obligation writer closes every child's
transferred dispatch under authenticated terminal proof and reconciles every export/final-backup
slot against the accepted-write journal and a fresh store read, without resuming a cancelled job.
Only after all children resolve may the parent seal accepted versions or canonical no-write.
Journal/store unavailability leaves the obligation open without consuming a job-attempt budget;
after all runner reaps active-store destruction may proceed. Destruction completion first commits
step 9, its effect evidence and the exact delete claim binding while that claim's reservation and
live locks remain held. Unlock or reaping happens only after this durable point; a second transaction
records fresh session/lock absence, closes the claim and reservation and succeeds the delete job.
If the runner dies after steps 1–8 are durably succeeded but before that point, the sweep preserves
the same job/reservation and routes an unbounded supervisor takeover: after reaping the exact dead
claim, it writes only the step-9 marker and never repeats a destructive step.
The durable finalizer waits for that independently retryable close phase, the seal and the linked
delete job still `succeeded` before it issues the unique parent-linked initial attestation and moves the tenant to
`deleted` atomically. `prepared_at` is not a supersession precondition. This is the only
path that bypasses request-time `409`; claim-time live-lock and reservation checks remain intact.
The future suite must hold the old runner session and live lock across cutoff, cover queued,
running, `needs_reconciliation` and terminal-before-unlock jobs, pause after store acceptance before
acknowledgement, make both journal and store unavailable, crash after step 8 before the marker,
after durable destruction completion before unlock and again after unlock before durable close,
and unique finalization, pause closure-resource delivery at exact natural/instructed cutoff, and
mutate every reaper/transfer/trigger/barrier predicate.

**Deletion supersedes export.** This is a required part of the retention implementation and is not
present in the current queue. Every customer-encrypted export archive is wrapped in a second
storage-encryption layer with an export-specific data key; a runner receives a short-lived,
export-and-fence-bound publication capability whose hard
expiry is no later than `recovery_ends_at`. The artefact store accepts a publish only while the
tenant deletion fence and the exact `Export.publish_fence` are current. It never accepts a bare
customer encryption key as write authority. The outer key is non-exportable: collection and
packaging stream through the fenced encryption service, including temporary chunks. The runner
never possesses a raw outer key and persists no plaintext; bounded plaintext exists only in the
in-memory transform described above.

The transaction that accepts a `delete` at recovery expiry or on a validated earlier instruction
closes export admission, advances the tenant deletion fence and durably links **every** tenant
export to the delete. Selection is never by terminal state: `failed`, `expired`, `ready` and
`collected` are all linked, including ordinary pre-exit rows whose `tenant_exit_id` is null. The
transaction moves every linked row's trusted-time hard access cutoff to no later than
`TenantExit.effective_access_ends_at`, even when an expiry writer runs late, so the old ordinary
30-day expiry cannot preserve access. Durable key, capability and artefact evidence only decides whether
destruction or purge work is already proven and may be skipped idempotently. The writer marks each
row that still needs the barrier `superseding`, refuses any new capability, destroys its
export-specific outer key and records that proof before the delete can proceed. The trusted-time `hard_access_ends_at` denial is the deadline
backstop; key destruction is the durable deletion barrier recorded by the worker. Together they
ensure an unavailable runner or artefact store cannot leave a readable copy or extend the recovery
window. Physical removal is still mandatory and retried, but every issued slot and accepted opaque
or unreachable object version stays in the sealed export artefact scope manifest copied into the
initial deletion attestation. The scope manifest never changes; the final certificate separately
records immutable fresh absence evidence proving every scope member physically absent.

Object storage and PostgreSQL do not share a transaction. Before issuing any write capability,
Core commits a deterministic object/version slot to the current manifest generation. The
artefact service accepts only that slot and journals the accepted version durably. After fencing,
supersession reconciles every issued capability against the journal and a fresh prefix/version
read, sealing either the accepted version or its authenticated absence proof. A crash after store
acceptance but before Core acknowledgement therefore cannot create an untracked object. The
future runtime acceptance suite must inject exactly that crash; a mutation that issues the capability before the slot
commit, or omits one journal entry from reconciliation, must fail.

Handling is closed by prior state:

- `requested`: its request-time key and empty manifest already exist; destroy the key, create the
  job child, prove from claim history and a fresh live-lock read that no runner session exists, then
  cancel the queued job and end its reservation atomically. A legacy row from before request-time
  allocation instead needs durable proof that no key, capability or artefact was ever created;
- `running`, `leased`, `orphaned` or `needs_reconciliation`: advance the fence, destroy the key,
  bind its cutoff job child to every historical unended/live claim session across all fences,
  terminate or prove each exact session already absent, prove all of their locks absent, then cancel
  the job and end its reservation atomically. Missing stop evidence
  keeps cancellation/reservation release pending but never preserves access or readable data;
- `failed` or `expired` with retained chunks or an archive: keep the terminal job immutable,
  destroy the key and carry every manifest member into the same purge obligation as a ready archive;
- `ready` or `collected`: destroy the key and clear `object_ref` only after recording the immutable
  object/version identifier for purge; its already-succeeded producer job is not rewritten;
- any terminal state with fresh key-destruction and manifest-member absence proofs: record the
  deletion link and proof without rewriting its terminal job.

The narrowly authorised queue writer may move only a linked export job from `queued`, `leased`,
`running`, `orphaned` or `needs_reconciliation` to `cancelled`; only after the matching child proves
the exact session/live lock absent does it clear any live lease and end the reservation in the same
transaction, and no decision may resume it. `Export` itself moves from
`superseding` to `superseded` only after the key-destruction proof is durable; artefact purge may
complete later. The `delete` request keeps its earlier place in request order and claims its
exclusive tenant lock as soon as those reservations end. The implementation must add these states,
fields, writer and mutation tests proving that removing the admission fence, trusted-time read or
unwrap cutoff, publish fence, request-time key/empty-manifest allocation, no-durable-plaintext
collection controls, key destruction, state/evidence handling or atomic reservation release prevents
deletion acceptance. One acceptance case freezes the clock at the deadline with both the delete
runner and artefact store unavailable and proves a previously ready archive cannot be unwrapped;
another mutation removes only that runner-independent cutoff and must fail.
Until those exist, Core does not implement the 90-day or earlier-deletion guarantee.

| # | Step (`delete`) | Proof | Timeout | Retry | Compensation |
|---|---|---|---|---|---|
| 1 | `confirm` — either the staff operator typed the slug back, or the trusted cutoff scheduler presents the exact `TenantExit`, cutoff reason/time and `ExitCutoffReconciliation` created by the lifecycle transaction; export admission is closed; every selected export/decommission job child proves every historical claim-session child across all fences and its live locks absent and its reservation released; and every export that held or could create an artefact has crossed the durable key-destruction barrier above. Physical purge and transferred-dispatch/backup evidence remain obligations and attestation gates, not access-window extensions. The clock or validated instruction triggers this system branch: an absent, pending or incomplete export and an unpaid invoice never extend the recovery end, because data is not held as leverage (CGV 16.6, [`BILLING_MODEL.md`](BILLING_MODEL.md) §6) | `guarded` | 30 s | C | none |
| 2 | `destroy_infrastructure` — `tofu destroy` for the tenant state file | `declarative` | 30 min | C | none — destruction is not compensable |
| 3 | `release_addresses` — release retained addresses unless the organisation keeps them for a replacement tenant | `natural-key` | 5 min | C | none |
| 4 | `delete_dns` | `declarative` | 5 min | C | none |
| 5 | `delete_clients` — remove this tenant's own clients from the organisation's realm. The realm itself is never deleted by this job, not even for the organisation's last tenant (§1, **Locks**) | `read-then-write` | 5 min | C | none |
| 6 | `revoke_secrets` — every `Secret` to `revoked`; the agent row revoked. The tenant's provider key at `ProjectBootstrap.secret_ref` is left as it is: the bucket purge still needs it, and the operator revokes it after that purge (step 7) | `commit-marker` | 60 s | C | none |
| 7 | `hand_over_project_closure` — record the handoff at the human-controlled boundary of ADR-0005. After the last backup object's lock expires, the worker purges the bucket with the tenant's key as a scheduled follow-up; only after that purge does the operator revoke the tenant's API key, and then close the project. This job does neither: both need organisation-level IAM and project rights the worker does not hold, and revoking the key before the purge would leave the bucket impossible to purge | `commit-marker` | 60 s | C | none |
| 8 | `register_deletion_finalization` — durably register that the cutoff obligation may finalize this tenant once both destruction completion and sealed evidence exist; this step never polls the evidence service | `commit-marker` | 60 s | C | none |
| 9 | `mark_destruction_complete` — the dedicated first phase requires steps 1–8 succeeded, then commits this step, effect evidence, the exact delete claim binding and `ExitCutoffReconciliation.destruction_completed_at` while the claim's live locks and durable reservation remain held. Only after commit does the runner unlock; an idempotent second phase records `released`, or the supervisor records `terminated`/`already_absent` after a crash, with fresh exact backend/lock absence, then ends the claim/reservation and succeeds the job. A runner lost after step 8 but before the marker is reaped and adopted by the supervisor, which writes only this marker and never repeats destruction. Neither a marked nor takeover-eligible delete can be failed by the lease sweep. The tenant remains `decommissioning`; after evidence seals and durable close, the parent-linked finalizer issues exactly one initial attestation and moves the tenant to `deleted` atomically, with no bounded attempt budget | `commit-marker` | 30 s | C | none |

Billing records are **not** tenant data: invoices, payments and the accepted documents live in Core, are kept for their legal periods ([`BILLING_MODEL.md`](BILLING_MODEL.md) §6), and this job neither reads nor deletes them. Backups are **not** deleted by this job: Object Lock in COMPLIANCE mode makes that impossible before expiry. The initial attestation names the lock expiry and does not claim that locked copies are already gone. A separate follow-up job must purge the last locked copy after expiry and only then issue the final deletion certificate.
Audit: `tenant.decommission_requested`, `export.ready` when an export was requested and completed, `tenant.infrastructure_destroyed`, `tenant.deletion_certificate_issued`, `tenant.deleted`. The delete job emits infrastructure destruction; the future durable finalizer emits the legacy initial-attestation and deleted actions atomically. `tenant.deletion_certificate_issued` records only the initial active-store attestation. The future follow-up purge job must add a separate final-certificate action to the closed audit registry and OpenAPI contract in the same change; no such action is registered or emitted yet. `max_attempts`: 1 for `decommission` and for `delete`. `decommission` has irreversible steps — the final backup it locks and the services and clients it stops and disables for the recovery period — so an automatic re-run after an orphaning is refused, as for `delete`. `tenant.realm_deleted` stays in the registry for the organisation-offboarding realm job, which is not a kind of this catalogue yet; no kind here emits it.

The durable finalizer after every tenant `delete` always issues its attestation with `closure_scope = tenant_only`, including for
the organisation's last tenant. A future organisation-offboarding job, under the organisation lock
exclusive, is the sole producer of `closure_scope = final_organisation`: after every tenant has a
tenant-only attestation and status `deleted`, it closes identity-backup admission at a durable
generation and drains or reconciles every writer registered through that cutoff as specified in
[`../specs/BACKUP_AND_RESTORE.md`](../specs/BACKUP_AND_RESTORE.md) §2.1. Only then does it remove
the realm, obtain an authenticated fresh provider read proving the realm absent, seal the
realm-bearing object inventory through the cutoff, and in the same control-plane transaction record
`tenant.realm_deleted`, the final-organisation active-store attestation and `Organisation.closed`.
That attestation's manifest contains every realm-bearing identity backup identified in
[`../specs/BACKUP_AND_RESTORE.md`](../specs/BACKUP_AND_RESTORE.md) §2.1 and its latest lock expiry.
The transaction emits the existing `tenant.deletion_certificate_issued` action against the final
tenant with `metadata.closure_scope = final_organisation`; the future final-certificate job still
owes a distinct registry action. Organisation/person purge is refused until this exact attestation
exists, and final-certificate issuance is refused until every object in its manifest is purged.

The bucket purge after the last backup object's lock expires, final-certificate issuance after that purge, and the weekly backup prune ([`../specs/BACKUP_AND_RESTORE.md`](../specs/BACKUP_AND_RESTORE.md) §1.3) are infrastructure mutations under ADR-0004 and so must run as jobs. None is a kind of this catalogue yet; they become job kinds in a follow-up. One question is open with them: the tenant's key is issued with an expiry, and nothing yet ensures that the expiry falls after the last backup object's lock, so a key that expires first leaves the purge without a credential until one is re-issued at the ADR-0005 boundary.

Exports requested during the recovery window are ordinary top-level `export` jobs. Their completion
is `export.ready`, the event the `publish` step already emits. The `not_requested` marker and the
deletion-supersession link are job state, not customer events, so no duplicate event row is added.

### `drift_check`

Nightly per tenant, and on demand.

| # | Step | Proof | Timeout | Retry | Compensation |
|---|---|---|---|---|---|
| 1 | `plan` — `tofu plan -detailed-exitcode` against the tenant state file | `declarative`, read-only | 15 min | A | none |
| 2 | `ansible_check` — the tenant's plays in check mode | `declarative`, read-only | 20 min | A | none |
| 3 | `render_registry` — render `tenant.yaml` from the database and diff it against the fleet checkout | `declarative` | 2 min | A | none |
| 4 | `domain_checks` — re-run the recurring domain checks | `guarded` | 5 min | A | none |
| 5 | `record` — write `Tenant.observed`, raise findings | `commit-marker` | 30 s | C | none |

`drift_check` **never** changes anything. It writes `observed`, emits `tenant.drift_detected` with a summary, and alerts. Remediation is a separate, human-triggered job. `max_attempts`: 2.

### `realm_create` and `realm_update`

Organisation-scoped: no tenant lock, and the organisation lock exclusively (§1). The realm is the organisation's one realm (ADR-0006). Each of these runs as its own job, never as a sub-job: `realm_create` runs once for a new organisation, created by the intake before any tenant exists ([`../specs/FIRST_OWNER_BOOTSTRAP.md`](../specs/FIRST_OWNER_BOOTSTRAP.md) §3.1), and is a no-op when the realm already exists; a job that needs a realm change waits on the realm job that makes it. Neither is claimed while a realm-changing outbox delivery for the organisation is in flight or unresolved. Uses the per-realm `realm-management` service account; master-realm rights exist only in the worker (ADR-0003).

| # | Step (`realm_create`) | Proof | Timeout | Retry | Compensation |
|---|---|---|---|---|---|
| 1 | `create_realm` — realm named `Organisation.slug` with the template settings; a no-op when it already exists (ADR-0006) | `read-then-write` | 2 min | A | delete the realm if this attempt created it and it holds no user |
| 2 | `create_clients` — the realm's clients that no single tenant owns, with PKCE, redirect URIs per declared host, logout channels; each tenant's own clients are created by that tenant's `provision` step 9 | `read-then-write` | 2 min | A | delete the clients |
| 3 | `create_service_account` — the per-realm `realm-management` account with `manage-users` and `view-users` only | `read-then-write` | 60 s | A | delete the account |
| 4 | `configure_idp` — brokered provider or hosted-account settings, mappers, allowed email domains, auto-redirect flow | `read-then-write` | 3 min | A | remove the provider |
| 5 | `configure_smtp` — the tenant's own mail credentials | `read-then-write` | 60 s | A | clear the settings |
| 6 | `apply_theme` | `read-then-write` | 60 s | A | reset to default |
| 7 | `verify` — discovery document reachable, a scripted authentication round-trip succeeds | `guarded` | 2 min | A | none |

`realm_update` is steps 2, 4, 5, 6, 7 applied as a difference against the live realm, never a full re-import, so a `--import-realm` mapper defect cannot silently drop configuration.
Audit: `realm.created`, `realm.updated`, `realm.client_changed`, `realm.idp_changed`, `realm.verification_failed`. `max_attempts`: 3.

## 3. Emitted audit events, summary

Every event name above is a member of the closed action registry in [`AUDIT_TAXONOMY.md`](AUDIT_TAXONOMY.md). A job that emits a name absent from that registry fails a contract test. Domain events carry the tenant or organisation URN as their target and the `job_id` that produced them; the generic `job.*` events carry the job's own URN.

## 4. Recovery: `orphaned` and `needs_reconciliation`

From ADR-0004: a runner restart mid-apply must not leave locked state and a half-built project, and it must not repeat an effect nobody can prove stopped.

1. **Detection.** A sweeper runs every 60 seconds and selects jobs with `status IN (leased, running)` and `lease_expires_at < clock_timestamp()`. Every write it makes to such a job is conditional on the fence of the claim it supersedes, so a claim that renewed or finished in the meantime is left alone.
2. **Classify from the dispatch records, never from absence of evidence.** A cutoff-owned job is
   first routed to its existing cutoff job/session children without changing status, steps, lease,
   dispatch or reservation; this branch precedes every ordinary classification. Otherwise, if no
   dispatch is open and no sub-job is non-terminal — a non-terminal sub-job counts as an open
   dispatch whatever its dispatch record says — the job becomes `orphaned`, emits `job.orphaned`,
   its reservation ends and every `running` step returns to `pending`; the sweep never marks a step
   `succeeded`. Otherwise it becomes `needs_reconciliation`: it records `unresolved_step` and
   `unresolved_operation_ref`, emits `job.reconciliation_required`, alerts (the alert is owed, §1),
   and keeps its reservation. An expired lease, a stale heartbeat row or an advisory lock nobody
   holds decides neither way (§1).
3. **No automatic force-unlock.** Nothing in recovery runs `tofu force-unlock`. A re-run that finds the tenant's state file still locked by an earlier run does not unlock it: the step records a dispatch whose operation is the lock identifier before it looks at the lock and, on finding the lock free, retargets that same dispatch to the apply's correlation before the apply starts, so the look and the apply share one dispatch; on finding the lock held the runner holds the job for reconciliation with that dispatch, so the job goes to `needs_reconciliation` because whether that lock's holder stopped is exactly what the operator's decision establishes. A force-unlock is an operator's act after that decision (§1), audited as `job.state_force_unlocked`, and it alerts.
4. **Resume an `orphaned` job.** It is claimed again with a higher fence and re-runs **from the first step whose status is not `succeeded`**. Steps already `succeeded` are skipped on the strength of their idempotency proof, and the claim itself marks `succeeded` a class `C` step whose dispatch in the current resolution cycle closed `completed`, without dispatching it again; a step that cannot prove idempotency is re-run from its beginning after its compensation.
5. **Budget.** Every claim counts against `max_attempts`, except the claim that follows a `resume` decision (§1), so a job is claimed automatically at most `max_attempts` times. The sweep that would make a job `orphaned` when its claims already number `max_attempts` makes it `failed` with `error_code = orphaned_exhausted` instead, ends its reservation, and it never self-recovers again. In A3 a job in `needs_reconciliation` leaves only by an operator's decision; the future retention exception transfers a selected export/decommission dispatch to that job's cutoff child and cancels without a new claim or resume. Cutoff evidence finalization is an independently retried durable obligation, not a job claim, so an unavailable journal/store cannot consume or exhaust this budget.
6. **Class C steps.** A step with retry class `C` is never dispatched a second time automatically. If its dispatch has terminal proof of failure, the job fails, because the class allows one attempt; if its dispatch is open, the job is in `needs_reconciliation` under rule 2. Repeating an irreversible side effect is worse than stopping.
7. **Chaos tests.** One test kills the worker mid-`tofu apply` on a fake provider and runs the sweeper. It asserts that the job becomes `needs_reconciliation` with the unresolved step and operation recorded, that nothing unlocks the state file or repeats the apply, that a stale runner's step write and dispatch are refused on its fence, and that after a recorded `resume` decision the job re-runs from the first non-succeeded step under a higher fence, with no step having run twice with a visible effect and the resulting world equal to the world produced by an uninterrupted run. A second test, for a kind whose budget allows a second claim, kills the worker after a step's claim but before its dispatch, and asserts that the job becomes `orphaned` and recovers automatically.

## 5. What a reviewer checks

- [ ] Every new step names its idempotency proof from the table in §1 and has a test that runs it twice.
- [ ] Every step has a timeout and a retry class; irreversible steps are class `C`.
- [ ] Compensation exists, is idempotent, and is ordered in reverse.
- [ ] The kind's organisation and tenant lock modes are stated in §1 and §2, and shared versus exclusive is justified; a realm change the job needs before it can run is a realm job it waits on, not a step of its own.
- [ ] No step issues an invoice, sends a message or runs a user-level identity operation itself: each of those is an outbox delivery.
- [ ] Every emitted audit action exists in the registry.
- [ ] The desired-state change, the job and the audit row commit in one transaction.
- [ ] A chaos test covers the job's longest-running step.

## Changelog

- Specifies the future 90-day exit and earlier-deletion protocol without claiming runtime support: generation-barrier termination, independent recovery exports, one cutoff child per selected job, exact claim-session reap before reservation release, durable evidence reconciliation, destruction completion followed by non-exhausting finalization, and separate locked-backup final certification.
- First version. Fixes assessment item C4: the closed list of fifteen job kinds with ordered steps, per-step idempotency proofs, timeouts, lease renewal, compensations, retry classes and emitted audit events, plus the orphan-recovery procedure required by ADR-0004 with its no-live-runner guard on `tofu force-unlock`.
- Emits only names the closed registry of `AUDIT_TAXONOMY.md` §3 carries, so the catalogue's own contract test can pass: `provision` emits `realm.created` rather than `tenant.realm_created`, and `decommission` emits `export.ready` — the `export` job's own completion event — rather than a second name for the same fact.
- Starts provisioning from a verified human-controlled project bootstrap instead of granting organisation-level project and IAM creation to the general worker.
- Makes the realm an organisation property throughout, as ADR-0006 decides: `provision` step 9 and `realm_create` step 1 are no-ops when the organisation's realm exists, and `suspend`, `decommission` and `delete` act on the tenant's clients so one tenant's lifecycle can no longer disable or delete a realm its sibling tenants are still using.
- Adds `bootstrap_verify` as the sixteenth kind and the one place a `ProjectBootstrap` is verified; `provision` step 3 re-checks the same evidence and fails closed. States that the provider key is the human-issued key of ADR-0005, loaded per job and never revoked by the worker.
- Aligns the catalogue with ADR-0003 and ADR-0004 as accepted. A claim takes a higher `fence`, and every step, status and dispatch write is fenced. A lost lease or an unknown outcome leaves `orphaned` only when no dispatch is open, and `needs_reconciliation` otherwise, which only an operator's recorded decision leaves, through the closed `resume` and `fail` exits and outside `max_attempts`. §4 no longer force-unlocks anything automatically. The lock classes and their fixed order, the organisation-lock mode per kind, durable reservations, request-order claims and the reservation checks are stated. `realm_create` and `realm_update` are their own jobs, which `provision` no longer runs as step 9: that step now creates this tenant's own clients only. Invoice issuance and every notification are outbox deliveries, not job steps. The upgrade rollback no longer claims to be loss-free, and the shared ops age identity is limited to `lab` and `staging`. `provision` step 8 no longer issues the backup key and `delete` step 7 no longer closes the project: both acts belong to the ADR-0005 boundary, where the operator revokes the tenant's key and then closes the project, and only after the worker has purged the bucket.
- Review fixes. A tenant `delete` never deletes the organisation's realm, even for the last tenant, and holds the organisation lock shared; `tenant.realm_deleted` is left to a future organisation-offboarding realm job. The decision `external-execution-stop-evidence` must be taken before any job with a real provider effect runs, `lab` included, and no exit from `needs_reconciliation` counts against `max_attempts`. A realm-changing outbox delivery no longer starts while a realm job waits, and an unresolved delivery follows the job rule. `409 tenant-locked` is only for a conflict with an exclusive hold or reservation. Sub-job claims run no checks and need the parent `running` under the dispatching fence; `lock_requested_at` is database time and never backdated. Every writer that can end a reservation is named, and the allocation-generation lock is not reserved. A correlation read that finds an effect absent counts only when the call is proven ended or a late landing converges. The bucket purge and backup prune are named as owed job kinds, `revoke_secrets` leaves the tenant key for the operator, and a key expiring before the backup lock is open. A job whose realm job failed is failed at claim. The non-job takers of the organisation lock are named, the owed `needs_reconciliation` alert and runbook are named as a follow-up, and the restore paragraph states what a restore does not bring back.
- Second review fixes: every ending write of a reservation is conditional on `ended_at IS NULL` and the job's current status and fence; the stop-evidence gate reads "no job with a real provider effect runs", matching the provider-verification-only probes of ENVIRONMENT_ALLOCATION §6; the delivery convoy behind a waiting realm job is stated as deliberate; a delivery whose second check fails releases the lock and does not start.
- Records the owner's decision `external-execution-stop-evidence`: an operator decision leaves `needs_reconciliation`, for a job or a delivery, only with provider-API evidence that the compute which ran the operation is terminated and a fresh read of the target resource recording what it did; lease expiry, a missed heartbeat or a released lock never count, and the other live gates of `ENVIRONMENT_ALLOCATION.md` §6 still apply. Follows the lead's ruling that a failed `provision` automatically compensates step 9, deleting only the tenant's own clients. A job whose realm job failed is failed before any lock check and holds no place in request order. States the orphan budget as a number of claims, decided at the sweep. The queue that implements §1 and §4 is specified in [`../specs/JOB_QUEUE.md`](../specs/JOB_QUEUE.md).
- Review round one of the job-queue specification. The sweep failing a job `orphaned_exhausted` ends its reservation, and is named among the writers that may. Non-job takers of the organisation lock use the jobs' key function. Sub-jobs never hold a place in request order, close their parent's dispatch when they end, and are failed `parent_not_running` when stranded; a parent's decision waits for them. `provision` step 9's compensation deletes the tenant's own clients by natural key in the owning claim, and a failure no runner owns enqueues a compensation job whose kind is owed with the contract; the `fail` exit says so. `decommission` gets `max_attempts` 1. A state-file lock is recorded as a dispatch before it is looked at. The orphan chaos test names a kind whose budget allows the re-run.
- Review round two of the job-queue specification. Only a sub-job's effect-starting writes need its parent running, and every writer that ends a sub-job closes the parent's dispatch with the sub-job's outcome; the parent never closes it, nor finishes past a live sub-job. The sweep never marks a step `succeeded`: a class `C` step closed `completed` is marked by the next claim. A state-file lock look and its apply share one dispatch. The owning claim ends its reservation only by making the job terminal, as `MODEL.md` §8 says; only the sweep orphans a job. `provision` step 9's compensation applies once step 9 is no longer `pending`, with the same lock set claimed in request order and a derived key, and its enqueuing waits for its kind.
- Review round three of the job-queue specification. §1's lease paragraph matches the queue: `clock_timestamp()`, and a renewal that locks the job's row first and checks the lease again under the lock. The lead's application of the owner's stop-evidence decision to a dispatch that names a sub-job is stated here, with what the queue does and does not check. A step-9 compensation job takes the latest place in request order, and the consequence is stated.
- Review round four of the job-queue specification. The step-9 compensation key is the queue specification's JSON-array derivation, not a delimiter-joined string. A job takes its place in request order once the job it waits on `succeeded`, not merely ended. The `resume` exit says what happens to a dispatch a sub-job's terminal write had already closed.
- Lists the pilot's operator commands that bind the intended owner and reissue or revoke an owner claim among the non-job takers of the organisation lock, exclusive and non-blocking for one transaction, under the jobs' key function (`../specs/FIRST_OWNER_BOOTSTRAP.md` §§5.6, 6.6). Also lists `initialiseWorkspace`, which the list had not named: it takes the lock exclusively, and how it waits is `../specs/PILOT_WORKSPACE_ONBOARDING.md` §6 step 3's.
- `delete` no longer waits for unpaid invoices: it runs at the end of the recovery period whatever is still owed (CGV 16.6), and leaves Core's billing records. `resume` completes by the next business day, as the terms say.
