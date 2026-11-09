# ADR-0006: kodera.io uses one identity service with a realm per organisation

**Status:** Accepted
**Deciders:** zôÖma

## Context

The customer expects one login for the console and the enabled La Suite apps.
The current workspace contained two identity directions with different
hostnames, realm topologies, infrastructure and migration timing. One was a
useful implementation study for a wider product group; the other was the
kodera.io tenant design. Building both would split authentication, operations
and incident response before the first paid tenant.

## Decision

- The production identity service for this offer is Keycloak at
  `id.kodera.io`.
- It has one `kodera-staff` staff realm and one realm per paid customer
  organisation. A customer's console, Visio and later admitted applications use
  that customer's realm.
- A tenant slug is a DNS label and a Scaleway project name; it is never a realm
  name. The realm is named from the organisation slug, and a second tenant of
  the same organisation reuses its organisation's realm rather than receiving
  one of its own.
- Staff authenticate through the staff realm. Tenant roles remain Core database
  memberships; a token does not grant an organisation role by itself.
- The Core API derives the organisation from the verified issuer. It never
  accepts a realm or organisation identifier supplied by the browser as an
  authorisation fact.
- The browser discovers the realm at runtime and uses Authorization Code with
  PKCE. Tenant access tokens remain in memory.
- The API holds no Keycloak master-realm credential. Realm creation and template
  changes run through the worker; delegated people administration uses a
  per-realm service account with only the reviewed realm-management roles.
- The Keycloak database and backups live in Paris and are operated as a shared
  production service with a separate staging deployment. Identity backups are
  cross-tenant artefacts and use separate recipients and retention from tenant
  backups.
- Tenant administrators and all staff use mandatory MFA. No SMS factor is part
  of the initial baseline.
- The public free demo keeps its current identity boundary until a dedicated
  migration specification proves account handling, rollback, privacy notice and
  load behaviour. Its migration is not coupled to paid-tenant identity launch.
- Work from another identity implementation may be reused only as reviewed
  components or runbooks. It is not a second production design of record for
  kodera.io.

## Options considered

| Option | Decision |
|---|---|
| One shared customer realm | Rejected. Tenant separation and delegated realm administration would depend on claims and application filtering. |
| A console-only realm plus tenant app realms | Rejected. It gives the buyer two identities and adds subject-mapping machinery. |
| One realm per customer on the kodera.io service | Chosen. It matches the isolation promise and keeps console and apps on one customer identity. |
| Separate identity deployments for console and applications | Rejected for the first stage. It doubles operations and failure modes without improving the customer journey. |

## Consequences

- Shared Keycloak is a cross-tenant service and receives stronger backup,
  access-review, restore and upgrade gates than one tenant runtime.
- Realm discovery is a critical login dependency and needs rate limiting,
  enumeration resistance and an actionable failure path.
- A person belonging to several organisations can have several `(issuer,
  subject)` identities mapped to one Core user.
- Two tenants of the same organisation share a realm, a user directory and an
  issuer, and they are **not** isolated from each other at the identity or
  authorisation layer. `Membership` is `(user, organisation)` and carries no
  tenant, so one membership authorises its holder on every tenant of that
  organisation; that is the intended single sign-on, not a control. What the
  per-tenant client secret, LiveKit API secret, TEM key and infrastructure
  separate is the tenants' services, not their people. A customer needing two
  tenants their own staff cannot cross needs two organisations. Documents that
  describe tenant isolation must say this rather than naming the realm or
  `Membership`
  ([`../security/THREAT_MODEL.md`](../security/THREAT_MODEL.md) §4, B4).
- The organisation's realm is created with its first tenant and deleted with its
  last ([`../domain/JOB_CATALOGUE.md`](../domain/JOB_CATALOGUE.md) `delete`
  step 5, [`../domain/TENANT_STATE_MACHINE.md`](../domain/TENANT_STATE_MACHINE.md)
  T22), while the `Organisation` row can still be `active` or `suspended` and its
  console login depends on that realm ([`../api/AUTHZ.md`](../api/AUTHZ.md) §2
  step 8). There is no `realm_delete` kind and nothing hangs realm teardown off
  `organisation.terminated`. The realm is an organisation property whose
  lifecycle is still keyed to a tenant; giving the organisation its own
  lifecycle is owed and is not decided here.
- A future change to an organisation-based single realm or separate identity
  deployments requires a superseding ADR and migration proof.
