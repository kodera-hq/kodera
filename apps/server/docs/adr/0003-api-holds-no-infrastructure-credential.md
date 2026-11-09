# ADR-0003: The API process holds no infrastructure credential

**Status:** Accepted
**Date:** 2026-09-02
**Deciders:** the crew (proposal by zôÖma)

## Context
The Core API is internet-facing (the console calls it). To provision a tenant, something must create Scaleway projects, VMs, and DNS records, create Keycloak realms, and configure VMs over SSH. If the API process held those credentials, one SSRF or RCE in Django or DRF would expose every tenant's identity, backups, and hosts. The internal pack's own audit already forbade an always-on host holding a fleet-wide age key.

## Decision
- The **API process** holds no organisation-level Scaleway key, no Keycloak master-realm right, no SSH key, no age identity. It reads and writes Postgres, verifies Keycloak tokens, and enqueues jobs.
- A separate **provisioning worker**, with no inbound network, dequeues jobs and obtains credentials per job: a Scaleway application API key whose bearer policy is restricted to one tenant project, an SSH certificate from an SSH CA valid at most 8 hours with a per-tenant principal, and the shared ops age identity loaded to memory from Scaleway Secret Manager for the duration of the job.
- The shared ops age identity is **not target-isolated**: a worker holding it for one job can decrypt every bundle encrypted to it, not only that job's target. There is one such identity per environment class, never shared across classes (deployment profiles ADR-0005, Proposed: "A credential valid in two classes is a defect"). It is acceptable for `lab` and `staging` only. Every other class, `demo-canary` and `platform-prod` included, first needs target-isolated decryption and one-job secret delivery, required by ADR-0012 (Core owns environment allocation and live-command authority) and to be provided by a separate decision.
- The first project and tenant-policy-scoped application cannot create themselves. Their human-controlled bootstrap and the gate for a future privileged allocator are defined by ADR-0005. The API and general provisioning worker never receive the organisation-level capability used for that bootstrap.
- Delegated administration uses a **per-realm `realm-management` service account** (`manage-users`, `view-users`); master-realm rights exist only in the worker.
- Tenant secrets are stored **envelope-encrypted** with a KEK in Scaleway Key Manager; they are decrypted only on the tenant VM they serve, written mode 600.
- Human age identities are hardware-bound; none exist on disk.
- No tenant VM holds a credential that resolves outside its own Scaleway project (TEM subdomain and DNS sub-zone are created in the tenant project). Preflight asserts this.

## Options considered
- One Django process doing both API and provisioning with a fleet key: rejected as the crown-jewel failure mode.
- Credentials in environment variables of the worker: rejected; per-job loading limits exposure to the job's lifetime.

## Consequences
- Provisioning latency includes credential issuance and, initially, an explicit project-bootstrap handoff; the customer flow must show it honestly.
- The worker needs its own threat model and its own audit trail; both are part of the M1 exit criteria.
