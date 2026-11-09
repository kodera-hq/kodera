# ADR-0013: Shared hosts are filled by resource budget, not by tenant count

**Status:** Proposed
**Owner:** Infra seat
**Deciders:** Infra seat, Product seat

## Context

ADR-0002 keeps one dedicated instance per organisation at launch. It names bin-packing on shared
hosts as the first step if its triggers fire, with two parameters: one retained IP per tenant, and
at most five tenants per host.

The product now sells a shared entry plan from launch, beside the dedicated instance. Fleet
ADR-0006 records that hosting model: tenants of the entry plan share application hosts, one media
host running one LiveKit server, and one managed PostgreSQL. It is a product decision taken on a
cost analysis, not a trigger of ADR-0002 firing.

Both packing parameters of ADR-0002 break on that model:

- **A tenant count is not a capacity unit.** An organisation of four users and one of fifty do not
  load a host the same way. A cap of five tenants would leave a host idle with small tenants and
  overload it with large ones. The number mixes two different limits: what a host can carry, and
  how many customers one host failure may reach.
- **One retained IP per tenant does not fit a shared edge.** In the shared model each application
  host serves its own tenants through one edge on one retained address.

Core owns environment allocation (ADR-0012), so the rule that decides whether a tenant fits on a
host is a core rule. Fleet ADR-0006 cannot be accepted until core states it.

## Decision

### The shared hosting model exists from launch

- A tenant is placed on a `dedicated` or a `shared` hosting model. The choice follows the plan the
  organisation buys. It is not gated on the ADR-0002 triggers, which keep governing any move
  towards an orchestrator.
- ADR-0002's packing parameters, one retained IP per tenant and at most five tenants per host, are
  replaced by the rules below for `shared` tenants. `dedicated` tenants are not packed.

### Capacity is a resource budget

- A `shared` tenant draws on three shared resources: an application host, the media host and the
  managed PostgreSQL. Each of them is a **resource pool**.
- Each capacity tier declares a **reservation** for `shared` tenants in every pool the tenant uses.
  The tier is chosen from the organisation's number of users. A reservation covers:
  - on the application host: CPU, memory, disk and network bandwidth;
  - on the media host: concurrent media participants, and the network bandwidth they use;
  - on the managed PostgreSQL: connections, storage and IOPS.
- The reservation MUST include the fixed footprint of an idle tenant stack, which every tenant
  consumes whatever its size. On the managed PostgreSQL this includes the connections its idle
  services hold open.
- Each pool declares a **budget** for every resource above: its capacity minus a recorded headroom
  for peaks. A resource with no recorded budget has a budget of zero, so no tenant fits.
- The media host's budget is counted in **concurrent participants**, because media load follows who
  is in a call at the same moment, not registered users.

### One atomic placement check

- Placement is one check across the three pools. It passes only when, in each pool and for each
  resource, the sum of the reservations, the new tenant included, stays within the budget.
- The check is atomic. Allocation records the tenant's reservations in all three pools together,
  or records none of them. A placement never holds an application host without its media host and
  database reservations, or the reverse.
- Two placements that run at the same time MUST NOT both pass against the same remaining budget.
  Allocation serialises placements that touch the same pool.
- Allocation MUST refuse a placement that fails the check in any pool. The refusal names the pool
  and the resource that does not fit. Allocation MUST NOT overcommit a pool silently.
- A tier change runs the same check. When the new reservation does not fit in one pool, the change
  is refused, or the tenant moves to pools where every reservation fits.
- Reservations and budgets are placeholders until measured on the target hardware and on the
  managed database offer in use. Until then, each placement on a shared host is reviewed by a
  human.

### A tenant cap is a blast-radius limit, not capacity

- Every shared application host and every media host MUST have a maximum number of tenants. The cap
  bounds how many customers one host failure reaches. It is a risk and commercial decision.
- The cap is a finite number, recorded with its reason in the allocation policy that core owns. The
  Product seat approves the value.
- The cap changes only through a reviewed revision of that recorded policy, approved by the Product
  seat. No job, operator action or host record changes it.
- Allocation refuses a placement on a host that has no recorded cap, and a placement that would
  take a host above its cap.
- The target's synthetic canary tenant (ADR-0014) is a placement like any other: it counts against
  the tenant cap of each host it is placed on and against the budget of every pool, and its
  placement passes the same check.
- The cap is a blast-radius limit, not a capacity rule. Allocation enforces the cap and the budget
  check, and a placement must pass both. A host below its cap can still be full, and the cap never
  raises or replaces a budget.

### Addressing

- Each shared application host holds one retained IPv4 for the edge of its own tenants. Each media
  host holds one retained IPv4 for its relay range and TURN over TLS on 443.
- A tenant's host placement and media assignment are core-owned allocation facts under ADR-0012. The
  shared media host and the managed database belong to the shared target, and each tenant's use of
  them is recorded in that tenant's placement, as ADR-0014 decides, not in an endpoint-sharing
  decision.

### Media placement

- Media never enters an orchestrator, as ADR-0002 already requires. Media runs on dedicated hosts,
  Scaleway Instances or Elastic Metal, not only on VMs.

## Relationship to accepted decisions

- ADR-0014 (proposed) decides where shared hosts live: the `tenant-shared-prod` environment class
  and its one shared provider project. This decision only decides how the hosts of that class are
  filled.
- ADR-0005's human-controlled bootstrap remains in force. The shared project is not a tenant
  project: ADR-0014 bootstraps it once through ADR-0005, with a provisioning credential restricted
  to the shared project, and keeps that credential away from tenant jobs.
- ADR-0007 is unchanged: shared hosts, the managed database and every backup stay in the Paris
  region.
- ADR-0012 gets no change from this decision. This decision adds the budget check and the tenant
  cap to the allocation ADR-0012 already owns; it does not add a second allocation authority. The
  class and project changes to ADR-0012 come from ADR-0014.

## Options considered

| Option | Decision |
|---|---|
| Keep at most five tenants per host | Rejected. A count ignores tenant size, and five is below the break-even of the shared plan. |
| Cap by registered users per host | Rejected. Registered users do not load a host; concurrent use does. Users choose the tier; the tier carries the reservation. |
| Overcommit and rely on monitoring | Rejected. A host that fills silently degrades every tenant on it before an alert fires. |
| A tenant cap as the only rule | Rejected. It is kept as a mandatory blast-radius limit beside the budget, not as capacity. |
| An optional tenant cap | Rejected. It leaves no required bound on how many customers one host failure reaches. |
| Budget CPU, memory and media participants only | Rejected. The managed PostgreSQL and the host disk and network fill up too, and a tenant placed without them overloads a pool no check watches. |
| Resource budget per pool, reservation per tier, one atomic check | Chosen. It follows what actually loads each shared resource and keeps placement a data check. |

## Consequences

- ADR-0002's packing clause points to this decision. Its other decisions, no Kubernetes at launch,
  Kapsule conditions and no Kosmos, are unchanged.
- The allocation model needs a budget per pool, a per-tier reservation in each pool, a recorded
  tenant cap per host and one atomic placement check. Its tests refuse a placement that overflows
  each pool in turn, a placement above the cap, a placement on a host with no cap, and two
  concurrent placements that fit only one at a time. The environment-allocation specification and
  the Fleet tier file each need a follow-up change.
- The Product seat has to approve a finite tenant cap before the first shared placement, which is
  the canary's (ADR-0014).
- Fleet ADR-0006 can move to Accepted once this decision and ADR-0014 are accepted.
- Until reservations are measured, the budget rule is enforced but its numbers are guesses, and
  placement stays human-reviewed.

## References

- [ADR-0002](0002-no-kubernetes-at-launch.md)
- [ADR-0005](0005-human-controlled-project-bootstrap.md)
- [ADR-0007](0007-france-only-data-residency.md)
- [ADR-0012](0012-core-owns-environment-allocation.md)
- [ADR-0014](0014-shared-tenant-environment-class.md)
- Fleet ADR-0006, shared entry hosting model: `deployment profiles`, `docs/adr/0006-shared-entry-plan.md`

## Changelog

- Proposes resource-budget placement for shared hosts in place of ADR-0002's five-tenant cap and
  per-tenant retained IP, and separates the optional blast-radius cap from capacity.
- Extends the budget to the managed PostgreSQL and to host disk and network, with one atomic
  placement check across the application host, the media host and the database. Makes the per-host
  tenant cap mandatory. Cites ADR-0014 for the shared project.
- Records a tenant's use of the shared media host and database as its tenant placement, as ADR-0014
  decides, and links the ADR-0014 file.
- Counts the target's canary tenant against the tenant cap and the budget like any member, as
  ADR-0014 requires before either record is accepted.
