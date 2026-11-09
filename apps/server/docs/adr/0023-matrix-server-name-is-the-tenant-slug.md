# ADR-0023: The Matrix server name is the tenant's slug

**Status:** Accepted
**Owner:** API seat
**Deciders:** the lead, who asked for the contract change, for the quick workspace (`docs/specs/QUICK_WORKSPACE.md`), whose plan made the tenant slug the Matrix server name and which the console's W2 implements.

**Partly supersedes [ADR-0018](0018-messaging-and-audio-rooms-in-the-pilot.md):** its section "The Matrix `server_name` and the organisation slug", for which slug names the homeserver. ADR-0018 stays in force for everything else.

## Context

ADR-0018 named each tenant's `server_name` `{organisation-slug}.kodera.io`, made the organisation slug immutable once its Espace exists, and reserved for organisation slugs the platform's labels under `kodera.io`. Two things came later:

- **The quick workspace** (`createTenant`, contract 0.35.0) has the owner choose the tenant's own slug. `TenantCreation.slug` is "the tenant's DNS label and its Matrix server name". It is unique, never reused (ADR-0008) and never changed, and it may not take one of the platform's own host names (`RESERVED_TENANT_SLUGS`).
- **The tenant slug may differ from the organisation slug.** An organisation created as `acme-sas` may name its workspace `acme`. Fleet's one Espace record, `kodera-team`, is consistent with it: its `features.matrix_server_name` is its slug under the staging zone, a value written by hand, and there the tenant slug and the organisation slug are the same.

The console's W2 (kodera-console #333) derives the homeserver and the Matrix session from `tenant.slug`, never the organisation slug, with a test where they differ. Core's normative Espace table still named the organisation slug, so the contract and its two implementations disagreed.

## Decision

- **A tenant's Matrix `server_name` is `{tenant slug}.{matrix domain}`:** `kodera.io` in production, `staging.kodera.io` on staging. It is delegated by `.well-known` to wherever the homeserver runs, and it is never a customer's custom domain.
- **A client reads the slug from the organisation's tenant:** `Tenant.slug` of its newest tenant that is not `deleted`, Core's rule (`newest_tenant_not_deleted`), from `listTenants` or `getTenant`. A deleted tenant's row stays listed, and its slug stays taken. A client never derives the server name from the organisation's slug.
- **The tenant slug is permanent,** as every user and room identifier embeds it. It never changes and is never reused (ADR-0008).
- **The platform's labels must be reserved for tenant slugs too.** ADR-0018 reserved them for organisation slugs only, because the organisation slug named the homeserver. `RESERVED_TENANT_SLUGS` (`apps/tenancy/models.py`) does not yet hold `notify`, `staging`, `support`, `billing`, `console`, `developers`, `matrix`, `auth-admin` or `auth-mail`. So today a tenant could take `staging` and be given the server name `staging.kodera.io`, the staging Matrix domain itself. Adding them is a contract change and a migration, owed as its own change. Until it lands, no organisation but our own creates a workspace.
- **The organisation slug stays permanent.** Matrix no longer needs it, but it is the realm's name and its issuer's path (`docs/specs/CUSTOMER_PERSISTENCE.md`), and the contract refuses its change unconditionally (`patchOrganisation` cannot patch it). This record changes neither.

## Options considered

| Option | Why not |
|---|---|
| Keep the organisation slug as the server name | The quick workspace asks the owner for the workspace's address, and that address is the tenant slug. Two slugs naming one homeserver would let the console, Fleet and Core disagree, and they already did. |
| Force the tenant slug to equal the organisation slug | It is a needless coupling: an organisation's legal name and its workspace address are different choices. It would also refuse a free tenant slug because the organisation's is taken. |

## Consequences

- The contract's Espace table names the tenant slug (contract 0.37.2, prose only).
- Fleet's record writer (F1) derives `features.matrix_server_name` from the tenant slug, and the agent's `KODERA_MATRIX_SERVER_NAME` carries that value.
- An organisation with more than one tenant would have one homeserver per tenant. The pilot allows one workspace per organisation (QUICK_WORKSPACE.md §4), so this is not exercised yet.
- **Revisit** if a customer's own domain is ever offered as the server name. That is a new decision, since a server name never changes.
