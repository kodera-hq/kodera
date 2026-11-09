# ADR-0001: Profile and agent contracts separate tenant workloads from the control plane

**Status:** Accepted

**Deciders:** zôÖma, product owner

## Context

Kodera's control plane (`apps/server`) owns organisation tenancy, identity realms, billing, audit trails, and desired-state orchestration, while each provisioned tenant runs isolated application workloads on dedicated infrastructure. Coupling the control plane directly to host-level compose layouts or ad-hoc node scripts blurs the security boundary between control-plane state and workload execution.

## Decision

`apps/server` is the single control plane and interacts with tenant workloads exclusively across two versioned contracts:

1. **Tenant profile contract** — declarative compose bundle (`docker-compose.yml`, metadata, smoke test, sandboxed Jinja variables) plus the versioned `x-kodera` schema extension, pinned by commit SHA at provisioning time.
2. **Agent API contract** (`packages/api-contract/agent-api.openapi.yaml`) — narrow mTLS/token-authenticated heartbeat, vitals, configuration pull-by-reference, and idempotent command-result interface between a tenant host agent and the control plane.

## Alternatives rejected

- **Delegating tenancy, domains, identity, or billing to a host-level manager**: rejected; keeps multi-tenant authorisation, billing, and audit atomicity in one control plane.
- **Unstructured SSH command execution from API views**: rejected; violates ADR-0003 and bypasses deterministic schema validation.

## Consequences

- Control-plane upgrades and tenant profile revisions evolve independently behind explicit contract versions.
- Every tenant profile is validated against a strict deny-list schema before rendering or deployment.
