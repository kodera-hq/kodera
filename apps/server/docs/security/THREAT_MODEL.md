# Threat model — kodera.io control plane and fleet

**Status:** Proposed · **Owner:** SEC

Scope: the control plane (`kodera-server` API and provisioning worker), the console, the shared services (Keycloak, observability, backups), and the tenant VMs it provisions on Scaleway `fr-par`. Out of scope: standalone public demo instances and the customer's own external IdP.

The model is normative. Every threat row names a control and how that control is **asserted**. A control with no assertion is a wish, not a control; it is listed in [Residual risks](#7-residual-risks) instead.

## 1. Assets

| # | Asset | Where it lives | Why an attacker wants it | Loss type |
|---|---|---|---|---|
| A1 | Organisation-level Scaleway capability | Human operator account with MFA during the initial stage; a future allocator only after ADR-0005's gate | Full organisation takeover: projects, IAM policy and then every tenant resource | Confidentiality, Integrity, Availability |
| A2 | Keycloak master-realm rights | Worker only, per job | Mint tokens in any customer realm; impersonate any admin | C, I |
| A3 | SSH access to tenant VMs | SSH CA; certificates ≤ 8 h, per-tenant principal | Root on a tenant; read decrypted config | C, I, A |
| A4 | Shared ops age identity | Scaleway Secret Manager; memory-only for the job's lifetime. Not target-isolated, one per environment class, and acceptable for `lab` and `staging` only: every other class waits for target-isolated decryption and one-job secret delivery (ADR-0003, ADR-0012) | Decrypt every SOPS bundle encrypted to it | C |
| A5 | Tenant secrets (DB password, LiveKit API secret, OIDC client secret, TEM key, backup key) | `Secret` rows, envelope-encrypted with a KEK in Scaleway Key Manager; plaintext only on the tenant VM, mode 600 | Impersonate a tenant's services; mint LiveKit tokens; send mail as the tenant | C, I |
| A6 | The KEK | Scaleway Key Manager, never exported | Decrypt every `Secret` row at once | C |
| A7 | Backups (restic repositories, Keycloak dumps) | Per-tenant Scaleway buckets, append-only key, Object Lock COMPLIANCE ≥ 30 d; Keycloak dump 90 d with separate recipients | Read every tenant's data offline; or destroy it to force a ransom | C, A |
| A8 | Customer personal data in tenant runtime | Tenant VM Postgres, Redis, Docs/Drive S3 bodies; media in transit | The product's raison d'être for a data thief | C, I |
| A9 | Control-plane database (`Organisation`, `Membership`, `Subscription`, `Domain`, `Job`, `AuditEvent`) | Core Postgres, `fr-par` | Customer graph, billing contacts, and the ability to rewrite history | C, I |
| A10 | The audit trail (`Job` + `AuditEvent`) | Same transaction as the mutation (ADR-0004) | Erase evidence of an intrusion; break the DPA accountability clause | I |
| A11 | Tenant profiles (declarative compose + `x-kodera`) | Vendored by commit SHA | Profiles are executable input: a malicious profile is remote code on every tenant | I, C |
| A12 | Image supply chain (`lasuite/*`, `livekit/*`, `postgres`, `redis`, `quay.io/keycloak/*`, `nginxproxy/*`) | Mirrored by digest, `versions.lock.yaml` | One poisoned tag reaches the whole fleet at the next upgrade wave | I |
| A13 | Two retained flexible IPv4 per tenant (web, media) | Scaleway, `lifecycle=retain` | Losing them breaks DNS and certificates for a customer's published domain | A |
| A14 | Staff identities (Keycloak `kodera-staff` realm, Scaleway, GitHub, Stripe, Qonto) | Hardware-bound second factor mandatory | The cheapest route to A1–A4 is a person, not a process | C, I, A |
| A15 | DNS zones (`kodera.io`, delegated tenant sub-zones) | Scaleway DNS; sub-zone delegated into the tenant project | Certificate issuance for our names; traffic interception | C, I |

## 2. Trust boundaries

| # | Boundary | Direction and transport | What crosses it | Trust after crossing |
|---|---|---|---|---|
| B1 | Console → Core API | HTTPS from the browser, OIDC access token from the caller's realm | Desired-state changes, reads | Authenticated principal bound to one organisation via `iss` → org; **no infrastructure credential exists on the far side** |
| B2 | Core API → job queue | In-process, same Postgres transaction as the mutation (ADR-0004) | `Job` rows with `idempotency_key`, `desired_spec_hash`, `steps[]` | Job payloads are data written by the API, but the worker treats them as untrusted input and re-validates |
| B3 | Worker → Scaleway / Keycloak / tenant VMs | Outbound only; the worker has **no inbound network** | OpenTofu applies, Ansible plays, Keycloak admin calls, SSH sessions | Highest-privilege boundary in the system; every credential is per job and time-boxed |
| B4 | Tenant ↔ tenant | None by design | Nothing | Separate Scaleway project, VM, NIC, Postgres, Redis, LiveKit, bucket and TEM key. A separate Keycloak realm **only between organisations**: two tenants of one organisation share that organisation's realm (ADR-0006), and §4's B4 table states what separates them instead |
| B5 | Agent (tenant VM) → Core API | HTTPS inbound to the API, mTLS or per-tenant token | Heartbeat, vitals, command results, log references | Lowest-trust authenticated caller: a compromised tenant VM speaks here. It may report about itself and nothing else |
| B6 | Staff → everything | Console, Core admin, Scaleway, Keycloak, SSH CA, GitHub | Human decisions and emergency actions | MFA-gated, audited, and the only boundary where a single person can exceed a tenant's blast radius |

Two boundaries deserve naming even though they are not attack surfaces we own: **customer IdP → customer realm** (federated assertions we accept but do not control) and **upstream release → mirror** (covered in `SUPPLY_CHAIN_POLICY.md`).

## 3. Attacker profiles

| Profile | Capability | Goal | Primary boundaries |
|---|---|---|---|
| P1 Internet background noise | Scanners, credential stuffing, known-CVE exploitation | Any foothold | B1, B5 |
| P2 Authenticated tenant user | A valid account in one customer realm | Reach another tenant, or escalate inside their own | B1, B4 |
| P3 Compromised tenant VM | Root on one tenant's host, holding that tenant's decrypted config | Reach the control plane, other tenants, or the backups | B4, B5 |
| P4 Malicious or compromised upstream | A poisoned image tag or a hostile tenant-profile change | Code execution across the fleet at the next wave | B3, A11, A12 |
| P5 Targeted attacker against the control plane | SSRF, RCE, or dependency compromise in Django/DRF | A1–A4, then everything | B1, B2 |
| P6 Insider or compromised staff device | A person's laptop, tokens, and hardware key | Anything; the fastest path to fleet-wide access | B6 |
| P7 Coding agent gone wrong | Write access to a branch, no deploy credential | Merge a change that weakens a gate | B6, `SECURE_SDLC.md` |
| P8 Lawful-but-unwelcome demand | Legal process against us or a vendor | Customer data outside the customer's control | Handled contractually; handled under the applicable Data Processing Agreement |

## 4. STRIDE per boundary

Assertion legend: **T** unit/integration test · **P** preflight check with a self-test mutation (a check that cannot fail is not a check) · **C** CI policy gate · **R** review or drill.

### B1 — Console → Core API

| STRIDE | Threat | Control | Asserted |
|---|---|---|---|
| S | Token from another realm accepted as an org admin | `iss` → `Organisation` mapping is explicit; unknown issuers rejected; staff realm accepted only for staff scopes (D3) | T: token from realm B rejected on org A's endpoints |
| T | Client tampers with the desired spec after review | `desired_spec_hash` recorded on the `Job`; the worker re-derives it and refuses a mismatch | T: mutated spec → job fails closed |
| R | Actor denies a destructive change | `AuditEvent` written in the same transaction as the mutation (ADR-0004) with `actor` | T: no code path mutates desired state without an audit row |
| I | Error pages or logs leak another org's data | RFC 9457 errors with no object echo; no external error-reporting service (decision O4) | T, for `identity-unknown` only: on every customer operation that resolves a principal, the `403` body equals exactly `type`, `title`, `status` and `request_id`, and its one log line never carries the subject or the caller's request id (`tests/test_identity_unknown_http.py`). The log-line properties are each caught by a mutation; the body's equality has no mutation of its own |
| D | Cheap endpoint used as an amplifier | Per-principal rate limits; `Idempotency-Key` on mutations so retries do not multiply jobs | T: replayed key returns the first job |
| E | Member of org A reads or mutates org B | Org scoping in the queryset layer, not in the view; deny by default | T: cross-org read and write both 404/403 for every endpoint |

### B2 — Core API → job queue

| STRIDE | Threat | Control | Asserted |
|---|---|---|---|
| S | A forged job appears in the queue | Only the API writes `Job`; the DB role for the API cannot write `AuditEvent` retroactively; jobs carry `actor` and `parent_job` | T + R: schema-permission review |
| T | Desired-state change commits but the job does not (or the reverse) | Outbox pattern: one Postgres transaction for the state change, the `Job` and the `AuditEvent` (ADR-0004) | T: crash injected between commit and dequeue leaves no orphan state |
| R | A job's history is edited to hide a step | A step's specification is immutable and its row is never deleted, both refused by trigger; each step's success or failure is recorded as a `job.step_succeeded` or `job.step_failed` audit row, whichever writer records it, and the step carries its output reference; an operator's reconciliation decision, for a job or a delivery, is a row no `UPDATE` or `DELETE` can touch, refused by trigger; audit rows are not updatable by the application role ([`../specs/JOB_QUEUE.md`](../specs/JOB_QUEUE.md) §3.2) | T |
| I | Job payload carries a secret into the queue and the logs | **Secrets never travel in a job or a command**; the worker and the agent fetch by `config_ref` | C: grep-style policy check on job payload schemas; T on the agent contract |
| D | Queue flooded with duplicate work | `idempotency_key` unique; leases with `lease_expires_at` renewed every 30 s and a `fence` taken higher on every claim; per-organisation and per-tenant advisory locks backed by durable reservations, with claims served in request order | T: two identical enqueues → one job; T: a stale runner's step write and dispatch are refused on its fence |
| E | A queued job escalates to a wider scope than its actor had | Job kind → required scope table checked at enqueue **and** at dequeue | T: staff-only job kind enqueued by a tenant admin is refused twice |

### B3 — Worker → Scaleway / Keycloak / tenant VMs

| STRIDE | Threat | Control | Asserted |
|---|---|---|---|
| S | Worker impersonated to Scaleway or Keycloak | Tenant-policy-scoped credentials loaded for one job; the organisation-level project bootstrap never enters this runtime (ADR-0003, ADR-0005) | T: worker refuses to start if an organisation-level credential is present; R: quarterly IAM review |
| T | Tenant profile as executable input runs arbitrary code | Profiles vendored by commit SHA, rendered in a sandboxed Jinja environment with `StrictUndefined`, validated against a deny-list schema (no `privileged`, `cap_add`, `network_mode: host`, unlisted host mounts, non-digest images) | C: conftest on rendered compose; T: each deny-list rule has a fixture that must fail |
| R | An apply cannot be attributed | Every step writes its output reference to the `Job`; `deploys/<slug>/<date>.json` verdict is the deploy audit trail | T |
| I | A tenant VM ends up holding a credential that resolves outside its project | TEM subdomain and DNS sub-zone created **in the tenant project**; one certificate file for LiveKit; no wildcard certificate anywhere | P: "no credential on this host resolves outside project `{slug}`" with a self-test mutation |
| D | A stuck apply leaves locked state and a half-built project, or a second apply races one that never stopped | Leases, the fence, per-step idempotency and dispatch records (ADR-0004): `orphaned`, re-run automatically from the first non-succeeded step, only when no dispatch is open; otherwise `needs_reconciliation`, which alerts, keeps the lock reservation and waits for an operator's decision recorded with evidence. No `tofu force-unlock` runs without that decision | T: a runner killed before dispatch recovers without human input; T: a runner killed mid-apply leaves `needs_reconciliation`, and nothing unlocks the state file or repeats the apply until a decision is recorded |
| E | An 8-hour SSH certificate is reused against another tenant | Per-tenant principal in the certificate; host CA on the tenant side | T: certificate for tenant A rejected by tenant B's host |

### B4 — Tenant ↔ tenant

**Read the realm out of this boundary first.** Under ADR-0006 the Keycloak realm belongs to the organisation, not to the tenant. Between two tenants of **different** organisations the realm is a separating control. Between two tenants of the **same** organisation it is not: they share one realm, one user directory and one issuer.

State the rest plainly, because it is the part that is easy to overstate. **Two tenants of the same organisation are not isolated from each other at the identity or authorisation layer.** `Membership` is `(user_id, organisation_id)` and carries no tenant ([`../domain/MODEL.md`](../domain/MODEL.md), `Membership`); no tenant-scoped membership exists anywhere in the model. Every tenant-principal queryset is filtered by `organisation_id` alone, and per-tenant scoping is defined for **agent** principals only ([`../api/AUTHZ.md`](../api/AUTHZ.md) §6.1–6.2); `org_member` reads `Tenant` rows by that same organisation test (§5). Nothing restricts which of the organisation's users may authenticate through a given tenant's client either: `create_clients` sets PKCE, redirect URIs and logout channels, not an allowed-user list ([`../domain/JOB_CATALOGUE.md`](../domain/JOB_CATALOGUE.md), `provision` step 9). One `Membership` therefore authorises its holder on **every** tenant of that organisation, and that is the intended design — it is the single sign-on the customer bought.

So `Membership` separates organisations, not tenants inside one, and it is not listed below as a control between tenants. What the per-tenant controls separate is the tenants' **services and infrastructure**, not their people: the per-tenant OIDC client secret, the per-tenant LiveKit API secret and TEM key (A5), and the separate Scaleway project, VM, Postgres, Redis and bucket (§2, B4). Those stop tenant A's *workload* from presenting itself as tenant B's; they do not stop, and are not meant to stop, a member of the organisation from reaching both. A customer who needs two tenants their own staff cannot cross needs two **organisations**. The exposure is carried as RR10.

| STRIDE | Threat | Control | Asserted |
|---|---|---|---|
| S | Tenant A's service authenticates as tenant B | **Different organisations:** separate realm, separate OIDC client and secret, separate LiveKit API secret, separate TEM key. **Same organisation:** the realm is shared and `Membership` is organisation-scoped, so the separating controls are the per-tenant OIDC client secret and the per-tenant LiveKit API secret and TEM key. These bind the tenants' **services**; **no control separates the organisation's own members from either tenant** (preamble, RR10) | T: realm A token rejected by tenant B's Meet; T: tenant A's OIDC client secret and LiveKit API secret rejected by tenant B's client and SFU. **Same organisation, human principal: no isolation assertion, because there is nothing to assert.** A characterisation test pins the intended behaviour instead — a member of organisation X is authorised on every tenant of X to the extent their role allows, and a member of another organisation is refused |
| T | Tenant A writes into tenant B's storage | Separate Scaleway project and project-scoped IAM policy; separate bucket and backup key | C: `tofu plan` diff on `scaleway_iam_policy` reviewed in CI; no cross-project reference in plan output |
| R | A cross-tenant action cannot be attributed | Every infrastructure mutation is a job scoped to one tenant, or to one organisation for a change to its realm; every other control-plane change commits with its own `AuditEvent` naming its target (ADR-0004) | T |
| I | Backups of A readable from B | Per-tenant bucket, per-tenant append-only key, Keycloak dump kept as a separate cross-tenant artefact with its own recipients | R: monthly restore drill per tenant; T: key A denied on bucket B |
| D | A's load or crash degrades B | Separate VM and NIC cap; `deploy.resources` limits on every service; `max_participants` per tier plus a LiveKit `limit:` block | P: cap assertion with a mutation; load test on `lab` while `free` is in use shows no effect |
| E | Escape from A's container to the host, then to B | One tenant per host at launch; deny-list schema forbids `privileged`, `cap_add`, host networking and host mounts | C: conftest; the second hop is stopped by the project boundary, not by the container boundary |

### B5 — Agent → Core API

| STRIDE | Threat | Control | Asserted |
|---|---|---|---|
| S | A stolen agent token used to report as another tenant | mTLS or per-tenant token; the reported `tenant` must equal the authenticated tenant | T: agent A posting tenant B's slug is rejected, not silently coerced |
| T | Forged vitals hide a real outage or fake a healthy upgrade | `seq` monotonic per agent; core marks `stale` after three missed heartbeats; independent evidence from Gatus probes and Prometheus | T + R: the probe path never trusts the agent |
| R | A command result cannot be tied to a command | `command_id` idempotent, acknowledged then reported, closed enum of error codes | T |
| I | Heartbeats become an exfiltration channel | The heartbeat schema is closed: counters, states, timestamps. No free-text, no room names, no user identifiers | C: schema validation rejects additional properties |
| D | A compromised VM floods the heartbeat endpoint | Per-tenant rate limit on the agent endpoints; heartbeat every 60 s is the contract | T |
| E | A compromised VM asks core for a wider credential | Secrets never travel in commands; the agent pulls by `config_ref` scoped to its own tenant | T: `config_ref` from another tenant is refused |

### B6 — Staff → everything

| STRIDE | Threat | Control | Asserted |
|---|---|---|---|
| S | A staff account is phished | MFA mandatory on Keycloak, Scaleway, GitHub, Stripe, Qonto; human age identities hardware-bound, none on disk; no SMS as a factor | R: periodic access and MFA review across privileged identity providers |
| T | An emergency change bypasses the job model | Emergency access is still a tracked job; ad-hoc bastion scripts outside a recorded operational runbook are forbidden | R: exceptions listed and closed |
| R | A person denies an action | `actor` on every job and audit row; SSH certificates carry the principal; Keycloak admin and user events retained 12 months, pseudonymised | T + R |
| I | Customer data pulled into a laptop, a ticket, or a fixture | "Never log, fixture, or test with real customer data" (`AGENTS.md`, `SECURITY.md`); tenant contacts live in core encrypted, not in `tenant.yaml` in git | C: gitleaks and secret scanning on every push; R: review triggers |
| D | An accidental fleet-wide destructive action | `serial: [1, 3, 5]` with `any_errors_fatal: true`; suspension and destroy require written confirmation; backups are append-only with a COMPLIANCE lock a compromised operator cannot shorten | R: quarterly kill-switch drill |
| E | An automated contributor widens its own privileges | Automated contributors hold no deploy credential, operate on feature branches only, and Ring 0 paths (`.github/workflows/`, `SECURITY.md`, `GOVERNANCE.md`, auth/migrations) require Maintainer + Code Owner review and green required CI checks | C + R: branch protection, `.github/CODEOWNERS`, and CI policy gates |

## 5. The worker's threat model (the one ADR-0003 promised)

ADR-0003 accepted the worker as a consequence with its own threat model and audit trail owed by M1 exit. This is it.

**What the worker is.** A separate process with **no inbound network**, no listening socket, and no HTTP surface. It dequeues from Postgres, obtains credentials per job, runs OpenTofu and Ansible, and writes results back. It is the only component in the system that can reach A1, A2, A3 and A4 — so it is the crown jewel, and the model below is about keeping the crown jewel boring.

**Trust assumptions, written down so they can be attacked:**

| # | Assumption | If false | Compensating control |
|---|---|---|---|
| W1 | Nothing can initiate a connection to the worker | Remote attack surface reappears | Security group denies all inbound; no port bound; asserted at preflight with a mutation (open a port → red) |
| W2 | Job rows are the only input | A poisoned row is remote code | Job kinds are a closed enum; payloads validated with pydantic; `desired_spec_hash` re-derived, never trusted |
| W3 | A tenant provisioning credential is in worker memory only for a job's duration, and at rest only in the secret store | A leaked key can mutate a tenant project until its expiry | Human-issued expiring application key whose policy names one project (ADR-0005), stored only under `ProjectBootstrap.secret_ref`; loaded to memory per job; age identity loaded to memory only; process exits between jobs; no credential written to disk or to the environment |
| W4 | Tenant profiles are reviewed code | Profile render is arbitrary execution | Vendored by SHA, sandboxed Jinja, deny-list schema, digest-pinned images |
| W5 | The worker's own dependencies are trustworthy | Supply-chain compromise = A1 | `SUPPLY_CHAIN_POLICY.md`: lockfiles, digest pinning, Trivy gate, SBOM |
| W6 | Its host is not shared | A co-tenant reads memory holding the age identity | The worker runs on its own host in the ops project, not on a tenant VM, and not alongside the API |

**Credential lifecycle per job.** After the human-controlled bootstrap in ADR-0005, dequeue → derive the required scope from the job kind → load the application API key at the tenant's `ProjectBootstrap.secret_ref`, whose policy names exactly one tenant project, an SSH certificate (≤ 8 h, per-tenant principal), and, in `lab` and `staging` only, the shared ops age identity → verify scope and expiry against the `verified` bootstrap record → run steps → drop every credential from memory at exit → record the load as an audit row. The worker **never revokes** the human-issued key: it is issued once with an expiry and reused by every job of that tenant — nightly `backup-verify`, weekly `backup-prune`, `drift_check`, `upgrade` — until it expires or the operator replaces it (`tenant.project_bootstrap_replaced`). The SSH certificate and the age identity are per-job credentials; the provider key is per tenant, per expiry. Its expiry cadence, and who rotates it across N tenants, is an owner decision recorded as open in RR11; until it is taken the expiry is whatever the operator set, and a key past `key_expires_at` fails every job closed. Rotation follows the *Rotate secrets* runbook in [`../specs/RUNBOOK_INDEX.md`](../specs/RUNBOOK_INDEX.md). A job that cannot obtain exactly the scope its kind declares **fails closed**; it never falls back to a wider credential.

**Escalation paths the design deliberately removes:** the API cannot reach Scaleway or the Keycloak master realm at all (so an SSRF or RCE in Django yields the control-plane database, not the fleet); the console cannot reach Keycloak, Scaleway or a tenant VM directly; a tenant VM holds no credential that resolves outside its own project; and no human age identity exists on disk.

**Worker-specific detection.** Alert on: a job requesting a scope its kind does not declare; a credential issuance without a matching job; a `tofu force-unlock` without a recorded operator decision on a job in `needs_reconciliation`, or under any actor but `staff`; a job that stays in `needs_reconciliation`; an SSH certificate issued with a principal that has no live job; the worker binding any port; a heartbeat gap on the worker itself. These alerts are Sev-1 candidates because they all mean the same thing.

## 6. Design decisions that answer whole threat classes

| Decision | Threat class removed |
|---|---|
| ADR-0003 — API holds no infrastructure credential | Internet-facing RCE/SSRF no longer equals fleet compromise |
| ADR-0005 — human-controlled project bootstrap | The first project-scoped identity has an explicit root of trust; organisation capability stays outside the API and general worker |
| ADR-0004 — every infrastructure mutation is a job, atomic with its audit row, fenced, and never recovered automatically while an effect's outcome is unknown | Silent drift, unattributable infrastructure change, lost provisioning, and a repeat of an effect nobody proved had stopped |
| One Scaleway project per tenant | Cross-tenant reads become an IAM policy question, not a code question |
| Append-only backup key + Object Lock COMPLIANCE ≥ 30 d | Ransomware and malicious-operator deletion |
| Realm per organisation, no master-realm rights in the API | One realm compromise stays in one customer organisation |
| Two retained IPs and one certificate per media host, no wildcard | A wildcard key on every tenant VM would be a cross-tenant secret |
| Preflight checks that ship with a self-test mutation | Silent gate failure, the failure mode that makes every other control theatre |

## 7. Architectural trade-offs & residual risks

| # | Trade-off / risk | Architectural rationale | Owner | Mitigation / roadmap direction |
|---|---|---|---|---|
| RR1 | LiveKit SFU terminates DTLS-SRTP media | Required for multi-party selective forwarding and server-side room features unless client-side E2EE / MLS is active | SEC | State media transport boundaries transparently; track OpenMLS / E2EE media framing on the public roadmap |
| RR2 | Keycloak is a shared multi-realm service | Realm-per-organisation isolation (ADR-0006) avoids per-tenant IdP overhead while isolating user directories and OIDC signing keys | SEC | Strict realm-topology CI gates, zero master-realm credentials in the API, and HA deployment |
| RR3 | Upstream container images vary in signature coverage | Not every upstream image publishes Cosign attestations | PLAT | Enforce immutable SHA-256 image digests and Trivy/CycloneDX SBOM gates (`SUPPLY_CHAIN_POLICY.md`) |
| RR4 | Control-plane database stores the organisation graph | Required as the transactional system of record | SEC | Field-level encryption for sensitive contact metadata, strict queryset scoping, and encrypted backups |
| RR5 | Agent self-reports host vitals | Host-level resource counters originate on the tenant VM | PLAT | Pair agent heartbeats with independent external probes for availability and safety decisions |
| RR6 | Organisation members share access across that organisation's tenants | `Membership` is scoped to `(user, organisation)` (`AUTHZ.md` §6.1) to provide single sign-on across an organisation's suite | SEC | Organisations requiring hard administrative separation between business units provision separate organisations |
| RR7 | Tenant-scoped provider keys remain encrypted in the secret store between recurring jobs | ADR-0005 issues expiring project-scoped keys reused by scheduled maintenance jobs (`backup-verify`, `drift_check`) | SEC | Enforce key expiration (`key_expires_at` fails closed) and scheduled secret rotation |

## 8. Review

Re-read this document when: a boundary is added or removed; a new component holds a credential; an ADR that it cites is superseded; after any Sev-1 or a pen test; otherwise at each milestone exit review.

## Changelog

| Version | Change |
|---|---|
| 1.0 | Public monorepo baseline aligned with ADR-0003..0006, Ring 0/1/2 governance (`GOVERNANCE.md`), and `kodera-staff` realm naming. |
