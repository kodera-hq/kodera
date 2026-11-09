// Every server read this screen makes (docs/specs/02-status.md §6), through
// TanStack Query (ADR-0005) and the generated Core API client — never a raw
// `fetch`. `useTenantStatus` is the one with the polling rule (§5); every
// other query here reads once and lets the query cache's own defaults
// (`src/app/providers.tsx`) govern retries.

import { useQuery } from '@tanstack/react-query'
import { offers } from '@/app/capabilities'
import { coreApi } from '@/api/client'
import type { components } from '@/api/schema'
import { statusPollingIntervalMs } from './polling'

export type Tenant = components['schemas']['Tenant']
export type TenantStatusView = components['schemas']['TenantStatusView']
export type StatusComponent = components['schemas']['StatusComponent']
export type Incident = components['schemas']['Incident']
export type AvailabilityDay = components['schemas']['AvailabilityDay']
export type Subscription = components['schemas']['Subscription']

function hasObjectRows(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row))
  )
}

/** A missing collection is not a successful empty read. */
function rows<T>(body: { data: T[] } | undefined): T[] {
  if (!body || !Array.isArray(body.data)) throw new Error('Invalid status collection response.')
  if (body.data.some((row) => row === null || typeof row !== 'object'))
    throw new Error('Invalid status collection row.')
  return body.data
}

// The first (and, at launch, only) tenant of the organisation — an
// organisation's shape allows more without a contract change, but nothing
// in this screen chooses among several.
export async function fetchFirstTenant(organisationId: string): Promise<Tenant | null> {
  const { data } = await coreApi().GET('/organisations/{organisation_id}/tenants', {
    params: { path: { organisation_id: organisationId }, query: { limit: 1 } },
  })
  const tenant = rows(data)[0] ?? null
  if (tenant !== null && (typeof tenant.id !== 'string' || tenant.id.length === 0))
    throw new Error('Invalid tenant identifier.')
  return tenant
}

export function useOrganisationTenant(organisationId: string) {
  return useQuery({
    queryKey: ['organisation-tenant', organisationId],
    queryFn: () => fetchFirstTenant(organisationId),
  })
}

export async function fetchTenantStatus(tenantId: string): Promise<TenantStatusView> {
  const { data } = await coreApi().GET('/tenants/{tenant_id}/status', {
    params: { path: { tenant_id: tenantId } },
  })
  // Same defensive guard as `src/app/org-route.tsx`'s `fetchMe`: the client
  // middleware throws on any non-2xx, so a resolved call always carries a
  // body — this only guards openapi-fetch's own optimistic typing.
  if (data === undefined) {
    throw new Error('GET /tenants/{tenant_id}/status resolved with no body; unreachable.')
  }
  if (
    typeof data.status !== 'string' ||
    !data.agent ||
    typeof data.agent.stale !== 'boolean' ||
    (data.components !== undefined && !hasObjectRows(data.components)) ||
    // Null until the tenant's capacity is measured (contract 0.30.0); never absent.
    (data.capacity !== null &&
      (typeof data.capacity !== 'object' || !data.capacity.participants)) ||
    !hasObjectRows(data.apps) ||
    !hasObjectRows(data.provisioning_steps)
  )
    throw new Error('Invalid tenant status response.')
  return data
}

/**
 * The one polled query (§5): 30 s while `active`, 10 s while `provisioning`,
 * backing off to 2 min after three consecutive failures
 * (`statusPollingIntervalMs`), never while the tab is hidden
 * (`refetchIntervalInBackground: false` is TanStack Query's own default),
 * and resuming immediately on focus (`refetchOnWindowFocus: 'always'`
 * overrides the application's own `false` default from
 * `src/app/providers.tsx`, which exists for resources that do not need it).
 */
export function useTenantStatus(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['tenant-status', tenantId],
    queryFn: () => fetchTenantStatus(tenantId as string),
    enabled: tenantId !== undefined,
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return statusPollingIntervalMs(status, query.state.fetchFailureCount)
    },
  })
}

async function fetchStatusComponents(tenantId: string): Promise<StatusComponent[]> {
  const { data } = await coreApi().GET('/status/components', {
    params: { query: { tenant_id: tenantId } },
  })
  return rows(data)
}

/** A separate call from `useTenantStatus`, deliberately: the components card
 * can fail on its own while the rest of the screen — apps, capacity — stays
 * usable (§12 acceptance test 7, overlay `status.components-error`). */
export function useStatusComponents(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['status-components', tenantId],
    queryFn: () => fetchStatusComponents(tenantId as string),
    enabled: tenantId !== undefined && offers('status-components'),
  })
}

async function fetchOpenIncidents(tenantId: string): Promise<Incident[]> {
  const { data } = await coreApi().GET('/status/incidents', {
    params: { query: { tenant_id: tenantId, state: 'open' } },
  })
  return rows(data)
}

export function useOpenIncidents(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['status-incidents', tenantId],
    queryFn: () => fetchOpenIncidents(tenantId as string),
    enabled: tenantId !== undefined && offers('status-incidents'),
  })
}

async function fetchAvailability(tenantId: string): Promise<AvailabilityDay[]> {
  const { data } = await coreApi().GET('/tenants/{tenant_id}/availability', {
    params: { path: { tenant_id: tenantId }, query: { days: 7 } },
  })
  return rows(data)
}

/** Fetched lazily — only once the history drawer is opened
 * (`status_history_opened`, §11) — since it is never shown by default. */
export function useTenantAvailability(tenantId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['tenant-availability', tenantId],
    queryFn: () => fetchAvailability(tenantId as string),
    enabled: enabled && tenantId !== undefined && offers('availability-history'),
  })
}

async function fetchActiveSubscription(organisationId: string): Promise<Subscription | null> {
  const { data } = await coreApi().GET('/organisations/{organisation_id}/subscriptions', {
    params: { path: { organisation_id: organisationId }, query: { state: 'active' } },
  })
  return rows(data)[0] ?? null
}

export function useActiveSubscription(organisationId: string, enabled = true) {
  return useQuery({
    queryKey: ['active-subscription', organisationId],
    queryFn: () => fetchActiveSubscription(organisationId),
    enabled,
  })
}
