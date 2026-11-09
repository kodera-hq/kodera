// `landingFor` (`landing.ts`) for one organisation, reading its applications from its tenant
// status through the same query keys the rail and the Applications screen read.

import type { components } from '../api/schema'
import { fetchFirstTenant, fetchTenantStatus } from '../features/status/queries'
import { landingFor, type Landing } from './landing'
import { queryClient } from './queryClient'

type OrganisationRole = components['schemas']['OrganisationRole']
type AppCode = components['schemas']['AppCode']

/** The application codes of the organisation's tenant; `null` when the organisation has no tenant
 * yet; `undefined` when a read fails, so a member lands on Home rather than on a workspace that may
 * not exist. */
async function organisationApps(organisationId: string): Promise<AppCode[] | null | undefined> {
  try {
    const tenant = await queryClient.fetchQuery({
      queryKey: ['organisation-tenant', organisationId],
      queryFn: () => fetchFirstTenant(organisationId),
    })
    if (tenant === null) return null
    const status = await queryClient.fetchQuery({
      queryKey: ['tenant-status', tenant.id],
      queryFn: () => fetchTenantStatus(tenant.id),
    })
    return status.apps.map((app) => app.code)
  } catch {
    return undefined
  }
}

/** Where `role` lands in the organisation. Only a member's landing depends on the applications,
 * so no other role reads them. */
export async function landingIn(
  organisationId: string,
  role: OrganisationRole | undefined
): Promise<Landing> {
  if (role !== 'org_member') return '/$org/home'
  return landingFor(role, await organisationApps(organisationId))
}
