# Runbook index

**Status:** Proposed · **Owner:** Lours

The set of runbooks that must exist, who owns each, and where each will live. This index specifies the contract between the alerting configuration and the response procedures: **every alert must link to a runbook, and CI must reject an alert pointing at a runbook that does not exist.** Section 5 defines the acceptance requirement; this document does not establish that the gate is implemented.

**Status: partial scaffolding, not operational acceptance.** At `deployment profiles` main `b1680b9e`, eleven of the thirteen files in §2 are tracked under `runbooks/`; `incident.md` and `preflight.md` are absent. The Fleet runbook README identifies the existing files as stubs whose procedures must be rehearsed on `lab`. File presence does not satisfy the content, alert-link or rehearsal requirements in §5. Read the coverage and rehearsal columns below as requirements, not as evidence that those procedures have been executed.

**Each runbook belongs in `deployment operations/runbooks/`**, one Markdown file each, next to the code that would be run. They belong in the private fleet repository because they name hosts, key material locations and escalation contacts. This index lives with the specifications in `kodera-core` because the specifications are what require them to exist.

---

## 1. Conventions every runbook follows

1. **A title that is a symptom, not a component.** The reader arrives from a pager at an hour they did not choose; they know what is broken, not which subsystem owns it.
2. **First section: "Stop the bleeding."** The shortest safe action that restores service, before any diagnosis. Diagnosis sections come after.
3. **Copy-pasteable commands**, with every variable named at the top and no invented hostnames.
4. **A "do not" list.** The destructive things a tired operator reaches for: `restart` instead of `up`, deleting a repository lock from the wrong host, editing the edge template by hand, clearing a silence that is masking a second incident.
5. **Verification at the end**: which preflight phase, which probe, which metric must be green before the incident is closed.
6. **A rollback or abort path** for anything that mutates state.
7. **Owner and last-rehearsed marker.** A runbook nobody has executed is a draft. The marker is a rehearsal reference, not a promise about a date.
8. **No customer personal data**, no secrets, no room slugs — the same rule the alert payloads follow.

---

## 2. The set

Owners are proposals; the service owner assigns. "Rehearsal" says what proves the runbook works, since a runbook that has never been executed is untested code.

### 2.1 Incident response

| Runbook | File | Owner | Covers | Rehearsal |
|---|---|---|---|---|
| **Host loss** | `runbooks/host-loss.md` | Lours | A tenant VM is gone or unreachable: confirm with both vantage points, decide rebuild versus repair, rebuild from the factory onto the **retained** addresses, restore from the latest snapshot, re-issue certificates, re-register probes and backups, verify against all three phases of preflight. The one runbook where the RTO number is actually tested. | Quarterly, on the throwaway tenant, timed against the tier RTO |
| **Certificate failure** | `runbooks/cert-failure.md` | Lours | Expiry, issuance failure, chain or SNI mismatch, a custom domain added before its verification record resolved, the **media-host certificate out of sync** with the media service after renewal, and issuance rate limits on the shared registered domain. Includes the forced-renewal path and the reload hook. | Semi-annually: force a renewal on the canary and prove the media service picks it up |
| **Relay flood / media saturation** | `runbooks/relay-flood.md` | Lours | Media CPU or egress at the ceiling, relay allocations exhausted, an abusive or runaway room, packet loss under load. Levers in order: identify the room, apply the node-level track and bandwidth limits, reject new joins, drop the room, and only then consider a tier change. Explains why there is no node-level participant cap and what actually binds instead. | Annually, from the load-test rig against the throwaway tenant |
| **Disk full** | `runbooks/disk-full.md` | Omar? | Projected-full and already-full paths. Safe reclamation order: container logs, image cache, orphaned volumes, old dumps — and what must never be deleted (the live database directory, the object-store cache mid-sync). Covers the case where the database has already stopped accepting writes. | Quarterly, by filling a disk on the throwaway tenant |
| **Incident response** | `runbooks/incident.md` | Lours | The entry point when no specific runbook applies, and the second half of several that do: the severity matrix and the Sev-1 definition from [`SLO.md`](SLO.md) §7, who is woken and when per §7.1 there, the escalation path, the customer communication templates and the update cadence, and the post-mortem format. Indexed here rather than referenced from outside the set, so that every alert in §3 points at a file this index owns. | Every incident is the rehearsal; the escalation path is exercised in the quarterly dead-man-switch drill |
| **Identity provider outage** | `runbooks/idp-outage.md` | Lours | New logins failing fleet-wide. Establishes first what still works — meetings in progress and guest joins are unaffected by design — so the customer message is right within minutes. Then: restart, restore from the 90-day-locked dump, or fail over. Includes the per-realm export path when a single realm is damaged rather than the whole instance. | Semi-annually: stop the provider on the lab environment, prove a guest join still succeeds, restore |

### 2.2 Lifecycle

| Runbook | File | Owner | Covers | Rehearsal |
|---|---|---|---|---|
| **Tenant create** | `runbooks/tenant-create.md` | Lours · Omar? | From an approved order to a green `public` preflight: project, VM, two retained addresses, security group, delegated DNS sub-zone, mail subdomain, the organisation's realm when this is its first tenant plus this tenant's clients (ADR-0006), profile render, backup bucket with its lock and append-only key, probes and status components registered, first backup verified. Includes the isolation assertion — no credential on the host resolves outside the tenant's own project — and the unattended-time target. | Every tenant creation is the rehearsal; a second person must have run one unaided |
| **Decommission** | `runbooks/decommission.md` | Lours | Written customer confirmation; synchronous ordinary access/write fences; clients disabled and remaining writes drained before the final backup; final-backup coverage through the DB/object/document high-water marks, an absolute natural-expiry store deadline and a backup-store fence for earlier deletion; independent export produced and handed over when requested; request-time outer key and hard access cutoff, no durable plaintext collection, write-ahead artefact slots, and at deletion trigger export admission/publication fenced for every tenant export state and each outer key destroyed. Closure-resource capabilities carry their own generation and transport deadline so exact natural or instructed cutoff does not depend on a worker. The cutoff transaction records one parent obligation, one job child per selected export/decommission and one session child per historical unended/live claim across every fence, with a sentinel only for proven no-claim history; every exact session reaches one closed reap outcome and fresh absence proof before cancellation/reservation release or delete claim, while a separate writer reconciles each transferred dispatch and every storage slot. Destruction completion uses a durable marker under held locks/reservation followed by an independently retryable runner-close phase; the supervisor can take over after a dead claim without repeating destructive effects. Once the parent evidence and delete close are sealed, the unique parent-linked finalizer atomically issues the active-store attestation and marks the tenant deleted. The lifetime-retained artefact manifest is scheduled for evidenced purge so an absent, pending, ready or incomplete request never extends the recovery end; bounded read-only exit lasts at most 90 days unless a validated controller instruction requests earlier irreversible deletion; infrastructure is destroyed; this tenant's clients are removed from the organisation's realm, which a tenant's decommission never deletes, not even for the organisation's last tenant (ADR-0006; organisation offboarding removes it); the ledger row is closed; the tenant-only active-store deletion attestation is signed with the last backup-lock expiry and durable immutable backup/export manifests; all deletion-linked copies are purged after expiry; and the final deletion certificate is issued only after that exact sealed scope is gone. The one runbook where the legal text and the technical steps must agree exactly. | On a throwaway tenant, exercise exact closure-access expiry, exact final-backup expiry without the writer, earlier deletion, a paused pre-fence write, multiple live export/decommission sessions including multiple fences of one shared-lock job, a terminal commit paused before unlock, final-backup drain coverage, a backup-store fence race, an ordinary pre-exit export, a running recovery export, a ready export, an unavailable delete runner, an unavailable artefact store, a long evidence outage after destruction, crashes after step 8, the durable marker and unlock, and a crash after object acceptance before Core acknowledgement; prove independent access/cutoff fences, drain coverage, complete session-child cardinality and exact-session reap before each reservation release, key-destruction barrier, child/slot reconciliation, two-phase destruction recovery, resumable unique finalization, purge obligation, and initial/final evidence documents |
| **Rotate secrets** | `runbooks/rotate-secrets.md` | Lours · security | Per-secret blast radius and order. The application signing key invalidates every session — a mass logout, potentially mid-meeting. The **media API secret must change in two places or every token fails signature validation and nobody can join**, while the stack looks perfectly healthy. Database password, identity client secrets, mail keys, cloud keys, the probe identity's credentials, the recovery identity. Each entry: order, blast radius, verification. | Semi-annually, one secret class per drill, on the canary |

### 2.3 Routine operations

| Runbook | File | Owner | Covers | Rehearsal |
|---|---|---|---|---|
| **Restore drill** | `runbooks/restore-drill.md` | Lours | The monthly automated drill, its nine pass criteria, and the manual path for when the automation itself fails. Includes clearing a stale repository lock **from the worker** — it cannot be done from the tenant host, which holds no delete right — and the separate identity-provider drill with its 90-day-locked artefacts. | Monthly, automatically, per tenant; the manual path semi-annually |
| **Upgrade** | `runbooks/upgrade.md` | Lours | The operator's view of [`UPGRADE_PROCEDURE.md`](UPGRADE_PROCEDURE.md): pre-checks including the upstream contract gate and the error-budget state, the seven steps, the rollback rule, wave composition and exclusions, and the identity provider's separate window. | Every wave; one deliberate rollback rehearsed per quarter |
| **Nightly preflight failure** | `runbooks/preflight.md` | Lours | Nightly preflight failed; the failing phase is in the alert annotation. The runbook branches on that phase: `config` (on-host checksums drifted from the rendered set, a cap or secret inconsistent, the media API secret not matching the application's), `stack` (a container unhealthy, the backup marker stale, log retention not enforced), `public` (DNS, TLS, security headers, the public surface and its redirects). Each branch ends at the same decision: fix forward within the night, or roll back under [`UPGRADE_PROCEDURE.md`](UPGRADE_PROCEDURE.md) §3. | Every red nightly is a rehearsal; each phase branch is exercised by the preflight suite's own self-test mutations |
| **Quota and capacity check** | `runbooks/quota-check.md` | Lours · Omar? | Paris cloud quotas against fleet need. Tier headroom per tenant against the measured capacity ledger, the near-cap signal and how it becomes a conversation rather than an incident, and refusing a tenant creation that would exceed granted quota at plan time rather than mid-apply. | Quarterly, and before a capacity rehearsal |

---

## 3. Alert-to-runbook map

The reverse index. Alert names are from [`OBSERVABILITY_STACK.md`](OBSERVABILITY_STACK.md) §6, and **this map and the `Runbook` column there are the same map**: every alert appears in both, with the same targets in the same order, and CI compares them. No entry is a pattern — an alert is named in full or it is not mapped. Every target is a file in §2.

| Alert | Runbook |
|---|---|
| `TenantWebDown` | `host-loss.md`, `incident.md` |
| `TenantAgentSilent` | `host-loss.md` |
| `TenantJoinFailing` | `relay-flood.md`, `incident.md` |
| `TenantRelayJoinFailing`, `LiveKitCpuHigh` | `relay-flood.md` |
| `TenantLoginFailing`, `IdPOutageFleetWide` | `idp-outage.md` |
| `CertExpiringSoon`, `CertExpiringCritical`, `CertExpired`, `MediaCertOutOfSync` | `cert-failure.md` |
| `DiskFillingUp`, `DiskCritical` | `disk-full.md` |
| `BackupStale`, `BackupFailedTwice`, `RestoreDrillStale`, `RestoreDrillFailed` | `restore-drill.md` |
| `HostEgressHigh`, `ParticipantsNearCap`, `ParticipantsAtCap`, `ScalewayQuotaNearLimit` | `quota-check.md` |
| `HostEgressCritical` | `quota-check.md`, `incident.md` |
| `PreflightNightlyFailed` | `preflight.md` |
| `PreflightStale`, `SilenceOutlivedJob` | `upgrade.md` |
| `ObjectLockNotEnforced` | `rotate-secrets.md`, `incident.md` |
| `SLOBurnFast`, `SLOBurnHigh`, `SLOBurnMedium`, `SLOBurnSlow`, `SLOBudgetExhausted`, `DeadMansSwitchTriggered`, `ProbePeerDown`, `ForbiddenLabelObserved` | `incident.md` |
| `Watchdog` | **none — the single documented exception** |

Three things this map settles, each of which was previously answered differently in the two documents:

- **`PreflightNightlyFailed` opens `preflight.md`**, not "the runbook named by the failing phase" and not `upgrade.md`. The phase (`config`, `stack`, `public`) travels as an annotation on the alert and selects a section inside that one file. A phase name is not a file, and the CI rule at the top of this document can only check files.
- **`incident.md` is indexed in §2.1**, so the rows above that point at it satisfy the acceptance criterion in §5 like any other row. It is the entry point when no specific runbook applies, and the second stop when one does.
- **`Watchdog` is the one alert with no runbook**, because it notifies no human: it is the dead-man switch's heartbeat and its absence raises `DeadMansSwitchTriggered`, which does have one. CI treats it as an exception list of exactly one member, so a second untargeted alert cannot join it unnoticed.

Which of these alerts pages, and at what hour, is not in this map: that is [`SLO.md`](SLO.md) §7.1, and it is the only place it is stated.

---

## 4. Also in the fleet repository, not indexed here

These belong to support, legal and identity workflows rather than to reliability, and are owned elsewhere: customer offboarding and export, abuse reports, data-subject requests, realm configuration, suspend and resume, and the on-call rota. They are listed so nobody concludes from this index that they are missing.

---

## 5. Acceptance

Satisfied when: every runbook in §2 exists in the fleet repository, in its existing `runbooks/` directory; every alert in the catalogue except `Watchdog` links to one of the files in §2, the two maps agree name for name, and CI fails on a broken link, on a target that is not one of those files, and on an exception list longer than one; each runbook names an owner and carries a rehearsal marker; and **a second person has executed host loss, restore drill and upgrade unaided** — the three where a single point of human failure would cost the most.

---

## Changelog

| Rev | Change |
|---|---|
| 1 | Initial proposal: eleven runbooks across incident response, lifecycle and routine operations, with owners, coverage, rehearsal expectations, shared conventions, the alert-to-runbook reverse index, and the CI rule binding alerts to runbook files. |
| 2 | Review fixes: existence claims reworded to the intended tense — no runbook exists yet and `deployment operations` carries no `runbooks/` directory. `preflight.md` added as the real target for `PreflightNightlyFailed`; `incident.md` indexed in §2.1 so the rows pointing at it satisfy §5. §3 rewritten as a per-alert map identical to [`OBSERVABILITY_STACK.md`](OBSERVABILITY_STACK.md) §6 — no patterns, every target a file in §2 — with `Watchdog` recorded as the single exception, and the acceptance criterion reworded to match. Thirteen runbooks. |
| 3 | Removes the second-region replication alert and quota work after ADR-0007 selected Paris-only data residency. |
| 4 | Tenant create and decommission describe the realm as the organisation's, as ADR-0006 decides: a decommission removes this tenant's clients and deletes the realm only when the organisation has no other tenant. |
| 5 | The decommission row no longer deletes the organisation's realm with its last tenant: a tenant's decommission never deletes it, and organisation offboarding removes it. |
