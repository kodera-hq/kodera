# First-slice G1 specification and expected-red gate

**Status:** Proposed · **Owner:** API seat

## Purpose

G1 freezes the written contract and the honest acceptance boundary before any new runtime product
implementation. It reconciles the thirty-three mandatory scenario records, records the
owner-independent decisions plus the delegated Core MFA consumer contract, and keeps two
owner-gated questions visibly open.

G1 is not customer readiness and is not first-slice runtime acceptance. A green G1 planning gate
means the repository describes its red state exactly. The runtime acceptance command remains red
until all thirty-three scenarios pass against the real admitted services.

## Scope

This increment changes specifications, ADR proposals, the scenario registry and offline gate
proofs. It also makes a prose-only OpenAPI 0.25.1 correction to `TenantStatus` and aligns the
existing production job-kind registry's `decommission` step name and timeout with the catalogue.
The one current-runtime hardening is queue admission: `start_sub_job` refuses every parent-step-child
relation absent from the closed production registry, and that production registry remains empty, so
every production sub-job start is refused. This adds no model, migration, API operation,
authorization path, new worker or provider execution, provider adapter, invoice behavior,
identity-provider configuration or deployment asset; in particular, the future closure-principal
export operation and deletion-supersession writer do not exist yet.

## Decisions recorded for G1

`tests/first_slice/scenarios.toml` uses `decided` to mean that a scenario needs no further owner
answer. It does not mean the behavior is implemented, or that a Proposed ADR has completed the
repository's separate status-only ratification workflow.

| Decision key | G1 rule | Record |
|---|---|---|
| `organisation-states-and-wire-operations` | Five states: `prospect`, `active`, `suspended`, `closing`, `closed`; unknown states fail closed; use the six existing intake/claim/order/status operation IDs | ADR-0019 |
| `mfa-contact-proof-and-claim-delivery` | Strict signed `email_verified=true` and `kodera_mfa_enrolled=true`; configured Console `azp`; current-login `amr` contains exact `otp`; freshness at most 330 seconds; local TOTP only in v1, including for brokered owners | `REGISTERED_FACTOR_SIGNAL.md` |
| `operation-scope-and-dedup-retention` | Keep the 24-hour response receipt and a separate durable semantic identity for every effect-bearing operation | ADR-0020 |
| `external-execution-stop-evidence` | Leaving `needs_reconciliation` requires both authenticated stop evidence and a fresh target read | ADR-0021 |
| `tenant-scoped-retained-access-window` | Each tenant termination opens bounded read-only exit access for designated closure principals for at most 90 days; a validated controller instruction may end it earlier and require irreversible deletion without an export prerequisite; only the final tenant enters organisation offboarding and realm deletion | Internal `FS-RETAINED-ACCESS-90` and `FS-CONTROLLER-EARLY-DELETION` |

## Questions that remain owner-gated

| Decision key | Why G1 does not decide it | Scenarios directly blocked |
|---|---|---|
| `post-identity-erasure-one-time-redelivery` | Whether support may deliver legally retained invoices, credit notes and deletion evidence once through independently verified, audited access after the application identity and realm are gone remains a product/privacy decision | `FS-LIFE-03` |
| `invoice-issuer-and-reconciliation` | The first-slice packet assumes a provider-issued number while Core currently issues the legal number; choosing the legal authority requires explicit commercial-owner ratification | None yet: billing scenarios stop at an earlier real-provider gap |

No scenario, spec or implementation may infer an answer to either question from the absence of a
decision. The Keycloak producer, realm configuration, real-provider MFA evidence and
provider-specific stop-evidence tooling are operational qualification owned by SRE; none is an
additional product decision.

## Reconciled scenario population

| Group | Mandatory | Expected failure | Owner-blocked |
|---|---:|---:|---:|
| Bootstrap and authority | 7 | 7 | 0 |
| Lifetimes | 3 | 2 | 1 |
| Identifiers | 3 | 3 | 0 |
| Operation identity and replay | 6 | 6 | 0 |
| Concurrency and external execution | 6 | 6 | 0 |
| Billing | 6 | 6 | 0 |
| Full journey | 1 | 1 | 0 |
| Harness | 1 | 1 | 0 |
| **Total** | **33** | **32** | **1** |

There are zero passing scenarios. `FS-LIFE-02` moves from blocked to expected failure because the
tenant-scoped retention boundary is decided; its fixture first stops at
`harness:identity-provider-second-factor`. `FS-OP-05` moves from blocked to expected failure because the
two-tier rule is decided. `FS-BOOT-06` and `FS-OP-06` move because the Core MFA consumer rule is
decided. All four first reach `harness:identity-provider-second-factor`: their fixture construction
needs a real provider-issued second factor before their later assertions run. `FS-ID-03` and
`FS-CON-05` were already expected failures at earlier gaps; their later decision checks now proceed
when those paths become reachable.

## Gates

`make check-first-slice-expected-red` is the lightweight G1 planning gate. It requires:

- the exact thirty-three identifiers in canonical order;
- zero pass, thirty-two `xfail` and one `blocked` row;
- exactly the five recorded G1 decisions and the prior `placeOrder` decision marked `decided`;
- exactly the two owner-gated decisions marked `open`;
- only `FS-LIFE-03` blocked on post-identity-erasure one-time redelivery.

The gate exits zero only for that expected-red boundary and prints `runtime_acceptance: not_met`.
It never executes or certifies product behavior.

The later runtime acceptance for the retention decision must include a ready export at the exact
recovery deadline with both delete runner and artefact store unavailable. Trusted-time unwrap/read
denial must still hold. Its paired mutation removes only that runner-independent cutoff and must
fail. The same runtime change pauses an already-authorized read and realtime session after
generation validation but before send: termination must wait on the exclusive delivery barrier,
those emissions complete before commit and no later chunk/frame uses the old generation. It keeps
multiple export/decommission claim sessions, including multiple fences of one shared-lock job, and
live locks through exact natural expiry, then proves the supervisor creates one session child per
non-reusable claim tuple and reaps every exact session before that job's cancellation/reservation
release, including a terminal commit paused before unlock beneath a reap-only job child. Every
transferred dispatch has its own job child and all
backup/export slots remain under the parent obligation; late acknowledgement or unavailable
journal/store cannot produce false no-write or an attestation, exhaust a short retry budget or
strand finalization after destruction. Kill points after delete step 8, after the durable step-9
marker and after live-lock release prove sweep preservation, supervisor takeover and the two-phase
runner-close obligation before the unique parent-linked finalizer.
Closure-resource streams are separately paused after authorization before send at exact natural
expiry and across an earlier instruction; their hard transport deadline/generation barrier denies
without delete, supervisor or expiry-writer availability. It also drains a pre-fence
write, proves the final backup covers every DB/object/document high-water mark, holds a stale
final-backup capability through exact natural expiry with its writer/supervisor unavailable, and
races the backup store call against an earlier-deletion fence. Ordered cancellation separately
proves no workload/data store was provisioned and atomically creates canonical empty manifests,
the `never_provisioned` attestation and `deleted` status only when no lifetime ProjectBootstrap row
exists. Cancellation's permanent tenant fence serializes and blocks bootstrap record/verify and
provisioning. With any recorded, verified, expired or replaced boundary it proves cancellation
creates a complete historical-scope cleanup and leaves the tenant `ordered`; only independently
verified retirement/absence of every scoped project/application/policy/key allows the unbounded
finalizer to attest and enter `deleted`. Provisioning and final-organisation offboarding race both
branches, and mutations dropping the lifecycle fence, one predecessor, cleanup audit action,
cross-scope equality, closure receipt, verifier separation or status gate
must fail. A second race pauses an identity backup both
before provider snapshot-begin while realm creation competes for the catalogue reservation, and
between snapshot and publication while final-
organisation offboarding crosses its generation fence; publication must join the sealed manifest
or be refused, the exact realm list must match the dump bytes, and omitting either reservation or
generation re-check must fail. These are future runtime contracts: no current model, migration,
realm writer, backup worker or provider adapter implements them, and this planning gate does not
execute or certify them.

`make mutate-first-slice-expected-red` weakens the required-count, state-count, decision-boundary
and blocker-binding guards one at a time in disposable copies. Each weakening must make its named
counterexample fail while the intact-boundary control stays green.

A candidate is not publishable until both commands pass on its exact head. Static source checks or
unit coverage of their wiring do not substitute for the mutation command's four disposable runs.

The existing dynamic harness remains authoritative for actual scenario behavior:

- ordinary `pytest tests/first_slice` requires every expected failure to stop at its recorded first
  gap and every blocked row at its recorded decision;
- `make first-slice-scenarios` requires every selected scenario to pass and therefore remains
  nonzero at G1;
- a runtime implementation must change the scenario row, this specification and the expected-red
  gate in the same change. A surprise pass is a failure, not silent progress.

`FS-OP-01` consumes `X-Operation-Ref` on complete and in-flight intake responses and compares it
with the durable `realm_create` job key. Core now declares the fault points `FS-BOOT-02`,
`FS-OP-01` and `FS-CON-06` arm (`core/faults.py`, recorded in `tests/first_slice/fault_points.toml`),
and the harness arms them for real: an in-process crash that rolls the intake's transaction back, or
a hold before its commit. The three now stop at their next recorded gap,
`harness:identity-provider-second-factor`, on the staff intake each point interrupts.
`make check-first-slice-fault-points` and `make mutate-first-slice-fault-points` hold the tree to
the inventory and prove each of its rules can fail.

`FS-CON-06` names its points in the order "desired state, audit, job"; the sites follow the
contracted order of `JOB_QUEUE.md` §4.1 instead (job row, the intake's audit, steps, `job.created`),
so `intake:after-audit` is reached with the job row already written and `intake:after-job` after
both audit events. Each crash must still leave nothing, which is what the scenario asserts.

## Exit from G1

Runtime work may begin only after the written contract and expected-red proofs are reviewed. It
must preserve the owner gates above, introduce written acceptance before each behavior, and remove
an expected gap only with executable evidence that fails when that behavior is weakened.

## Changelog

- First version. Reconciles the expected-red registry, records the owner-independent decisions and
  preserves the remaining owner gates without claiming runtime acceptance.
- Records the delegated Core MFA consumer contract and moves `FS-BOOT-06` and `FS-OP-06` to their
  earlier real-provider second-factor gap, leaving Keycloak proof as an SRE delivery task.
- Wires `FS-OP-01` to the stable operation-reference header and durable job key while preserving
  its later `harness:core-fault-points` expected gap.
- Records the tenant-scoped 90-day maximum recovery window and controller-requested earlier
  deletion as decided, moves `FS-LIFE-02` to its first implementation gap, and leaves only
  post-identity-erasure one-time redelivery owner-gated in `FS-LIFE-03`.
- Wires Core's named fault points. `FS-BOOT-02`, `FS-OP-01` and `FS-CON-06` move from
  `harness:core-fault-points` to `harness:identity-provider-second-factor`; the totals stay zero
  passing, thirty-two expected failures and one blocked. Records that `FS-CON-06`'s point order
  follows `JOB_QUEUE.md` §4.1, not its prose order.
