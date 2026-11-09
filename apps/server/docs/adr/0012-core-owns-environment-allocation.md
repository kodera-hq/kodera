# ADR-0012: Core owns environment allocation and live-command authority

**Status:** Proposed
**Owner:** Security seat
**Deciders:** API seat, Worker seat, Infra seat, Security seat

## Context

The control plane already records provider identifiers on tenants, hosts, IPs and
domains, while `deployment operations` also needs a global view to prove that two
environment classes do not share a project, prefix, bucket, principal or DNS
zone accidentally. Neither representation is yet an authoritative allocation
ledger. Keeping both writable would make a clean preflight result meaningless:
the other registry could change or disagree before a live command starts.

The environment boundary has six closed classes: `lab`, `staging`,
`demo-canary`, `platform-prod`, `tenant-prod` and `tenant-shared-prod`. The
sixth, for shared-plan tenants in one shared provider project, is decided in
ADR-0014. Platform targets do not belong
to a customer organisation, so they cannot be represented as a tenant with a
fake organisation merely to fit the current data model. Conversely, a worker
must not receive the global inventory just because it needs the projection for
one target.

ADR-0004 makes the desired-state change, job, steps and audit row atomic, and
gives every claim a strictly increasing `fence`, but a queued job does not yet
bind the allocation generation it was validated against. A runner identity and
lease do not exist when the job is created, so one object cannot truthfully be
both the job-time snapshot and the attempt-time execution authority.

ADR-0003 correctly keeps infrastructure credentials out of the internet-facing
API. Its shared operations age identity, however, is not target-isolated and
therefore cannot satisfy the environment boundary for live production. The
human-controlled project bootstrap in ADR-0005 remains the root of trust until
the separately gated allocator described there is accepted and built.

## Decision

### One allocation authority

Core owns a normalized environment allocation ledger with append-only revision
history. After a reviewed genesis import, it is the only writable allocation
authority.
Repository manifests and generated exports are immutable evidence or inputs;
they MUST NOT remain parallel registries.

Every committed allocation change creates exactly one monotonically numbered
ledger revision and atomically advances a singleton head. The revision contains
bounded, versioned canonical bytes and their digest. Allocation writers
serialize on the head rather than relying on sequence allocation order.

Core-owned records use UUIDv7 under ADR-0009. Provider identifiers keep their
provider-native representation. An active provider resource identity can have
only one owner target and is not reusable at launch. Prefix containment is a
collision in either direction. Cross-target consumption is closed by default;
only a service endpoint may be shared, and only through an exact, reviewed
decision naming every consumer target.

The ledger becomes authoritative for provider identity. Existing tenant, host,
IP and domain fields become foreign keys or derived projections in a later
migration; they MUST NOT remain independently writable copies.

Every environment class is disabled by default. A reviewed ledger decision may
move one class to synthetic-only execution, read-only provider verification or
live mode and names the exact allowed operations and evidence. Synthetic mode
cannot produce live evidence. The decision is bound and rechecked at claim,
credential delivery, receipt issue/use and the final entry point.

### Two distinct execution artifacts

Job creation atomically stores an immutable `JobAllocationSnapshot` with the
desired-state change, `Job`, `JobStep`, exact credential requirements and audit
event. The snapshot pins one ledger revision, one target projection, the policy
digest and the desired-state digest. It contains no runner, attempt or lease
claim because none exists yet.

Each authenticated claim creates a `JobAttempt` with a new random lease ID and
a monotonically increasing fence for that job. Normal lease renewal changes the
expiry only; it does not change the lease ID or fence. Reclaiming an orphan
creates a new attempt and fence, invalidating every earlier execution authority.

After validating the pinned full revision, a separate coordinator signs a
bounded `TargetReceipt` for one exact command. The receipt binds the job,
snapshot, target, attempt, authority epoch, fence, lease ID, executor identity
and audience, class enablement, allocation generation, policy, desired state,
target projection, Fleet revision, command identity, issuer and validity
interval. A receipt is consumed once. Replaying it MUST NOT launch a second
command.

If the allocation generation changes, the job is stale. Recovery MUST NOT
silently rebase it; an explicit replacement job is created from current desired
state and a new snapshot.

### Runtime separation and locks

The API, allocation writer, coordinator/exporter, credential broker, target
executor, external head-seal service and offline recovery principal are
separate runtime identities:

- the API may request an approved allocation change and invoke one fixed,
  owner-controlled snapshot-creation database function, but cannot select or
  mutate ledger rows directly;
- only the allocation writer may mutate the ledger; it has no provider,
  signing or secret-redemption authority;
- only the coordinator/exporter database role may read the global ledger and
  sign snapshot attestations and receipts;
- the coordinator holds no provider credential and no secret-unwrapping right;
- a separate credential broker validates the exact receipt and exchanges an
  opaque reference for a one-job, target-restricted credential; it has no
  ledger-writing or signing right and no standing fleet-wide secret right;
- the target executor has no general Core database credential, global-ledger
  right, secret-store right or receipt-signing key;
- the executor receives only the canonical projection for one target, one
  exact receipt and credentials restricted to that job and target;
- the head-seal service can append and authenticate only ledger ID, authority
  epoch, generation and digest; it receives no canonical ledger bytes and
  cannot mutate Core;
- the offline recovery principal is unavailable to normal runtimes and can act
  only during reviewed quiescent recovery; and
- the internet-facing API holds none of the coordinator, executor, provider or
  secret-redemption authorities.

The coordinator-side runner holds a dedicated, non-pooled database session with
a shared allocation-generation lock, the applicable whole-attempt target lock
and an attempt-fence lock from claim until the attempt and every dispatched
command have terminal proof.
Allocation changes take the exclusive generation lock; orphan reclamation
takes the attempt-fence lock before it can replace an attempt. Receipt
consumption checks the current authority epoch, generation, live attempt,
fence, lease, executor and command while those locks are held. No database
transaction is kept open for the duration of an external command.

Losing lease renewal causes the runner to stop and reap the child process. A
database connection or authenticated control channel is not evidence that a
local or remote child stopped: every dispatch leaves a durable open record, and
only a signed terminal attestation from the actual execution sink closes it.
Allocation changes and replacement attempts fail closed while such a record is
open. A local supervisor kills the whole process group on control loss and
attests confirmed exit; a remote Agent must enforce the fence and durable
one-shot receipt itself. Until its contract does so, remote mutating commands
remain blocked. Automatic recovery remains limited to steps whose idempotency
proof permits it; retry-class-C steps require an operator decision.

### Credential boundary

The snapshot records exact credential requirements, never secret values. An
attempt records append-only evidence of the authenticated principal, issuer,
audience, validity, effective capability set, effective resource set and a
denied out-of-target probe. Verification succeeds only when the required and
effective relational sets are equal.

The shared operations age identity in ADR-0003 does not satisfy this contract,
and ADR-0003 accepts it for `lab` and `staging` only. Live execution in
every other class — `demo-canary`, `platform-prod`, `tenant-prod` and
`tenant-shared-prod` — remains blocked until a separate accepted decision and
implementation provide target-isolated decryption and one-job secret delivery.
In `tenant-shared-prod` the gate is stated per tenant: the decryption is
isolated per tenant, not only per target, so that one tenant's delivery cannot
decrypt another member's bundle, and the shared operations age identity is not
accepted there (ADR-0014). This ADR does not
authorize the future privileged allocator from ADR-0005 and does not give its
credentials to the coordinator.

### Visibility and recovery

Allocation heads, revisions, imports, global resource identities and share
decisions are `fleet-confidential` internal-global data. They are neither
customer-scoped rows nor public catalogues. No customer, support or agent route
may enumerate them. A target projection is produced by a positive relational
selection; full-ledger bytes are never serialized and filtered afterward.

Genesis import is accepted only against an empty generation-zero ledger.
Recovery import requires quiescence, reviewed evidence, preserved Core
identifiers and complete tombstones, an independently durable signed head seal,
and an atomic new revision greater than any accepted generation. Recovery
increments the authority epoch, revokes old sessions and receipt keys, and
keeps execution disabled until the new head seal is acknowledged. Imported
resources enter quarantine and require live reconciliation before a later
revision activates them. Credentials are reissued, never restored from a
manifest.

## Relationship to accepted decisions

- ADR-0003's prohibition on infrastructure credentials in the API is
  preserved and extended to receipt signing and secret redemption. On
  acceptance, this decision supersedes only ADR-0003's authorization of a
  shared operations age identity; all other ADR-0003 controls remain in force.
- ADR-0004's atomic job creation is preserved and extended with the allocation
  snapshot and credential requirements. Its mutable lease projection is fenced
  by distinct, monotonically fenced attempts, each carrying the job's `fence`.
  ADR-0004 already lets a job with an open dispatch progress only on
  authenticated terminal proof or a safe convergent outcome, and otherwise
  leaves it in `needs_reconciliation`; this decision names that proof as a
  signed `CommandTerminal` from the actual execution sink. It also narrows the
  manual pilot and break-glass allowance: a runbook is additional evidence,
  never a bypass around snapshot, receipt, fencing, credential or entry-point
  controls.
- ADR-0005's human-controlled bootstrap remains in force. Allocation ownership
  does not imply organisation-level provider authority.
- ADR-0009 governs every Core-generated identifier introduced here.
- ADR-0014 (proposed) extends the closed class list to six with
  `tenant-shared-prod`, and states the live-execution gate per tenant for that
  class. A shared tenant's use of the shared hosts and database is its tenant
  placement inside one target, not cross-target consumption through an
  endpoint share decision.
- Acceptance of this ADR alone does not make any live Fleet target available.
  The contract gates in the environment-allocation specification and Fleet
  policy must pass first.

## Options considered

| Option | Decision |
|---|---|
| Keep Fleet manifests and Core rows as writable peers | Rejected. Two authorities cannot prove collision freedom or recover deterministically. |
| Put the global inventory in every worker payload | Rejected. A target compromise would disclose other targets and customer topology. |
| Bind the runner and lease in the job-time snapshot | Rejected. They do not exist until a later claim. |
| Validate once, then run without a generation lock | Rejected. Allocation or ownership can change between validation and side effect. |
| Use one global generation at launch | Chosen. It is conservative and can stale unrelated queued jobs, but gives the smallest auditable safety proof. |
| Reuse retired provider identifiers | Deferred. Safe reclamation needs temporal collision rules and evidence that are not needed for launch. |
| Store target credentials in Core | Rejected. Core stores requirements, fingerprints and opaque references, never credential values. |
| One normalized ledger plus immutable snapshots and fenced receipts | Chosen. It separates authority, evidence and execution without weakening ADR-0003. |

## Consequences

- Allocation changes wait while a live side-effecting command holds the shared
  generation lock. This is an accepted launch trade-off for a global proof.
- Allocation writes and live claims stop while the independent current-head
  seal is unavailable or unacknowledged. Availability cannot override rollback
  protection.
- Any allocation revision makes older queued jobs stale, even if their target
  did not change. Dependency-closure generations may be proposed later only
  with an equivalent collision proof.
- The Core model, job catalogue, threat model, audit taxonomy and Agent contract
  need explicit follow-up changes before implementation.
- Fleet must split its current single bundle into a job-time snapshot and an
  attempt-time envelope, and define lease binding as stable lease ID plus fence,
  not the renewable expiry timestamp.
- DNS delegation beneath a platform parent remains blocked until an explicit
  ownership/delegation model is accepted; it receives no endpoint or implicit
  cross-class exception.
- No live provider call is enabled by this documentation change.

## References

- [ADR-0003](0003-api-holds-no-infrastructure-credential.md)
- [ADR-0004](0004-postgres-backed-job-queue.md)
- [ADR-0005](0005-human-controlled-project-bootstrap.md)
- [ADR-0009](0009-uuidv7-primary-identifiers.md)
- [ADR-0014](0014-shared-tenant-environment-class.md)
- [Environment allocation contract](../specs/ENVIRONMENT_ALLOCATION.md)

## Changelog

- Proposes Core as the only writable allocation authority and separates the
  immutable job snapshot from the fenced attempt receipt.
- Keeps global inventory and receipt signing out of the API and target executor.
- Makes import, projection, credential equality, replay and recovery gates
  explicit while leaving every live target blocked.
- Follows ADR-0003 and ADR-0004 as accepted: drops the statement that the job
  lease has no fencing token, since ADR-0004 now has `fence`; blocks live
  execution in every class but `lab` and `staging`, not only
  `tenant-prod`; and no longer quotes an orphan-recovery phrase the accepted
  ADR-0004 removed, stating instead how this decision's terminal proof fits its
  `needs_reconciliation` rule.
- Agrees with ADR-0014 before either is accepted: six closed classes with
  `tenant-shared-prod`, and the live-execution gate stated per tenant for that
  class.
