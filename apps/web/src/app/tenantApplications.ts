import { useOrganisationTenant, useTenantStatus } from '../features/status/queries'
import type { TenantApp } from '../features/status/AppsCard'

/**
 * Where the applications come from — no new endpoint, no new field.
 *
 * `GET /organisations/{id}/tenants?limit=1` for the organisation's tenant,
 * then `GET /tenants/{id}/status`, whose `apps[]` is a `TenantApp[]` with the
 * `code`, `name` and `url` this rail draws. That is exactly what the
 * Applications screen reads (`src/features/status/StatusScreen.tsx` →
 * `AppsCard`), through the very same two hooks and therefore the very same
 * TanStack Query keys — so the rail shares that screen's cache instead of
 * opening a second conversation about the same thing.
 *
 * A tenant that does not exist yet, a status call that fails, an organisation
 * still provisioning: all three resolve to an empty list here, and the rail
 * renders its constants (the maker's mark, and « Réglages » for every role but
 * `org_member`) without complaint, as the phone's module bar (`NarrowModuleBar`)
 * renders « Accueil » and « Messages ». The Applications screen is where a
 * failure is explained; a strip of icons is not the place to report one.
 */
export function useTenantApplications(organisationId: string): {
  apps: readonly TenantApp[]
  /**
   * The tenant read has answered that the organisation has none yet. Not while the first read
   * loads or fails (no data); kept through a later refetch that fails, like `apps`.
   */
  noTenantYet: boolean
} {
  const tenant = useOrganisationTenant(organisationId)
  const status = useTenantStatus(tenant.data?.id)
  return {
    apps: status.data?.apps ?? [],
    noTenantYet: tenant.data === null,
  }
}

/** The applications the rail and the phone's module bar draw as applications: every one but
 * `messaging`, which is this application's own workspace surface, « Messages », drawn once as
 * that surface. In the server's order. */
export function otherApplications(apps: readonly TenantApp[]): readonly TenantApp[] {
  return apps.filter((app) => app.code !== 'messaging')
}
