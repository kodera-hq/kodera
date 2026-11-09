// Every Core API read Home composes (docs/specs/08-home.md §6). One
// TanStack Query hook per call, each a thin wrapper the screen's components
// call directly — no fan-out orchestration here, since which calls actually
// run depends on data only `Home.tsx` has (whether a tenant exists yet,
// whether it is active), and that branching belongs in the screen, not in a
// hook nobody can see the tree of `enabled` flags for.
//
// `coreApi()`'s middleware throws `ApiProblem` / `NetworkError` on failure
// (`src/api/client.ts`), so every `queryFn` below is a resolved call
// carrying a body — the `data === undefined` guard is the same defensive,
// should-be-unreachable check `src/app/org-route.tsx` already uses for `/me`.

import { useQuery } from '@tanstack/react-query'
import { coreApi } from '../../api/client'
import type { components } from '../../api/schema'
import {
  shouldPollTenantStatus,
  statusSummaryRefetchInterval,
  tenantStatusRefetchInterval,
} from './polling'

type OrganisationStatusSummary = components['schemas']['OrganisationStatusSummary']
type TenantStatusView = components['schemas']['TenantStatusView']
type Subscription = components['schemas']['Subscription']
type Invoice = components['schemas']['Invoice']
type Invitation = components['schemas']['Invitation']
type HelpContext = components['schemas']['HelpContext']

function unwrap<T>(data: T | undefined, label: string): T {
  if (data === undefined) {
    throw new Error(`${label} resolved with no body; this should be unreachable.`)
  }
  return data
}

/** Only an explicit empty list is successful absence; malformed pages fail. */
function firstRow<T>(page: { data: T[] }, label: string): T | null {
  if (!Array.isArray(page.data)) throw new Error(`${label} returned an invalid list.`)
  if (page.data.length === 0) return null
  const row = page.data[0]
  if (row === null || typeof row !== 'object') throw new Error(`${label} returned an invalid row.`)
  return row
}

async function fetchStatusSummary(organisationId: string): Promise<OrganisationStatusSummary> {
  const { data } = await coreApi().GET('/organisations/{organisation_id}/status-summary', {
    params: { path: { organisation_id: organisationId } },
  })
  const summary = unwrap(data, 'GET /organisations/{organisation_id}/status-summary')
  if (
    summary.tenant_id !== null &&
    (typeof summary.tenant_id !== 'string' || summary.tenant_id.length === 0)
  ) {
    throw new Error('Status summary returned no tenant identifier or explicit absence.')
  }
  return summary
}

export function useStatusSummaryQuery(organisationId: string) {
  return useQuery({
    queryKey: ['home', 'status-summary', organisationId],
    queryFn: () => fetchStatusSummary(organisationId),
    refetchInterval: (query) => statusSummaryRefetchInterval(query.state.fetchFailureCount),
    refetchOnWindowFocus: true,
  })
}

/** "only when status-summary.tenant_id is null" (§6): the fallback that
 * discovers whether ANY tenant row exists at all, before it has been linked
 * onto the summary. */
async function fetchFallbackTenantId(organisationId: string): Promise<string | null> {
  const { data } = await coreApi().GET('/organisations/{organisation_id}/tenants', {
    params: { path: { organisation_id: organisationId }, query: { limit: 1 } },
  })
  const page = unwrap(data, 'GET /organisations/{organisation_id}/tenants')
  const tenant = firstRow(page, 'Tenant discovery')
  if (tenant === null) return null
  if (typeof tenant.id !== 'string' || tenant.id.length === 0)
    throw new Error('Tenant discovery returned no identifier.')
  return tenant.id
}

export function useFallbackTenantIdQuery(organisationId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['home', 'tenants-fallback', organisationId],
    queryFn: () => fetchFallbackTenantId(organisationId),
    enabled,
  })
}

async function fetchTenantStatus(tenantId: string): Promise<TenantStatusView> {
  const { data } = await coreApi().GET('/tenants/{tenant_id}/status', {
    params: { path: { tenant_id: tenantId } },
  })
  return unwrap(data, 'GET /tenants/{tenant_id}/status')
}

/**
 * Fetched whenever a tenant id is known, active or not (§6: Home's own
 * Applications card reads `apps[]` from here, which `status-summary` does
 * not carry). Only the repeat-polling cadence follows the provisioning rule
 * — "not at all once it is active" caps `refetchInterval`, read from the
 * query's own last-known status rather than a caller-supplied flag, since
 * that status is exactly what this query itself resolves.
 */
export function useTenantStatusQuery(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['home', 'tenant-status', tenantId],
    queryFn: () => fetchTenantStatus(tenantId as string),
    enabled: tenantId !== undefined,
    refetchInterval: (query) =>
      shouldPollTenantStatus(query.state.data?.status)
        ? tenantStatusRefetchInterval(query.state.fetchFailureCount)
        : false,
    refetchOnWindowFocus: true,
  })
}

async function fetchActiveSubscription(organisationId: string): Promise<Subscription | null> {
  const { data } = await coreApi().GET('/organisations/{organisation_id}/subscriptions', {
    params: { path: { organisation_id: organisationId }, query: { state: 'active', limit: 1 } },
  })
  return firstRow(
    unwrap(data, 'GET /organisations/{organisation_id}/subscriptions'),
    'Subscriptions'
  )
}

export function useActiveSubscriptionQuery(organisationId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['home', 'subscriptions', organisationId],
    queryFn: () => fetchActiveSubscription(organisationId),
    enabled,
  })
}

async function fetchLatestIssuedInvoice(organisationId: string): Promise<Invoice | null> {
  const { data } = await coreApi().GET('/organisations/{organisation_id}/invoices', {
    params: { path: { organisation_id: organisationId }, query: { state: 'issued', limit: 1 } },
  })
  return firstRow(unwrap(data, 'GET /organisations/{organisation_id}/invoices'), 'Invoices')
}

export function useLatestIssuedInvoiceQuery(organisationId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['home', 'invoices', organisationId],
    queryFn: () => fetchLatestIssuedInvoice(organisationId),
    enabled,
  })
}

export interface PendingInvitationsPage {
  invitations: Invitation[]
  hasMore: boolean
}

/** "the banner pages `invitations?state=pending` and filters on the last
 * send older than 72 hours" (§6) — the filter is applied by the caller
 * (`src/features/home/invitations.ts`), this hook only pages the one
 * request the contract allows (`limit=100`, no server-side age filter). */
async function fetchPendingInvitations(organisationId: string): Promise<PendingInvitationsPage> {
  const { data } = await coreApi().GET('/organisations/{organisation_id}/invitations', {
    params: { path: { organisation_id: organisationId }, query: { state: 'pending', limit: 100 } },
  })
  const page = unwrap(data, 'GET /organisations/{organisation_id}/invitations')
  return { invitations: page.data ?? [], hasMore: page.has_more }
}

export function usePendingInvitationsQuery(organisationId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['home', 'invitations', organisationId],
    queryFn: () => fetchPendingInvitations(organisationId),
    enabled,
  })
}

/** Fetched per §6; kept warm for the People screen's own seat gauge, which
 * shares this cache key, but Home renders no figure of its own from it — no
 * state or wireframe in 08-home.md calls for one. */
async function fetchActiveMembersCount(organisationId: string): Promise<number> {
  const { data } = await coreApi().GET('/organisations/{organisation_id}/memberships/count', {
    params: { path: { organisation_id: organisationId }, query: { state: 'active' } },
  })
  return unwrap(data, 'GET /organisations/{organisation_id}/memberships/count').count
}

export function useActiveMembersCountQuery(organisationId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['home', 'memberships-count', organisationId],
    queryFn: () => fetchActiveMembersCount(organisationId),
    enabled,
  })
}

async function fetchHelpContext(locale: 'fr' | 'en'): Promise<HelpContext> {
  const { data } = await coreApi().GET('/support/help-context', {
    params: { query: { area: 'shell', screen: 'home', locale } },
  })
  return unwrap(data, 'GET /support/help-context')
}

export function useHelpContextQuery(locale: 'fr' | 'en', enabled: boolean) {
  return useQuery({
    queryKey: ['home', 'help-context', locale],
    queryFn: () => fetchHelpContext(locale),
    enabled,
  })
}
