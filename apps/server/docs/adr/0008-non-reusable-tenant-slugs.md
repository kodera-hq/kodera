# ADR-0008: Provisioned organisation and tenant slugs are never reused

**Status:** Accepted
**Deciders:** zôÖma

## Context

A tenant slug appears in DNS names, Scaleway project names, buckets,
certificates, status components, audit targets, backup tags and customer
bookmarks; an organisation slug appears in Keycloak issuers and realms.
Reassigning either after deletion can bind old links, cached identity metadata,
delayed e-mail, DNS caches or retained evidence to a different customer.

The original domain-model convention allowed a slug to become available after
the soft-delete retention period, while the fleet lifecycle retired slugs
permanently. The less restrictive rule would create an identity and domain
confusion risk precisely after most diagnostic context had been purged.

## Decision

- An organisation or tenant slug is provisional while an order has created no
  external resource.
- Once project bootstrap, realm creation, DNS publication or certificate
  issuance starts, the slug is permanently reserved and MUST NOT identify a
  different organisation or tenant.
- Deletion removes customer data according to retention rules but preserves a
  minimal non-personal reservation record: slug, kind, reservation time,
  retirement state and the deletion-certificate reference.
- A returning customer receives a new slug and new issuer. Redirects from a
  retired hostname are not created unless their ownership is freshly verified
  and the redirect reveals no prior-tenant information.
- Provider resource names include a stable opaque suffix where practical; a
  globally reusable bucket name is never treated as proof of tenant identity.

The reservation model and uniqueness migration must be specified and tested
before the first Core migration creates organisation or tenant slugs.

## Options considered

| Option | Decision |
|---|---|
| Reuse after the purge window | Rejected. It converts stale identity, DNS and messaging artefacts into cross-customer confusion. |
| Never reuse after any draft order | Rejected. Abandoned, unprovisioned drafts would consume names without creating a security history. |
| Permanently reserve once an external identity or resource exists | Chosen. It aligns the control plane and fleet lifecycle at the point where stale references become possible. |

## Consequences

- Deletion is not literal erasure of the slug reservation. The legal basis and
  minimisation statement for that non-personal security record must be captured
  in the retention documentation.
- Slug availability checks query active and retired reservations.
- Tests must cover concurrent reservation, cancelled drafts, deletion and an
  attempted post-purge reuse.
- A mistaken production reservation requires an explicit exceptional decision;
  it is not fixed by deleting a row.
