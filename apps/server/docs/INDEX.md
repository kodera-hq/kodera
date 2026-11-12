# Documentation index

**Status:** Proposed · **Owner:** Product seat

Every document under `docs/` and `contracts/` is listed here. A pull request that adds a document adds a row; a pull request that removes one removes the row. CI fails on an orphan file under `docs/` (a file with no row) and on a row whose path does not exist — **except that a row marked reserved for a parallel workstream may name a path that does not exist yet**. A reserved row is annotated *Written in parallel* and is the index's way of saying who owes what; without the exception, either the index cannot be written before the last document lands, or the rule is quietly not enforced, and a rule that is quietly not enforced is worse than one with a stated exception. A reserved row that is still reserved when its workstream has merged is a defect, and CI reports it as one. The check is `scripts/ci/check-docs-index.py`, run by the `index` job on every pull request; its self-test plants an orphan, a phantom and a stale reservation before the real run, so the job has seen itself fail before it is trusted.

## Conventions for every document in this repository

- First line after the title: `**Status:** Proposed | Accepted | Superseded by <path>` and `**Owner:** <seat>`.
- Last section: `## Changelog`, a short list of what changed and why. No dates, no deadlines, no owners' personal names — seats only.
- English. Normative statements use MUST / MUST NOT / SHOULD / MAY as in RFC 2119.
- A document that contradicts an accepted ADR is invalid until the ADR is superseded (`AGENTS.md`).

## Seats

| Seat | Scope |
|---|---|
| Product seat | Offer, billing, console-facing behaviour, this index |
| API seat | Core API, authorisation, domain model, developer conventions |
| Worker seat | Provisioning worker, job catalogue, state machines, audit |
| Infra seat | Fleet, identity deployment, environments, SLO |
| Security seat | Threat model, data classification, crypto, access control |

## This index

| Doc | Status | Owner | Purpose |
|---|---|---|---|
| [`INDEX.md`](INDEX.md) | Proposed | Product seat | This file. It carries its own row so the orphan rule holds on the document that states it |

## Architecture decision records

| Doc | Status | Owner | Purpose |
|---|---|---|---|
| [`adr/README.md`](adr/README.md) | Proposed | API seat | ADR register and the supersede rule |
| [`adr/0000-template.md`](adr/0000-template.md) | Proposed | API seat | Template for a new decision |
| [`adr/0001-profile-and-agent-contracts.md`](adr/0001-profile-and-agent-contracts.md) | Accepted | API seat | Profile and agent contracts separate tenant workloads from the control plane |
| [`adr/0002-no-kubernetes-at-launch.md`](adr/0002-no-kubernetes-at-launch.md) | Proposed | Infra seat | No Kubernetes at launch; bin-packing before Kapsule |
| [`adr/0003-api-holds-no-infrastructure-credential.md`](adr/0003-api-holds-no-infrastructure-credential.md) | Accepted | Security seat | The API process holds no infrastructure credential |
| [`adr/0004-postgres-backed-job-queue.md`](adr/0004-postgres-backed-job-queue.md) | Accepted | Worker seat | Every infrastructure mutation is a job on a Postgres-backed queue |
| [`adr/0005-human-controlled-project-bootstrap.md`](adr/0005-human-controlled-project-bootstrap.md) | Accepted | Security seat | Human-controlled root of trust for tenant projects and the gate for a future allocator |
| [`adr/0006-kodera-identity-topology.md`](adr/0006-kodera-identity-topology.md) | Accepted | Security seat | One kodera.io identity service, staff realm and realm per customer organisation |
| [`adr/0007-france-only-data-residency.md`](adr/0007-france-only-data-residency.md) | Superseded by ADR-0017 | Product seat | France-only customer-data boundary and the honest regional-disaster residual risk |
| [`adr/0008-non-reusable-tenant-slugs.md`](adr/0008-non-reusable-tenant-slugs.md) | Accepted | API seat | Permanent reservation of provisioned organisation and tenant slugs |
| [`adr/0009-uuidv7-primary-identifiers.md`](adr/0009-uuidv7-primary-identifiers.md) | Accepted | API seat | Core-owned primary identifiers use UUIDv7 |
| [`adr/0010-fixed-v1-role-set.md`](adr/0010-fixed-v1-role-set.md) | Accepted | Product seat | Fixed tenant and staff role sets with explicit grant paths |
| [`adr/0011-member-import-data-minimisation.md`](adr/0011-member-import-data-minimisation.md) | Accepted | Security seat | Immediate raw-upload deletion and a seven-day staging ceiling |
| [`adr/0012-core-owns-environment-allocation.md`](adr/0012-core-owns-environment-allocation.md) | Proposed | Security seat | Core is the sole environment-allocation authority and every live command is snapshot- and receipt-bound |
| [`adr/0013-shared-hosts-filled-by-resource-budget.md`](adr/0013-shared-hosts-filled-by-resource-budget.md) | Proposed | Infra seat | Shared hosts are filled by resource budget across hosts and database; a mandatory tenant cap bounds blast radius |
| [`adr/0014-shared-tenant-environment-class.md`](adr/0014-shared-tenant-environment-class.md) | Proposed | Security seat | A sixth environment class for shared-plan tenants, one shared project, no project-wide credential on a tenant job |
| [`adr/0015-identity-and-mail-on-kodera-io.md`](adr/0015-identity-and-mail-on-kodera-io.md) | Proposed | Security seat | Identity hostnames and sending domains of the Kodera offer on `kodera.io`, migration order |
| [`adr/0016-engines-and-permission-intents.md`](adr/0016-engines-and-permission-intents.md) | Proposed | API seat | Docs v6 and Meet with LiveKit for the pilot; Core sends each tenant agent the organisation's member set, which the agent converges its engines to; licence findings |
| [`adr/0017-eu-data-residency.md`](adr/0017-eu-data-residency.md) | Accepted | Product seat | European Union promise for customer data and backups; placement stays Scaleway `fr-par` until the measured provider decision |
| [`adr/0018-messaging-and-audio-rooms-in-the-pilot.md`](adr/0018-messaging-and-audio-rooms-in-the-pilot.md) | Accepted | API seat | Live text channels and always-open audio rooms join the pilot: Core policy → Matrix room membership → LiveKit access, a Kodera Synapse policy module, federation and end-to-end encryption off, authenticated media, the slug freeze |
| [`adr/0019-organisation-lifecycle-states.md`](adr/0019-organisation-lifecycle-states.md) | Accepted | API seat | Five explicit organisation lifecycle states without deciding retained-record access |
| [`adr/0020-two-tier-idempotency.md`](adr/0020-two-tier-idempotency.md) | Accepted | API seat | A short HTTP response receipt plus durable semantic identity for every effect-bearing operation |
| [`adr/0021-external-stop-evidence.md`](adr/0021-external-stop-evidence.md) | Accepted | Worker seat | Both authenticated stop evidence and a fresh target read are required for reconciliation |
| [`adr/0022-payment-link-creation-asks-the-provider-from-the-api.md`](adr/0022-payment-link-creation-asks-the-provider-from-the-api.md) | Proposed | API seat | Payment link creation asks the provider from the API, outside the replay step |
| [`adr/0023-matrix-server-name-is-the-tenant-slug.md`](adr/0023-matrix-server-name-is-the-tenant-slug.md) | Accepted | API seat | The Matrix server name is the tenant's slug, not the organisation's; partly supersedes ADR-0018 |
| [`adr/0024-default-community-membership.md`](adr/0024-default-community-membership.md) | Accepted | API seat | Canonical community membership, issuer isolation and explicit account binding |

## API specifications

| Doc | Status | Owner | Purpose |
|---|---|---|---|
| [`api/CONVENTIONS.md`](api/CONVENTIONS.md) | Proposed | API seat | REST shape, versioning, errors, pagination, idempotency, rate limits, OpenAPI-first workflow. Every endpoint PR is checked against it |
| [`api/AUTHZ.md`](api/AUTHZ.md) | Proposed | API seat | Token verification across N customer realms, role and scope matrix, object-level rules, agent authentication |

## Domain specifications

| Doc | Status | Owner | Purpose |
|---|---|---|---|
| [`domain/MODEL.md`](domain/MODEL.md) | Proposed | API seat | The v1 data model: entities, fields, invariants, soft-delete and purge conventions, ER diagram |
| [`domain/TENANT_STATE_MACHINE.md`](domain/TENANT_STATE_MACHINE.md) | Proposed | Worker seat | The one canonical `Tenant.status` enum, its transitions, and which job drives each |
| [`domain/DOMAIN_STATE_MACHINE.md`](domain/DOMAIN_STATE_MACHINE.md) | Proposed | Worker seat | Custom-domain verification states, nonce format, DNS and certificate checks |
| [`domain/JOB_CATALOGUE.md`](domain/JOB_CATALOGUE.md) | Proposed | Worker seat | Every job kind: steps, idempotency proof, timeouts, leases, compensation, retries, audit events |
| [`domain/AUDIT_TAXONOMY.md`](domain/AUDIT_TAXONOMY.md) | Proposed | Worker seat | `AuditEvent` schema, closed action registry, target URN format, retention split, export format |
| [`domain/BILLING_MODEL.md`](domain/BILLING_MODEL.md) | Proposed | Product seat | Plan versioning, price snapshots, VAT regimes, invoice immutability, dunning, reconciliation |

## Developer handbook

| Doc | Status | Owner | Purpose |
|---|---|---|---|
| [`specs/CUSTOMER_PERSISTENCE.md`](specs/CUSTOMER_PERSISTENCE.md) | Proposed | API seat | Customer persistence anchors and shared UUID acceptance before implementation |
| [`specs/CUSTOMER_HTTP_ACCEPTANCE.md`](specs/CUSTOMER_HTTP_ACCEPTANCE.md) | Proposed | API seat | Customer self-read contract, host PostgreSQL qualification and pending image boundary |
| [`specs/CUSTOMER_READ_CONTRACT.md`](specs/CUSTOMER_READ_CONTRACT.md) | Proposed | API seat | The customer read increment: organisation slug domain, the bounded `/me` projection, and its conditional-request and no-store rules |
| [`specs/ORGANISATION_DETAIL_READ.md`](specs/ORGANISATION_DETAIL_READ.md) | Proposed | API seat | Customer-only persisted own-organisation read, current grant, coherent snapshot and conditional-response acceptance |
| [`specs/MEMBERSHIP_DIRECTORY_READ.md`](specs/MEMBERSHIP_DIRECTORY_READ.md) | Proposed | API seat | Current stored membership directory, bounded signed continuation and local acceptance |
| [`specs/MEMBERSHIP_LIFECYCLE.md`](specs/MEMBERSHIP_LIFECYCLE.md) | Proposed | API seat | Changing, suspending, reactivating and removing a membership: rules, locks, audit, the engine hooks and what stays with the realm worker |
| [`specs/INVITATIONS.md`](specs/INVITATIONS.md) | Proposed | API seat | Inviting people by email: the six invitation operations, the token, the realm account the realm worker makes and the invitation mail |
| [`specs/OPERATOR_SCHEDULE.md`](specs/OPERATOR_SCHEDULE.md) | Proposed | API seat | The one supported process that runs the invitation mails, message deliveries and realm deliveries every minute |
| [`specs/ORGANISATION_NOTICE_CONTACTS.md`](specs/ORGANISATION_NOTICE_CONTACTS.md) | Proposed | API seat | The DPA's three notice addresses on the organisation, owner-set, defaulting to the owners |
| [`specs/CUSTOMER_DIRECTORY_IMAGE_ACCEPTANCE.md`](specs/CUSTOMER_DIRECTORY_IMAGE_ACCEPTANCE.md) | Proposed | API seat | Single owned image/provider qualification and bounded client lending |
| [`specs/CURSOR_PAGINATION_CHECK.md`](specs/CURSOR_PAGINATION_CHECK.md) | Proposed | API seat | What the offline cursor-pagination check asserts on every list operation, and what it deliberately leaves unchecked |
| [`specs/JOB_KIND_CATALOGUE_CHECK.md`](specs/JOB_KIND_CATALOGUE_CHECK.md) | Proposed | API seat | What the offline job-kind check asserts between `JobKind` and the job catalogue, and what it deliberately leaves unchecked |
| [`specs/CUSTOMER_HTTP_RUNTIME.md`](specs/CUSTOMER_HTTP_RUNTIME.md) | Proposed | API seat | Owned reader-role, image and provider runtime qualification preparation |
| [`specs/JOB_QUEUE.md`](specs/JOB_QUEUE.md) | Proposed | Worker seat | The Postgres-backed job queue of ADR-0004: records, service functions, claim checks, sweep, reconciliation exits and the acceptance tests, implemented in `apps.jobs`, `apps.outbox` and `apps.audit`, every row passing and every mutant flag run in CI |
| [`specs/STAFF_IDENTITY.md`](specs/STAFF_IDENTITY.md) | Proposed | API seat | The stored staff identity, with no organisation and in the staff realm, the `StaffRole` grant, the customer/staff readers, staff-role commands, verified-token principal and ratified command-only pilot constructor |
| [`specs/REGISTERED_FACTOR_SIGNAL.md`](specs/REGISTERED_FACTOR_SIGNAL.md) | Implemented locally; review pending | API seat | The `kodera_mfa_enrolled` claim Core consumes for `Identity.mfa_enrolled` and claim consumption, and its 330-second clock budget |
| [`specs/member-authority-revision.md`](specs/member-authority-revision.md) | Proposed | API seat | Current membership authority facts: the organisation authority revision bumped by every membership and identity write, and its snapshot reader |
| [`specs/workspace-member-parent-policy.md`](specs/workspace-member-parent-policy.md) | Proposed | API seat | Member authority and parent-policy facts read together in one snapshot, with the qualified policy seam |
| [`specs/workspace-metadata-schema.md`](specs/workspace-metadata-schema.md) | Proposed | API seat | Workspace, category and channel structure persisted without any command or content access |
| [`specs/workspace-parent-policy.md`](specs/workspace-parent-policy.md) | Proposed | API seat | Persisted category and channel access-policy facts and their fail-closed reader |
| [`specs/workspace-policy-projection.md`](specs/workspace-policy-projection.md) | Proposed | API seat | Pure capability evaluator over authority and policy facts; no HTTP, database or engine |
| [`specs/IDEMPOTENCY_REPLAY.md`](specs/IDEMPOTENCY_REPLAY.md) | Proposed | API seat | The `Idempotency-Key` replay store of CONVENTIONS §8: per-principal, per-path entries, in-flight refusal, 24-hour retention, the HTTP adapter every `POST` route uses, and what it does not yet do |
| [`specs/SUPPORT_TICKETS.md`](specs/SUPPORT_TICKETS.md) | Proposed | API seat | createSupportTicket: who may open a ticket, its limits, and the plain-text mail to the support mailbox |
| [`specs/TRUSTED_EDGE.md`](specs/TRUSTED_EDGE.md) | Proposed | API seat | When Core believes `X-Forwarded-For` (the operator's trusted edge, rightmost untrusted hop) and the `c-` namespace of a caller's `X-Request-Id` |
| [`specs/ABUSE_AND_ORIGIN_CONTROLS.md`](specs/ABUSE_AND_ORIGIN_CONTROLS.md) | Proposed | API seat | Console-only CORS from `KODERA_CONSOLE_ORIGINS`, the per-principal mutation bucket answered `429`, and room-access's per-identity limit on LiveKit call tokens, with what the in-process count does not guarantee |
| [`specs/REALM_DISCOVERY.md`](specs/REALM_DISCOVERY.md) | Proposed | API seat | Public realm discovery contract and owed runtime acceptance; the K7 pilot realm-ready fact, writer and counting reader |
| [`specs/PILOT_WORKSPACE_ONBOARDING.md`](specs/PILOT_WORKSPACE_ONBOARDING.md) | Proposed | API seat | The text-first starter workspace, the setup state Core derives from the realm job, trust and owner confirmation, what the console shows per state, `getWorkspace` and `initialiseWorkspace`, and their acceptance |
| [`specs/QUICK_WORKSPACE.md`](specs/QUICK_WORKSPACE.md) | Proposed | API seat | One-step workspace creation on a deployment that does not bill: the billing switch, and what it refuses |
| [`specs/DEFAULT_COMMUNITY.md`](specs/DEFAULT_COMMUNITY.md) | Implemented | API seat | Community bootstrap, support intake and real-room readiness |
| [`specs/ESPACE_STRUCTURE.md`](specs/ESPACE_STRUCTURE.md) | Proposed | API seat | Owners and admins administer Espace: category and channel create, rename, move, archive; a channel's access (visibility, members, read-only, listen-only) read and replaced whole; the audio `lounge` template; reserved slugs; app code `messaging`; acceptance |
| [`specs/OUTBOX_MAIL_SENDER.md`](specs/OUTBOX_MAIL_SENDER.md) | Proposed | Worker seat | Core's own mail: `message` outbox deliveries, the sealed recipient and link secret, the template catalogue with the approved copy, the SMTP transport, `run_deliveries --once`, and the outcome each SMTP reply maps to |
| [`specs/ORGANISATION_INTAKE.md`](specs/ORGANISATION_INTAKE.md) | Proposed | API seat | The staff intake `createOrganisation` as built against the pilot amendment of FIRST_OWNER_BOOTSTRAP ratified on Core #154: the staff principal, the intake gate, the one-transaction effect, the sealed intake record, and where it departs from the amendment and the contract |
| [`dev/BASELINE.md`](dev/BASELINE.md) | Proposed | API seat | Frozen tech baseline: runtime, libraries, pinned versions |
| [`dev/PROJECT_LAYOUT.md`](dev/PROJECT_LAYOUT.md) | Proposed | API seat | Django apps, the services layer, and the no-cross-app-model-import rule |
| [`dev/TESTING.md`](dev/TESTING.md) | Proposed | API seat | Test tiers, real Postgres, contract tests, worker and chaos tests, coverage gate, self-test mutations |
| [`dev/MIGRATIONS.md`](dev/MIGRATIONS.md) | Proposed | API seat | Additive-only, expand/contract, reversible data migrations, concurrent indexes, CI check |
| [`dev/SETTINGS_AND_SECRETS.md`](dev/SETTINGS_AND_SECRETS.md) | Proposed | API seat | Settings per environment, banned environment variables in the API process, per-job credential loading |
| [`dev/OBSERVABILITY.md`](dev/OBSERVABILITY.md) | Proposed | API seat | Log field names, context binding, span naming, metric names |
| [`dev/RUNTIME_BOOTSTRAP.md`](dev/RUNTIME_BOOTSTRAP.md) | Proposed | API seat | Minimal local runtime, truthful probes and process-isolation acceptance |
| [`dev/HOST_MIGRATIONS.md`](dev/HOST_MIGRATIONS.md) | Proposed | API seat | Host-side migration plan/apply/check with an immutable image and separate migration authority |

## Testing

| Doc | Status | Owner | Purpose |
|---|---|---|---|
| [`testing/first-slice-acceptance-inventory.md`](testing/first-slice-acceptance-inventory.md) | Proposed | API seat | The executable inventory of first-slice acceptance scenarios and its evidence boundary |
| [`testing/first-slice-acceptance-harness.md`](testing/first-slice-acceptance-harness.md) | Proposed | API seat | The pytest harness that runs all thirty-three first-slice scenarios under honest, bound states, and its proofs that it can fail |

## Security

| Doc | Status | Owner | Purpose |
|---|---|---|---|
| [`security/README.md`](security/README.md) | Proposed | Security seat | Index of the security documents and the rules they share |
| [`security/THREAT_MODEL.md`](security/THREAT_MODEL.md) | Proposed | Security seat | Assets, adversaries, trust boundaries, and the controls each boundary carries |
| [`security/SECURE_SDLC.md`](security/SECURE_SDLC.md) | Proposed | Security seat | Spec, review, gates, and the self-test-mutation rule |
| [`security/SUPPLY_CHAIN_POLICY.md`](security/SUPPLY_CHAIN_POLICY.md) | Proposed | Security seat | Dependency pinning, image digests, mirror and scan, profile vendoring by commit SHA |
| [`security/THIRD_PARTY_ACTIONS.md`](security/THIRD_PARTY_ACTIONS.md) | Proposed | Security seat | Review record for every third-party GitHub Action in use |
| [`security/TOKEN_VERIFICATION.md`](security/TOKEN_VERIFICATION.md) | Proposed | Security seat | Local signed-token profile and owned provider qualification; no Core authentication authority |

Data classification, logging policy, retention schedule, secrets and crypto, and access control live in `deployment operations/security/` ([`security/README.md`](security/README.md)). This index carries no reserved row for a path this repository will never hold.

## Specifications shared with other repositories

| Doc | Status | Owner | Purpose |
|---|---|---|---|
| [`specs/FIRST_OWNER_BOOTSTRAP.md`](specs/FIRST_OWNER_BOOTSTRAP.md) | Accepted | API seat | Staff intake and first-owner claim: transactions, locks, the `bootstrap` principal, and its recorded decision boundaries |
| [`specs/FIRST_SLICE_G1.md`](specs/FIRST_SLICE_G1.md) | Proposed | API seat | Reconciled 33-scenario expected-red boundary, three owner-independent decisions and the remaining owner gates |
| [`specs/SLO.md`](specs/SLO.md) | Proposed | Infra seat | Three SLIs, error budget, exclusions, credit ladder |
| [`specs/BACKUP_AND_RESTORE.md`](specs/BACKUP_AND_RESTORE.md) | Proposed | Infra seat | What is backed up, where it goes, the append-only key and lock, restore drills, the recovery numbers |
| [`specs/OBSERVABILITY_STACK.md`](specs/OBSERVABILITY_STACK.md) | Proposed | Infra seat | How signals leave a tenant VM, where they are stored, what they may contain, which alert links to which runbook |
| [`specs/RUNBOOK_INDEX.md`](specs/RUNBOOK_INDEX.md) | Proposed | Infra seat | The runbooks that must exist, their owners, and the alert-to-runbook rule |
| [`specs/UPGRADE_PROCEDURE.md`](specs/UPGRADE_PROCEDURE.md) | Proposed | Infra seat | How a tenant moves between pinned releases as a job with snapshot and rollback |
| [`specs/ENVIRONMENT_ALLOCATION.md`](specs/ENVIRONMENT_ALLOCATION.md) | Proposed | Worker seat | Allocation ledger, target projection, runner fencing, receipt, import and live-enablement contract |

## Contracts

Contracts are versioned interface files, not prose. They live outside `docs/` because they are consumed by build tooling.

The tenant-profile extension schema `x-kodera.schema.json` has **no row here**. It lives in `deployment operations/schemas/`, which owns it, and is referenced by URL plus commit SHA rather than copied ([`../contracts/README.md`](../contracts/README.md)); a reserved row for a path this repository will never hold is a row that can never resolve.

| Doc | Status | Owner | Purpose |
|---|---|---|---|
| `../contracts/README.md` | Proposed | API seat | How the contracts are edited and versioned, which contract gates CI runs, and which are still owed |
| `../contracts/CONSOLE_RECONCILIATION.md` | Proposed | API seat | How the console's screen-flow specifications and the Core contract were reconciled into one, and the open items that remain |
| `../contracts/core-api.openapi.yaml` | Proposed | API seat | The Core API contract the console consumes. Hand-authored; CI lints it and holds every change to the version policy |
| `../contracts/agent-api.openapi.yaml` | Proposed | Infra seat | The contract every tenant agent implements (ADR-0001, strategy Appendix A) |
| `../contracts/served-operations.json` | Proposed | API seat | The Core operations the deployed API routes, generated from its urlconf by `dev/served_operations.py`; `tests/test_served_operations.py` fails when it is stale |
| `specs/CONTRACT_VERSION_POLICY.md` | Proposed | API seat | Version policy and the CI breaking-change gate that classifies each contract change with oasdiff, with their self-tests and mutations, for issue #28 |

## Operational files owned elsewhere in the repository

| File | Status | Owner | Purpose |
|---|---|---|---|
| `../AGENTS.md` | Accepted | API seat | Working rules for humans and agents. Second reviewer required to change |
| `../compose.yaml` | Proposed | API seat | Local backing services, API probes and an explicit unimplemented worker placeholder |
| `../scripts/ci/` | Proposed | API seat | Server CI policy gates and self-tests |
| `../../../.github/` | Proposed | API seat | Monorepo CI workflows, `CODEOWNERS`, pull-request and issue templates |

## Changelog

- First index. Lists the documents created with it, and reserves rows for the contracts, security, baseline, compose and CI files written in parallel by other workstreams.
- Adds a row for this file, so the orphan rule holds on the document that states it, and drops the reserved row for `../contracts/x-kodera.schema.json`: that schema is owned by `deployment operations` and referenced by SHA, so the row could never resolve.
- Writes the reserved-row exception into the rule in the opening paragraph: a row annotated *Written in parallel* may name a path that does not exist yet, and a reserved row still reserved after its workstream merges is a defect CI reports.
- Registers the four new foundation ADRs. Every ADR header reads `Proposed`: a decision is accepted when its owner accepts it, not when a branch merges.
- Adds the rows for the security, specification and contract documents that landed without one, links the reserved rows whose files now exist, corrects `specs/slo.md` to the file's actual name, and drops the reserved rows for the internal security pack: those documents live in `deployment operations/security/`, so the rows could never resolve.
- Names the CI check that makes the opening paragraph's rule true, with its self-test.
- Registers the proposed environment-allocation ADR and its implementation contract.
- Registers `specs/FIRST_OWNER_BOOTSTRAP.md`, the design of record for the staff-intake and first-owner-claim slice.
- Registers `testing/first-slice-acceptance-harness.md`, the pytest harness for the thirty-three first-slice scenarios.
- Registers `specs/JOB_QUEUE.md`, the implementation contract for the job queue.
- Describes `specs/JOB_QUEUE.md` as implemented: its rows pass against the queue in `apps.jobs`, `apps.outbox` and `apps.audit`, and CI runs every mutant flag. Its status stays `Proposed` until its owner accepts it.
- Registers `specs/IDEMPOTENCY_REPLAY.md`, the replay store every `POST` route uses.
- Registers `specs/STAFF_IDENTITY.md`, the stored staff identity and the `StaffRole` grant.
- Registers `specs/REALM_DISCOVERY.md`, the realm-discovery contract of `core-api.openapi.yaml` 0.12.0.
- Registers `specs/PILOT_WORKSPACE_ONBOARDING.md`, the onboarding step of contract 0.13.0.
- Registers `specs/OUTBOX_MAIL_SENDER.md`, the sender of Core's `message` outbox deliveries.
- Registers `specs/ORGANISATION_INTAKE.md`, the staff intake built against the pilot amendment of `specs/FIRST_OWNER_BOOTSTRAP.md`.
- Registers `specs/REGISTERED_FACTOR_SIGNAL.md`, the consumer half of the registered-factor signal.
- Registers `specs/MEMBERSHIP_LIFECYCLE.md`, the membership administration operations.
- Registers `specs/ORGANISATION_NOTICE_CONTACTS.md`, the DPA's notice addresses.
- Registers `specs/INVITATIONS.md`, the invitation operations.
- Registers `specs/OPERATOR_SCHEDULE.md`, the periodic runner of the operator's one-shot commands.
- Registers `specs/TRUSTED_EDGE.md`, the client address behind the operator's edge and the caller's request-id namespace.
- Registers `specs/SUPPORT_TICKETS.md`, the support ticket operation and its mail.
- Registers `specs/QUICK_WORKSPACE.md`, the billing switch of contract 0.34.0 and the one-step workspace creation it opens.
- Registers `../contracts/served-operations.json`, the Core operations the deployed API routes, generated from its urlconf.
- Registers ADR-0023, the Matrix server name is the tenant's slug.
- Registers `specs/ABUSE_AND_ORIGIN_CONTROLS.md`, the CORS and rate-limit controls at the API's edge.
