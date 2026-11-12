// Every read the order wizard needs, through the generated Core API client
// and TanStack Query (ADR-0005) — never `fetch` directly, never a second
// client. Reads here are exactly the catalogue's four collections plus slug
// availability and legal documents (01-order.md §6); nothing here computes a
// price or a total (docs/dev/API_CLIENT.md).

import { useQuery } from '@tanstack/react-query'
import { coreApi } from '../../api/client'
import type { components } from '../../api/schema'

export type Pack = components['schemas']['Pack']
export type Plan = components['schemas']['Plan']
export type CapacityTier = components['schemas']['CapacityTier']
export type Price = components['schemas']['Price']
export type SlugAvailability = components['schemas']['SlugAvailability']
export type LegalDocument = components['schemas']['LegalDocument']
export type BillingPeriod = components['schemas']['BillingPeriod']

/** Exact selection only: no fallback plan, period, price or arithmetic. */
export function cataloguePrice(
  prices: readonly Price[],
  packCode: string | undefined,
  tierCode: string | undefined,
  billingPeriod: BillingPeriod
): Price | undefined {
  return prices.find(
    (price) =>
      price.pack_code === packCode &&
      price.capacity_tier_code === tierCode &&
      price.billing_period === billingPeriod
  )
}

/**
 * The plan a price is sold under, at the version the price names: Core links a plan to a tier
 * nowhere else (01-order.md §4.1), and a price is always read through a plan version. `undefined`
 * without a price, or when no listed plan has that code and version; a screen then reads the
 * tier's own name, « Capacité M ».
 */
export function planOfPrice(price: Price | undefined, plans: readonly Plan[]): Plan | undefined {
  if (price === undefined) return undefined
  return plans.find((plan) => plan.code === price.plan_code && plan.version === price.plan_version)
}

/**
 * Catalogue reads share one `staleTime`: prices and packs change by
 * publication, not by the second, so a screen that revisits `plan` a minute
 * later should not re-fetch the exact data it just showed.
 */
const CATALOGUE_STALE_TIME_MS = 60_000

export function usePacksQuery() {
  return useQuery({
    queryKey: ['order', 'packs'],
    queryFn: async () => {
      const { data } = await coreApi().GET('/catalog/packs', { params: { query: {} } })
      return data?.data ?? []
    },
    staleTime: CATALOGUE_STALE_TIME_MS,
  })
}

export function useCapacityTiersQuery() {
  return useQuery({
    queryKey: ['order', 'capacity-tiers'],
    queryFn: async () => {
      const { data } = await coreApi().GET('/catalog/capacity-tiers', { params: { query: {} } })
      return data?.data ?? []
    },
    staleTime: CATALOGUE_STALE_TIME_MS,
  })
}

export function usePlansQuery() {
  return useQuery({
    queryKey: ['order', 'plans'],
    queryFn: async () => {
      const { data } = await coreApi().GET('/catalog/plans', { params: { query: {} } })
      return data?.data ?? []
    },
    staleTime: CATALOGUE_STALE_TIME_MS,
  })
}

export function usePricesQuery(packCode: string | undefined, billingPeriod: BillingPeriod) {
  return useQuery({
    queryKey: ['order', 'prices', packCode, billingPeriod],
    queryFn: async () => {
      const { data } = await coreApi().GET('/catalog/prices', {
        params: {
          query: {
            billing_period: billingPeriod,
            ...(packCode === undefined ? {} : { pack_code: packCode }),
          },
        },
      })
      return data?.data ?? []
    },
    enabled: packCode !== undefined,
    staleTime: CATALOGUE_STALE_TIME_MS,
  })
}

/**
 * 01-order.md §8: checked server-side, debounced 400 ms on blur — the
 * debounce is the caller's job (it decides when `slug` changes), this hook
 * only decides whether a request is in flight. `available: false` never says
 * who holds the name (the contract's own privacy rule for this endpoint).
 */
export function useSlugAvailabilityQuery(slug: string, enabled: boolean) {
  return useQuery({
    queryKey: ['order', 'slug-availability', slug],
    queryFn: async () => {
      const { data } = await coreApi().GET('/slug-availability', { params: { query: { slug } } })
      return data
    },
    enabled: enabled && slug.length > 0,
    // A taken name does not become free a second later; no reason to keep
    // asking, and asking again is exactly what a fresh blur already does.
    staleTime: Infinity,
    retry: 0,
  })
}

export function useLegalDocumentsQuery(packCode: string | undefined, locale: 'fr' | 'en') {
  return useQuery({
    queryKey: ['order', 'legal-documents', packCode, locale],
    queryFn: async () => {
      const { data } = await coreApi().GET('/legal-documents', {
        params: { query: { locale, ...(packCode === undefined ? {} : { pack_code: packCode }) } },
      })
      return data?.data ?? []
    },
    staleTime: CATALOGUE_STALE_TIME_MS,
  })
}

/**
 * The organisation's owner, for the message a `member` sees instead of the
 * order form (`console.order._.error-role`, "Ask {owner}") — the only reason
 * this screen ever reads memberships at all.
 */
export type Order = components['schemas']['Order']
export type Invoice = components['schemas']['Invoice']
export type PaymentLink = components['schemas']['PaymentLink']

export function useOrderQuery(orderId: string | undefined) {
  return useQuery({
    queryKey: ['order', 'order', orderId],
    queryFn: async () => {
      const { data } = await coreApi().GET('/orders/{order_id}', {
        params: { path: { order_id: orderId ?? '' } },
      })
      return data
    },
    enabled: orderId !== undefined,
    retry: 1,
  })
}

export function useInvoiceQuery(invoiceId: string | undefined) {
  return useQuery({
    queryKey: ['order', 'invoice', invoiceId],
    queryFn: async () => {
      const { data } = await coreApi().GET('/invoices/{invoice_id}', {
        params: { path: { invoice_id: invoiceId ?? '' } },
      })
      return data
    },
    enabled: invoiceId !== undefined,
  })
}

export function useInvoiceDownloadLinkQuery(invoiceId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['order', 'invoice-download', invoiceId],
    queryFn: async () => {
      const { data } = await coreApi().GET('/invoices/{invoice_id}/download', {
        params: { path: { invoice_id: invoiceId ?? '' } },
      })
      return data
    },
    enabled: enabled && invoiceId !== undefined,
  })
}

export function useOrganisationOwnerQuery(organisationId: string | undefined) {
  return useQuery({
    queryKey: ['order', 'organisation-owner', organisationId],
    queryFn: async () => {
      const { data } = await coreApi().GET('/organisations/{organisation_id}/memberships', {
        params: { path: { organisation_id: organisationId ?? '' }, query: {} },
      })
      const owner = (data?.data ?? []).find((membership) => membership.role === 'org_owner')
      // The owner's name, else their address where Core discloses it. From a member it withholds
      // a colleague's address (contract 0.42.0, « Directory privacy »), omitted or `null` alike:
      // there is then no one to name, which is `null` here, never a blank or the word « null ».
      const name = owner?.display_name?.trim()
      if (name !== undefined && name.length > 0) return name
      const email = owner?.email?.trim()
      return email !== undefined && email.length > 0 ? email : null
    },
    enabled: organisationId !== undefined,
  })
}

/** Whether the organisation already has an order that is not cancelled: `true` when one is read,
 * `false` when none is, `'unknown'` when the read does not say (more than one page, none live on
 * the first). The console places no new order unless it is `false`: one order per organisation
 * for now, stricter than Core, which lets a paid order hold nothing (01-order.md §6). */
export function useLiveOrderQuery(organisationId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['order', 'live-order', organisationId],
    queryFn: async (): Promise<boolean | 'unknown'> => {
      const { data } = await coreApi().GET('/organisations/{organisation_id}/orders', {
        params: { path: { organisation_id: organisationId }, query: { limit: 100 } },
      })
      if ((data?.data ?? []).some((order) => order.state !== 'cancelled')) return true
      return data?.has_more === false ? false : 'unknown'
    },
    enabled,
  })
}
