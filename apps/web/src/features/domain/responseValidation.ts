// What the list of addresses checks before it keeps a response. Generated
// client types do not validate wire responses; this checks the fields the list
// renders or decides from, and nothing else — it is not OpenAPI validation and
// it takes no authorisation decision.
//
// The fields that describe how an instance is hosted are read by `./hosting.ts`
// and only there: this file asks it whether what arrived is usable.

import type { components } from '../../api/schema'
import { isAppCode } from './apps'
import { isDomainState } from './domainStatus'
import { isAddressPurpose, providedAddresses } from './hosting'
import type { ProvidedAddress } from './hosting'

export type Domain = components['schemas']['Domain']

export interface DomainsPage {
  data: Domain[]
  next_cursor?: string | null
  has_more: boolean
}

/** The instance, as far as the list needs it. */
export interface AddressedTenant {
  id: string
  provided: ProvidedAddress[]
}

/** Shared request and response bound for one domains page. */
export const DOMAINS_PAGE_SIZE = 50

/** `Cursor`'s own bound in the contract. */
const CURSOR_MAX_LENGTH = 512
/** `Domain.fqdn`'s own bound in the contract. */
const FQDN_MAX_LENGTH = 253

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function cursorAgrees(value: Record<string, unknown>): boolean {
  if (typeof value.has_more !== 'boolean') return false
  const cursor = value.next_cursor
  return value.has_more
    ? typeof cursor === 'string' && cursor.length > 0 && cursor.length <= CURSOR_MAX_LENGTH
    : cursor == null
}

/**
 * The organisation's instance, or `null` when it has none yet. The list reads
 * the first one, as the Applications screen does: nothing at launch gives an
 * organisation a second, and nothing on this screen would choose between two.
 */
export function requireFirstTenant(value: unknown, organisationId: string): AddressedTenant | null {
  if (!object(value) || !Array.isArray(value.data) || !cursorAgrees(value)) {
    throw new Error('Tenant list response is unavailable.')
  }
  const tenant: unknown = value.data[0]
  if (tenant === undefined) {
    if (value.has_more) throw new Error('Tenant list response is unavailable.')
    return null
  }
  if (!object(tenant) || !text(tenant.id) || tenant.organisation_id !== organisationId) {
    throw new Error('Tenant list response is unavailable.')
  }
  return { id: tenant.id, provided: providedAddresses(tenant) }
}

function usableRow(value: unknown, tenantId: string): boolean {
  if (!object(value)) return false
  if (!text(value.id) || value.tenant_id !== tenantId) return false
  if (!text(value.fqdn) || value.fqdn.length > FQDN_MAX_LENGTH) return false
  if (!isDomainState(value.state) || !isAddressPurpose(value.role)) return false
  if (value.app != null && !isAppCode(value.app)) return false
  return value.is_canonical === undefined || typeof value.is_canonical === 'boolean'
}

/**
 * The page, or a thrown error the query turns into its error state. One
 * unusable row refuses the whole page: a list that silently dropped an address
 * would be a list nobody could trust to be complete.
 */
export function requireDomainsPage(
  value: unknown,
  tenantId: string,
  pageSize = DOMAINS_PAGE_SIZE
): DomainsPage {
  const fail = (): never => {
    throw new Error('Domain list response is unavailable.')
  }
  if (!object(value) || !Array.isArray(value.data) || !cursorAgrees(value)) return fail()
  if (value.data.length > pageSize) return fail()
  if (!value.data.every((row) => usableRow(row, tenantId))) return fail()
  return value as unknown as DomainsPage
}
