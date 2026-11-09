# ADR-0021: Reconciliation requires stop evidence and a fresh target read

**Status:** Accepted
**Owner:** Worker seat
**Deciders:** The product decision already recorded in `docs/domain/JOB_CATALOGUE.md`; this record
reconciles that rule with ADR-0004. Independent worker and security review remains a merge gate.

## Context

ADR-0004 correctly says an expired lease, stale heartbeat or unheld advisory lock does not prove
that an external operation stopped, but it still calls the exact evidence an open decision and says
that safe convergence can establish that an operation stopped. Convergence is an idempotency
property, not execution-termination evidence. `JOB_CATALOGUE.md`, the queue model, database guards
and acceptance tests already encode the product decision: leaving `needs_reconciliation` requires
two structured pieces of evidence.

The contradiction makes an implemented safety rule appear optional, obscures the narrower pre-hold
path available to the current fenced runner and keeps `FS-CON-05` behind a decision gate after the
decision has been taken.

## Decision

The recovery boundary has three paths:

1. **Ordinary/orphan recovery.** Authenticated terminal proof closes a dispatch. If no dispatch for
   the current step remains open, the sweep may classify the job `orphaned` and ordinary automatic
   recovery may reclaim it.
2. **Current fenced pre-hold replay.** Before the job enters `needs_reconciliation`, a registered
   safe-convergence contract may authorize only the current fenced runner to replay the same logical
   provider request under the same still-open `JobDispatch`, the same correlation or idempotency key
   and an unchanged desired payload. This is transport/request replay under the existing dispatch,
   not a new `record_dispatch`. It does not close the dispatch, create a second dispatch, release its
   reservation or prove termination. `close_dispatch` requires authenticated terminal proof; only
   authenticated terminal proof closes the dispatch. A correlated target observation counts as that
   proof only when the registered provider or operator-tooling contract authenticates that it proves
   execution ended. Lease loss or unresolved terminality while the dispatch remains open moves the
   job to `needs_reconciliation`, even when replay would be duplicate-safe. Every closed dispatch
   remains backed by authenticated terminal proof; a crash after closure but before the step write
   cannot make an operation of unproven terminality automatically recoverable.
3. **Staff decision after hold.** Every staff decision leaving `needs_reconciliation`, including a
   resume that permits redispatch, requires both:
   1. authenticated provider or operator-tooling evidence identifying the compute or request that
      executed the unresolved operation and proving that execution has ended; and
   2. a fresh, correlated read of the target resource recording whether the effect is complete,
      absent or partial.

- The two evidence records are mandatory for the third path. They are not a universal prerequisite
  for ordinary/orphan recovery or for the current fenced runner's registered pre-hold resolution.
- Evidence fields are nonempty, time ordered, bound to the unresolved dispatch and recorded with
  the immutable reconciliation decision and audit event.
- Lease expiry, a missed heartbeat, process disappearance from a local table, an unheld advisory
  lock or elapsed time never substitutes for either item.
- A live, running or unknown external outcome for which the current runner cannot obtain
  authenticated terminal proof remains held. After hold it is never replayed or retried
  automatically, and no force-unlock follows from lease age.
- After hold, a correlated complete or absent result may progress only when the authenticated
  evidence also proves that execution ended. Stable natural-key convergence may prevent a live
  runner from creating a duplicate before reconciliation, but it never substitutes for stop
  evidence and cannot take held work out of reconciliation.
- Provider-specific collectors and runbooks must define how their evidence references are
  authenticated and retained. This record does not claim that operational tooling exists.

## Options considered

| Option | Decision |
|---|---|
| Recover after lease expiry | Rejected. The external process can still be running. |
| Accept either stop evidence or a target read | Rejected. One says the call ended; the other says what it did. Both facts are needed. |
| Require both structured evidence records | Chosen. It matches the implemented database and queue guards. |
| Require both records before every recovery or retry | Rejected. Authenticated terminal proof supports ordinary/orphan recovery, and a registered convergence contract may permit the current fenced runner's bounded same-open-dispatch replay; it never closes or creates a dispatch. |

## Consequences

- On acceptance this record supersedes ADR-0004's sentence that calls
  `external-execution-stop-evidence` open and its claim that safe convergence proves an operation
  stopped. The rest of ADR-0004 remains in force.
- `FS-CON-05` is no longer decision-blocked. It remains expected red at its earlier identity-provider
  gap until the whole fixture can reach reconciliation.
- The Core rule is decided; provider evidence collection, alerting and runbooks remain an SRE
  qualification task before any real provider effect runs.

## Changelog

- Clarified the three-path recovery boundary: ordinary/orphan recovery, the current fenced runner's
  registered pre-hold resolution and the two-record requirement for every staff decision leaving
  `needs_reconciliation`.
- First version. Reconciles ADR-0004 with the existing rule that both authenticated stop evidence
  and a fresh correlated target read are required to leave `needs_reconciliation`.
