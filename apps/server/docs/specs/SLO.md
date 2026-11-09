# SLO — service level objectives, error budget and paging

**Status:** Proposed · **Owner:** Lours

Scope: one dedicated tenant instance of the managed La Suite offer (one VM, one Scaleway project, `fr-par`), plus the shared identity provider it depends on. This document defines what "up" means, how it is measured, what we promise, what we exclude, when a human is woken, and what the customer sees. It is the source the SLA schedule quotes; where the two disagree, the SLA schedule is the contract and this document must be corrected.

Companion specs: [`OBSERVABILITY_STACK.md`](OBSERVABILITY_STACK.md) (how the signals are collected), [`BACKUP_AND_RESTORE.md`](BACKUP_AND_RESTORE.md) (RPO/RTO), [`UPGRADE_PROCEDURE.md`](UPGRADE_PROCEDURE.md) (maintenance mode), [`RUNBOOK_INDEX.md`](RUNBOOK_INDEX.md) (the response procedures alerts link to).

---

## 1. Principles

1. **A tenant is measured from outside its own region.** A prober inside `fr-par` cannot see a regional outage. The authoritative vantage point is off-region; the in-region one exists to tell an edge fault from a path fault.
2. **We measure the product, not the process.** A green container that nobody can join is an outage. Every SLI ends in a user-visible outcome: a page rendered, media flowing, a token issued.
3. **Only measured numbers are published.** No SLI enters the status page or the contract before it has run for a full month against a real tenant.
4. **Every check must be able to fail.** Each probe ships with a self-test mutation that proves a red verdict is reachable, in the same discipline as the tenant preflight suite.
5. **Alerts carry tenant slugs and counters, never user data.** This is what makes the alert path acceptable on non-EU messaging.

---

## 2. The three SLIs

Exactly three SLIs per tenant. Nothing else is contractual.

| SLI | What it proves | Interval | Vantage point(s) | Status page component |
|---|---|---|---|---|
| `web_availability` | The tenant's web surface answers over valid TLS | 60 s | Off-region **and** in-region | **Web** |
| `join_success` | Two participants can actually meet, including from a restricted network | 5 min | Off-region | **Calls** |
| `login_availability` | The organisation's realm is discoverable and a full OIDC round-trip completes | 60 s (discovery) / 5 min (round-trip) | Off-region | **Console** |

### 2.1 `web_availability` — two vantage points

**Probe.** `GET https://{meet_host}/` (the tenant's Meet host; `{slug}.visio.kodera.io` or the customer's custom host once verified), following at most one redirect.

**Good** requires all of:

- HTTP status `200`, body contains the SPA root marker;
- TLS handshake completes, leaf certificate valid for the requested SNI, **≥ 14 days** remaining (a shorter remaining life is an alert, not a failure);
- total time ≤ 5 s;
- no HSTS or security-header duplication (a `preflight public` assertion, checked on the probe path so a bad edge template shows as degraded, not silently).

**Vantage points.**

| Id | Placement | Role |
|---|---|---|
| `P-EXT` | Gatus on an OVHcloud VPS, Roubaix — deliberately **not** `fr-par` | **Authoritative** for the SLI |
| `P-INT` | Gatus in the ops project, `fr-par`, on the fleet host | Tie-breaker and diagnostic only |

**Interval classification.**

| `P-EXT` | `P-INT` | Verdict |
|---|---|---|
| good | any | **good** |
| bad (2 consecutive) | bad | **bad** — service down, page |
| bad (2 consecutive) | good | **bad** — the customer cannot reach the service; the fault is in the path or the edge. Counts against the SLO. Classified as a network incident in the post-mortem, not excluded from the SLI |
| bad, **and every tenant is bad simultaneously**, `P-INT` good for all | good | **prober-suspect** — held out of the SLI pending arbitration (§2.4) |

The tie-breaker never turns a bad interval good on its own. Only the arbitration rule in §2.4 can discard an interval, and it requires an independent confirmation that the service was up.

**Aggregation.** One 60 s interval per probe run; the month's SLI is `good_intervals / attempted_intervals`, prober-suspect intervals removed from both numerator and denominator.

### 2.2 `join_success` — synthetic two-party join, one client forced through TURN/TLS 443

**Probe.** Every 5 minutes, from `P-EXT`, a scripted two-party join against a reserved probe room on the tenant:

1. Mint a token for the room `__probe` through the tenant's own API path (`GET /api/v1.0/rooms/__probe`) using a probe identity from the organisation's realm — the same code path a real participant takes, so a broken backend, a broken realm, or a LiveKit key mismatch all fail the probe.
2. **Client A** joins over the unrestricted path (UDP preferred, ICE as the browser would).
3. **Client B** joins from a network namespace on the same prober whose egress policy permits **only TCP/443 and UDP/443** — everything else dropped. This forces the TURN/TLS relay on the media IP and is the only continuous proof that the restricted-network path works.
4. Both publish a synthetic audio track and subscribe to the other.
5. **Good** when both peers reach ICE `connected`, each receives ≥ 50 inbound RTP packets from the other, and the whole sequence completes within **20 s**.
6. Both leave; the room is left to expire on `empty_timeout`.

**Notes that must not be lost.**

- The probe consumes **two** participant slots. The tenant's `room.max_participants` is a per-room cap, so the probe room never competes with a real meeting for slots — but the probe's media does count against the host NIC budget. Budget it at ≤ 0.5 Mbps and exclude the `__probe` room from the capacity dashboard's peak-participants series.
- No error-reporting service receives the probe room's URL, whose slug is a secret like any other room slug (decision O4).
- Client B's failure alone is a **Calls degraded** condition, not a full outage: the service works for most networks and is unusable behind a restrictive firewall. It is reported separately as `join_success_relay` and pages at Sev-2, while a both-clients failure pages at Sev-1.

### 2.3 `login_availability` — realm discovery plus a scripted OIDC round-trip

Two parts, both from `P-EXT`, both required for the SLI to be good:

**a. Realm discovery, every 60 s.** `GET https://id.kodera.io/realms/{organisation_slug}/.well-known/openid-configuration` → `200`, `issuer` equals the expected value for the tenant's organisation, `jwks_uri` fetched and parsing to at least one signing key, total ≤ 3 s. The realm is the organisation's, not the tenant's (ADR-0006), so every tenant of one organisation shares this half of the SLI. This is the same assertion the Keycloak restore drill makes, so a drill and a probe cannot disagree about what "the realm exists" means.

**b. Scripted OIDC round-trip, every 5 min.** A headless authorisation-code flow with PKCE for a dedicated probe user in the organisation's realm: authorisation request → login form → callback → token exchange → the tenant's Meet session established (`/api/v1.0/users/me` returns the probe user). **Good** when a valid ID token is issued whose `sub` matches the expected immutable subject and the whole flow completes within **15 s**.

The probe user lives in the organisation's realm, has no membership in any real room, is exempt from brute-force lockout by a dedicated policy, and its credentials live in the same envelope-encrypted store as every other tenant secret. Login and admin events for the probe user are tagged so they can be excluded from the tenant's own event exports.

**Why this is not contractual.** Keycloak is the one shared component, and by design an identity outage does not interrupt calls in progress or guest joins: only *new logins* fail. `login_availability` therefore carries the same 99.5 % objective as an internal SLO, is shown on the status page as **Console**, and is excluded from the contractual availability figure (§3). A Keycloak outage that also breaks new joins for a tenant is by definition visible in `join_success` and is charged there.

### 2.4 Arbitration of a suspect prober

Two failure modes make the prober itself the problem: the OVHcloud VPS loses transit, or Gatus stops running. Both are handled without trusting the prober's own report:

- The two Gatus instances **heartbeat each other**; loss of the peer heartbeat raises an alert on the surviving one and, because that condition also implies the dead-man switch (§6) stops being fed, reaches the on-call phone by an independent route.
- When every tenant goes red on `P-EXT` within the same 60 s while `P-INT` is green for all of them, the affected intervals are marked **prober-suspect** and held out. They are discarded only if a third, on-demand vantage point (a run of the same Gatus check set from a second EU region, started by the on-call engineer within the incident) confirms the service was reachable. Absent that confirmation the intervals count as bad. The evidence — which probe, which check, which arbitration run — is recorded in the incident file; a month cannot be corrected retroactively without it.

---

## 3. Objectives

| Objective | Target | Window |
|---|---|---|
| **Contractual tenant availability** = intervals where `web_availability` **and** `join_success` are both good | **99.5 %** | calendar month, per tenant, measured 24/7 |
| `login_availability` (internal) | 99.5 % | calendar month, per tenant |
| Time to acknowledge Sev-1 | 30 min, in Business Hours | rolling quarter |
| Backup freshness | last verified backup < 26 h | continuous |
| Restore drill freshness | < 40 days per tenant | continuous |

Measurement is 24/7. Response targets apply in Business Hours only (§7) — an important asymmetry: the clock on availability never stops, the clock on our obligation to answer does.

**How the contractual figure is computed.** The two SLIs it combines run on different clocks (§2), so they are combined on the coarser one. The month is divided into **five-minute intervals** — 8 064 in a 28-day month, 8 640 in 30 days, 8 928 in 31 days — and each interval gets one verdict:

| Part | Good when | Bad when |
|---|---|---|
| `web_availability` in the interval | **every** 60 s run inside those five minutes is good under the classification in §2.1 (`P-EXT` authoritative, `P-INT` tie-breaker only) | any run inside it is bad |
| `join_success` in the interval | the single two-party run inside those five minutes is good under §2.2 | that run is bad |
| The interval, for the contractual figure | both parts are good | either part is bad |

- **Numerator:** intervals good for both parts.
- **Denominator:** intervals in which **both** probes attempted a run, less announced-maintenance intervals (§4) and prober-suspect intervals (§2.4) — both removed from numerator and denominator alike.
- **Not counted either way:** an interval where a probe did not run at all. A missing run is not a bad interval; it leaves both sides, and the monthly report states how many were removed and why, so a thin month is visible rather than flattering.

**A bad five-minute interval spends five minutes of the §3.1 budget.** That is the whole mapping: the minute figures in the table below are five times the count of bad intervals. The budget is stated in minutes because that is what a customer reads, and measured in intervals because that is what the probes produce; a `web_availability` failure lasting 70 s and one lasting 4 min cost the same five minutes, which is the price of combining a 60 s SLI with a 5 min one and is stated here rather than discovered during a credit claim.

`login_availability` is computed on the same five-minute grid — an interval is good when every 60 s discovery run inside it and the round-trip run inside it are all good, over intervals where both parts attempted — and it stays out of the contractual figure (§2.3). It is reported against its own 99.5 % objective and shown as **Console**.

### 3.1 Error budget

0.5 % of a calendar month:

| Month length | Total minutes | Error budget |
|---|---|---|
| 28 days | 40 320 | **201 min** (3 h 21 m) |
| 30 days | 43 200 | **216 min** (3 h 36 m) |
| 31 days | 44 640 | **223 min** (3 h 43 m) |

**The table assumes a month with no announced maintenance.** Announced maintenance leaves both numerator and denominator (§4), so a used window shrinks the denominator and the budget with it: a fully used 4-hour window in a 30-day month leaves 42 960 minutes, of which 0.5 % is **214.8 minutes**, not 216. The window neither spends budget nor extends it — it makes the month shorter. The 28- and 31-day figures above are **truncated** (201.6 and 223.2 exactly); the table is a working aid, and the number that decides a credit is always the availability ratio of §3, never a rounded minute count.

**With the Enterprise high-availability option contracted**, the objective is 99.9 % and the budget is a tenth of the above:

| Month length | Total minutes | Error budget at 99.9 % |
|---|---|---|
| 28 days | 40 320 | **40.3 min** |
| 30 days | 43 200 | **43.2 min** |
| 31 days | 44 640 | **44.6 min** |

That row exists so this document and the SLA schedule agree on the arithmetic (§9), not because the objective is sellable: principle 3 of §1 forbids signing a number before it has been measured for a full month against a real high-availability deployment, and none exists. Every tenant without the option is held to 99.5 %.

### 3.2 Error budget policy

The budget is a change-rate governor, not a target to spend. Per tenant, per month:

| Consumed | State | What changes |
|---|---|---|
| < 25 % | **Normal** | Business as usual. Canary waves proceed on schedule. |
| 25–50 % | **Watch** | The next upgrade wave for that tenant needs a named reviewer and a longer soak on the canary. |
| 50–75 % | **Caution** | Non-essential change to that tenant is deferred: no profile change, no tier change, no optional add-on enablement. Security fixes, backup fixes and reliability fixes proceed. |
| 75–100 % | **Freeze** | Change freeze on that tenant except (a) security patches, (b) fixes for the incident class that consumed the budget, (c) restore drills. The next upgrade wave excludes the tenant. |
| > 100 % | **Breach** | Freeze continues into the following month. A written post-mortem is mandatory even if no single incident reached Sev-1. Reliability work for that tenant takes priority over feature work until the following month closes green. The SLA credit ladder (§9) applies on the customer's claim, independently of this policy. |

Fleet-level rule: if **three or more tenants** are simultaneously in Caution or worse, the fleet-wide upgrade programme stops until the common cause is found; this is a fleet condition, not a per-tenant one, and it exists because our tenants share exactly three things — the images, the profiles, and the identity provider.

The budget resets on the first of the month. It is never lent, borrowed or carried forward.

---

## 4. Exclusions

Excluded from both numerator and denominator:

1. **Announced maintenance.** The default window is **Tuesday 07:00–09:00 Europe/Paris**, per-tenant override in the tenant record, **≤ 4 h per calendar month**, announced on the status page and by email **≥ 5 business days** ahead for planned work. An emergency window may be announced on **≥ 48 h** notice; below 48 h it is an incident, not maintenance, and it spends budget. Unannounced work never qualifies, whatever its intent.
2. **Customer-caused unavailability**: the customer's own DNS or federated IdP, a change made by the customer in their realm, credentials revoked by the customer, suspension for non-payment or under the acceptable-use policy.
3. **Use beyond the sold capacity**: participants rejected at join because the tenant's per-room cap was reached, or degradation while the host is above the measured cap for its tier. The cap is a sold quantity; exceeding it is not an outage.
4. **Client-side conditions**: the participant's own device, browser, or local network — including a network that blocks UDP *and* TCP/443, which no relay can rescue.
5. **Force majeure** only as defined and reviewed in the terms. ADR-0007, and ADR-0017 after it, establish no whole-region recovery target, so a `fr-par` regional failure is not silently moved from the availability calculation into an unsupported recovery promise. Any contractual regional-failure treatment must match the accepted terms and the backup specification.

**Exclusion 3 is dormant.** It turns on "the measured cap for its tier", and the capacity ledger in `kodera-visio` — proposed as `docs/CAPACITY.md`, and today a table of empty rows — carries no measured value yet, so the phrase has no referent: until it does, no degradation is excluded under exclusion 3 and it is not invoked in a monthly figure or a credit claim. Only the per-room cap half of it — participants rejected at join because the sold per-room cap was reached — is operative today, because that number is configured rather than measured. The exclusion becomes usable at the first ledger row for the deployed version, per principle 3 of §1.

Explicitly **not** excluded — these spend budget:

- our own upgrade run outside an announced window, or one that overruns it;
- an expired or mis-issued certificate, including on a custom domain;
- a failure of the shared identity provider that prevents joins;
- capacity exhaustion at or below the sold cap;
- a failed rollback.

---

## 5. Alerting

### 5.1 Hard-down alerts (symptom first)

| Alert | Condition | Severity | Route |
|---|---|---|---|
| `TenantWebDown` | `P-EXT` `web_availability` bad for 2 consecutive checks (2 min) | Sev-1 | phone, any hour |
| `TenantJoinFailing` | `join_success` bad for 2 consecutive runs (10 min) | Sev-1 | phone, any hour |
| `TenantRelayJoinFailing` | `join_success_relay` bad for 3 consecutive runs (15 min) while the unrestricted client succeeds | Sev-2 | chat; phone in Business Hours |
| `TenantLoginFailing` | `login_availability` bad for 3 consecutive checks | Sev-2 | chat; phone in Business Hours |
| `IdPOutageFleetWide` | `login_availability` bad on ≥ 3 tenants at once | Sev-1 | phone, any hour |
| `CertExpiringSoon` | leaf certificate < 14 days | Sev-3 | ticket |
| `CertExpiringCritical` | leaf certificate < 3 days | Sev-2 | chat; phone in Business Hours |
| `CertExpired` | leaf certificate expired or SNI mismatch | Sev-1 | phone, any hour |

### 5.2 Burn-rate alerts (budget first)

Multi-window, multi-burn-rate, per tenant, on the contractual availability SLI. A burn rate of 1 consumes the month's budget exactly over the month; 14.4 consumes it in 2 days.

| Alert | Long window | Short window | Burn rate | Budget consumed if sustained | Severity | Route |
|---|---|---|---|---|---|---|
| `SLOBurnFast` | 1 h | 5 min | ≥ **14.4×** | 2 % in 1 h | Sev-1 | phone, any hour |
| `SLOBurnHigh` | 6 h | 30 min | ≥ **6×** | 5 % in 6 h | Sev-2 | chat; phone in Business Hours |
| `SLOBurnMedium` | 1 d | 2 h | ≥ **3×** | 10 % in 1 d | Sev-3 | ticket |
| `SLOBurnSlow` | 3 d | 6 h | ≥ **1×** | 10 % in 3 d | Sev-3 | ticket |

Both windows must be over the threshold before the alert fires, and the short window must still be over it for the alert to stay firing — this is what stops a single failed probe from paging and what makes recovery visible without a manual reset.

`SLOBudgetExhausted` (budget consumed ≥ 100 % for the month) is a Sev-3 ticket, not a page: by then the paging has already happened. It is what flips the tenant into **Breach** in §3.2.

### 5.3 Saturation and hygiene alerts

These exist so that a symptom alert arrives with its cause already on screen. Most of them never page. Which ones do, and at what hour, is answered in exactly one place — the table in §7.1 — and this section does not restate it; there are two kinds of exception and they are worth naming here:

- **Sev-2 saturation and hygiene** — `HostEgressHigh`, `LiveKitCpuHigh`, `DiskFillingUp`, `BackupStale`, `TenantAgentSilent` and the rest of their class reach chat at any hour and the on-call phone **within Business Hours only**. They are a working-hours interruption, never a night-time one.
- **Sev-1 saturation** — `HostEgressCritical`, `DiskCritical` and `ObjectLockNotEnforced` page at any hour, because each is a state minutes away from something unrecoverable rather than a threshold with headroom: the host at its NIC ceiling stops serving, a disk projected full within hours stops the database accepting writes, and a bucket whose Object Lock is no longer enforced has stopped protecting the backups we would restore from. §7 defines Sev-1 by that condition, not only by present customer impact.

The full catalogue with expressions lives in [`OBSERVABILITY_STACK.md`](OBSERVABILITY_STACK.md) §6: host egress above 60 % of the instance NIC cap for 5 min, LiveKit CPU above 70 % for 5 min, participants at or above 90 % of the tier cap twice in a week (the upsell signal, not a fault), disk above 80 %, backup age above 26 h, restore drill older than 40 days, nightly `preflight all` red, no metrics from a tenant agent for 10 min.

---

## 6. Dead-man switch

The failure we cannot detect with our own alerting is our own alerting failing. Three independent legs, none of which trusts the others:

1. **`Watchdog`, always firing.** A Prometheus rule that is unconditionally true; Alertmanager routes it to a push endpoint on the off-region Gatus every 60 s. Gatus alerts if no push arrives for **5 minutes**, over a route that does not pass through Alertmanager (SMS to the on-call phone via the French SMS/phone API).
2. **Mutual probe heartbeat.** The off-region Gatus and the in-region Gatus each check the other's health endpoint. A self-hosted prober has nobody watching it; the mutual heartbeat is what makes the choice safe, and it is not optional.
3. **Absence-of-metrics.** No sample from a tenant's agent for **10 minutes** raises `TenantAgentSilent` (Sev-2). Absence of data is treated as a failure, never as "no news".

Drill: the dead-man switch is exercised in the quarterly drill by stopping Alertmanager and confirming the SMS arrives. An alert path that has never fired in a drill is assumed broken.

---

## 7. Severity, response and paging path

| Severity | Definition | Acknowledge | Mitigate | Route |
|---|---|---|---|---|
| **Sev-1** | **Customer impact now, or imminent unrecoverable loss.** Now: nobody can join a tenant, the tenant's web surface is down, new logins fail across the fleet, a certificate is expired or mis-issued, or the month's budget is burning fast enough to be gone in two days. Imminent and unrecoverable: an instance is minutes from becoming unreachable (host egress at the NIC ceiling, a disk projected full within hours) or minutes from losing the backup guarantee (Object Lock or the append-only key no longer enforced). Also: a suspected personal-data breach, personal data leaving the tenant boundary, and the loss of our own alerting path. | 30 min | 4 h | phone (SMS + call) at any hour, then chat |
| **Sev-2** | Partial media or login failure on one tenant, restricted-network path broken, a saturation or hygiene threshold crossed that still has hours of headroom, two consecutive failed backups, a failed restore drill, a silent tenant agent | 2 h | next business day | chat at any hour; phone **within Business Hours only** |
| **Sev-3** | Single user affected, a hygiene threshold crossed with days of headroom, budget exhausted | next business day | best effort | ticket; never pages |
| **Sev-4** | Question, request, non-urgent change | next business day | scheduled | ticket; never pages |

The second half of the Sev-1 definition is what carries `HostEgressCritical`, `DiskCritical` and `ObjectLockNotEnforced`. None of the three is a customer-visible outage at the moment it fires, and all three are one short interval away from one that cannot be undone by waiting for Business Hours — which is the whole reason they are worth a call at three in the morning and the Sev-2 thresholds below them are not.

**Business Hours:** 09:00–18:00 Europe/Paris, Monday to Friday, French public holidays excluded.

**Escalation:** alert → **primary on-call** (acknowledge within 30 min) → **secondary** if no acknowledgement at 30 min → **security lead** for identity or security incidents → **service owner** declares Sev-1, owns customer communications; **customer success** runs the status page and the message templates. The rota is two people alternating by ISO week and is published in `deployment operations/ON-CALL.md`.

**Outside Business Hours:** alerts still reach the rota's phones; responding is voluntary. The contract wording is: *"Outside Business Hours, Kodera may at its sole discretion respond to Severity 1 incidents; no response or resolution time applies, and no service credit accrues on time outside Business Hours."* Availability measurement continues 24/7 regardless — the SLI does not sleep.

**Post-mortem:** within 5 business days for Sev-1 and Sev-2, shared with affected customers, written blameless, and always naming the alert that fired (or the one that should have and did not).

### 7.1 Which alert pages, and when

**This table is the single answer to "can this wake me".** Every alert in the catalogue of [`OBSERVABILITY_STACK.md`](OBSERVABILITY_STACK.md) §6 appears in exactly one row, carries exactly one severity, and pages exactly as that row says; §6.5 there routes from these severities and adds nothing to them. Where any other sentence in either document seems to say otherwise, this table is the one that is right and the other sentence is the bug.

| Severity | Alerts | Pages when |
|---|---|---|
| **Sev-1** | `TenantWebDown`, `TenantJoinFailing`, `IdPOutageFleetWide`, `SLOBurnFast`, `CertExpired`, `HostEgressCritical`, `DiskCritical`, `ObjectLockNotEnforced`, `DeadMansSwitchTriggered`, `ForbiddenLabelObserved` | **Any hour.** SMS and a call to the on-call phone, then chat. Acknowledgement is owed within 30 min in Business Hours; outside them the phone still rings and answering is voluntary (see above) |
| **Sev-2** | `TenantRelayJoinFailing`, `TenantLoginFailing`, `SLOBurnHigh`, `CertExpiringCritical`, `MediaCertOutOfSync`, `HostEgressHigh`, `LiveKitCpuHigh`, `DiskFillingUp`, `BackupStale`, `BackupFailedTwice`, `RestoreDrillFailed`, `ProbePeerDown`, `TenantAgentSilent` | **Business Hours only.** Chat at any hour; the phone rings only inside Business Hours. A Sev-2 crossing at 02:00 waits in chat until 09:00 |
| **Sev-3** | `SLOBurnMedium`, `SLOBurnSlow`, `SLOBudgetExhausted`, `ParticipantsNearCap`, `ParticipantsAtCap`, `ScalewayQuotaNearLimit`, `CertExpiringSoon`, `RestoreDrillStale`, `PreflightNightlyFailed`, `PreflightStale`, `SilenceOutlivedJob` | **Never, except as noted below.** Ticket only, answered the next business day — `PreflightNightlyFailed` is the one row that can escalate out of Sev-3 |

**Escalations.** The rows above give each alert one severity. Exactly one alert changes severity on its own, and this table — not the prose below it — is the list: it is what the severity-parity check in [`OBSERVABILITY_STACK.md`](OBSERVABILITY_STACK.md) §7 item 5 reads, and an alert whose `Sev` cell there is not a bare digit must appear here or fail the build.

| Alert | Base severity | Escalates to | Condition |
|---|---|---|---|
| `PreflightNightlyFailed` | Sev-3 | Sev-2 | red on two consecutive nights; from that point it pages within Business Hours like any other Sev-2 |

One row today. A second one is a decision to be argued for, not a formatting accident, which is why the check refuses anything not listed here.

Two things that look like escalations and are not, and one exception:

- **`TenantLoginFailing` does not escalate.** It is Sev-2 per tenant and stays Sev-2. When three or more tenants fail login at once, a *different* alert fires — the fleet condition `IdPOutageFleetWide`, Sev-1 in its own right — and the per-tenant alerts are inhibited under it. Two alerts, two fixed severities, no escalation to check.
- **A burn-rate alert does not escalate either.** `SLOBurnFast`, `SLOBurnHigh`, `SLOBurnMedium` and `SLOBurnSlow` are four separate alerts on four windows, each with one severity; a faster burn fires a different alert rather than raising an existing one.
- **`Watchdog` is outside all of this.** It carries no severity, has no row in the paging table above, and never notifies anyone: it is a heartbeat pushed out of Alertmanager, and its *absence* is `DeadMansSwitchTriggered`, Sev-1 above. Having no row here is exactly what puts it out of scope of the parity check, in the same way [`RUNBOOK_INDEX.md`](RUNBOOK_INDEX.md) §3 puts it out of scope of the runbook rule. It is the one catalogue entry with no severity and no runbook.

---

## 8. Status page

Public at `status.kodera.io`, served from the off-region Gatus so it does not share a failure domain with what it reports. **Three components per tenant**, each backed by exactly one SLI:

| Component | SLI | Reads on the page as |
|---|---|---|
| **Web** | `web_availability` | the tenant's meeting site loads |
| **Calls** | `join_success` | people can actually join and hear each other |
| **Console** | `login_availability` | signing in and the administration console |

Components are independent on purpose: a media-only outage shows **Calls** degraded while **Web** stays green, which is both true and the thing that stops a support queue filling with "is it just me?".

**States:** `Opérationnel` · `Dégradé` · `Panne` · `Maintenance planifiée`.

### 8.1 Customer messages (French, plain language)

No jargon, no component names the customer does not use, a next-update time in every open message. `{h:mm}` is a real clock time, never "soon".

**Calls — dégradé (restricted-network path only):**
> Les réunions fonctionnent normalement pour la plupart des participants. Les personnes connectées depuis un réseau d'entreprise très filtré peuvent ne pas voir ni entendre les autres. Nous travaillons à rétablir ce chemin d'accès. Prochaine mise à jour à {h:mm}.

**Calls — panne:**
> Il n'est actuellement pas possible de rejoindre une réunion. Les réunions en cours peuvent être interrompues. Nous avons identifié le problème et travaillons à le résoudre. Prochaine mise à jour à {h:mm}.

**Web — panne:**
> Le site de vos réunions ne répond pas. Les réunions déjà en cours peuvent continuer, mais il n'est pas possible d'en rejoindre une nouvelle. Prochaine mise à jour à {h:mm}.

**Console — panne (identity provider):**
> La connexion à votre compte est momentanément indisponible. Les participants déjà connectés et les invités peuvent continuer à rejoindre leurs réunions. Prochaine mise à jour à {h:mm}.

**Maintenance planifiée (announced ahead):**
> Une maintenance est prévue le {jour} de {h:mm} à {h:mm}. Le service sera indisponible pendant cette période. Les réunions programmées sur ce créneau doivent être déplacées.

**Rétabli:**
> Le service est rétabli depuis {h:mm}. Nous publierons un compte rendu de cet incident sous 5 jours ouvrés. Si vous constatez encore un problème, écrivez-nous à support@kodera.io.

Rules for whoever writes the next one: say what the customer can and cannot do, never why in technical terms, never blame a supplier by name during an incident, always give the next update time and always publish at that time even when there is nothing new.

---

## 9. SLA credits — reference

Contractual, not operational. The ladder lives in the SLA schedule of the legal pack; it is restated here only so that an on-call engineer knows what a month costs:

| Measured monthly availability | Credit |
|---|---|
| < 99.5 % | 10 % of the monthly fee |
| < 99.0 % | 25 % |
| < 98.0 % | 50 % |

Claim within 30 days of the month's close; credits are the sole remedy. A separate **99.9 %** ladder applies to the **Enterprise high-availability option**: that is the SLA schedule's wording, it ties the ladder to Enterprise high availability rather than to a tier of its own, and per §5 of this document the schedule wins where the two differ — so this text follows it. High availability is an option contracted on top of a tier, not a tier; its error budget is in §3.1 and its restore commitment in [`BACKUP_AND_RESTORE.md`](BACKUP_AND_RESTORE.md) §4. Every tenant that has not contracted it is on the 99.5 % ladder above, whatever its tier. RPO/RTO commitments are in `BACKUP_AND_RESTORE.md` and are not part of the availability credit.

Credits are computed from the contractual availability figure in §3, using the probe record and the arbitration evidence in §2.4 — never from a hand estimate, and never from a customer's own measurement.

---

## 10. Where this lives and what must exist

| Artefact | Location |
|---|---|
| Probe definitions (three per tenant, plus the relay variant) | `deployment profiles` Gatus configuration, rendered per tenant from the tenant record |
| Probe self-test mutations | `deployment profiles` probe self-test suite, run in CI |
| Recording rules, burn-rate rules, alert routes | `deployment profiles` Prometheus and Alertmanager configuration |
| `Probe` and SLI history | `kodera-core` (`Probe` model, monthly rollups per tenant) |
| Monthly availability report per tenant | generated from the rollups; the figure the invoice and any credit claim use |
| Status page | off-region Gatus, public |
| On-call rota | `deployment operations/ON-CALL.md` |

**Acceptance for this spec.** It is satisfied when, for one real tenant: the three probes run continuously for a full calendar month, each has failed at least once in a self-test mutation, the dead-man switch has been exercised in a drill, a burn-rate alert has fired and been acknowledged in a drill, and the monthly report is produced from the rollups with no manual step.

---

## 11. Open questions

1. **Probe identity lifecycle.** The probe user's credentials are tenant secrets that must rotate with the rest; the rotation runbook must cover them without breaking the SLI during the rotation window.
2. **Custom domains.** When a tenant moves to a custom host, the probes must follow it and the old host must keep a probe until the DNS record is retired. The switch-over must not create a false outage.
3. **Second EU vantage point.** §2.4 assumes a third, on-demand vantage point exists. Whether it is a permanently running third probe or a scripted one-shot is unresolved; a permanent one is simpler to trust and costs one more small VPS.
4. **Composite versus per-SLI credits.** The contract credits a single availability figure. If a customer disputes a month on the basis of Calls alone, we need a written rule; today the composite absorbs it.

---

## Changelog

| Rev | Change |
|---|---|
| 1 | Initial proposal: three SLIs with measurement method and probe placement, 99.5 % objective and error-budget policy, exclusions, hard-down and burn-rate alerting, dead-man switch, severity and paging path, status page components with French customer messages, credit ladder reference. |
| 2 | Review fixes: one paging answer per alert — Sev-1 redefined as customer impact now **or** imminent unrecoverable loss, which is what the egress, disk and Object Lock conditions rest on; Sev-2 paging limited to Business Hours; §7.1 added as the single alert → severity → pages-when table that §5.3 and [`OBSERVABILITY_STACK.md`](OBSERVABILITY_STACK.md) §6 both defer to. Interval basis of the contractual figure made explicit (five-minute grid, numerator, denominator, and how a bad interval becomes budget minutes). §3.1 stated as assuming a month with no announced maintenance, truncation noted, and the 99.9 % budget added for the Enterprise high-availability option, with §9 aligned to the SLA schedule's wording. Exclusion 3 marked dormant until the capacity ledger carries measured rows. §7.1's Sev-3 cell reads "never, except as noted below", so it does not contradict the `PreflightNightlyFailed` escalation stated under the same table. An `Escalations` table under §7.1 makes the one severity change a named row rather than a sentence, and says plainly which look-alikes are separate alerts. |
| 3 | Removes the unsupported regional-recovery cliff and replication alert after ADR-0007 selected Paris-only data residency. |
| 4 | Names the realm the probes discover as the organisation's, not the tenant's, as ADR-0006 decides. The synthetic probe identity and the reserved `__probe` room are the identities ADR-0007 allows an external prober to hold; nothing belonging to a real user or room crosses to `P-EXT`. |
| 5 | Drops the Sev-2 wording for replication behind a disaster-recovery RPO that revision 3 left behind: no such replication exists under ADR-0007, and no alert in §7.1 can produce the condition. |
| 6 | Cites ADR-0017 beside ADR-0007 for the absence of a whole-region recovery target: ADR-0017 supersedes ADR-0007 on acceptance and carries that clause over. |
