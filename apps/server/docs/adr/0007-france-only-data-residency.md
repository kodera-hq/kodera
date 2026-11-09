# ADR-0007: Customer data and backups remain in the Paris region

**Status:** Superseded by ADR-0017
**Deciders:** zôÖma

## Context

The offer promises French hosting and states that customer personal data is
stored and processed in France. Earlier planning also proposed a backup copy in
a second Scaleway region. Scaleway's other cloud regions are outside France, so
those statements cannot both be true.

Paris has three availability zones and Standard Multi-AZ Object Storage. That
improves resilience to an availability-zone failure inside Paris; it is not a
copy in a second geographic region and does not protect against complete loss
or prolonged isolation of the Paris region.

## Decision

- Customer content, identity data, control-plane customer records, application
  logs, secrets, encryption keys, backups, exports and deletion evidence MUST be
  stored and processed in Scaleway `fr-par` unless a later ADR changes the
  customer promise and legal pack.
- Backups use Standard Multi-AZ Object Storage in `fr-par`, versioning and the
  accepted Object Lock policy. A One Zone copy is not the durable backup floor.
- Zonal compute resources may be distributed across Paris availability zones
  where the service design supports it. A single tenant VM remains a zonal
  failure domain until a measured need justifies a more complex tenant profile.
- External availability probes may run elsewhere in France and carry only
  service names, synthetic identifiers and measurements. They MUST NOT receive
  customer content, the identifier or credential of a real user, or the URL of
  a real room. A probe MAY hold the credentials and tokens that authenticate a
  dedicated synthetic probe identity, and the URL of its own reserved probe
  room: those name a monitoring account we create and destroy, never a
  customer.
- Internal tools outside the customer-data path receive no customer personal
  data. Configuration checks and redaction tests enforce that claim.
- No replication, backup, snapshot, log export or support attachment containing
  customer personal data may target another country under this ADR.
- The legal pack and service description state the residual risk honestly:
  recovery is designed for host and availability-zone incidents, not guaranteed
  loss of the whole Paris region.

A geographic disaster-recovery copy is a future product and legal decision. It
requires a superseding ADR, DPA and ROPA changes, sub-processor and region
disclosure, key-custody design, deletion/retention alignment and a completed
restore drill before any customer data is copied.

## Options considered

| Option | Decision |
|---|---|
| Paris primary plus another European region | Rejected under the current promise because customer data would leave France. |
| Paris-only with Multi-AZ storage and an explicit regional residual risk | Chosen. It is consistent with the offer and improves AZ resilience without mislabelling it geographic DR. |
| Promise full regional disaster recovery without a remote copy | Rejected. It is not technically supportable. |
| Operate a second French provider immediately | Deferred. It adds a second platform, contract and restore path before the single-provider factory is proven. |

## Consequences

- A whole-region incident can exceed the normal recovery objectives. Sales,
  DPA, SLA and incident language must not claim otherwise.
- Backup and restore drills must identify the AZ and storage class in their
  evidence.
- A second-country replica cannot be added as a quiet operations improvement.
- Provider concentration remains an accepted risk and is reviewed after the
  first factory and restore evidence exist.

## References

- [Scaleway product availability and availability zones](https://www.scaleway.com/en/docs/account/reference-content/products-availability/)
- [Scaleway Object Storage concepts](https://www.scaleway.com/en/docs/object-storage/concepts/)
- [Scaleway Object Storage FAQ](https://www.scaleway.com/en/docs/object-storage/faq/)
