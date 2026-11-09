// The Domain area's reads, through TanStack Query and the generated Core
// client (ADR-0005). The client's middleware raises an HTTP or a network
// failure; `./responseValidation.ts` refuses a response the list cannot render
// before it is cached as a success.

import { useQuery } from '@tanstack/react-query'
import { coreApi } from '../../api/client'
import { offers } from '../../app/capabilities'
import { addressRows } from './hosting'
import type { AddressRow } from './hosting'
import { DOMAINS_PAGE_SIZE, requireDomainsPage, requireFirstTenant } from './responseValidation'
import type { AddressedTenant, Domain } from './responseValidation'

export { DOMAINS_PAGE_SIZE } from './responseValidation'
/**
 * How far the cursor is followed. An instance has a handful of addresses; a
 * list still promising more after this many pages is a cursor going round in
 * circles, and an error is more honest than a screen that never settles.
 */
export const DOMAINS_MAX_PAGES = 10

/** What the list is drawn from: no instance yet, or the instance's addresses. */
export type Addresses =
  { instance: false } | { instance: true; tenantId: string; rows: AddressRow[] }

/** Exported for the slices that change an address and must read the list again. */
export function addressesQueryKey(organisationId: string) {
  return ['domain-addresses', organisationId] as const
}

async function fetchFirstTenant(organisationId: string): Promise<AddressedTenant | null> {
  const { data } = await coreApi().GET('/organisations/{organisation_id}/tenants', {
    params: { path: { organisation_id: organisationId }, query: { limit: 1 } },
  })
  return requireFirstTenant(data, organisationId)
}

/**
 * Every address of the instance. A page carries no total and a server may
 * answer fewer rows than asked (docs/specs/README.md §5), so the cursor is
 * followed until `has_more` is false: half a list of addresses, with nothing
 * on screen to say so, would be read as the whole.
 */
async function fetchAllDomains(tenantId: string): Promise<Domain[]> {
  const domains: Domain[] = []
  let cursor: string | undefined
  for (let page = 0; page < DOMAINS_MAX_PAGES; page += 1) {
    const { data } = await coreApi().GET('/tenants/{tenant_id}/domains', {
      params: {
        path: { tenant_id: tenantId },
        query: { limit: DOMAINS_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
      },
    })
    const checked = requireDomainsPage(data, tenantId, DOMAINS_PAGE_SIZE)
    domains.push(...checked.data)
    if (!checked.has_more) return domains
    cursor = checked.next_cursor ?? undefined
  }
  throw new Error('Domain list did not end.')
}

/**
 * The organisation's instance, then its addresses. One query, so the screen
 * has one loading state, one failure and one retry — the instance's own
 * provided addresses are never shown beside a list that failed to arrive.
 */
export function useAddressesQuery(organisationId: string) {
  return useQuery({
    queryKey: addressesQueryKey(organisationId),
    // Never fetched while Core does not serve it (`src/app/capabilities.ts`).
    enabled: offers('domain-addresses'),
    queryFn: async (): Promise<Addresses> => {
      const tenant = await fetchFirstTenant(organisationId)
      if (tenant === null) return { instance: false }
      const domains = await fetchAllDomains(tenant.id)
      return { instance: true, tenantId: tenant.id, rows: addressRows(tenant.provided, domains) }
    },
  })
}
