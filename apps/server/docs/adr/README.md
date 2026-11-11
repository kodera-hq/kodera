# Architecture decision records

One file per decision, numbered, never edited after acceptance except to change **Status** (Proposed → Accepted → Superseded by ADR-nnnn). Template: [`0000-template.md`](0000-template.md).

| # | Title | Status |
|---|---|---|
| [0001](0001-profile-and-agent-contracts.md) | Profile and agent contracts separate tenant workloads from the control plane | Accepted |
| [0002](0002-no-kubernetes-at-launch.md) | No Kubernetes at launch; bin-packing before Kapsule; Kosmos never | Proposed |
| [0003](0003-api-holds-no-infrastructure-credential.md) | The API process holds no infrastructure credential | Accepted |
| [0004](0004-postgres-backed-job-queue.md) | Every infrastructure mutation is a job on a Postgres-backed queue | Accepted |
| [0005](0005-human-controlled-project-bootstrap.md) | Tenant projects are bootstrapped through a human-controlled boundary | Accepted |
| [0006](0006-kodera-identity-topology.md) | kodera.io uses one identity service with a realm per organisation | Accepted |
| [0007](0007-france-only-data-residency.md) | Customer data and backups remain in the Paris region | Superseded by ADR-0017 |
| [0008](0008-non-reusable-tenant-slugs.md) | Provisioned organisation and tenant slugs are never reused | Accepted |
| [0009](0009-uuidv7-primary-identifiers.md) | Core-owned primary identifiers use UUIDv7 | Accepted |
| [0010](0010-fixed-v1-role-set.md) | The v1 tenant and staff role sets are fixed | Accepted |
| [0011](0011-member-import-data-minimisation.md) | Member-import staging data has a fixed seven-day ceiling | Accepted |
| [0012](0012-core-owns-environment-allocation.md) | Core owns environment allocation and live-command authority | Proposed |
| [0013](0013-shared-hosts-filled-by-resource-budget.md) | Shared hosts are filled by resource budget, not by tenant count | Proposed |
| [0014](0014-shared-tenant-environment-class.md) | Shared-plan tenants run in their own `tenant-shared-prod` environment class | Proposed |
| [0015](0015-identity-and-mail-on-kodera-io.md) | Identity and mail of the Kodera offer use `kodera.io` | Proposed |
| [0016](0016-engines-and-permission-intents.md) | Pilot engines, and the member set Core sends their tenant agents | Proposed |
| [0017](0017-eu-data-residency.md) | Customer data and backups remain in the European Union | Accepted |
| [0018](0018-messaging-and-audio-rooms-in-the-pilot.md) | Messaging and audio rooms in the pilot | Accepted |
| [0019](0019-organisation-lifecycle-states.md) | Organisation lifecycle uses five explicit states | Accepted |
| [0020](0020-two-tier-idempotency.md) | Response replay and durable effect identity are separate tiers | Accepted |
| [0021](0021-external-stop-evidence.md) | Reconciliation requires stop evidence and a fresh target read | Accepted |
| [0022](0022-payment-link-creation-asks-the-provider-from-the-api.md) | Payment link creation asks the provider from the API, outside the replay step | Proposed |
| [0023](0023-matrix-server-name-is-the-tenant-slug.md) | The Matrix server name is the tenant's slug (partly supersedes ADR-0018) | Accepted |

| [0024](0024-default-community-membership.md) | Canonical community membership and explicit identity binding | Accepted |

Source: `deployment operations/ARCHITECTURE_STRATEGY_2026-09-02.md` (v5), sections 3.1, 3.4, 5, 6, and Appendix A.

The active cross-repository execution map is `IMPLEMENTATION_PLAN.md` on `internal architecture records` main; in this workspace it is the project roadmap. Numbered ADR titles and their original product wording are preserved as decision records; current product prose uses Kodera.
