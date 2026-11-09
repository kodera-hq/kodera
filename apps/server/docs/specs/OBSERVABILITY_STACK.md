# Observability stack

**Status:** Proposed · **Owner:** Lours

How signals leave a tenant VM, where they are stored, what they are allowed to contain, and which alert links to which runbook. The objectives those signals serve are in [`SLO.md`](SLO.md); the procedures the alerts point at are in [`RUNBOOK_INDEX.md`](RUNBOOK_INDEX.md).

---

## 1. Shape

```text
┌── Tenant N (one VM, one Scaleway project, fr-par) ─────────────────────────┐
│  Grafana Alloy  ← node_exporter (host)                                     │
│                 ← cAdvisor-style container metrics                         │
│                 ← LiveKit /metrics (prometheus.port)                       │
│                 ← nginx-proxy / edge log-derived metrics                   │
│                 ← agent vitals: backup age, cert expiry, preflight verdict │
└───────────┬────────────────────────────────────────────────────────────────┘
            │ remote_write, mTLS, egress only (no inbound scrape into a tenant)
┌───────────▼── Ops project, fr-par ─────────────────────────────────────────┐
│  Prometheus  ──▶ Alertmanager ──▶ chat (warnings) · phone/SMS (Sev-1)      │
│      │                    └─────▶ Watchdog push ──▶ off-region Gatus       │
│      └──▶ Grafana dashboards                                               │
└────────────────────────────────────────────────────────────────────────────┘
┌── Off-region: Gatus on an OVHcloud VPS, Roubaix ───────────────────────────┐
│  the three SLI probes per tenant · dead-man switch · public status page    │
└────────────────────────────────────────────────────────────────────────────┘
┌── In-region: Gatus in the ops project ─────────────────────────────────────┐
│  the same web check per tenant, as tie-breaker · mutual heartbeat with ↑   │
└────────────────────────────────────────────────────────────────────────────┘
```

Two rules give the shape its meaning:

- **Blackbox lives outside `fr-par`, whitebox lives inside.** A prober in the region it watches cannot report a regional outage. A metrics pipeline outside the region pays for transit it does not need.
- **Tenants push, the ops project never pulls.** The provisioning worker has no inbound network and neither does the metrics path: Alloy on the tenant VM `remote_write`s outward over mTLS with a per-tenant client certificate. Nothing in the ops project holds a credential that can reach into a tenant, and a compromised ops project cannot scrape a tenant it was not already receiving from.

### 1.1 Components

| Component | Where | Purpose | Notes |
|---|---|---|---|
| **node_exporter** | tenant VM | host CPU, memory, disk, NIC bytes, load | NIC counters are the egress-versus-cap series; the cap is a per-instance-type constant carried as a label |
| **Grafana Alloy** | tenant VM | collection and `remote_write` | one agent, not three; relabels every series with the tenant identity before it leaves the host |
| **LiveKit metrics** | tenant VM | `livekit_*` from the server's Prometheus endpoint (`prometheus.port`) | the only source for participant, track and packet counts |
| **Agent vitals** | tenant VM | backup age, certificate expiry, nightly preflight verdict, participant peak, egress peak | exported as gauges so an absence is detectable, never as log lines |
| **Prometheus** | ops project, `fr-par` | storage, recording rules, alert rules | one instance; sharding is a phase-2 problem |
| **Alertmanager** | ops project | grouping, inhibition, routing, silences | the maintenance silence is created by the upgrade job, not by hand |
| **Grafana** | ops project | dashboards | read-only for anyone not on the rota |
| **Gatus (off-region)** | OVHcloud VPS, Roubaix | SLI probes, dead-man switch, status page | authoritative for the SLO |
| **Gatus (in-region)** | ops project | web check tie-breaker, mutual heartbeat | never authoritative |

Scaleway Cockpit remains the managed alternative for metrics and alerting and is the fallback if running Prometheus ourselves costs more attention than it returns. The decision point is written into the phase-2 triggers, not left to taste. Note that Cockpit is billed per Project, so every tenant agent would push to the ops project either way — the pipeline shape above does not change if we switch.

---

## 2. Metric and label conventions

### 2.1 The rule that matters

**Labels carry infrastructure identity only. No user data, ever.** Not an email, not a display name, not a user id, not a room slug, not an IP address, not a document title. A room slug is a capability: whoever knows it can join. A label is not a place to put a capability.

This is what makes the alert path acceptable: alert payloads carry hostnames, tenant slugs and counters, so delivery over a non-EU chat service processes no personal data. Break the rule once and that statement stops being true for every alert.

### 2.2 Required labels

| Label | Value | Cardinality |
|---|---|---|
| `tenant_slug` | the tenant's stable slug, e.g. `lab` | one per tenant; the primary dimension everywhere |
| `tenant_tier` | `S` / `M` / `L` / `XL` | 4 |
| `instance_type` | Scaleway type, e.g. `vm-l` | small |
| `nic_cap_bps` | the type's published bandwidth cap, as a label on the host info series | small |
| `app` | `meet`, `livekit`, `docs`, `y-provider`, `postgres`, `redis`, `edge`, `agent` | small |
| `env` | `prod`, `staging`, `lab` | 3 |
| `host_role` | `web`, `media` | 2 |

`tenant_slug` is applied by Alloy on the tenant VM, from the rendered profile — never derived in the ops project, so a mislabelled series is a rendering bug that CI catches rather than a silent mis-attribution.

**Forbidden as labels:** `room`, `room_slug`, `user`, `user_id`, `email`, `sub`, `document_id`, `client_ip`, `session_id`, and any free-text field from an application. A metrics relabel drop-list enforces this in Alloy, and a CI check asserts the drop-list covers every label name the LiveKit and Django exporters can emit for the pinned versions. The check ships with a self-test mutation: a series carrying a forbidden label must be dropped, and the test proves it is.

### 2.3 Naming

`kodera_<subsystem>_<thing>_<unit>` for anything we author; upstream names are kept as they are (`livekit_*`, `node_*`, `nginx_*`) so an upstream dashboard still works. Counters end in `_total`, gauges carry the unit (`_bytes`, `_seconds`, `_ratio`), timestamps are `_timestamp_seconds` so freshness is `time() - metric`.

Authored series that must exist:

| Series | Type | Meaning |
|---|---|---|
| `kodera_backup_last_ok_timestamp_seconds` | gauge | last verified off-box backup |
| `kodera_restore_drill_last_ok_timestamp_seconds` | gauge | last passed restore drill |
| `kodera_cert_expiry_timestamp_seconds` | gauge | per certificate on the host, labelled `host_role` |
| `kodera_preflight_last_verdict` | gauge | `1` green, `0` red, labelled `phase` (`config`/`stack`/`public`) |
| `kodera_preflight_last_run_timestamp_seconds` | gauge | freshness of the nightly run |
| `kodera_tenant_max_participants` | gauge | the deployed per-room cap, so alerts compare against what is actually configured, not what we believe |
| `kodera_agent_heartbeat_timestamp_seconds` | gauge | absence of this is `TenantAgentSilent` |

---

## 3. Retention

| Data | Retention | Why |
|---|---|---|
| Prometheus raw samples | **35 days** | one full calendar month plus the margin needed to close and dispute it |
| Monthly SLI rollups (recording rules → `kodera-core`) | **13 months** | year-on-year comparison and credit claims; small enough to keep cheaply |
| Gatus probe results | **90 days** | evidence for a credit claim, which may arrive up to 30 days after a month closes |
| Alertmanager notification log | **90 days** | proves an alert fired and when it was acknowledged |
| Host logs (journald, on-box) | **7 days** | the published privacy commitment; enforced by a journald drop-in, the Docker daemon default and the container log driver |
| Incident files and post-mortems | indefinite, in the fleet repo | no personal data by construction |

Nothing ships to a hosted log service unless its retention is set to match the 7-day published clock. Metrics are not logs: they carry no personal data and therefore have no 7-day obligation, which is precisely why the label rule in §2.1 is load-bearing.

---

## 4. Error reporting

No external error-reporting service: Sentry was dropped (decision O4). Application exceptions are meant to go to the host logs, with the retention in §3, but do not yet: `config/` defines no `LOGGING` and `DEBUG` is `False`, so an unhandled exception that becomes a `500` writes nothing to stderr (reproduced: 0 bytes). Until Core configures logging, such an exception leaves no trace.

---

## 5. Dashboards

Six, and no more without deleting one. A dashboard nobody opens during an incident is a liability.

| Dashboard | Rows | Answers |
|---|---|---|
| **Fleet health** | one row per tenant: Web / Calls / Console state, egress vs NIC cap, LiveKit CPU, participants vs cap, disk %, backup age, cert days left, preflight verdict | "is anything wrong right now, and where" |
| **Tenant detail** | the same series for one tenant, plus per-container CPU and memory against the compose resource limits, Postgres connections, Redis memory, edge 5xx rate, Django p95 | "what is wrong with this tenant" |
| **SLO and error budget** | per tenant: the three SLIs, budget consumed this month, current burn rate over each alert window, the month's incidents overlaid | "how much room do we have left, and does an upgrade wave go ahead" |
| **Capacity** | peak concurrent participants per tenant per day vs the tier cap, egress peak vs NIC cap, the measured-capacity ledger value for the deployed version | "who needs a bigger tier, and is the published number still true" |
| **Media** | LiveKit participants, tracks, published/subscribed bitrate, packet loss, ICE candidate types (relay share), TURN allocations | "is this a media problem, and is it the relay path" |
| **Backups and drills** | backup age, size trend, last drill result and age, restore duration per tenant | "would we survive a restore, and how long would it take" |

Every dashboard is filtered by `tenant_slug` and every panel that alerts links to its runbook.

---

## 6. Alert catalogue

Severity and routing follow [`SLO.md`](SLO.md) §7, and **which of these alerts pages, and at what hour, is stated once — in the table at [`SLO.md`](SLO.md) §7.1**. The `Sev` column below is that table's **base** severity for the same alert, and CI compares the two columns as §7 item 5 describes; §6.5 routes from the severity and adds no paging rule of its own. Expressions are sketches: the intent and the window are normative, the exact PromQL is settled when the rules are written and each rule ships with a unit test over synthetic series.

Runbook links are to `deployment operations/runbooks/`.

### 6.1 Availability and budget

| Alert | Expression sketch | For | Sev | Runbook |
|---|---|---|---|---|
| `TenantWebDown` | `gatus_result_success{check="web",vantage="ext"} == 0` | 2 m | 1 | `host-loss.md`, `incident.md` |
| `TenantJoinFailing` | `gatus_result_success{check="join"} == 0` | 10 m | 1 | `relay-flood.md`, `incident.md` |
| `TenantRelayJoinFailing` | `gatus_result_success{check="join_relay"} == 0 and gatus_result_success{check="join"} == 1` | 15 m | 2 | `relay-flood.md` |
| `TenantLoginFailing` | `gatus_result_success{check="login"} == 0` | 3 checks | 2 | `idp-outage.md` |
| `IdPOutageFleetWide` | `count(count by (tenant_slug) (gatus_result_success{check="login"} == 0)) >= 3` | 5 m | 1 | `idp-outage.md` |
| `SLOBurnFast` | `slo:burn_rate:1h > 14.4 and slo:burn_rate:5m > 14.4` | 2 m | 1 | `incident.md` |
| `SLOBurnHigh` | `slo:burn_rate:6h > 6 and slo:burn_rate:30m > 6` | 15 m | 2 | `incident.md` |
| `SLOBurnMedium` | `slo:burn_rate:1d > 3 and slo:burn_rate:2h > 3` | 1 h | 3 | `incident.md` |
| `SLOBurnSlow` | `slo:burn_rate:3d > 1 and slo:burn_rate:6h > 1` | 3 h | 3 | `incident.md` |
| `SLOBudgetExhausted` | `slo:error_budget_consumed_ratio:month >= 1` | 5 m | 3 | `incident.md` |

### 6.2 Saturation and capacity

| Alert | Expression sketch | For | Sev | Runbook |
|---|---|---|---|---|
| `HostEgressHigh` | `rate(node_network_transmit_bytes_total[5m]) * 8 > 0.6 * nic_cap_bps` | 5 m | 2 | `quota-check.md` |
| `HostEgressCritical` | same, `> 0.85 * nic_cap_bps` | 2 m | 1 | `quota-check.md`, `incident.md` |
| `LiveKitCpuHigh` | container CPU for `app="livekit"` `> 0.70` of the host | 5 m | 2 | `relay-flood.md` |
| `ParticipantsNearCap` | `livekit_participant_total >= 0.9 * kodera_tenant_max_participants` twice in 7 d | — | 3 | `quota-check.md` (upsell signal, not a fault) |
| `ParticipantsAtCap` | `livekit_participant_total >= kodera_tenant_max_participants` | 1 m | 3 | `quota-check.md` |
| `DiskFillingUp` | `node_filesystem_avail_ratio < 0.20` | 10 m | 2 | `disk-full.md` |
| `DiskCritical` | `node_filesystem_avail_ratio < 0.08`, or projected full in < 4 h | 5 m | 1 | `disk-full.md` |
| `ScalewayQuotaNearLimit` | fleet gauge of used vs granted projects, IPs, instances per type `> 0.85` | 1 h | 3 | `quota-check.md` |

### 6.3 Certificates, backups, integrity

| Alert | Expression sketch | For | Sev | Runbook |
|---|---|---|---|---|
| `CertExpiringSoon` | `kodera_cert_expiry_timestamp_seconds - time() < 14d` | 1 h | 3 | `cert-failure.md` |
| `CertExpiringCritical` | `< 3d` | 15 m | 2 | `cert-failure.md` |
| `CertExpired` | `< 0`, or the probe reports an SNI or chain error | 5 m | 1 | `cert-failure.md` |
| `MediaCertOutOfSync` | media-host certificate serial ≠ the one loaded by the media service | 15 m | 2 | `cert-failure.md` |
| `BackupStale` | `time() - kodera_backup_last_ok_timestamp_seconds > 26h` | 10 m | 2 | `restore-drill.md` |
| `BackupFailedTwice` | two consecutive failed runs | — | 2 | `restore-drill.md` |
| `RestoreDrillStale` | `time() - kodera_restore_drill_last_ok_timestamp_seconds > 40d` | 1 h | 3 | `restore-drill.md` |
| `RestoreDrillFailed` | last drill verdict red | — | 2 | `restore-drill.md` |
| `ObjectLockNotEnforced` | bucket policy audit reports lock off, retention < 30 d, or a delete right on the tenant key | 1 h | 1 | `rotate-secrets.md`, `incident.md` |

### 6.4 Pipeline integrity (the alerts that watch the watchers)

| Alert | Expression sketch | For | Sev | Runbook |
|---|---|---|---|---|
| `Watchdog` | `vector(1)` — always firing, pushed to the off-region Gatus every 60 s | — | — | **none — the one documented exception** (§7); it notifies no human, so there is nothing to open. Its absence is the alert below |
| `DeadMansSwitchTriggered` | raised by Gatus when no `Watchdog` push for 5 m; delivered by SMS on a route that bypasses Alertmanager | 5 m | 1 | `incident.md` |
| `ProbePeerDown` | either Gatus loses the other's heartbeat | 5 m | 2 | `incident.md` |
| `TenantAgentSilent` | `time() - kodera_agent_heartbeat_timestamp_seconds > 10m` | — | 2 | `host-loss.md` |
| `PreflightNightlyFailed` | `kodera_preflight_last_verdict == 0` | — | 3 (2 on two consecutive nights) | `preflight.md` |
| `PreflightStale` | `time() - kodera_preflight_last_run_timestamp_seconds > 36h` | 1 h | 3 | `upgrade.md` |
| `SilenceOutlivedJob` | an Alertmanager silence still active after the upgrade job named in its comment has closed | 15 m | 3 | `upgrade.md` |
| `ForbiddenLabelObserved` | any series arriving with a label on the drop-list | 5 m | 1 | `incident.md` |

`PreflightNightlyFailed` carries the failing phase (`config`, `stack` or `public`) as an **annotation on the alert**, not as its runbook target: the target is always `preflight.md`, which branches on the phase. A phase name is not a file, and the CI rule in §7 can only check files.

`ForbiddenLabelObserved` is Sev-1 despite being invisible to customers: it means personal data may be leaving the tenant boundary, which is a breach question, not a reliability one.

### 6.5 Routing and noise control

- **Inhibition.** `TenantWebDown` inhibits every saturation and hygiene alert for the same `tenant_slug` — when the host is gone, its disk is not the news. `IdPOutageFleetWide` inhibits per-tenant `TenantLoginFailing`.
- **Grouping.** By `tenant_slug`, then `severity`. One notification per tenant per incident, updated, not repeated.
- **Silences.** The upgrade job creates a scoped, time-boxed silence for the tenant it is touching and removes it on completion; a silence outliving its job is itself an alert (`SilenceOutlivedJob`, Sev-3, catalogued in §6.4). Silences are never created by hand during an incident without a comment naming the incident.
- **Routes.** Sev-1 → SMS and call to the on-call phone at any hour, then chat. Sev-2 → chat at any hour, and the phone **within Business Hours only**. Sev-3/4 → ticket, never a page. This is the routing side of [`SLO.md`](SLO.md) §7.1, which lists every alert against its severity; nothing here overrides a row there, and a saturation threshold is not an exception to it — `HostEgressCritical`, `DiskCritical` and `ObjectLockNotEnforced` page at night because §7 defines Sev-1 to include imminent unrecoverable loss, not because routing treats them specially.
- **`Watchdog` is not routed to a human at all.** It is pushed to the off-region Gatus and nowhere else; the human-facing alert is `DeadMansSwitchTriggered` (Sev-1) when the push stops.

---

## 7. What must exist before this is real

1. Alloy rendered per tenant by the factory, with the relabel drop-list and its self-test mutation in CI.
2. `remote_write` over mTLS with a per-tenant client certificate issued at tenant creation and rotated with the rest of the tenant's secrets.
3. Recording rules producing `slo:burn_rate:*` and `slo:error_budget_consumed_ratio:month` per tenant, with unit tests over synthetic series.
4. Every alert in §6 linked to a runbook file that exists in `deployment operations/runbooks/`; an alert pointing at a missing runbook fails CI, and so does a target that is not a file name. **`Watchdog` is the single permitted exception** — it notifies no human — and CI asserts that the exception list has exactly that one member, so a second untargeted alert cannot be added quietly. The alert-to-runbook map in [`RUNBOOK_INDEX.md`](RUNBOOK_INDEX.md) §3 and the `Runbook` column of §6 above are the same map and CI compares them.
5. **Severity parity between the two documents, checked on the base severity.** The check's scope is **the alerts that have a row in [`SLO.md`](SLO.md) §7.1** — every alert in §6 except `Watchdog`, which has no row there by design because it carries no severity and notifies no human. `Watchdog` is out of scope of this rule exactly as item 4 carves it out of the runbook rule, and for the same reason; CI asserts that the set of in-scope alerts is the §6 catalogue minus that one name, so a second severity-less alert cannot appear without failing.

   For every alert in scope: its `Sev` cell here must equal the severity of the §7.1 row it sits in. The comparison reads the **leading digit** of the `Sev` cell and nothing else, because one cell is not a bare digit — `PreflightNightlyFailed` carries `3 (2 on two consecutive nights)`, sits in the Sev-3 row of §7.1, and matches on base severity 3. Its escalation is checked **separately, against the `Escalations` table under §7.1** — a table, not prose, so the check parses `alert → base severity → escalated severity → condition` rather than guessing which sentence is a rule: the base severity there must equal the leading digit here, and the escalated severity must equal the one in parentheses here. An in-scope alert whose `Sev` cell is not a bare digit and has no row in that table fails the build until it is either simplified or argued into the table.

   **This is a CI job now (`Alert catalogue parity`), not a simulation.** The paragraph that stood here counted the two documents by hand and got all three of its numbers wrong — 37 catalogue alerts where there are 36, 36 in scope where there are 35, 35 bare-digit cells where there are 34. That is the argument for the job, not against the paragraph, and the counts are not restated here: the check prints what it actually read on every run, so there is nothing left to drift.

   It compares more than severities, because severities are not where the two documents came apart. They came apart on **what a threshold counts** — `IdPOutageFleetWide` fires on a fleet-wide count, and the dimension it counts is stated in §6's sketch, in [`SLO.md`](SLO.md) §5.1's condition, and in ordinary sentences elsewhere under `docs/`. Both documents said Sev-1 throughout while those disagreed. So the job also holds the grouping label against the required-label table at §2.2, the first firing integer against §5.1, and the unit against every sentence under `docs/` that names the alert and states a threshold. Changelog sections and `docs/adr/` are exempt: a record of the behaviour before a correction is not a restatement of the rule.
6. A drill in which the dead-man switch, one burn-rate alert and one certificate alert each fire and are acknowledged.

---

## Changelog

| Rev | Change |
|---|---|
| 1 | Initial proposal: push-based Alloy pipeline into Prometheus and Alertmanager in `fr-par`, Gatus off-region plus in-region tie-breaker, scrubbed Sentry with asserted configuration, label conventions with an enforced drop-list, retention table, six dashboards, full alert catalogue with runbook links and routing rules. |
| 2 | Review fixes: severity and routing bound to the single paging table at [`SLO.md`](SLO.md) §7.1, with §6.5 stating no paging rule of its own. `PreflightNightlyFailed` retargeted from a phase name to `preflight.md`, the failing phase carried as an alert annotation. `SilenceOutlivedJob` added as a catalogue row. `Watchdog` marked as the single documented exception to the runbook rule, and §7 extended to compare the two alert-to-runbook maps in CI. Severity parity written up as a check that compares base severities and handles the one escalation separately, so its first red build is not a surprise. The severity-parity check is scoped to the alerts that have a §7.1 row, so `Watchdog` is carved out of it exactly as item 4 carves it out of the runbook rule, and it reads the `Escalations` table rather than prose. |
| 3 | Removes the second-region replication metric and alert after ADR-0007 selected Paris-only data residency. |
| 4 | §7 item 5 becomes a CI job instead of a hand simulation, and its three hand-counted numbers are dropped rather than corrected — all three were wrong by one. The job compares the counting grain as well as the severities: the grouping label of a fleet-wide count against §2.2, its first firing integer and its unit against [`SLO.md`](SLO.md) §5.1, and the same threshold against every sentence under `docs/` that names the alert, outside changelogs and `docs/adr/`. |
| 5 | Removes Sentry after decision O4: the error-reporting service (§1, §3, §4) and the `SentryScrubbingRegressed` alert. §4 keeps its number so the references to §5–§7 hold. |
