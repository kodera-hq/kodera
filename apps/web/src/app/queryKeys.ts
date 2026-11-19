// The TanStack Query keys more than one surface reads. The shell's status banner, the rail, Home,
// the Applications screen and the landing redirect all ask the Core API the same three questions;
// one key per question means one request and one cache entry, not one per surface.

/** `GET /organisations/{id}/status-summary` — read by the status banner and by Home. */
export const statusSummaryQueryKey = (organisationId: string) =>
  ['status-summary', organisationId] as const

/** `GET /organisations/{id}/tenants?limit=1` — read by the rail, Applications and the landing. */
export const organisationTenantQueryKey = (organisationId: string) =>
  ['organisation-tenant', organisationId] as const

/** `GET /tenants/{id}/status` — read by the rail, Applications, Home and the landing. */
export const tenantStatusQueryKey = (tenantId: string | undefined) =>
  ['tenant-status', tenantId] as const
