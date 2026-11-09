# Upgrade procedure

**Status:** Proposed · **Owner:** Lours

How a tenant moves from one pinned release to the next without losing data and without discovering the failure from a customer. Every upgrade is a job in the control plane with an idempotency key, a lease, ordered steps, and an audit row committed in the same transaction as the desired-state change. There is no manual upgrade path in production; the manual path exists only to be automated.

Companion specs: [`BACKUP_AND_RESTORE.md`](BACKUP_AND_RESTORE.md) (the snapshot this procedure depends on), [`SLO.md`](SLO.md) (maintenance exclusions and the budget that gates a wave), [`OBSERVABILITY_STACK.md`](OBSERVABILITY_STACK.md) (the silence the job creates).

---

## 1. The sequence

Seven steps, in this order, on one tenant. A step that fails stops the job; the job never skips forward.

```text
maintenance ON ──▶ safety snapshot ──▶ pull ──▶ up ──▶ migrate ──▶ preflight ──▶ maintenance OFF
                                                                        │
                                                                     (red) └──▶ rollback (§3)
```

### 1.1 Maintenance mode ON

- The edge serves **HTTP 503 with a `Retry-After` header** on the tenant's web surface, and a branded page in French and English saying what is happening and when it ends. `Retry-After` matters: a client that retries in a tight loop turns a two-minute upgrade into an incident.
- The **realtime collaboration provider is drained first**, before the 503 goes up: connected editors are asked to flush, given a short grace period, and disconnected cleanly. Dropping a collaboration websocket without draining is how unsaved edits are lost, and it is the one loss this procedure would otherwise cause. Draining is a precondition of the 503, not a parallel action.
- Media is **not** killed at this point. Participants already in a meeting keep their session; the media service is restarted at the `up` step, which ends those meetings. The maintenance announcement must say meetings will be interrupted — because they will.
- A **scoped, time-boxed alert silence** is created for this tenant by the job, with the job id in the comment. The silence is removed at maintenance-off. A silence outliving its job raises its own alert.
- The status page component moves to `Maintenance planifiée`, and the SLI intervals inside an **announced** window are excluded from the objective (see [`SLO.md`](SLO.md) §4). An unannounced window is an incident and spends budget — the job records which one it is at start, and it cannot be reclassified afterwards.

### 1.2 Hot safety snapshot

A snapshot taken **now**, not the last nightly. It is the rollback, and there is no other one.

- Database dump, verified non-empty and non-zero-length before anything else proceeds.
- The current rendered configuration set and its checksums.
- The current image digests and profile SHA, recorded in the job.
- Written to the tenant's append-only repository with the current-job tag, so the retention lock protects it like any other snapshot.

**If the snapshot fails or verifies empty, the job aborts and maintenance mode is lifted.** An upgrade without a rollback is not an upgrade, it is a gamble.

What the snapshot is not, stated so that nobody promises more (ADR-0004): restoring it returns the database, the rendered configuration and the image and profile pins to the moment it was taken, and discards everything written to them after it. Object-storage bodies and the organisation's realm are not in it, and a restore does not return them to that moment.

### 1.3 Pull

- Images are pulled **by digest** from our own registry mirror, never by tag from an upstream registry. A tag can move; a digest cannot, and the deploy path must not depend on a third-party registry being reachable or on its pull-rate limits.
- The compose topology is fetched at **the same pinned tag as the images**. Fetching a branch head while pinning images leaves the topology unpinned — port publications, mount targets and edge templates can change under a deploy that believes itself reproducible. The branch head is for the drift gate to look at, never for a host.
- The rendered configuration is produced from the profile at its pinned commit SHA, in a sandboxed template environment, and validated against the deny-list schema before it touches the host.

### 1.4 Up

- `docker compose up -d`, never `restart`. A container's image is bound at creation: `restart` reuses the existing container, the pulled layers are never used, and the next step then runs new migrations against old code. This is the single most expensive mistake available in this procedure.
- Services that must be **recreated, not restarted**, because they only read certain configuration at creation: the edge proxy (its log driver), and any service whose logging or network settings changed.
- Resource limits from the profile are re-applied here; a service that comes back without its limits is a red preflight, not a warning.

### 1.5 Migrate

- Migrations run after `up`, once the new code is the running code.
- The job records the migration list applied. **A migration that is not additive stops the wave**: a destructive migration cannot be rolled back by restoring a dump taken before it without losing everything written since, which for a live tenant is the whole point of the safety snapshot. Destructive migrations are handled as a separate, individually planned change with its own window, never inside a routine wave.

### 1.6 Preflight

The deploy gate, in three phases, all of which must be green: **`config`** (on-host checksums match the rendered set, caps and secrets are consistent, the media API secret matches the application's), **`stack`** (containers healthy, backup marker fresh, log retention enforced), **`public`** (DNS, TLS, security headers, the public surface and its redirects).

The job **does not mark the deploy done** until all three are green, and it verifies the three SLI probes recover: a green preflight with a failing synthetic join is still a failed upgrade. Every check ships with a self-test mutation proving it can go red; a suite that cannot fail is not a gate.

### 1.7 Maintenance mode OFF

503 lifted, collaboration provider re-enabled, silence removed, status page component returned to `Opérationnel`, job closed with an audit row and the resulting version manifest written to the tenant's observed state.

---

## 2. Soak

| Stage | Soak before proceeding |
|---|---|
| Upstream release → canary instance | **48 h** on the canary with real traffic |
| Canary → **dogfood tenant** | **48 h** green on the canary: no Sev-1/2, nightly preflight green both nights. This is the gate Fleet CI enforces on a pin |
| **Dogfood tenant** → wave 1 (one tenant) | **48 h** green on our own tenant. The dogfood stage is the *configuration* canary (§6), so this clock is the only one that covers a profile change rather than an image change |
| Wave 1 → wave 3 | **48 h** |
| Wave 3 → wave 5 | **48 h** |
| Wave 5 → the remainder | **48 h** |

**Every row of this table is a boundary between two separate playbook runs, never a pause inside one.** `serial: [1, 3, 5]` batches within a single run and those batches execute back to back, so a single invocation over the whole fleet would run wave 1, wave 3 and wave 5 within minutes of each other and none of these clocks would hold. §6 says how the waves are split so that they can.

The clock starts when the deploy completes, not when it begins, and it is a *green* clock: any Sev-1 or Sev-2 on an upgraded tenant resets it. Fleet CI refuses a tenant pin newer than the canary's, or one younger than 48 hours of canary soak. That refusal is a gate, not a lint.

**The dogfood stage is a gate too, and it is the one most easily skipped.** Fleet CI refuses a tenant-profile change that has not yet been applied to the dogfood tenant (`SUPPLY_CHAIN_POLICY.md`), for the same reason it refuses an unsoaked pin: a profile renders differently against a real tenant record than against the canary's, and the failure it produces is a configuration failure the image soak cannot see. A release that only moves images still passes through dogfood; a release that moves the profile cannot go round it.

Before an event a customer has told us about, the upgrade goes **before** the event with a full soak, never after and never inside the freeze. The reliability gain of a newer release is worth nothing if it lands untested the week of the thing it was meant to protect.

---

## 3. Rollback rule

**A red preflight is not investigated in production. It is rolled back.**

```text
preflight red ──▶ restore the safety snapshot ──▶ previous digests + previous profile SHA
              ──▶ up ──▶ migrate (no-op) ──▶ preflight ──▶ maintenance OFF ──▶ Sev-2 ticket
```

Rules:

1. **The decision is automatic, not a judgement call.** The job rolls back on a red preflight. There is no "look at it for five minutes first" — five minutes is how a two-minute window becomes an hour of downtime with an unusable safety snapshot.
2. **The rollback target is the exact previous state**: the digests and profile SHA recorded at §1.2, not "the previous tag".
3. **The rollback is itself gated**: preflight must be green after the rollback, and the SLI probes must recover, before maintenance is lifted. A failed rollback escalates to Sev-1 immediately and moves to the host-loss and restore procedures.
4. **The wave stops.** A rollback on any tenant halts the wave for every remaining tenant until the cause is written down. One tenant's failure is evidence about the release, not bad luck.
5. **A destructive migration disables automatic rollback.** If the release contained one, the job refuses to run in a routine wave at all (§1.5), so this case should not arise; if it does, it is a Sev-1 with a human decision and a written record.

---

## 4. Stepping upstream minors, and when a batch is allowed

Upstream minors arrive faster than a full fleet wave completes, which is the tension this section exists to resolve: stepping every one of them means a fleet that is permanently mid-wave, and skipping them means an unreviewable jump before an event. How much faster is an **observation from the release watch** (`SUPPLY_CHAIN_POLICY.md` §7), not a measured figure, so no cadence number is published here — principle 3 of [`SLO.md`](SLO.md) §1 applies to this document too. When the release watch has produced a measured cadence, it goes here.

The rule, taken from `SUPPLY_CHAIN_POLICY.md`: **minors are stepped one at a time; a batch is a decision, not a shortcut.** Stepping is the default and needs no justification.

A batch — to the latest patch of the latest minor in the range, one pass through the canary — is available when stepping would cost more wave time than the risk it buys, and it is a decision that is **recorded on the release**: who took it, which upgrade notes and changelogs were read across the whole range, and why the range was judged safe to take in one move. An unrecorded batch is not a batch, it is a skipped step.

A batch is **refused** outright, and the releases are stepped, when:

- the upgrade notes contain a manual step for any release in the range;
- the range contains a non-additive migration;
- the upstream contract gate fails for the target and passes for an intermediate release — then the step stops at the last passing one.

Watch **tags, not releases**: a project that tags without publishing a release will otherwise appear frozen while it is moving. Read the upgrade notes and the changelog across the whole range before pinning the target, and record in the job what was read.

---

## 5. Upstream contract gate

Our configuration depends on upstream behaviour that is not part of any upstream API: environment variable names, template structure, the fact that the application never creates rooms itself so the server-level participant cap binds every room, the identity-integration flag semantics, the CSS variable names the theme overrides. None of this is contractual upstream. All of it can change in a minor.

The gate is a script that asserts every one of those assumptions **against the target tag**, before anything is pulled.

- **A bump merges only if the gate passes for the target tag.** No override, no "it's only frontend".
- The gate runs again in CI on the branch head so drift is visible before it is urgent.
- When the gate flags the edge template, the template is **re-derived**: the fresh upstream default plus our marked blocks, reviewed as a diff. It is never hand-patched, because a hand-patched template silently diverges and the next re-derivation loses the patch.
- A newly discovered assumption becomes a new assertion in the gate in the same pull request that discovers it. The gate only stays useful if it grows.

---

## 6. Canary and waves

| Stage | Population | Purpose |
|---|---|---|
| **Canary** | the free public instance | version canary: real traffic, real browsers, real hardware diversity |
| **Dogfood** | our own tenant | configuration canary: proves the profile change, not just the images |
| **Wave 1** | 1 tenant, lowest tier, no event within the soak | first paying blast radius, deliberately smallest |
| **Wave 3** | 3 tenants across two tiers | proves the change is not tenant-specific |
| **Wave 5** | 5 tenants | the batch size `SUPPLY_CHAIN_POLICY.md` fixes; the last value of `serial` repeats, so this size carries the rest of the fleet |
| **Wave n** | the remainder, in batches of 5 | executed with `serial: [1, 3, 5]` and `any_errors_fatal: true` |

Wave composition rules:

- A tenant in **Freeze** on its error budget is excluded from the wave (see [`SLO.md`](SLO.md) §3.2).
- A tenant with a customer event inside the soak window is excluded and upgraded after, or before with the customer's written agreement.
- The identity provider is upgraded **on its own**, never in the same window as a tenant wave, with a restore drill the day before — a failure there is fleet-wide and must not be confounded with a tenant release.
- Ansible runs the waves with `serial: [1, 3, 5]` and `any_errors_fatal: true`, exactly as `SUPPLY_CHAIN_POLICY.md` specifies. A partial wave is impossible: it is all the tenants in the batch, or it is a stop and a rollback. The shape is 1, then 3, then 5 and 5 again until the fleet is done — not 1, 3, remainder, which would put the whole tail in one batch and throw away the blast-radius discipline of the first two.

**One playbook run per wave.** `serial` batches *inside* a run and its batches execute back to back, so upgrading the fleet in one invocation would collapse the soak in §2 into a few minutes of Ansible. The fleet is therefore never upgraded in one invocation:

- Each stage is its own **inventory group** — `canary`, `dogfood`, `wave1`, `wave3`, `wave5`, `rest`, one per row of the soak table in §2. The first two are separate machines rather than subsets of the fleet (the free public instance and our own tenant), so they are separate targets for the same reason the waves are separate groups: a run against one of them cannot touch the others. Membership of the four fleet groups is a property of the tenant record, so a wave is composable and reviewable before it runs.
- Each run is **limited to one group** (`--limit canary`, `--limit dogfood`, `--limit wave1`, and so on). `serial: [1, 3, 5]` still applies within the run: it is what protects a group from itself when the group holds more than one tenant, and `rest` is exactly the group where the repeating final value of 5 does its work.
- **The group is the soak unit; `serial` is the batch unit inside it.** The two do not describe the same partition, and they are not meant to: `--limit wave3` runs its three tenants as 1 then 2, `--limit wave5` runs its five as 1, 3, 1, and `rest` runs 1, 3, then fives. The "3 tenants" and "5 tenants" in the §6 stage table are **group sizes** — how many tenants a soak boundary carries — not the size of a single batch. Inside a run the batching is deliberately smaller than the group, which is the blast-radius discipline; between runs the boundary is the group, which is what the 48 h clock measures.
- **The soak clock of §2 runs between runs**, in wall-clock time, with nothing executing. That is the only place it can run.
- **`any_errors_fatal: true` stops a run at the first failure**; the red gate stops the *next* run from being started at all. A failed or rolled-back run halts the programme until the cause is written down (§3, rule 4) — it is not a matter of the playbook continuing to the next batch, because there is no next batch in that invocation.

`serial` is what makes one wave safe. One run per group is what makes the soak between waves real. Neither substitutes for the other.

---

## 7. What the job records

Every upgrade job writes, in the same transaction as the desired-state change: the tenant, the from- and to-versions (profile SHA and every image digest), the safety snapshot id, whether the window was announced and when, the migrations applied, the three preflight verdicts as JSON, the SLI recovery check, the rollback decision if any, and the wall-clock duration of the maintenance window.

That record is the audit trail, the evidence for the maintenance exclusion in the monthly availability figure, and the input to the fleet metric that matters most: **how long a full upgrade cycle takes across the fleet**, which is one of the written triggers for changing the architecture.

---

## 8. Acceptance

Satisfied when: a tenant has been taken through a multi-minor upgrade by the job — stepped, and once through a recorded batch — with every record written before the safety snapshot present and readable afterwards, and a maintenance window inside its announced bounds; **one deliberate rollback has been rehearsed** end to end from a red preflight, with the safety snapshot restored and preflight green afterwards; the contract gate has blocked at least one real bump and the blocking assumption is written down; and a second person has run an upgrade unaided.

---

## Changelog

| Rev | Change |
|---|---|
| 1 | Initial proposal: the seven-step sequence with collaboration-provider drain and 503 with `Retry-After`, hot safety snapshot as the only rollback, digest-pinned pull with topology at the same tag, `up` rather than `restart`, three-phase preflight as the gate, automatic rollback on red, soak times, upstream minor batching, upstream contract gate, canary and 1 → 3 → n waves, job record contents. |
| 2 | Review fixes: wave shape corrected to `serial: [1, 3, 5]` with `any_errors_fatal: true`, as `SUPPLY_CHAIN_POLICY.md` specifies. Default inverted to match the same policy: minors are stepped one at a time and a batch is a decision recorded on the release. Dogfood added to the soak table with its own clock, and the policy's refusal of a tenant-profile change not yet applied to the dogfood tenant restated here. Unmeasured upstream cadence figure removed, with the reason it was unpublishable. One playbook run per wave — an inventory group per wave selected with `--limit` — so the soak clock between waves survives `serial`'s back-to-back batching. Inventory groups named for every soak boundary including `canary` and `dogfood`, with the group as the soak unit and `serial` as the batch unit inside it. |
| 3 | Aligns with ADR-0004 as accepted: §1.2 states what the safety snapshot does not cover and that restoring it discards what was written after it, and §8 replaces "zero data loss", which no rollback can promise, with a criterion a person can check. |
