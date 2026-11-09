# ADR-0002: No Kubernetes at launch; bin-packing before Kapsule; Kosmos never for this fleet

**Status:** Proposed
**Date:** 2026-09-02
**Deciders:** the crew (proposal by zôÖma)

## Context
The tenant model is one dedicated instance per organisation: one VM, one Scaleway project, two retained IPv4 (web, media), Docker Compose. LiveKit needs direct UDP and TURN/TLS on 443 on a stable address. The team is small and the first commercial slice must minimise operational systems. Scaleway documentation confirms: Kapsule node pools are Scaleway Instances only; Kosmos attaches external nodes over a Kilo (WireGuard) mesh without auto-healing or autoscaling on those nodes; Scaleway's Load Balancer has no UDP.

## Decision
- **At launch: no Kubernetes.** Declarative state and rolling upgrades come from the job runner and tenant profiles, not from an orchestrator.
- **If the written triggers fire** (upgrade cycle > 2 working days; ops > 1 h per tenant-month over a quarter; fleet > €3 000/month where packing saves ≥ 30 %): first **bin-pack compose profiles on shared hosts** (capacity by resource budget and one retained IP per host, as set by [ADR-0013](0013-shared-hosts-filled-by-resource-budget.md); a shared entry plan sold from launch uses the same rules without waiting for a trigger), with the factory or a conformant `greffer`, keeping one packaging format.
- **Kapsule** only if an apps-plane service needs more than one host per tenant. **Media stays on VMs** in every scenario.
- **Kosmos** is not used for this fleet: its value is heterogeneous or bare-metal nodes, at the cost of a mesh in the data path and no auto-healing.
- Nomad is excluded by licence.

## Options considered
- Kapsule with one namespace per tenant from the start: rejected; abandons isolation-as-a-product, requires a second packaging format (Helm/Kustomize) and a second gate harness, cannot host media behind a load balancer.
- Kosmos with Elastic Metal for media: rejected; media does not need Kubernetes at all.

## Consequences
- Tenant profiles must stay declarative and host-agnostic so bin-packing later is a scheduling change, not a rewrite.
- The pack's "rated for 30 tenants" ceiling remains the point where this ADR is revisited.
