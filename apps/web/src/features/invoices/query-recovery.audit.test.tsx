import type { PropsWithChildren } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchInvoiceDownloadLink,
  useActiveSubscriptionQuery,
  useInvoiceQuery,
  useDunningQuery,
  useInvoicesQuery,
  useBillingProfileQuery,
} from './queries'
import { baseInvoice, INVOICE_ID, ORGANISATION_ID } from '../../mocks/fixtures/invoiceFixtures'
const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../api/client', () => ({ coreApi: () => ({ GET: get }) }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}
describe('actual invoice query recovery boundaries', () => {
  it('represents a successful empty subscription as null', async () => {
    get.mockResolvedValue({ data: { data: [] } })
    const { result } = renderHook(() => useActiveSubscriptionQuery('org'), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toBeNull()
  })
  it.each([
    { has_more: false, next_cursor: null },
    { data: [], has_more: true, next_cursor: null },
    { data: [], has_more: true },
    { data: [], has_more: false, next_cursor: 'contradictory' },
  ])('refuses malformed or contradictory invoice page %j', async (payload) => {
    get.mockResolvedValue({ data: payload })
    const { result } = renderHook(() => useInvoicesQuery(ORGANISATION_ID, undefined), {
      wrapper: wrapper(),
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
  })
  it.each([false, true])('preserves a valid page with continuation=%s', async (more) => {
    get.mockResolvedValue({
      data: {
        data: [baseInvoice({ id: 'invoice' }), baseInvoice({ id: 'draft', state: 'draft' })],
        has_more: more,
        next_cursor: more ? 'next-page' : null,
      },
    })
    const { result } = renderHook(() => useInvoicesQuery(ORGANISATION_ID, undefined), {
      wrapper: wrapper(),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.hasNextPage).toBe(more)
    expect(result.current.data?.pages[0]?.data).toEqual([baseInvoice({ id: 'invoice' })])
  })
})

// A real QueryClient must enter its error state, not cache an apparently open
// invoice or a paid invoice for a different request. Only consumed display fields
// and immutable resource bindings are admitted here; this is not full OpenAPI validation.
it.each([
  {},
  baseInvoice({ id: '' }),
  { ...baseInvoice(), state: 'unknown' },
  { ...baseInvoice(), state: 'toString' },
  baseInvoice({ organisation_id: 'other-organisation' }),
])('refuses an unusable collection row %j', async (row) => {
  get.mockResolvedValue({ data: { data: [row], has_more: false } })
  const { result } = renderHook(() => useInvoicesQuery(ORGANISATION_ID, undefined), {
    wrapper: wrapper(),
  })
  await waitFor(() => expect(result.current.isError).toBe(true))
  expect(result.current.data).toBeUndefined()
})
it.each([
  {},
  baseInvoice({ id: 'different-invoice', state: 'paid' }),
  { ...baseInvoice(), state: 'future-state' },
  { ...baseInvoice(), lines: undefined },
  { ...baseInvoice(), lines: [null] },
  { ...baseInvoice(), total_excl_vat: { amount_minor: Infinity, currency: 'EUR' } },
  { ...baseInvoice(), vat_amount: { amount_minor: 10, currency: 'invalid-currency' } },
  { ...baseInvoice(), due_at: 'invalid-date' },
])('refuses an unusable detail response %j', async (invoice) => {
  get.mockResolvedValue({ data: invoice })
  const { result } = renderHook(() => useInvoiceQuery(INVOICE_ID, ORGANISATION_ID), {
    wrapper: wrapper(),
  })
  await waitFor(() => expect(result.current.isError).toBe(true))
  expect(result.current.data).toBeUndefined()
})
it.each(['issued', 'paid', 'draft', 'overdue', 'void', 'credited'] as const)(
  'preserves a complete matching detail with state %s',
  async (state) => {
    const invoice = baseInvoice({ state })
    get.mockResolvedValue({ data: invoice })
    const { result } = renderHook(() => useInvoiceQuery(INVOICE_ID, ORGANISATION_ID), {
      wrapper: wrapper(),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(invoice)
  }
)
it.each([
  {},
  {
    url: 'javascript:alert(1)',
    expires_at: '2099-01-01T00:00:00Z',
    content_type: 'application/pdf',
  },
  {
    url: 'https://documents.example.test/file',
    expires_at: 'invalid',
    content_type: 'application/pdf',
  },
  {
    url: 'https://documents.example.test/file',
    expires_at: '2000-01-01T00:00:00Z',
    content_type: 'application/pdf',
  },
  {
    url: 'https://documents.example.test/file',
    expires_at: '2099-01-01T00:00:00Z',
    content_type: 'text/html',
  },
])('refuses an unusable PDF link %j', async (link) => {
  get.mockResolvedValueOnce({ data: link })
  await expect(fetchInvoiceDownloadLink(INVOICE_ID)).rejects.toThrow()
})
it('preserves a usable unexpired PDF link without fetching its content', async () => {
  const link = {
    url: 'https://documents.example.test/file',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    content_type: 'application/pdf',
  }
  get.mockResolvedValueOnce({ data: link })
  expect(await fetchInvoiceDownloadLink(INVOICE_ID)).toBe(link)
  expect(get).toHaveBeenCalledTimes(1)
})

const activeSubscription = {
  id: 'subscription',
  organisation_id: ORGANISATION_ID,
  state: 'active',
  pack_code: 'synthetic-pack',
  billing_period: 'monthly',
  price_snapshot: { total_excl_vat: { amount_minor: 0, currency: 'EUR' } },
  current_period_end: '2099-01-01T00:00:00Z',
  next_invoice_at: null,
}
it.each([
  {},
  { ...activeSubscription, organisation_id: 'different-organisation' },
  { ...activeSubscription, state: 'unknown' },
  { ...activeSubscription, state: 'cancelled' },
  { ...activeSubscription, price_snapshot: {} },
  { ...activeSubscription, billing_period: 'fortnight' },
  { ...activeSubscription, current_period_end: 'invalid' },
])('refuses an unusable active subscription row %j', async (row) => {
  get.mockResolvedValue({ data: { data: [row] } })
  const { result } = renderHook(() => useActiveSubscriptionQuery(ORGANISATION_ID), {
    wrapper: wrapper(),
  })
  await waitFor(() => expect(result.current.isError).toBe(true))
})
it('preserves an active subscription with a nullable next-invoice date', async () => {
  get.mockResolvedValue({ data: { data: [activeSubscription] } })
  const { result } = renderHook(() => useActiveSubscriptionQuery(ORGANISATION_ID), {
    wrapper: wrapper(),
  })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data).toEqual(activeSubscription)
})
it.each([
  {},
  { state: 'current', steps: [null] },
  { state: 'unknown', steps: [] },
  { state: 'notice', steps: [{ state: 'unknown', done: false }] },
  { state: 'notice', steps: [{ state: 'notice', done: 'false' }] },
  { state: 'notice', steps: [{ state: 'notice', done: false, due_at: 'invalid' }] },
  { state: 'notice', steps: [], oldest_overdue_invoice_id: {} },
  { state: 'notice', steps: [], days_overdue: Infinity },
  { state: 'notice', steps: [], organisation_id: 'wrong-organisation' },
])('refuses unusable dunning state or steps %j', async (data) => {
  get.mockResolvedValue({ data })
  const { result } = renderHook(() => useDunningQuery(ORGANISATION_ID), { wrapper: wrapper() })
  await waitFor(() => expect(result.current.isError).toBe(true))
})
it('preserves empty current dunning and nullable optional fields', async () => {
  const data = {
    state: 'current',
    steps: [],
    oldest_overdue_invoice_id: null,
    days_overdue: null,
    amount_due: null,
    hold_until: null,
  }
  get.mockResolvedValue({ data })
  const { result } = renderHook(() => useDunningQuery(ORGANISATION_ID), { wrapper: wrapper() })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data).toEqual(data)
})

it('does not present a matching invoice ID belonging to a different current organisation', async () => {
  get.mockResolvedValue({
    data: baseInvoice({ organisation_id: 'different-organisation', state: 'paid' }),
  })
  const { result } = renderHook(() => useInvoiceQuery(INVOICE_ID, ORGANISATION_ID), {
    wrapper: wrapper(),
  })
  await waitFor(() => expect(result.current.isError).toBe(true))
  expect(result.current.data).toBeUndefined()
})

it.each([
  {},
  { amount_minor: 'bad', currency: 'EUR' },
  { amount_minor: 10, currency: 'invalid' },
  { amount_minor: Infinity, currency: 'EUR' },
])(
  'refuses unusable dunning money before the overdue banner renders it: %j',
  async (amount_due) => {
    get.mockResolvedValue({
      data: { state: 'notice', steps: [], oldest_overdue_invoice_id: INVOICE_ID, amount_due },
    })
    const { result } = renderHook(() => useDunningQuery(ORGANISATION_ID), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()
  }
)

it.each([
  undefined,
  null,
  { amount_minor: 0, currency: 'EUR' },
  { amount_minor: -100, currency: 'EUR' },
  { amount_minor: 100, currency: 'EUR' },
])('preserves absent, nullable and signed dunning money: %j', async (amount_due) => {
  const data = { state: 'notice', steps: [], ...(amount_due === undefined ? {} : { amount_due }) }
  get.mockResolvedValue({ data })
  const { result } = renderHook(() => useDunningQuery(ORGANISATION_ID), { wrapper: wrapper() })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data).toEqual(data)
})

describe('billing profile query binding', () => {
  it('requests and caches only the selected organisation profile', async () => {
    get.mockResolvedValue({ data: { id: 'org-1', name: 'ACME' } })
    const { result } = renderHook(() => useBillingProfileQuery('org-1'), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledWith('/organisations/{organisation_id}', {
      params: { path: { organisation_id: 'org-1' } },
    })
    expect(result.current.data).toEqual({ name: 'ACME', address: null })
  })
  it.each([
    undefined,
    { id: 'other', name: 'Foreign' },
    { id: 'org-1', name: 'ACME', billing_address: [] },
  ])('refuses an unavailable or foreign response', async (data) => {
    get.mockResolvedValue({ data })
    const { result } = renderHook(() => useBillingProfileQuery('org-1'), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()
  })
})
