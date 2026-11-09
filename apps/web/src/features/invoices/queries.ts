import { readBillingProfile, type BillingProfile } from './billingProfile'
// Invoice reads use TanStack Query and the generated Core client. Middleware
// handles HTTP/network failures; generated types do not validate JSON content.
// Feature-specific checks below refuse unusable response fields before they can
// become cached success or a destination the customer opens.

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { coreApi } from '../../api/client'
import type { components } from '../../api/schema'
import {
  requireActiveSubscription,
  requireDunningResponse,
  requireInvoiceDownloadLink,
  requireInvoiceResponse,
} from './responseValidation'

export type Invoice = components['schemas']['Invoice']
export type InvoiceState = components['schemas']['InvoiceState']
export type Subscription = components['schemas']['Subscription']
export type DunningView = components['schemas']['DunningView']
export type DownloadLink = components['schemas']['DownloadLink']
export type PaymentLink = components['schemas']['PaymentLink']

export interface CursorPageOf<T> {
  data: T[]
  next_cursor?: string | null
  has_more: boolean
}

const PAGE_SIZE = 25

/**
 * `useInfiniteQuery` rather than hand-rolled accumulation: "Afficher 25 de
 * plus" (§4.1) appends a page, never replaces one, which is exactly what
 * `data.pages` already gives for free — no local mirror of server state to
 * keep in sync via an effect. A page carries no total (`docs/specs/README.md`
 * §5), so `getNextPageParam` reads only `has_more`/`next_cursor`, never a
 * count.
 */
export function useInvoicesQuery(organisationId: string, state: InvoiceState | undefined) {
  return useInfiniteQuery({
    queryKey: ['invoices', organisationId, state ?? null],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<CursorPageOf<Invoice>> => {
      const { data } = await coreApi().GET('/organisations/{organisation_id}/invoices', {
        params: {
          path: { organisation_id: organisationId },
          query: {
            limit: PAGE_SIZE,
            ...(state === undefined ? {} : { state }),
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
        },
      })
      if (data === undefined) {
        throw new Error('GET /organisations/{id}/invoices resolved with no body.')
      }
      if (
        !Array.isArray(data.data) ||
        data.data.some((invoice) => invoice === null || typeof invoice !== 'object') ||
        typeof data.has_more !== 'boolean' ||
        (data.has_more
          ? typeof data.next_cursor !== 'string' ||
            data.next_cursor.length === 0 ||
            data.next_cursor.length > 512
          : data.next_cursor !== undefined && data.next_cursor !== null)
      )
        throw new Error('Invoice pagination response is unavailable.')
      for (const invoice of data.data) requireInvoiceResponse(invoice, { organisationId })
      // §8's client-side safety net: "A draft invoice is never listed."
      return { ...data, data: data.data.filter((invoice) => invoice.state !== 'draft') }
    },
    getNextPageParam: (lastPage) =>
      lastPage.has_more ? (lastPage.next_cursor ?? undefined) : undefined,
  })
}

export function useInvoiceQuery(invoiceId: string | undefined, organisationId: string) {
  return useQuery({
    queryKey: ['invoice', organisationId, invoiceId],
    enabled: invoiceId !== undefined,
    queryFn: async (): Promise<Invoice> => {
      const { data } = await coreApi().GET('/invoices/{invoice_id}', {
        params: { path: { invoice_id: invoiceId as string } },
      })
      if (data === undefined) throw new Error('GET /invoices/{id} resolved with no body.')
      requireInvoiceResponse(data, { invoiceId: invoiceId as string, organisationId })
      return data
    },
  })
}

/**
 * `state=active`, per §6 — the subscription the list, the banner and the
 * subscription screen all read. A page, per the contract's own shape, but
 * every screen here only ever reads the first row: an organisation carries
 * at most one active subscription at launch.
 */
export function useActiveSubscriptionQuery(organisationId: string) {
  return useQuery({
    queryKey: ['subscriptions', organisationId, 'active'],
    queryFn: async (): Promise<Subscription | null> => {
      const { data } = await coreApi().GET('/organisations/{organisation_id}/subscriptions', {
        params: { path: { organisation_id: organisationId }, query: { state: 'active' } },
      })
      if (data === undefined) {
        throw new Error('GET /organisations/{id}/subscriptions resolved with no body.')
      }
      if (!Array.isArray(data.data)) throw new Error('Subscription collection is unavailable.')
      const subscription = data.data[0]
      if (subscription !== undefined) requireActiveSubscription(subscription, organisationId)
      return subscription ?? null
    },
  })
}

export function useDunningQuery(organisationId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['dunning', organisationId],
    enabled: options.enabled ?? true,
    queryFn: async (): Promise<DunningView> => {
      const { data } = await coreApi().GET('/organisations/{organisation_id}/dunning', {
        params: { path: { organisation_id: organisationId } },
      })
      if (data === undefined) {
        throw new Error('GET /organisations/{id}/dunning resolved with no body.')
      }
      requireDunningResponse(data, organisationId)
      return data
    },
  })
}

/**
 * The PDF is a pre-signed link, never proxied bytes (§6): a plain async call
 * rather than a query — there is no cached "current download" to keep in
 * sync with the UI, only a one-off action ("open this now") the caller
 * awaits directly. Minting one is an audited issuance
 * (`DownloadLink`'s own doc comment), so this only ever runs when the person
 * actually asks for it, never eagerly.
 */
export async function fetchInvoiceDownloadLink(invoiceId: string): Promise<DownloadLink> {
  const { data } = await coreApi().GET('/invoices/{invoice_id}/download', {
    params: { path: { invoice_id: invoiceId } },
  })
  if (data === undefined) {
    throw new Error('GET /invoices/{id}/download resolved with no body.')
  }
  requireInvoiceDownloadLink(data)
  return data
}

/** Mounted only inside the existing Billing area guard. */
export function useBillingProfileQuery(organisationId: string) {
  return useQuery({
    queryKey: ['billing-profile', organisationId],
    queryFn: async (): Promise<BillingProfile> => {
      const { data } = await coreApi().GET('/organisations/{organisation_id}', {
        params: { path: { organisation_id: organisationId } },
      })
      return readBillingProfile(data, organisationId)
    },
  })
}
