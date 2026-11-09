# Environment allocation and execution-authority contract

**Status:** Proposed · **Owner:** Worker seat

This specification is the implementation contract for ADR-0012. It defines the
authoritative Core records, transaction boundaries, target projection, runner
fencing, signed command receipt, import rules and acceptance tests required
before any `deployment profiles` live entry point may run.

The terms MUST, MUST NOT, SHOULD and MAY are normative. This document does not
enable a provider call. Synthetic validation and fake-provider tests are the
initially permitted targets. The separately reviewed, read-only
`provider-verification-only` transition in §6 is the sole pre-live exception;
it never authorizes a provider mutation.

## 1. Closed vocabulary and invariants

### 1.1 Environment targets

`EnvironmentTarget.environment_class` is exactly one of:

| Class | Data | Exposure | Failure mutation | Recovery | Subject kind | Customer tenant |
|---|---|---|---|---|---|---|
| `lab` | `synthetic` | `private` | `allowed` | `recreate` | `synthetic-tenant` | forbidden |
| `staging` | `synthetic` | `private` | `controlled` | `recreate` | `shared-staging-platform` | forbidden |
| `demo-canary` | `public-service` | `public` | `forbidden` | `production` | `free-demo-service` | forbidden |
| `platform-prod` | `platform-records` | `mixed` | `forbidden` | `production` | `shared-production-platform` | forbidden |
| `tenant-prod` | `customer-tenant` | `public` | `forbidden` | `production` | `paid-tenant` | required |

The class-to-subject mapping is a database constraint, not application
convention. An active `tenant-prod` target has exactly one tenant, and a tenant
has at most one active production target. It also has exactly one active
`provider-project` allocation with the `tenant-project` role. Non-tenant classes
MUST NOT acquire an `organisation_id` or `tenant_id` to satisfy an existing
queryset.

Each target stores the accepted Fleet environment-policy contract version and
digest. Its data, exposure, mutation and recovery properties are validated
against that closed policy; Core does not invent a second class definition.
Target class, subject kind and tenant binding are immutable. Retirement creates
a ledger revision and never releases its identifiers for reuse.

Execution authority is a separate fail-closed state. An absent record means
`disabled`. `EnvironmentClassEnablement.mode` is one of `disabled`,
`synthetic-execution`, `provider-verification-only` or `live`; it names the
class, authority epoch, policy and evidence digests, exact allowed operations,
approving seats and accepted/superseded generations. Every change creates a
ledger revision. Its revision and digest are bound into snapshots and receipts
and checked again at claim, credential redemption, receipt issue/use and the
final entry point.

`synthetic-execution` accepts only `fixture-validation`, reserved fixture
namespaces, the reviewed synthetic authority, content-addressed fake
executables and explicit operations `synthetic-render`, `synthetic-plan` and
`synthetic-apply`. Network access and credential-broker/provider access are
denied. It cannot satisfy or transition a live gate. Core and Fleet must add it
through a contract-version decision before the synthetic receipt pipeline is
implemented; a disabled class never receives an implicit test exception.

### 1.2 Resource and sharing rules

`ResourceAllocation.kind` is exactly `provider-project`, `state-backend`,
`dns-zone`, `identity-realm`, `bucket`, `secret-prefix`, `service-endpoint` or
`principal`, matching Fleet contract version 1. Adding a kind requires a
contract-version decision, migration, canonicalizer, collision test, projection
rule, Fleet consumer contract and self-test mutation. Alert routes are not yet a
typed Fleet resource, and neither are network prefixes. Live targets remain
blocked until contract-versioned allocation kinds or equally explicit isolation
contracts exist for both.

Every resource has a generated `canonical_id`, its canonicalizer version and
exactly one owner target. Normal creation accepts typed fields and derives the
identifier. Import supplies both and must prove byte equality with the value
derived from those typed fields. The database rejects:

- a non-canonical identifier rather than silently rewriting it;
- a second allocation with the same `(kind, canonical_id)`, including a retired
  identifier;
- either-direction prefix containment after segment normalization;
- a subtype row whose type does not match the resource kind;
- an ownership change in place; or
- retirement while an active share, nonterminal job, live grant or unexpired
  command authority still depends on the resource.

Historical snapshots retain their foreign keys and prevent physical deletion
or identifier reuse, but do not prevent retirement. A retirement generation
stales every queued snapshot from the prior global generation.

The initial subtypes are:

| Subtype | Required typed fields |
|---|---|
| Provider project | provider, provider-native project identifier |
| State backend | provider, bucket-allocation FK, canonical state key |
| DNS zone | normalized absolute zone, exposure |
| Identity realm | issuer base, provider-native realm identifier |
| Object bucket | provider, canonical bucket identifier, data role |
| Secret prefix | provider, canonical path and normalized segments |
| Service endpoint | protocol, canonical address, exposure |
| Machine principal | issuer, subject or public-key fingerprint |

Cross-target consumption is forbidden unless the resource is a service
endpoint with one active `EndpointShareDecision`. A decision contains an
accepted ADR reference and digest, compensating-control evidence, reviewer seat,
accepted generation and exact consumer rows. Wildcards, environment-class
consumers and implicit same-class sharing do not exist. DNS delegation is an
ownership relationship to be specified separately; it is not endpoint sharing
and receives no silent prefix-overlap exception.

An accepted ADR reference is an allow-listed repository identity, immutable
commit SHA, repository-relative path and content digest of a document whose
parsed status is `Accepted` and whose commit satisfies the configured review or
signature policy. Branch names, mutable URLs, untrusted repositories, free-text
labels and a caller's status claim do not establish acceptance.

Fleet contract version 1 does not yet provide a closed live capability
vocabulary beyond its authority-operation matrix. Live receipts remain disabled
until Core and Fleet publish one versioned capability registry, including
implied-permission normalization, and bind its digest into grant requirements.

### 1.3 Visibility classes

Every Core table belongs to exactly one exhaustive visibility class:

1. `organisation-scoped`, reachable from `organisation_id` in at most one join;
2. `public-global`, one of the enumerated catalogues; or
3. `fleet-confidential`, internal-global and unavailable to customer, support
   and tenant-agent querysets.

The allocation head, revisions, imports, global resources, share decisions,
runner sessions, credential evidence and receipt records are
`fleet-confidential`. Job snapshots remain visible only through existing
job-authorisation rules and expose digests and safe status, never canonical
bytes, full identifiers, grant evidence, receipt signatures or secret
references. A reflection test enumerates all tables and route serializers so a
new table or field cannot fall between classes.

## 2. Authoritative relational model

All Core-owned primary keys below are UUIDv7. Provider identifiers and external
subjects are opaque provider-native strings.

### 2.1 Ledger and targets

| Entity | Required fields and constraints |
|---|---|
| `AllocationHead` | Singleton key, immutable `ledger_id`, monotonic `authority_epoch`, `current_generation bigint`, `current_revision_id` nullable only at generation zero, `head_digest` and external-seal state. Every allocation write locks this row first. |
| `AllocationRevision` | `id`, unique positive `generation`, parent generation and digest, canonical full-ledger bytes, SHA-256 digest, schema and canonicalizer versions, actor, reason/import reference, `created_at`. Append-only. |
| `EnvironmentTarget` | `id`, unique non-reusable key, closed class, data/exposure/mutation/recovery tuple and subject kind, nullable tenant FK, policy version/digest, lifecycle, created and retired generation FKs. Class, tuple, subject and tenant binding immutable. |
| `ResourceAllocation` | `id`, closed kind, unique non-reusable `(kind, canonical_id)`, canonicalizer version, display label, role, owner target, created and retired generation FKs. Append-only identity and ownership. |
| Resource subtype | One-to-one FK to `ResourceAllocation`; typed fields and checks from §1.2. |
| `EndpointShareDecision` | Endpoint FK, accepted ADR path/digest, control-evidence reference, reviewer seat, accepted and superseded generation FKs. At most one active decision per endpoint. |
| `EndpointShareConsumer` | Decision FK and consumer-target FK, unique as a pair. No wildcard representation. |
| `EnvironmentClassEnablement` | Class, authority epoch, closed mode, policy/evidence/operation-set digests, approving seats, accepted and superseded generation FKs. Absence means disabled; one active row per class. |
| `EnabledOperation` | Enablement FK plus exact authority, operation and mode tuple; unique as a tuple. Frozen on decision acceptance; its canonical set produces the operation-set digest. |
| `ResourceReconciliationDecision` | Resource FK, authority epoch and allocation-revision/generation composite FK, decision `quarantined`, `activated` or `rejected`, verifier and evidence digest. Immutable; unique `(resource, authority_epoch, generation)`. |
| `DecisionRepositoryPolicy` | Allow-listed repository identity, path policy, review/signature policy, accepted/superseded generation FKs. No caller-supplied repository is trusted implicitly. |
| `WorkloadSigningKey` | Authority epoch, issuer, key ID, purpose `snapshot`, `receipt`, `terminal`, `head-seal`, `recovery-export` or `recovery`, audience, public-key fingerprint and validity. Unique `(authority_epoch, issuer, key_id, purpose)`. Public verification material only. |
| `WorkloadSigningKeyRevocation` | Signing-key FK, revoking authority, reason, evidence digest and revoked instant. Immutable, unique per key; presence means revoked. |
| `RecoveryExportEnvelope` | Ledger ID, authority epoch, head generation/digest, complete canonical history/tombstone export digest and bytes, schema/canonicalizer versions, purpose-bound signer/key, audience, issued/expiry, nonce and signature. Immutable. |

`AllocationRevision.canonical_bytes` are a full, secret-free ledger document,
not a database dump. The versioned canonicalization contract defines field
names, ordering, Unicode treatment, number representation and set ordering.
Sets are sorted by stable canonical identity before serialization. A digest is
`sha256:<lower-case hex>` over exactly those bytes. Canonical bytes and digest
are bounded before insert and immutable after commit.

Launch bounds apply to canonical UTF-8 bytes before database insert or
signature verification:

| Artifact | Maximum |
|---|---:|
| Full ledger revision or import | 32 MiB |
| Complete recovery export | 128 MiB |
| Target projection or desired state | 2 MiB |
| Snapshot attestation, target receipt or command terminal | 64 KiB |

Exact-limit input is accepted; one byte over returns
`allocation.artifact_too_large`. Raising a limit is a reviewed contract-version
change with memory, database and denial-of-service evidence.

Every subtype contains its constant `kind`, a `CHECK`, and a composite foreign
key `(resource_id, kind)` to unique `(ResourceAllocation.id, kind)`. A deferred
constraint proves every allocation has exactly one matching subtype. Secret
prefixes use a versioned normalized-segment containment function.
Creation/retirement generation references are initially deferred so the post-
change revision and its rows can commit atomically.

Normal allocation creates exactly one initial `activated` reconciliation
decision in its creation revision after validation. Genesis and recovery import
create exactly one initial `quarantined` decision per resource. Only a later
ledger revision with independent provider evidence may append `activated`.
Current state is the decision at the greatest accepted generation in the
current authority epoch; the composite uniqueness and head serialization make
that ordering deterministic. Projection, credential requirements and
enablement select only resources whose current decision is activated.

### 2.2 Job snapshot and credential requirements

| Entity | Required fields and constraints |
|---|---|
| `JobAllocationSnapshot` | Unique non-null job FK, target FK, authority epoch, allocation revision/generation/digest, enablement revision/digest/mode, environment-policy version/digest, desired-state canonical bytes/digest, target-projection canonical bytes/digest, contract and canonicalizer versions. Immutable. |
| `JobExecutionEligibility` | Unique job FK, state `awaiting-attestation`, `eligible` or `stale`, attestation serial when eligible and reason when stale. Controlled projection; not a Job status. |
| `SnapshotResource` | Snapshot FK and exact resource-allocation FK included in its dependency closure; unique pair. |
| `CredentialGrantRequirement` | Snapshot FK, target FK, principal allocation FK, issuer, audience, policy digest and requirement state. No secret value. |
| `RequiredCapability` | Requirement FK and one closed capability; unique pair. |
| `RequiredGrantResource` | Requirement FK and exact resource-allocation FK; unique pair. |
| `SnapshotAttestation` | Snapshot FK and monotonic serial, coordinator/exporter workload identity, issuer, audience and key ID; job, target, authority epoch, allocation revision/generation/digest, enablement, policy, desired/projection, contract/canonicalizer and Fleet revision digests; issued/expiry instants and signature. Immutable; validity windows do not overlap. |

`Job.environment_target_id` becomes mandatory for infrastructure jobs. Tenant
jobs bind to their active `tenant-prod` target. Platform, staging, demo and lab
jobs bind directly to their non-tenant target and MUST NOT invent an
organisation. Jobs that cannot yet name a target cannot reach a Fleet live
entry point.

The immutable job specification comprises its identity, kind, actor, requested
desired state, target, idempotency key, parent, snapshot and ordered step
definitions. Status, scheduling and lease fields are a controlled operational
projection, not evidence that the whole `Job` row is append-only. Its allowed
updates are closed and database-enforced.

Job creation uses ADR-0004 status `queued` and leaves its separate eligibility
projection in `awaiting-attestation`. The
coordinator/exporter reads the snapshot and global revision directly through
its direct ledger-read role, validates them, then invokes one narrowly scoped
owner-controlled attestation function that writes the signed
`SnapshotAttestation` and makes eligibility `eligible`. Database role and
transaction provenance authenticate Core-to-coordinator input; there is no
second exporter service. Attestations last at most 24 hours, are immutable and
have non-overlapping validity per snapshot; a later serial may renew one without
changing snapshot bytes. Claim and receipt issuance require exactly one
currently valid attestation whose key is not revoked.

### 2.3 Runner, attempt, evidence and receipt

| Entity | Required fields and constraints |
|---|---|
| `RunnerSession` | Authenticated issuer, subject, key/certificate fingerprint, boot/session nonce, authority set, started, last heartbeat, revoked and ended instants. Identity comes from the workload authenticator, never a request body. |
| `ExecutorSession` | Authenticated execution-sink issuer, subject, audience, key/certificate fingerprint, target, boot/session nonce, started, revoked and ended instants. A tenant Agent session maps here but remains a distinct authenticator. |
| `JobAttempt` | Job and runner-session FKs, unique monotonic `(job, attempt)` and `(job, fence)`, globally unique random `lease_id`, authority epoch, snapshotted authority, claimed/expiry/ended instants and terminal reason. A partial unique constraint permits at most one live attempt per job. |
| `CredentialGrantObservation` | Requirement and attempt FKs, actual principal fingerprint, issuer, audience, policy digest, not-before/expiry, opaque secret reference and denial-probe evidence. Immutable. |
| `CredentialGrantVerification` | Unique observation FK, verifier identity, exact required/effective set digests, decision and evidence digest. Immutable terminal decision. |
| `EffectiveCapability` | Observation FK and one closed capability; unique pair. |
| `EffectiveGrantResource` | Observation FK and exact resource-allocation FK; unique pair. |
| `TargetReceipt` | Snapshot, target, attempt, authority epoch, fence and lease ID; exact runner session/effective authority/authority-matrix version and digest; exact executor session/issuer/subject/audience; exact operation and command identity; Fleet revision; enablement, allocation, policy, desired and projection digests; issuer/key ID; issued/not-before/expiry instants; globally unique issuer/nonce; detached signature. Immutable. |
| `ReceiptUse` | Unique receipt FK, authenticated executor session, verified command identity and consumed instant. Immutable consumption fact. |
| `CommandDispatch` | Unique receipt-use FK, job/attempt/fence/executor binding, command digest and dispatch instant. Its absence of a terminal row is a durable execution blocker. |
| `CommandTerminal` | Unique dispatch FK; terminal version and nonce; signer issuer/key/signature; dispatch/receipt and receipt-nonce FKs; command digest; job/target/attempt/lease/fence; executor session; launch state; local supervisor boot/spawn/process-group identity or remote operation identity; exit/result digest; termination instant and state `confirmed`. Immutable signed artifact. |

A deferrable constraint permits a `CredentialGrantVerification(decision =
verified)` only when required and effective capability sets are exactly equal,
required and effective resource sets are exactly equal, issuer/audience/policy
match, validity covers the bounded command window and the exact out-of-target
probe was denied. A subset match is a failure.

Composite keys and deferred composite foreign keys carry job, snapshot and
target through requirements, observations and verification. They prove that
the principal is a `principal` allocation owned by the target, the attempt's job
equals the snapshot job, and every grant resource belongs to both the target
and `SnapshotResource` dependency closure. Consumed shared endpoints are never
grant resources.

The workload trust contract MUST name the trust anchor, accepted issuer,
audience, maximum assertion lifetime, revocation mechanism and mapping from
authenticated identity to runner authority before `RunnerSession` is
implemented. Body fields and network location are never provenance. Claim and
receipt issuance authenticate the runner and verify authority, class and exact
operation against the versioned Fleet authority-operation matrix. Receipt use
rechecks that decision; the final entry point verifies the signed runner-
session, effective-authority and matrix-digest claims as the coordinator's
attestation. Recording or repeating an authority string is not authorization.

A terminal record is accepted only through the owner-controlled terminal
function after authenticating the bound executor. The function verifies the
closed canonical terminal bytes, terminal-purpose signing key, signature,
unique issuer/nonce, exact dispatch/receipt/command/job/target/attempt/lease/
fence/executor binding, process or operation identity and `confirmed` state. A
wrong or unverifiable terminal leaves the dispatch open and therefore cannot
release allocation or replacement fencing.

### 2.4 Immutability and closure transitions

The ledger history is append-only; not every operational row is. The allowed
write matrix is closed:

| Record | After initial insert |
|---|---|
| Revision, import, reconciliation decision, snapshot, attestation, receipt, receipt use, dispatch, terminal, observation, verification | No update or delete |
| Workload signing key and revocation | Key metadata never changes; one immutable revocation fact may be appended and is effective immediately for new verification |
| Allocation head | One writer transition advances generation/revision/digest and sets seal pending; only an authenticated exact seal acknowledgement changes pending to acknowledged |
| Target or resource | One `active` → `retired` transition that sets its retirement generation exactly once; identity and ownership never change |
| Share or enablement decision | One active → superseded transition that sets its superseding generation exactly once; replacement is a new row |
| Job eligibility | `awaiting-attestation` → `eligible`, renewal to a later attestation serial, or one terminal transition to `stale`; it never makes an ineligible Job claimable |
| Job operational projection | Only the registered state-machine, scheduling and lease projection updates |
| Job attempt | Expiry-only renewal under the current lease predicate, then one terminal end; job, runner, epoch, attempt number, lease ID and fence never change |
| Runner/executor session | Heartbeat plus one terminal revoke/end transition |

Share consumers are inserted only with a draft decision and become immutable
when the decision is accepted. Requirements and snapshot resources are inserted
in the job-creation transaction and freeze at snapshot commit. Effective grant
children are inserted with one observation and freeze before its verification
decision. Deferred constraints and concurrency tests prove that a child is
either included before closure or rejected afterward.

## 3. Transaction and locking contract

The lock order is the one ADR-0004 fixes and the job catalogue completes
([`../domain/JOB_CATALOGUE.md`](../domain/JOB_CATALOGUE.md) §1): organisation
advisory lock, tenant advisory lock, global allocation-generation advisory lock
and `AllocationHead`, target advisory lock, Job row, then attempt-fence advisory
lock, with ids sorted within each class. A path that needs more than one
acquires them only in that order, and a path that needs only some of them keeps
their relative order. The allocation-generation lock therefore never precedes
an organisation or tenant lock. A claim also checks the durable lock
reservations of ADR-0004 for its whole set before it takes any live lock, and
again once it holds them. `JobAttempt.fence` is the ADR's `fence`: the
`Job.fence` of the claim that created the attempt. Coordinator attempt sessions
are dedicated and non-pooled.

The API role has no ledger-table `SELECT`, `INSERT`, `UPDATE` or `DELETE`. It may
invoke a single owner-controlled `SECURITY DEFINER` job/snapshot function with a
fixed safe `search_path`, fully qualified objects and only `EXECUTE` granted.
The function performs server-side authorization and returns the existing safe
Job representation, never ledger rows or canonical bytes. A reflection test
proves the role has no broader privilege.

The authenticated allocation-writer runtime is the only ledger DML principal.
It accepts an audited, approved change request or an accepted import, records
the requesting actor and approving seats, and has no provider credential,
secret-redemption authority or signing key. The API may create the request but
MUST NOT approve or apply it directly. The exact approval matrix is a blocking
decision-alignment item before the writer is implemented.

The runtime capability matrix is exact:

| Runtime | Core database capability | Other authority |
|---|---|---|
| API | Execute job/snapshot and allocation-request functions only | Verify customer/staff tokens; no infrastructure, signing, seal or secret authority |
| Allocation writer | Read/write ledger through the writer service transaction; execute exact signed head-seal acknowledgement | Verify approved requests and seal signatures; no provider, signing, seal-issuance or secret authority |
| Coordinator/exporter | Direct read-only ledger access; execute `append_snapshot_attestation`, `issue_target_receipt`, `consume_receipt_and_dispatch`, `append_command_terminal` and `append_recovery_export` only | Separate snapshot, receipt and recovery-export signing keys; authenticate runners/executors; no provider or secret redemption |
| Credential broker | Execute `append_grant_observation_and_verification` only; no ledger read/write | Target-partitioned secret exchange; no signing, allocation or provider-mutation authority |
| Target executor | No Core database access | Verify receipt; execute one command; terminal-purpose signing key; no global ledger, receipt signing or secret-store access |
| Head-seal service | No Core database access | Append and authenticate only `(ledger_id, authority_epoch, generation, head_digest)`; no canonical bytes or Core mutation |
| Offline recovery principal | Execute the reviewed recovery-import, signing-key-revocation and exact seal-acknowledgement functions only while quiescent | Read external seals and recovery evidence; no normal runtime or provider authority |

Every owner-controlled function has a fixed safe `search_path`, fully qualified
objects, closed arguments, exact current-state predicates, bounded output and
no arbitrary row-return capability. Function owners are not login roles. The
privilege test compares effective grants to this table exactly.

### 3.1 Allocation change

One `SERIALIZABLE` transaction performs:

1. authenticate the allocation writer and validate the approved request;
2. acquire the exclusive session-level allocation-generation advisory lock;
3. require the current head seal to be acknowledged and reject while any
   `CommandDispatch` lacks a `CommandTerminal`;
4. lock `AllocationHead FOR UPDATE`;
5. validate target, resource, sharing and reference rules;
6. insert new rows or apply one allowed closure transition without identifier
   reuse;
7. run uniqueness, equality, subtype and prefix-containment constraints;
8. build bounded canonical full-ledger bytes from the post-change state;
9. insert generation `head + 1`, parent digest and exactly one
   `allocation.revision_committed` audit event;
10. atomically advance `AllocationHead` with external-seal state `pending`; and
11. commit, seal the new head externally, then release the session-level lock.

A bare PostgreSQL sequence MUST NOT define generation order because sequence
allocation order is not commit order. Every allocation and sharing write path
uses the same head lock. A write that cannot acquire the generation lock waits
or fails closed; it never bypasses a live command. A failed seal leaves the head
pending: subsequent allocation writes and all live claims fail closed until the
same epoch/generation/digest receives an authenticated acknowledgement.

### 3.2 Job creation

The fixed job/snapshot function extends the ADR-0004 transaction:

1. takes the shared allocation-generation lock and
   `AllocationHead FOR SHARE`;
2. takes the target lock in the shared/exclusive mode declared by the job
   catalogue, then locks relevant desired-state rows;
3. validates the active target, acknowledged head seal, policy digest,
   enablement state and full dependency closure;
4. creates or changes desired state;
5. inserts the immutable job specification and ordered steps;
6. inserts exact credential requirements;
7. builds and inserts the target projection and `JobAllocationSnapshot`;
8. inserts exactly one `job.created` audit event; and
9. commits all rows together and releases the locks.

If an approved writer action both changes allocation and creates the downstream
job, it uses the exclusive writer transaction, snapshots the post-change
generation and emits exactly one `allocation.revision_committed` plus one
`job.created` event linked by request, job and revision. Fault injection uses
the semantic checkpoints after desired state, job/steps, requirements/snapshot,
audit/pre-commit and one database-constraint failure. A second connection sees
either no effect or the complete linked tuple.

A crash after job commit but before attestation leaves the Job in ADR-0004
status `queued` with eligibility `awaiting-attestation`. Reconciliation may
create one valid attestation and make it eligible; claim cannot skip that state.

### 3.3 Claim, renewal and orphan recovery

An independently authenticated runner claims an eligible job by first checking
the job's whole lock set against durable reservations, then taking, in the order
of §3, the organisation and tenant locks the job catalogue sets for the kind, a
shared allocation-generation lock and `AllocationHead FOR SHARE`, the target's
whole-attempt shared/exclusive lock, the Job row with `FOR UPDATE SKIP LOCKED`,
and finally the attempt-fence lock. In that transaction, claim
rechecks the Job after every lock and rejects it with `allocation_stale` if the
current acknowledged head seal, authority epoch, allocation generation, target
lifecycle, enablement revision/mode, policy digest or desired-state digest
differs from its snapshot. Claim also requires exactly one valid, unexpired,
non-revoked snapshot attestation and the class mode needed by the requested
operation. It validates the authenticated runner authority against the Fleet
class/operation matrix. Success inserts a new attempt with a globally unique
lease ID and `previous fence + 1`, updates the operational job projection and
writes an audit event. The dedicated coordinator session keeps the
organisation, tenant, generation, target and attempt locks it took for the whole
attempt, including gaps between steps, and releases them only after all
dispatches have terminal proof and the attempt ends; the durable reservation
outlives the session if the attempt ends in `needs_reconciliation`.

Renewal is a conditional update matching attempt, runner session, lease ID and
authority epoch, and using database time to require an unexpired attempt plus a
non-ended, non-revoked runner session. Renewal changes only
`lease_expires_at`. An expired attempt cannot resurrect itself. After two
failed renewals the runner stops every command and requests confirmed
termination from each execution sink.

The sweeper may end an expired attempt only after lease expiry and acquisition
of that attempt's session-level fence lock; lease expiry, a stale heartbeat and
the absence of a live advisory lock are never evidence that a dispatch stopped.
The job's next state follows the two-state rule of ADR-0004. If every dispatch
by that attempt has a `CommandTerminal`, or none was made, the job becomes
`orphaned`, its reservation ends and a replacement attempt may be claimed. If a
sink is unreachable or termination is unconfirmed, the job becomes
`needs_reconciliation`, keeps its reservation, records the open dispatch as its
unresolved operation, and neither replacement nor allocation change proceeds
until an operator's decision is recorded with evidence. A
new attempt keeps the immutable snapshot but receives a new lease ID, fence and
receipts. A generation change sets the old Job to ADR-0004 status `failed`,
eligibility `stale` and error `allocation_stale`, emits exactly one `job.failed`
plus one `job.allocation_stale` domain event, and requires a separately
authorized replacement job with a new snapshot; no field of the old job is
rebased.

### 3.4 Command dispatch

For every external command that can read a credential or produce a side effect:

1. the coordinator-side runner holds a dedicated database session with the
   job's organisation and tenant locks, the shared allocation-generation lock,
   the job's target lock and its attempt-fence lock;
2. the coordinator validates the full pinned revision and current head;
3. the coordinator emits only the stored target projection;
4. the coordinator authenticates one exact `ExecutorSession` out of band;
5. when the snapshot has a nonempty credential requirement, credential
   resolution runs through the credential broker under its own exact receipt,
   and immutable observation plus verification proves set equality and the
   denied out-of-target operation; a synthetic snapshot has zero requirements
   and proves no broker/provider call occurred;
6. the coordinator signs a distinct receipt for one operation from the closed
   vocabulary in §5;
7. the executor verifies signature, its bound identity and audience, validity,
   all digests, target, attempt, fence, lease and command identity;
8. the coordinator performs one `INSERT ... SELECT` that atomically rechecks
   authority epoch, generation, enablement, current attempt/fence/lease,
   authenticated executor and unused issuer/nonce, then inserts `ReceiptUse`
   and `CommandDispatch` before launch;
9. the coordinator dispatches over a one-command authenticated channel; the
   sink independently enforces issuer/nonce replay protection and the exact
   fence; and
10. the executor launches only the verified command with the target projection
    and one-job credential, zeroizes the credential, terminates the entire
    process group or remote operation, and signs `CommandTerminal` before the
    coordinator releases its locks.

Reusing a consumed receipt fails closed before launch. If a runner dies after
launch, the open dispatch remains a durable blocker until the sink proves
termination. A local supervisor treats database or authenticated-channel loss
as cancellation, sends bounded termination then kill to the process group and
attests confirmed reap. A remote Agent must durably persist receipt nonce and
fence before the effect and return an authenticated terminal result; remote
mutating commands remain disabled until the Agent contract implements this.
Recovery then follows the step's existing idempotency proof and uses a new
receipt. A retry-class-C step is not reissued automatically.

## 4. Target projection and non-disclosure

The projection is a positive relational selection containing only:

- the selected target and its class/policy digest;
- the exact owned resources in `SnapshotResource` dependency closure;
- the exact shared service endpoints in that closure whose active decision names
  the target;
- exact grant requirements for this job and target; and
- the minimum command inputs required by the Fleet contract.

It contains no other target, full-ledger digest tree, provider credential value,
signing material, customer label not required by the command or secret value.
Core builds projection bytes directly from the selected rows. It MUST NOT
serialize the global revision and remove forbidden rows afterward.

The target executor receives the projection over an authenticated, integrity-
protected local or service channel. It starts with a sanitized environment,
closed inherited file descriptors and no Core database credential. Projection
bytes, process arguments, environment, logs, traces, error bodies,
`Job.artefact_refs` and Agent payloads are all covered by the non-disclosure
test.

## 5. Receipt and command identity

The receipt operation vocabulary is exactly `credential-resolve`,
`provider-scope-probe`, `render`, `plan`, `apply`, `restore`, `rotate`,
`destroy`, `agent-command`, `synthetic-render`, `synthetic-plan` or
`synthetic-apply`. The last three require mode `synthetic-execution`, reserved
fixtures, zero credential requirements, fake executable digests and denied
network/broker access. `credential-resolve` and `provider-scope-probe` require
`provider-verification-only` or `live`. Every other non-synthetic operation
requires `live`.

The receipt payload is a closed, versioned canonical structure. Unknown fields,
unknown algorithms and non-canonical bytes are rejected. Its signature covers
every claim, including:

- receipt version, globally unique issuer/nonce, issuer and key ID;
- job, snapshot, target, attempt, stable lease ID and lease fence;
- runner-session ID, authenticated effective authority and authority-matrix
  version/digest;
- ledger ID, authority epoch, allocation generation and revision digest;
- enablement revision/mode, environment-policy, desired-state and
  target-projection digests;
- executor-session ID, authenticated issuer/subject/fingerprint and audience;
- Fleet repository revision and accepted ADR digest;
- exact operation, executable identity, normalized argument vector, working
  directory identity and safe input-artifact digests; and
- issued, not-before and expiry instants with the accepted clock-skew policy.

A receipt expires no later than the earliest of 120 seconds after issue, lease
expiry, executor-session expiry, snapshot-attestation expiry and credential
expiry. Verification allows at most 30 seconds of clock skew and uses trusted
database or sink time, never a caller timestamp. Receipt expiry authorizes no
new launch; a consumed command remains governed by lease supervision and
terminal proof.

Command identity is derived from canonical executable identity plus normalized
arguments and immutable input bytes. A shell string is not an executable
identity. Mutable paths, tags, branches and `latest` references are forbidden.
The executor compares the command it will actually launch, not a caller's
description of it.

Each mutating Fleet or Agent entry point is registered with exactly one receipt
verifier. Direct module invocation, maintenance helpers and recovery commands
are in the registry; an unregistered mutating entry point fails the architecture
test.

Break-glass never bypasses ledger authority, snapshot, projection, class
enablement, receipt, fencing, credential equality or an entry-point verifier.
It adds independently issued authorization bound to actor, exact job, target,
operation, written reason, recovery assertion, approval and bounded validity,
and requires a post-review record. Those claims and their digest are signed
into the receipt.

`job_attempt` is distinct from Agent `delivery_attempt`. A receipt is consumed
once and never redelivered. A new delivery receives a new receipt only after the
prior dispatch has a terminal `not-launched` attestation, or after the prior
fence is confirmed dead and the step's idempotency contract authorizes
recovery. The Agent persists command ID, receipt nonce and fence before a side
effect; its existing command-ID deduplication remains an additional control.
Until its pull/ack/visibility-timeout contract implements these rules, remote
mutating Agent commands stay disabled.

## 6. Credential proof

Credential resolution and denial preflight are separate receipt-authorized
commands. A dedicated credential broker verifies signature, executor audience,
class enablement, target, requirement, attempt, authority epoch, generation and
live fence before exchanging an opaque reference. It delivers the credential
only to the bound authenticated executor over the one-command channel. It has
no ledger-writing or receipt-signing right and no standing fleet-wide secret
right; target-partitioned workload authority or an equivalent secret-store
condition is a live gate. Core stores the opaque reference and evidence, never
the secret value.

The fake-provider acceptance suite defines one harmless read operation inside
the target and one exact harmless operation outside it. Verification requires
the declared in-target operation to succeed and the out-of-target operation to
be denied. Replacing that denial with success is a mandatory mutation that
fails the gate. CI and automated tests never contact a real provider.

The live capability registry must name the provider, API version, method,
resource kind and accepted denial result for both probes. The out-of-target
probe reads metadata for a dedicated, ledger-owned denial-canary project whose
existence is proved independently; it never uses another customer's project
and never requests a mutation. An unknown, missing or merely nonexistent
resource is not sufficient denial evidence.

After workload authentication, receipt, broker isolation, one-job delivery and
fake-provider gates pass, a separately reviewed
`provider-verification-only` class mode may authorize only those two named
read/denial probes. It authorizes no render, plan, write, apply, restore, rotate,
destroy or arbitrary provider request. Its signed evidence may support a later
reviewed transition to `live`. Only `lab`, then `staging`, may enter this
mode initially; public and production classes remain disabled. No class, `lab`
included, may run a job with a real provider effect until the decision
`external-execution-stop-evidence` of ADR-0004 is taken: without it, a job whose
effect's outcome is unknown cannot leave `needs_reconciliation`
([`../domain/JOB_CATALOGUE.md`](../domain/JOB_CATALOGUE.md) §1).

The current shared operations age identity is prohibited for execution in
every class other than `lab` and `staging` — `demo-canary`,
`platform-prod` and `tenant-prod` — because it resolves outside one target
(ADR-0003). Live production remains unavailable until target-isolated
decryption and credential delivery pass the same equality and denial contract.

## 7. Import, export and recovery

`AllocationImport` stores mode `genesis` or `recovery`, canonical manifest
bytes/digest, schema and canonicalizer versions, source revision, prior-head
digest, reviewer/attestation evidence and accepted revision. It contains no
credential value. A unique manifest digest makes an identical retry
idempotent.

Before genesis, an offline root ceremony creates the immutable `ledger_id`,
sets authority epoch `1`, canonicalizes the empty generation-zero ledger and
obtains an acknowledged head-seal signature over its exact digest. The one-use
bootstrap function verifies the recovery-purpose trust root and seal before it
creates `AllocationHead`. Missing authorization, replay, an existing head, a
wrong ledger ID/epoch/generation/digest or an untrusted key fails without a row.
Genesis consumes that acknowledged generation-zero root, commits generation
one as seal-pending and enables no further write or claim until its exact seal
acknowledgement.

Import first looks up the manifest digest. If it identifies an accepted import,
Core returns the stored byte-identical result without another audit event or
head change. Only an unseen genesis digest proceeds to the generation-zero and
empty-ledger checks. A different manifest or any existing allocation fails
closed; Core does not merge by display name.

Recovery normally consumes the latest `RecoveryExportEnvelope` containing
complete revision history, Core UUIDs, imports, decisions, retirements and non-
reuse tombstones. The coordinator/exporter may create it only from an
acknowledged head and signs the canonical envelope with a distinct
`recovery-export` purpose key for the offline recovery audience. Recovery
verifies purpose, audience, issuer/key validity and revocation, unique nonce,
signature, ledger/epoch/head binding, complete canonical byte digest and exact
history/tombstone closure. Tamper, cross-ledger use and an export at or below an
already recovered external seal fail closed; an exact accepted retry returns
the stored recovery result without applying twice.

An independently durable append-only head-seal service, under an offline
recovery trust identity and separate custody from Core Postgres, stores signed
`(ledger_id, authority_epoch, generation, head_digest)` records. Its concrete
implementation and verification procedure are live blockers.

Recovery runs under a distinct, offline-authorized recovery principal because
normal coordinators and executors are stopped. It requires:

- an explicitly quiescent coordinator and all target executors stopped;
- signed quiescence evidence from the affected runtimes and reviewed source,
  signature, incident and reviewer-authorization evidence;
- a prior-head proof or explicit reviewed discontinuity record;
- an external seal equal to the highest sealed authority epoch/generation;
- a resulting generation greater than every previously accepted generation;
- one atomic import transaction that increments `authority_epoch`, revokes all
  old runner/executor sessions and old receipt keys, and emits one recovery
  audit event; and
- every imported resource entering `quarantined`.

A second live reconciliation revision verifies provider-native identity,
ownership and collision scope before activation. Credential grants are reissued
and reverified; they are never restored from the manifest. Interrupted import
leaves neither partial resources nor an advanced head. Once accepted, a
manifest is immutable evidence and never a writable allocation registry.
Execution remains disabled until the new epoch/generation/digest seal is
durably acknowledged by the external service. Authority epoch binding and key
rotation make every receipt from the pre-recovery database unusable even if an
older `ReceiptUse` row was not restored.

## 8. Retention and audit

Allocation identities, revisions, accepted imports and retirement tombstones
are retained while an external identifier could collide and are not purged at
launch. Snapshots, grant evidence, attempts, receipts and uses live at least as
long as their job and audit-accountability record. Secret references become
unusable when the job ends; fingerprints, digests and denial evidence remain.

Every state transition emits a registered audit action with actor, target,
generation, job/attempt when applicable, before/after digests and evidence
reference. Logs contain identifiers and digests only at the approved
classification; never canonical global bytes, secret references, signatures or
credential material.

## 9. Acceptance matrix

Fixtures live under `tests/allocation/fixtures/` and use only reserved synthetic
identifiers. The implementation MUST preserve these stable test IDs, exact
oracles and mutation ownership. Error names below are closed domain errors; a
database test additionally asserts the appropriate constraint or uniqueness
failure and no head advance.

### 9.1 Unit

| Test | Exact fixture and action | Exact oracle | Mutation |
|---|---|---|---|
| `ALU001` canonical identity | For every v1 kind, pass its canonical typed fixture, each documented alternate spelling and one typed-field/ID mismatch. | Canonical typed input derives the fixture ID; every alternate or mismatch returns `allocation.invalid_canonical_id` and no object. | `M-CANON-<kind>` |
| `ALU002` canonical bytes | Serialize the same ledger object with every map/set order permutation, then change one value and one stored byte. | Permutations are byte-identical with one digest; either change produces a different digest and stored-byte verification returns `allocation.digest_mismatch`. | `M-DIGEST` |
| `ALU003` exact grant | Verify one valid requirement/observation, then add or remove one capability/resource and change issuer, audience, policy, target, principal and validity one at a time. | Only the exact fixture inserts one `CredentialGrantVerification(verified)`; every delta returns its named mismatch error and inserts no verified decision. | `M-GRANT-<claim>` |
| `ALU004` endpoint decision | Validate an exact endpoint owner/consumer decision, then use a wildcard, class consumer, stale decision, wrong owner, each non-endpoint kind, untrusted repository, mutable ref, wrong path/digest, missing review/signature policy and `Proposed` ADR. | Only the exact endpoint plus allow-listed immutable accepted decision passes; each negative returns `allocation.share_forbidden` or `allocation.decision_untrusted`. | `M-SHARE-<control>` |
| `ALU005` projection non-interference | Build target A in two worlds that differ only in distinctive target-B resources, grants, principals and decisions. | A's projection bytes and projection digest are identical and contain none of B's sentinels; the global generation may differ. | `M-PROJECTION-FIELD` |
| `ALU006` receipt claims | Verify one valid receipt, then change exactly one signed claim, executor identity/audience, command byte, signature or validity boundary per table row. | Valid returns the receipt ID once; each delta returns `receipt.<claim>_mismatch` or `receipt.invalid_signature` before dispatch. | `M-RECEIPT-<claim>` |
| `ALU007` artifact bounds | Submit each canonical artifact at its exact byte limit and at limit plus one byte. | Exact limit proceeds to semantic validation; oversized returns `allocation.artifact_too_large` before parsing, storage or signature work. | `M-BOUND-<artifact>` |
| `ALU008` snapshot attestation | Verify one valid attestation, then change each signed field, signature, issuer/audience/key, validity, serial and revocation state separately. | Only the exact trusted artifact can make eligibility `eligible`; every delta leaves `awaiting-attestation` and returns `attestation.<claim>_mismatch` or `attestation.invalid_signature`. | `M-ATTEST-<claim>` |

### 9.2 PostgreSQL integration

| Test | Exact precondition and barrier/action | Exact oracle | Mutation |
|---|---|---|---|
| `ALI001` relational shape | Direct SQL attempts each unknown class, invalid class/subject/tenant cardinality, subtype/kind pair, owner, active target and non-reuse case. | Each statement fails its named check/FK/unique constraint; generation, revision and audit counts are unchanged. | `M-DB-<constraint>` |
| `ALI002` identity race | Two transactions synchronize before inserting the same `(kind, canonical_id)` for different targets. | Exactly one commits one revision/audit; the other gets the named uniqueness error and no partial row. | `M-DB-resource-identity` |
| `ALI003` containment race | Repeat a synchronized parent/child insert in both orders for normalized secret paths. | Exactly one transaction commits in each run; the loser gets `allocation.prefix_overlap`; equality is covered separately by `ALI002`. | `M-DB-prefix-secret` |
| `ALI004` atomic job tuple | Inject failure after desired state, job/steps, requirements/snapshot, audit/pre-commit and at one constraint; then run success. | A second connection sees zero rows after each failure. Success has exactly one desired change, job, declared steps, snapshot, requirement set and `job.created` event. | `M-TX-job-snapshot` |
| `ALI005` combined writer tuple | An approved request changes one allocation and creates its downstream job, then fails at the same semantic checkpoints. | Failure leaves old head and zero request effects. Success advances once and emits exactly one linked `allocation.revision_committed` and one `job.created`. | `M-TX-allocation-job` |
| `ALI006` idempotency race | Two synchronized requests use one idempotency key. | One tuple and one `job.created` exist; both callers receive byte-identical safe Job responses. | `M-DB-idempotency` |
| `ALI007` closure freeze | Race consumer insertion with share acceptance, capability/resource insertion with grant verification, and requirement insertion with snapshot commit. | The child is included before closure or rejected afterward; no accepted/verified parent has a different set digest. | `M-FREEZE-share`, `M-FREEZE-grant`, `M-FREEZE-snapshot` |
| `ALI008` attestation eligibility | Crash after job commit before attestation, attempt claim, then reconcile one valid attestation. | Before reconciliation eligibility stays `awaiting-attestation`, claim returns `job.attestation_required`, and no attempt exists; afterward one claim succeeds. | `M-CLAIM-attestation` |
| `ALI009` lease fence | Claim, renew, expire, revoke the runner, reclaim, then resume the old runner. | Renewal preserves fence; expired/revoked renewal updates zero rows; reclaim increments fence; every old renewal/result/receipt action updates or inserts zero rows. | `M-LEASE-expiry`, `M-LEASE-fence` |
| `ALI010` receipt consumption | Two executors concurrently consume one receipt; repeat with wrong executor and with enablement superseded. | Exactly one bound executor inserts one `ReceiptUse` and `CommandDispatch`; all others return the named receipt error and journal no command. | `M-USE-unique`, `M-USE-executor`, `M-USE-enablement` |
| `ALI011` retirement history | Complete one job, queue another snapshot of the same resource, retire it, then attempt to claim the queued job. | Retirement succeeds once, preserves historical FKs/tombstone and blocks physical delete/reuse; claim sets `failed/allocation_stale`, emits one `job.failed` plus one `job.allocation_stale`, and leaves no redeemable old receipt. | `M-RETIRE-history` |
| `ALI012` genesis | Import a reviewed manifest, replay its digest, then try a new digest against the nonempty ledger and inject an import failure. | First import advances once; replay returns the stored result with no new rows/audit; divergent and interrupted imports leave head/counts unchanged. | `M-IMPORT-empty`, `M-IMPORT-replay` |
| `ALI013` recovery epoch | Recover complete history/tombstones from the highest valid external seal; repeat with stale/corrupt seal and interruption. | Valid recovery increments epoch, preserves history, invalidates old sessions/keys/receipts, advances generation, emits one event and stays disabled until new seal ack; negatives are atomic refusal. | `M-RECOVERY-seal`, `M-RECOVERY-epoch`, `M-RECOVERY-ack` |
| `ALI014` visibility and privilege | Reflect every table/serializer and inspect effective grants for all seven runtimes in §3. | Every table has one class; public schemas expose no forbidden field; each runtime has exactly its declared operations and no owner-controlled function returns arbitrary ledger rows or bytes. | `M-VISIBILITY-table`, `M-PRIVILEGE-<runtime>` |
| `ALI015` stale replacement | Change generation after a queued job, claim it, then explicitly request a replacement. | Old job is `failed/allocation_stale` with eligibility `stale`, one generic and one domain event, unchanged snapshot/attestation evidence and no attempt; only the separately authorized replacement has the new snapshot. | `M-CLAIM-generation` |
| `ALI016` allocation chain race | Synchronize two approved, non-conflicting writers before head acquisition and run both arrival orders. | Both commit as consecutive generations with exact parent digests, two revision events and a final head equal to the second commit; no lost update or fork exists. | `M-HEAD-serialization` |
| `ALI017` snapshot cut race | Synchronize one allocation change against one job/snapshot creation before head acquisition and run both orders. | Snapshot is wholly before or after the change; its relational closure equals its canonical revision/projection bytes and never contains a torn set. | `M-SNAPSHOT-head-lock` |
| `ALI018` claim race | Two authenticated runners concurrently claim the same eligible queued job. | Exactly one attempt, fence and `job.started` event exist; the loser gets `job.not_eligible` and creates no row. | `M-CLAIM-job-lock` |
| `ALI019` seal failure | Fail sealing after a normal allocation commit, then submit invalid/tampered signature, wrong signer/key purpose/audience, not-yet-valid/expired/revoked key, wrong ledger/epoch/generation/digest, exact acknowledgement replay and one exact acknowledgement. | Head remains pending and claims/writes fail through every negative; counts do not change; only the first exact authenticated acknowledgement reopens progress and its replay is an idempotent no-op. | `M-SEAL-<claim>` |
| `ALI020` genesis root | Run root ceremony once, then test missing root, invalid/tampered signature, wrong purpose/audience, not-yet-valid/expired/revoked/untrusted key, replay/existing head and wrong ledger/epoch/generation/digest. | Only the exact one-use generation-zero authorization creates one acknowledged empty head; genesis creates generation one pending and nothing progresses before its exact acknowledgement; every negative leaves zero new rows. | `M-GENESIS-<claim>` |
| `ALI021` attestation windows | Race two attestation serials and submit overlapping, regressing and revoked-key windows. | Serials are monotonic and validity does not overlap; every invalid row fails its named constraint and eligibility remains ineligible. | `M-ATTEST-serial`, `M-ATTEST-window` |
| `ALI022` attestation transaction | Inject failure between attestation insert and eligibility promotion, then retry the same serial. | Failure rolls back to zero attestation rows and `awaiting-attestation`; retry creates exactly one artifact, one eligible transition and no duplicate audit. | `M-TX-attestation-eligibility` |
| `ALI023` signing-key revocation | Register purpose-bound keys, append a revocation twice, then run recovery epoch rotation. | Key uniqueness includes epoch/issuer/key/purpose; one revocation exists, replay is an idempotent no-op, verification rejects it immediately, and recovery atomically revokes all pre-epoch runtime keys. | `M-KEY-purpose`, `M-KEY-revocation` |

### 9.3 Cross-repository contract

| Test | Exact fixture and action | Exact oracle | Mutation |
|---|---|---|---|
| `ALC001` Core to Fleet | Feed one Core snapshot/projection per class and one representative signed receipt to the pinned Fleet consumer. | All five projections and the receipt pass; Fleet remains sole owner of its `ENV001`-`ENV016` negative matrix. | `M-CONTRACT-version` |
| `ALC002` canonical schema | Add one unknown field/algorithm and compare producer/consumer bytes for snapshot, projection, attestation and receipt. | Unknown input fails closed; accepted artifacts are byte-identical and have equal digests on both sides. | `M-SCHEMA-closed` |
| `ALC003` authenticated handoff | Present valid bytes over the authenticated channel, then copy them through a wrong runner or executor session. | Only identities bound out of band and in the signed claims pass; wrong/cross-executor presentations create no use or dispatch. | `M-HANDOFF-runner`, `M-HANDOFF-executor` |
| `ALC004` entry-point inventory | Reflect every render/plan/apply/restore/rotate/destroy, direct helper and recovery entry point. | Registry and discovered set are equal; every entry invokes the verifier before a fake journal write. | `M-ENTRYPOINT-<name>` |
| `ALC005` public non-exposure | Reflect Core OpenAPI/serializers and Agent schemas with sentinel confidential fields. | No global bytes, other-target ID, evidence, receipt signature, workload credential or secret reference is reachable. | `M-PUBLIC-sentinel` |
| `ALC006` Agent redelivery | Simulate visibility timeout before launch, after launch and after terminal result using distinct delivery attempts. | No receipt is reused; no new receipt is issued without prior terminal/dead-fence proof; command ID plus nonce/fence journal records one side effect. | `M-AGENT-redelivery` |
| `ALC007` recovery export | Verify one current export, then change signer, purpose, audience, key validity/revocation, nonce, ledger/epoch/head, one history byte, one tombstone and signature; replay it across a ledger and recovered seal. | Only the complete purpose-bound current envelope verifies; each delta returns `recovery.export_invalid`, changes no state and never imports; an exact accepted retry is idempotent. | `M-EXPORT-<claim>` |

### 9.4 Chaos

| Test | Failure injection | Exact oracle | Mutation |
|---|---|---|---|
| `ALH001` job/outbox death | Kill before commit and immediately after commit before attestation. | First leaves no tuple; second leaves the complete queued tuple with eligibility `awaiting-attestation`, never claimable until reconciled. | `M-CHAOS-attestation-guard` |
| `ALH002` supervisor connection loss | Sever the coordinator DB/control channel while a fake child ignores the first termination signal. | Open dispatch blocks allocation and replacement; journal records no second launch; only confirmed process-group reap creates terminal proof and releases the blocker. | `M-SUPERVISOR-terminal-proof` |
| `ALH003` validation-to-launch race | Pause after verification, then change enablement/generation or replace the fence before receipt use. | The atomic use inserts nothing and the fake command journal stays empty. | `M-FINAL-CAS-<claim>` |
| `ALH004` death around consumption | Kill immediately before and after receipt-use/dispatch commit, then retry delivery. | Before commit leaves no use/dispatch; after commit leaves one open dispatch that blocks a second launch until terminal proof and recovery authorization. | `M-CHAOS-receipt-use` |
| `ALH005` import interruption | Kill genesis/recovery at each semantic checkpoint and restart. | Restart gives clean idempotent replay or deterministic refusal; no partial head, epoch, history or seal-ack state exists. | `M-CHAOS-import` |
| `ALH006` old runner resume | Resume an old runner after confirmed termination and higher-fence reclaim. | It cannot renew, redeem, consume, write a result or journal a command; only the highest fence can progress. | `M-CHAOS-old-fence` |

### 9.5 Security

| Test | Adversarial action | Exact oracle | Mutation |
|---|---|---|---|
| `ALS001` forged context | Forge one target, epoch, generation, job, runner, executor, enablement or command claim while keeping body labels plausible. | Each fails from authenticated/signed context before receipt use and leaves the command journal empty. | `M-AUTH-<claim>` |
| `ALS002` replay/confused deputy | Replay a valid receipt across command, entry point, job, target, attempt, lease, fence, executor, audience, epoch and generation. | Every cross-context use fails; exact replay finds the prior use and never dispatches again. | `M-REPLAY-<claim>` |
| `ALS003` projection surfaces | Run the `ALU005` two-world fixture through arguments, environment, file descriptors, logs, traces, errors, receipt claims and artefact refs. | Target-A observable bytes remain identical and contain no target-B sentinel on every surface. | `M-SURFACE-<name>` |
| `ALS004` provider scope | Fake provider allows the named in-target read and returns the configured scope-denial result for the proven denial-canary project; then return allowed, not-found/unknown project, malformed target, timeout and generic-auth failure and widen one capability/resource. | Only the exact configured scope denial verifies; widening returns `grant.set_mismatch`; every other result returns `grant.denial_failed` without verification. | `M-PROVIDER-<result>` |
| `ALS005` credential custody | Attempt secret redemption from API, writer, coordinator and wrong executor; attempt ledger/signing access from broker/executor. | Every undeclared operation is denied by workload and store policy; only the bound broker-to-executor exchange succeeds and is audited. | `M-CUSTODY-<runtime>` |
| `ALS006` enablement and break-glass | Omit/supersede enablement, widen verification-only operations, and omit each independent break-glass claim. | Claim, redemption, issue, use and entry point all fail closed; break-glass never bypasses a base control. | `M-ENABLE-<stage>`, `M-BREAKGLASS-<claim>` |
| `ALS007` terminal proof | Submit one valid terminal, then forge/replay its signature, issuer/key/nonce, dispatch, receipt/nonce, command, job/target/attempt/lease/fence, executor, launch/result, process/operation identity and termination state one at a time. | Only the bound execution sink's exact signed terminal closes the dispatch; every negative leaves allocation and replacement blocked. | `M-TERMINAL-<claim>` |
| `ALS008` runner authority | Use each Fleet authority against one allowed and one forbidden class/operation, including body labels that claim the allowed value. | Claim, receipt issue/use and entry point accept only the authenticated matrix match; every wrong authority leaves no attempt/use/dispatch. | `M-AUTHORITY-<class-operation>` |
| `ALS009` synthetic execution | Request each synthetic operation with reserved and live namespaces, fake and real executable digests, network on/off and broker access on/off. | Only the reviewed synthetic authority, reserved fixture, fake digest, denied network and denied broker path pass; it creates no live evidence and cannot satisfy a live gate. | `M-SYNTHETIC-<control>` |

### 9.6 Mutation manifest contract

`tests/allocation/mutations.yaml` contains one explicit entry for every mutation
ID above and one `M-RECEIPT-<claim>`, `M-ATTEST-<claim>`,
`M-TERMINAL-<claim>`, `M-SEAL-<claim>`, `M-GENESIS-<claim>`,
`M-EXPORT-<claim>`, `M-REPLAY-<claim>` and
`M-FINAL-CAS-<claim>` entry for every independently verified signed claim. An
entry names its owner test, exact source preimage and one hunk, or one named SQL
constraint to disable in an ephemeral database.

The self-test first proves the baseline suite green. For each entry it then
proves exactly one control changed, the owning negative test is killed, every
positive and unrelated negative is unchanged, and stale/no-op or multi-hunk
mutations fail. It finally proves no tracked file changed. A family placeholder
with no expanded manifest entries is an incomplete gate.

Tests use real PostgreSQL synchronization barriers, controlled time, fake
tooling and a fake provider. They MUST NOT use SQLite, timing sleeps or a real
provider network.

## 10. Implementation sequence

Each slice is a separate reviewed pull request with a written acceptance test
before code. A later slice does not weaken an earlier gate.

1. **Decision alignment:** accept ADR-0012; amend the Core model, job catalogue,
   audit taxonomy and threat model; amend Fleet's one-bundle wording to the
   two-artifact contract; decide DNS delegation ownership, alert-route
   allocation, live capabilities and writer approvals; register
   `fleet-confidential` visibility.
2. **Contract fixtures:** publish versioned canonical schemas and synthetic
   bundle fixtures for all five classes; build Core producer/Fleet consumer
   contract tests and their mutations.
3. **Ledger kernel:** migrate head/epoch, revision, target, typed resource,
   share, enablement and import tables with constraints, canonicalizers and race
   tests. Every class stays default-disabled.
4. **Writer and genesis:** isolate the allocation-writer role, approval path and
   audit actions; implement dry-run validation and reviewed genesis import in
   synthetic `lab`; keep recovery and provider execution disabled.
5. **Job snapshot:** add target binding, immutable job fields, the fixed
   snapshot-creation function, exact requirements, projection, awaiting-
   attestation state and signed coordinator/exporter attestation.
6. **Runner and executor fencing:** add workload authentication, sessions,
   attempts, lease ID/fence, target/attempt locks, stale replacement, durable
   dispatch/terminal proof and local process-group supervision.
7. **Coordinator and receipt:** isolate runtime identities, sign and verify
   executor-bound exact receipts, enforce atomic one-shot consumption, close
   the entry-point registry and pass non-disclosure tests. Remote Agent
   mutations stay disabled.
8. **Credential broker:** implement receipt-bound, target-partitioned one-job
   redemption, relational equality proof and exact fake-provider denial. Shared
   decryption identity remains prohibited.
9. **Synthetic execution:** permit receipt-bound render/plan and fake apply only
   for `lab`, then `staging`, while running the full chaos and mutation
   suite; the persisted class mode is exactly `synthetic-execution` and cannot
   produce live evidence.
10. **Recovery:** select the independent head-seal facility; implement complete
    signed export, authority-epoch rotation, quiescent recovery import,
    anti-rollback and quarantined reconciliation; rehearse only with synthetic
    state.
11. **Provider verification:** after its gates pass, review the exact harmless
    operations and move `lab`, then `staging`, to
    `provider-verification-only`; record real evidence without authorizing a
    mutation.
12. **Live enablement review:** close every gate in §11, obtain Security and
    Infra seat approval, and enable one class through a new ledger decision.

## 11. Live-enablement gates

Every class starts unavailable. A class remains unavailable while any item is
open:

- ADR-0012 and every affected Core/Fleet contract are accepted and consistent.
- The allocation ledger is the sole writable authority; legacy identifiers are
  foreign keys or derived projections.
- The authenticated allocation writer, approval matrix, API snapshot function
  and database grants pass privilege and mutation tests.
- Default-disabled class enablement is stored in the ledger and checked at
  claim, credential redemption, receipt issue/use and every entry point.
- Workload authentication, coordinator attestation/signing, executor identity,
  issuer/audience binding and key rotation/revocation are specified and tested.
- The API has no infrastructure credential, receipt-signing key or secret-
  redemption authority.
- The broker has no ledger-write/signing right or standing fleet-wide secret
  right; the executor has no global-ledger/signing access; projection
  non-interference and credential-custody tests pass.
- The exact grant equality and harmless denied out-of-target provider operation
  pass first against the fake provider and then under the reviewed
  verification-only mode for the class.
- Shared operations decryption has been replaced with target-isolated,
  one-job delivery for every secret the command needs.
- Authority epoch, generation, target and attempt locks close the validation-to-
  launch race; open dispatches without terminal proof block changes and
  replacement; old fences and receipts cannot produce a side effect.
- Every mutating entry point verifies a one-shot exact-command receipt.
- Genesis, stale-job replacement, orphan recovery and signed recovery import
  pass real-PostgreSQL chaos tests and their mutations.
- The independent head seal acknowledges the current epoch/generation/digest;
  recovery invalidates every old session, key and receipt before execution.
- DNS delegation, alert-route and network-prefix isolation, and the closed live
  capability registry have accepted cross-repository contracts.
- Remote Agent mutations remain disabled until its sink-side fence, nonce,
  terminal-proof and redelivery contract passes.
- Fleet environment-boundary policy and all its negative cases remain green.
- No real provider credential or customer data appears in tests, repositories,
  logs, snapshots or manifests.
- Security and Infra seats approve the class-specific evidence. Enabling is an
  explicit reviewed policy change, never an incidental deploy.

`tenant-prod` has the additional gates of human-controlled project bootstrap,
target-isolated secret decryption, dedicated tenant policy proof and one active
production target per tenant. The future privileged project allocator remains
out of scope and blocked by ADR-0005.

## 12. Required follow-up documents

Before implementation, reviewed changes must reconcile:

- [`../domain/MODEL.md`](../domain/MODEL.md): the entities, visibility classes,
  target binding, immutable job specification and derived legacy identifiers;
- [`../domain/JOB_CATALOGUE.md`](../domain/JOB_CATALOGUE.md): target locks,
  attempts/fences, stale replacement and receipt-authorized steps;
- [`../domain/AUDIT_TAXONOMY.md`](../domain/AUDIT_TAXONOMY.md): closed allocation,
  snapshot, attempt, credential and receipt actions;
- [`../security/THREAT_MODEL.md`](../security/THREAT_MODEL.md): coordinator,
  executor, workload-authentication, signing, projection and import boundaries;
- `contracts/agent-api.openapi.yaml`: target/generation/fence/receipt binding for
  mutating agent commands; and
- the Fleet environment-boundary specification: split job snapshot from attempt
  envelope and define stable lease ID/fence semantics.

## Changelog

- Proposes the sole-authority ledger, target-scoped projection, two-artifact job
  and attempt contract, exact credential proof, receipt fencing and import
  semantics.
- Defines the implementation sequence, acceptance matrix, self-test mutations
  and explicit live-enablement gates without enabling live execution.
- Aligns with ADR-0003 and ADR-0004 as accepted: the lock order puts the
  organisation and tenant locks before the allocation-generation lock, claims
  check durable reservations first, `lease_fence` is renamed `fence` after the
  ADR, an unconfirmed termination leaves the job `needs_reconciliation` rather
  than `orphaned`, and the shared operations age identity is prohibited in every
  class but `lab` and `staging`, not only in `tenant-prod`.
- §6 requires the decision `external-execution-stop-evidence` before any job
  with a real provider effect runs in any class, `lab` included.
