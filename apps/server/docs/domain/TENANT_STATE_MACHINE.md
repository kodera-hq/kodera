# Tenant state machine

**Status:** Proposed · **Owner:** Worker seat

`Tenant.status` is the **one canonical enum** in the platform. Three enums previously disagreed — the `status:` field of `tenants/{slug}/tenant.yaml` in the fleet registry (`provisioning | active | suspended | decommissioning | deleted`), the lifecycle prose of the strategy (order, provision, ready, run, upgrade, leave), and the README's data-model sketch. This document replaces all three. Where `tenant.yaml` still carries a `status:` key, it is a **rendered copy** of `Tenant.status`, produced by a job and never read back as truth.

## 1. The enum

```text
ordered ──▶ provisioning ──▶ ready ──▶ active ⇄ upgrading
                                          ⇅        maintenance
                                          ⇅        suspended
                                          └──▶ decommissioning ──▶ deleted

failed  ◀── any job-driven state, on an exhausted job; retry returns to the state that failed
```

| Status | Meaning | Terminal |
|---|---|---|
| `ordered` | The row exists, the plan and pack are chosen, and no tenant workload or data store is provisioned. A human-controlled project/bootstrap boundary may already exist, or an ordered-cancellation cleanup may be closing its complete historical scope. Awaiting the DPA, project bootstrap/go-ahead, or cleanup finalization | no |
| `provisioning` | A `provision` job is building the host, addresses, realm clients, DNS, profile and probes inside the bootstrapped project | no |
| `ready` | Built and green on preflight, not yet handed over: no welcome mail sent, no member has logged in | no |
| `active` | In service. The only status in which the customer's users are expected to work | no |
| `upgrading` | An `upgrade` job is applying a release; maintenance mode is on for part of it | no |
| `maintenance` | A planned or ad-hoc operation is in progress that is not a release: restore, secret rotation, host rebuild, address move | no |
| `suspended` | Deliberately out of service: non-payment, abuse, or customer request. Data intact, logins disabled, running rooms finish | no |
| `decommissioning` | The bounded recovery window is open. Ordinary access and mutations are synchronously denied by the state and `TenantExit` fences; a delayed worker cannot preserve them. The state reserves a future top-level read-only export lane until deletion admission closes, but no current API operation admits it. The termination transaction fixes `TenantExit` and enters this state before enqueueing the preparation job; that job disables clients, drains writes and takes the final backup as defence-in-depth preparation, while a later `delete` job destroys active stores and the durable cutoff finalizer issues the initial deletion attestation | no |
| `deleted` | An initial deletion attestation exists and either tenant active stores are gone or the cancelled ordered tenant has canonical proof that no workload or tenant data store was ever provisioned. If a bootstrap project/IAM boundary existed, authenticated closure/absence evidence was finalized first. Only the tombstone, legally retained records and any separately clocked locked backups remain | **yes** |
| `failed` | A job-driven transition exhausted its retries. Carries `status_reason` and the failing `job_id` | no |

Only `deleted` is terminal. `failed` is a holding state, never a resting one: an operator either retries or moves the tenant to `suspended` or `decommissioning`.

## 2. What `status` is not

- **Not health.** A tenant whose agent has missed three heartbeats is `active` with `is_stale = true`. Staleness is a flag on the row and a status-page signal; it never changes `status`. Nothing in the system transitions a tenant on the basis of a missing heartbeat, because a network partition is not a lifecycle event.
- **Not drift.** `observed.drift` records that the nightly `drift_check` found a difference between plan and reality. Drift raises an alert and may cause an operator to run a job; it never moves the status by itself.
- **Not subscription state.** `Subscription.state` (`past_due`, `suspended`, `cancelled`) is separate. Billing *causes* a transition through the `suspend` job; it does not *encode* one. Reading dunning state off `Tenant.status` is forbidden.
- **Not capacity.** A tenant at 100 % of `room.max_participants` is `active`.

## 3. Allowed transitions

Every transition is a row in this table. A transition absent from this table is `409 invalid-state-transition` with the allowed set in the problem body. The transition, the desired-state change and the `AuditEvent` commit in one transaction (ADR-0004).

| # | From | To | Trigger | Job kind | Guards |
|---|---|---|---|---|---|
| T1 | — | `ordered` | `POST /api/v1/tenants` | none | Plan published; organisation `active`; slug free |
| T1b | — | `ordered` | `createTenant`, on a deployment that does not bill ([`QUICK_WORKSPACE.md`](../specs/QUICK_WORKSPACE.md) §4) | none | Caller `org_owner`; organisation `active`, its setup `ready`; no tenant of the organisation that is not `deleted`; slug free; the CGV and DPA in force accepted in the same transaction. No order: T2's guards apply unchanged, and a mistaken creation is the operator's to delete (`manage.py tenant_status`, slice C3) |
| T2 | `ordered` | `provisioning` | `POST .../actions/provision` | `provision` | `DpaAcceptance` for the current DPA major exists; contacts complete; quota check passes; current order is not cancelled; `ordered_cancellation_fenced_at` is null; a `ProjectBootstrap` in state `verified` whose `key_expires_at` is in the future — verified once by the `bootstrap_verify` job (T26), re-checked by `provision` step 3, which fails closed if the evidence changed (ADR-0005). Provisioning and cancellation lock the tenant row `FOR UPDATE`, so exactly one wins |
| T3 | `provisioning` | `ready` | `provision` succeeded | `provision` | Preflight `config → stack → public` all green; agent enrolled; probes registered |
| T4 | `provisioning` | `failed` | `provision` exhausted | `provision` | — |
| T5 | `failed` | `provisioning` | operator retry | `provision` | Same idempotency key; orphan recovery ran first |
| T6 | `ready` | `active` | `POST .../actions/activate`, or first successful member login | none | At least one canonical `Domain` in `live`; welcome notification queued |
| T7 | `active` | `upgrading` | `POST .../actions/upgrade` | `upgrade` | Release `approved`; inside the maintenance window or an explicit override; no other job holds or has reserved a conflicting tenant lock when the `upgrade` is claimed ([`JOB_CATALOGUE.md`](JOB_CATALOGUE.md) §1) |
| T8 | `upgrading` | `active` | `upgrade` succeeded | `upgrade` | Post-upgrade preflight green; maintenance mode off |
| T9 | `upgrading` | `active` | `upgrade` rolled back | `upgrade` | Safety snapshot restored; `TenantRelease` marked `rolled_back` |
| T10 | `upgrading` | `failed` | Rollback itself failed | `upgrade` | Alert raised at severity critical |
| T11 | `active` | `maintenance` | `restore`, `rotate_secret`, `add_domain` needing an edge reload, host rebuild | `restore`, `rotate_secret`, `add_domain`, `remove_domain` | Notice given per the maintenance window's `notice_hours`, or the operation is an emergency with `status_reason` recorded |
| T12 | `maintenance` | `active` | Job succeeded | as above | Preflight green |
| T13 | `maintenance` | `failed` | Job exhausted | as above | — |
| T14 | `failed` | `maintenance` | operator retry | as above | — |
| T15 | `active` | `suspended` | Dunning ladder, abuse enforcement, or customer request | `suspend` | Reason recorded; notification sent; data untouched |
| T16 | `ready` | `suspended` | Same | `suspend` | — |
| T17 | `suspended` | `active` | Payment received, abuse resolved, customer request | `resume` | Subscription not `terminated`; at the latest on the next business day after payment (CGV 13.3) |
| T18 | `suspended` | `decommissioning` | Termination at the end of the dunning ladder, or contract end | `decommission` | The accepting transaction creates `TenantExit` with the exact 90-day end and enqueues the job atomically. An export request, its absence or its state never extends that end |
| T19 | `active` | `decommissioning` | Customer-requested termination | `decommission` | Owner-confirmed; the accepting transaction creates `TenantExit` with the exact 90-day end and enqueues the job atomically. An export request, its absence or its state never extends that end |
| T20 | `ready` | `decommissioning` | Order cancelled before handover | `decommission` | The accepting transaction creates `TenantExit` with the exact 90-day end and enqueues the job atomically. An export request, its absence or its state never extends that end |
| T21 | `ordered` | `deleted` | Cancelled order reaches its durable finalizer before any workload was provisioned | none | Cancellation locks the tenant `FOR UPDATE`, writes its permanent ordered-cancellation fence before inspecting bootstrap state, and proves no `Host`, `Ip`, `Domain`, `TenantRelease`, `Backup`, `Secret`, `Agent` or tenant data-store authority exists. Every bootstrap record/verify and T2 path takes the same lock and checks the fence/current order. Only when no lifetime `ProjectBootstrap` row ever existed does cancellation record canonical empty backup/export manifests, issue exactly one tenant-only `never_provisioned` attestation bound to the cancelled order and change status atomically. If any recorded, verified, expired or replaced row exists, it instead retires the current row, creates one durable `OrderedCancellationCleanup` whose immutable scope contains every historical provider project/application/policy/key boundary without exception, and leaves the tenant `ordered`; no attestation or `deleted` status is allowed yet. Only after the operator closes every scoped boundary and an independent authenticated verifier seals exact absence evidence does the unbounded cleanup finalizer atomically issue the same attestation and enter `deleted`. The organisation's realm is not a tenant artefact and is left alone (ADR-0006). The current runtime implements neither future attestation branch, so acceptance remains expected-red |
| T22 | `decommissioning` | `deleted` | Durable cutoff finalizer observes `delete` destruction complete and cutoff evidence sealed | `delete` + cutoff obligation | The independently retried finalizer atomically issues the initial active-store deletion attestation and changes status; it has no bounded job-attempt budget. The attestation names the last backup-lock expiry; addresses are released; this tenant's clients are removed from the organisation's realm, which is never deleted by a tenant's `delete`, not even for the organisation's last tenant (organisation offboarding removes it); the project's closure is handed to the operator at the ADR-0005 boundary, who revokes the tenant's key and closes the project only after the worker has purged the bucket past its lock. A separate follow-up issues the final deletion certificate only after the last locked copy is purged |
| T23 | `decommissioning` | `failed` | `decommission` or `delete` exhausted | `decommission`, `delete` | Nothing is left half-destroyed silently |
| T24 | `failed` | `decommissioning` | operator retry | `decommission`, `delete` | — |
| T25 | `active` | `active` | `drift_check`, `backup`, `export` | those kinds | No status change; these jobs run against a live tenant under a shared lock. `realm_create` and `realm_update` are organisation-scoped and appear in no row of this table ([`JOB_CATALOGUE.md`](JOB_CATALOGUE.md) §2) |
| T26 | `ordered` | `ordered` | `ProjectBootstrap` recorded or replaced | `bootstrap_verify` | No status change; the job verifies the recorded bootstrap under the tenant's exclusive lock and is the only place that verification happens (ADR-0005) |
| T27 | `decommissioning` | `decommissioning` | Future recovery-window export request | `export` | No current API operation admits this transition. When implemented: the opening `decommission` job succeeded and ended its reservation; designated closure principal; before `recovery_ends_at`; no validated earlier-deletion instruction; export admission still open. The export is a top-level job under a shared tenant lock, never a child of `decommission` |
| T28 | `failed` | `decommissioning` | Natural recovery expiry or validated earlier-deletion instruction supersedes a failed `decommission` | `delete` | The failed preparation remains immutable and unreserved; the cutoff transaction closes/fences export and final-backup admission, creates the durable reconciliation obligation, and accepts delete without retrying preparation. The obligation later proves canonical no-write or records every accepted backup version before active-store attestation |

Transitions explicitly **not** allowed, and the reason:

| From → To | Why not |
|---|---|
| `deleted` → anything | Terminal. A returning customer is a new tenant with a new slug |
| `suspended` → `upgrading` | Never upgrade a tenant that is out of service; resume first |
| `provisioning` → `suspended` | Cancel the job and let it fail; then decide |
| `ordered` → `active` | Nothing exists to be active |
| `active` → `ready` | `ready` is pre-handover only, and handover is not reversible |
| any → `failed` without a job | `failed` always names a `job_id`. One declared exception: the pilot's operator override (§3.1), which records the operator and the reason instead |

### 3.1 The pilot's operator override

Until the `provision` job runs (F2), a staff operator moves a tenant by hand with
`manage.py tenant_status set` from the operator image ([`QUICK_WORKSPACE.md`](../specs/QUICK_WORKSPACE.md)
§5). It takes the rows below and no other, under a current `staff_operator` grant, with the tenant
row locked `FOR UPDATE` as T2 locks it. It is an **override**: it does not check T2's guards (a
verified `ProjectBootstrap`, complete contacts), T5's (the same idempotency key, orphan recovery
first) nor T6's (a live `Domain`, a queued welcome notice), and starts no job. It moves only a tenant **no order ever named** (a creation by
`createTenant`, T1b): an order's tenant moves with its order, so a later cancellation cannot leave
an `active` tenant behind a cancelled order. Each transition writes its own audit row as `staff`, metadata
`{from, to, override: true, reason}`, in the status change's transaction.

| `--to` | Rows taken | Audit |
|---|---|---|
| `provisioning` | T2 from `ordered`, or T5 from `failed` (a retry) | `tenant.provision_requested` |
| `active` | T3, then T6 | `tenant.ready`, then `tenant.activated` |
| `failed` | T4 | `tenant.failed` |
| `deleted` | T21, with no fence or attestation since nothing was built; its slug stays taken | `tenant.deleted` |

Any other move, a repeat, a tenant an order names and a caller without the grant are refused and
write nothing. This command moves a `failed` tenant by T5 only: one that was partly built leaves
by §3's other rows, never by this command's T21.

## 4. Which job kind drives each state

| Status | Entered by | Left by | Exclusive tenant lock held by the driving job |
|---|---|---|---|
| `ordered` | API | `provision`, or a cancel | only while `bootstrap_verify` runs |
| `provisioning` | `provision` | `provision` | yes, for the whole job |
| `ready` | `provision` | API activation, `suspend`, `decommission` | no |
| `active` | API, `upgrade`, `resume`, `restore` | `upgrade`, `suspend`, `decommission`, maintenance-class jobs | no |
| `upgrading` | `upgrade` | `upgrade` | yes |
| `maintenance` | `restore`, `rotate_secret`, `add_domain`, `remove_domain` | the same job | yes |
| `suspended` | `suspend` | `resume`, `decommission` | no |
| `decommissioning` | API termination transaction | `delete` | only while either short job runs; the recovery wait itself holds no live lock or durable reservation |
| `deleted` | ordered cancellation or durable cutoff finalizer | — | no |
| `failed` | any job kind on exhaustion | operator retry of the same kind, or cutoff supersession T28 for a failed decommission | no |

The last column is the job that drives the status. It is not the whole lock picture: `backup`,
`drift_check` and `export` run under a **shared** tenant lock in `ready`, `active` and `suspended`;
`export` alone may also run in `decommissioning` while T27's guard holds. The recovery wait is state,
not a running job: after `decommission` is terminal it holds no lock or reservation. A recovery-window
export is an independent top-level job with its own shared reservation, so the earlier
`decommission` cannot strand an exclusive reservation behind it.

Job steps, timeouts, compensations and locks are in [`JOB_CATALOGUE.md`](JOB_CATALOGUE.md). No two jobs hold conflicting locks on one tenant at once — an exclusive lock conflicts with every other, a shared one only with an exclusive one — and no job is claimed while another job's reservation conflicts with its lock set. A request is refused with `409 tenant-locked` only when its tenant lock conflicts with an **exclusive** lock held or reserved on that tenant; a request for an exclusive lock that meets only shared holders is accepted and waits its turn in request order.

At `recovery_ends_at`, or when a validated earlier-deletion instruction is accepted, export
and final-backup admission close before `delete` can claim its exclusive tenant lock. The narrow
cutoff writer may accept delete through existing export or exclusive `decommission` reservations:
it cancels future effects and creates a parent reconciliation obligation plus one cancel job child
per selected non-terminal job and one reap-only job child per relevant terminal job. Beneath each it
creates one session child for every historical unended/live claim across all fences, or one
`never_claimed` sentinel when durable history proves there was no claim. It leaves every old live
lock and reservation until every session child has one closed reap outcome (`terminated`,
`already_absent`, or sentinel-only `never_claimed`) and a fresh exact-session/job-fence lock absence
proof. The trusted writer then transfers
each open dispatch to its matching child, records the immutable supersession link and ends that
job's reservation atomically, or uses T28 when preparation already failed. Missing stop/drain
evidence moves with the obligation; `prepared_at` is not a cutoff gate.
Every export that held or
could create an artefact, including an ordinary pre-exit or already-ready export, is linked to the deletion, fenced and
crosses the durable key-destruction barrier in [`JOB_CATALOGUE.md`](JOB_CATALOGUE.md) §2. Live jobs
are fenced at cutoff, then cancelled and released only after their exact claim sessions and live locks are proved absent;
physical purge and missing runner-stop
evidence remain incident and final-certificate obligations rather than recovery-window extensions.
No new export may enter after admission closes, and the exclusive `delete` request keeps its place
ahead of later shared work while existing export reservations end. An export never extends the
recovery end.

In current A3, a job in `needs_reconciliation` moves no status: the tenant keeps the status the job drove it to, and does not reach `failed`, until an operator's decision takes the job out of that state (ADR-0004). Its reservation stays in force meanwhile, so an exclusive one also holds back that tenant's `backup`, `drift_check` and `export`.
The sole exception is the future cutoff supersession above: after proved claim-session absence, an
accepted delete may transfer each selected export/decommission dispatch to its own durable child,
cancel that job and release its reservation. The later evidence writer resolves every child and the
parent finalizer completes T22 once destruction, the exact delete-claim close proof and cutoff
evidence are durably complete.
No obligation writer resumes a job; customer access never returns or extends.

## 5. What the console shows

The console renders from `status`, `is_stale` and `observed`, never from a job's internal step names. Copy lives in the message catalogue; the keys below are the contract between core and console.

| Status | Badge | Primary message key | What is offered | What is hidden |
|---|---|---|---|---|
| `ordered` | grey, "Ordered" | `tenant.ordered` or `tenant.awaitingProjectBootstrap` | Complete the DPA, review contacts, view the recorded operator handoff, cancel | URLs, people, domains, invoices for this tenant |
| `provisioning` | blue, animated, "Being created" | `tenant.provisioning` | Live job progress by step, an estimate, cancel | Everything else; no URL is shown before it resolves |
| `ready` | amber, "Ready to hand over" | `tenant.ready` | URLs, the first admin invitation, the domain wizard | Capacity gauge (no traffic yet) |
| `active` | green, "In service" | `tenant.active` | Everything: people, domains, capacity, invoices, support, upgrade prompt at 90 % | — |
| `upgrading` | blue, "Update in progress" | `tenant.upgrading` | Target release, step progress, expected end, a link to the status page | Destructive actions, domain changes, plan changes |
| `maintenance` | blue, "Maintenance" | `tenant.maintenance` | What is running, expected end, notice reference | Destructive actions |
| `suspended` | red, "Suspended" | `tenant.suspended.<reason>` (`non_payment`, `abuse`, `customer_request`) | The unblocking path: pay the invoice, contact support, request resumption. Invoices stay readable | People and domain mutations |
| `decommissioning` | red, "Closing" | `tenant.decommissioning` | Future lane (no current API admission): bounded read-only exit resources while the window is open, progress | Everything mutating |
| `deleted` | grey, "Deleted" | `tenant.deleted` | Future finalizer output, while an approved identity path remains: the initial deletion attestation, final invoices, backup-lock expiry and the final certificate once issued. Delivery after identity erasure remains owner-gated | The tenant's own surfaces |
| `failed` | red, "Needs attention" | `tenant.failed` | A support entry point and the failing step name; the retry button is staff-only at launch | Any suggestion that the customer can fix it |

Independent of status, when `is_stale = true` the console shows a secondary "Not reporting" indicator with the last-seen time, and the status page's components fall back to probe results rather than agent vitals.

## 6. What the agent may set

The agent authenticates on `/agent/v1/` and has no scope on `Tenant` ([`../api/AUTHZ.md`](../api/AUTHZ.md) §7). A heartbeat may write only:

| Field | From | Rule |
|---|---|---|
| `Agent.last_seen_at`, `Agent.boot_id`, `Agent.seq`, `Agent.vitals`, `Agent.agent_version` | heartbeat | `seq` is monotonic **within one `boot_id`** and restarts at zero when the agent process does. Core orders by `(boot_id, seq)`: a `seq` already seen for the current `boot_id` is accepted with `200` and discarded, a new `boot_id` is the reboot case and is accepted with the counter restarting, and only a `seq` that goes backwards on a `boot_id` that already accepted a higher one is `409 seq-regression` ([`../api/AUTHZ.md`](../api/AUTHZ.md) §7) |
| `Tenant.observed.compose_digest`, `.profile_version` | heartbeat `profile` | Reported reality only |
| `Tenant.observed.maintenance` | heartbeat `maintenance` | What the box believes; a disagreement with `status` raises `tenant.maintenance_mismatch`, it does not change `status` |
| `Tenant.is_stale` | derived | Set true by the core after three consecutive misses; cleared by the next accepted heartbeat. Not written by the agent |
| `Backup` rows | backup report | `state`, `size_bytes`, `restic_snapshot_id`, `finished_at` for its own tenant |
| `JobStep.status` | command result | Only for steps of a job that dispatched a command to this agent, keyed by `command_id` |

The agent MUST NOT and CANNOT set `Tenant.status`, `plan_id`, `capacity_tier`, `apps`, any `Domain.state`, any billing row, or any other tenant's anything. A heartbeat that carries a `status` field is accepted and the field ignored, and the occurrence is counted so a non-conformant agent build is visible.

## 7. Invariants a test must prove

1. Every transition performed by the service layer exists in the table in §3; a generated test enumerates the cross-product and asserts that every pair outside the table raises.
2. No code path writes `Tenant.status` outside the transition service. One declared exception: the
   pilot's operator override (§3.1, `apps/tenancy/operator_status.py`), which takes §3's rows only.
3. A missed heartbeat never changes `status`; a test stops the fake agent and asserts `status` unchanged and `is_stale` true.
   A companion test replays one heartbeat inside its `boot_id` and asserts `200`, restarts the fake agent with a fresh `boot_id` and `seq` zero and asserts `200`, then rewinds `seq` on the unchanged `boot_id` and asserts `409` — three cases, because an agent that stops on a network retry and an agent that stops on a reboot are two different outages we would have shipped.
4. `deleted` is absorbing: every transition out of it raises.
5. A `failed` row always has a non-null `status_reason` and a `job_id` that exists. One declared
   exception: a `failed` set by the pilot's operator override (§3.1), whose reason and operator are on
   its `tenant.failed` audit row and which names no job.
6. Two jobs cannot hold conflicting tenant locks at once. A test holds a shared lock twice and asserts that an exclusive request is accepted and queued, and that a later shared request is not claimed before it; then it holds an exclusive lock and asserts that a shared request is refused with `409 tenant-locked`, including after the holder's database session has ended while its reservation stands.
7. The rendered `tenant.yaml` `status:` value equals `Tenant.status` at render time, and the nightly drift check reports a difference rather than resolving it.
8. Pausing the decommission runner immediately after T18, T19 or T20 commits leaves ordinary reads,
   sessions and mutations denied at the synchronous authorization/write fences while the exact
   recovery cutoff remains unchanged. Pausing a pre-fence write across that transition proves it is
   either refused before effect or included in the drain and final-backup coverage; mutations that
   depend on client-disable, service-stop or backup execution for logical denial must fail.
9. A request, response stream or realtime session admitted under the previous
   `Tenant.access_generation` holds the shared delivery barrier across validation and send. A test
   pauses after validation but before send: termination's exclusive barrier waits for that emission
   to complete before commit, and no later chunk, frame or heartbeat uses the old generation even
   when the decommission runner is unavailable.
10. At either cutoff, every queued, running or `needs_reconciliation` export/decommission job has
    its own cutoff job child and is superseded only after every historical unended/live claim-session
    child across all fences and its advisory locks are proved gone; a relevant terminal job paused
    before unlock has its own reap-only job child.
    Then no stale reservation or terminal live lock blocks delete. Each open dispatch transfers to
    its own child, and every store-accepted export/final-backup object remains in the immutable scope
    after journal/store reconciliation. Destruction completion uses a recoverable two-phase
    handoff: the effect marker commits while reservation and locks remain, then fresh absence proof
    closes the session/reservation and succeeds the job. A supervisor may adopt marker-only
    completion after a dead exact claim once steps 1–8 are durably succeeded. Unavailable evidence cannot create false no-write or an
    attestation; once evidence returns, the unique parent-linked finalizer completes T22 without a
    job retry cap.
11. Every closure-resource capability binds `TenantExit.closure_access_generation` and the effective
    cutoff. Each chunk/frame holds the closure delivery barrier across trusted-time validation and
    send with a transport deadline at the cutoff. Exact natural expiry denies independently of a
    writer; an earlier instruction advances the generation while holding the barrier exclusive.
    Tests pause after validation before send at both boundaries with delete and supervisor absent.

## Changelog

- Records the future bounded exit path: termination fixes the 90-day maximum and cuts ordinary access synchronously, cutoff can move earlier only on validated controller instruction, each selected job is safely superseded through its own reconciliation child, and the durable finalizer reaches `deleted` only after destruction and sealed evidence.
- First version. Fixes assessment item C3 and finding 7: one canonical `Tenant.status` replacing three disagreeing enums, an exhaustive allowed-transition table with guards, the job kind that drives each state, the console rendering contract, and the rule that agent staleness is a flag rather than a status.
- Removes `realm_update` from T25: it is organisation-scoped, takes no tenant lock and belongs in no row of a tenant transition table.
- States the `(boot_id, seq)` heartbeat rule in §6, matching `../api/AUTHZ.md` §7 and the agent contract, and adds the invariant that proves its three cases separately.
- Adds the accepted project-bootstrap record to the `ordered` to `provisioning` guard and makes the operator handoff visible without inventing a second tenant status.
- Stops treating the realm as a tenant artefact (ADR-0006): T21 leaves the organisation's realm alone, and T22 removes this tenant's clients and deletes the realm only when this was the organisation's last tenant.
- Names where bootstrap verification happens: the `bootstrap_verify` job (T26) verifies, the T2 guard consumes the `verified` record, and `provision` step 3 re-checks.
- Aligns the lock sentences with ADR-0004 as accepted: shared tenant locks may be held together, durable reservations count as well as live locks, and a job in `needs_reconciliation` moves no status and keeps its reservation. T22 no longer says the `delete` job closes the project: that is the operator's act at the ADR-0005 boundary, after the bucket purge and the key's revocation.
- Review fixes: a tenant's `delete` never deletes the organisation's realm (T22); T7 and the §4 lock column describe conflicting and shared locks rather than a single tenant lock; `409 tenant-locked` is only for a conflict with an exclusive hold or reservation, and invariant 6 tests it that way.
- `resume` (T17) completes at the latest on the next business day after payment, as CGV 13.3 says.
- Adds T1b, `createTenant` on a deployment that does not bill, and §3.1, the pilot's operator override of T2 or T5, T3 then T6, T4 and T21 (`manage.py tenant_status`), the one declared exception to "`failed` always names a `job_id`" and to §7's invariants 2 and 5.
