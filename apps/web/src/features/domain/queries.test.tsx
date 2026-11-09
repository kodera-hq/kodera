import type { PropsWithChildren } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORGANISATION_ID,
  TENANT_ID,
  baseDomain,
  baseTenant,
  domainId,
  providedHosts,
} from '../../mocks/fixtures/domainFixtures'
import {
  DOMAINS_MAX_PAGES,
  DOMAINS_PAGE_SIZE,
  addressesQueryKey,
  useAddressesQuery,
} from './queries'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../api/client', () => ({ coreApi: () => ({ GET: get }) }))

afterEach(() => {
  vi.clearAllMocks()
})

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

const TENANTS = '/organisations/{organisation_id}/tenants'
const DOMAINS = '/tenants/{tenant_id}/domains'

const tenants = (rows: unknown[]) => ({ data: { data: rows, has_more: false, next_cursor: null } })
const lastPage = (rows: unknown[]) => ({ data: { data: rows, has_more: false, next_cursor: null } })
const pageBefore = (rows: unknown[], cursor: string) => ({
  data: { data: rows, has_more: true, next_cursor: cursor },
})

const first = baseDomain('visio.acme.fr', { id: domainId(1) })
const second = baseDomain('docs.acme.fr', { id: domainId(2), app: 'docs' })
const third = baseDomain('reunions.acme.fr', { id: domainId(3) })

function renderAddresses() {
  return renderHook(() => useAddressesQuery(ORGANISATION_ID), { wrapper: wrapper() })
}

describe('useAddressesQuery', () => {
  it('reads the instance, then its addresses, each by identifier', async () => {
    get.mockResolvedValueOnce(tenants([baseTenant()])).mockResolvedValueOnce(lastPage([first]))
    const { result } = renderAddresses()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(DOMAINS_PAGE_SIZE).toBe(50)
    expect(get.mock.calls).toEqual([
      [TENANTS, { params: { path: { organisation_id: ORGANISATION_ID }, query: { limit: 1 } } }],
      [DOMAINS, { params: { path: { tenant_id: TENANT_ID }, query: { limit: 50 } } }],
    ])
    expect(result.current.data).toMatchObject({ instance: true, tenantId: TENANT_ID })
    const rows = result.current.data?.instance === true ? result.current.data.rows : []
    expect(rows.map((row) => row.host)).toEqual(['visio.acme.fr', ...providedHosts()])
  })

  it('follows the cursor to the last page and keeps every address, in order', async () => {
    get
      .mockResolvedValueOnce(tenants([baseTenant()]))
      .mockResolvedValueOnce(pageBefore([first], 'c-2'))
      .mockResolvedValueOnce(pageBefore([second], 'c-3'))
      .mockResolvedValueOnce(lastPage([third]))
    const { result } = renderAddresses()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(get.mock.calls.slice(1).map(([, init]) => init.params.query)).toEqual([
      { limit: 50 },
      { limit: 50, cursor: 'c-2' },
      { limit: 50, cursor: 'c-3' },
    ])
    const rows = result.current.data?.instance === true ? result.current.data.rows : []
    expect(rows.map((row) => row.host)).toEqual([
      'visio.acme.fr',
      'docs.acme.fr',
      'reunions.acme.fr',
      ...providedHosts(),
    ])
  })

  it('gives up, as a failure, on a list that never ends', async () => {
    get.mockImplementation((path: string) =>
      Promise.resolve(path === TENANTS ? tenants([baseTenant()]) : pageBefore([first], 'again'))
    )
    const { result } = renderAddresses()
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(result.current.error).toEqual(new Error('Domain list did not end.'))
    expect(get.mock.calls.filter(([path]) => path === DOMAINS)).toHaveLength(DOMAINS_MAX_PAGES)
    expect(result.current.data).toBeUndefined()
  })

  it('asks for no address when the organisation has no instance', async () => {
    get.mockResolvedValueOnce(tenants([]))
    const { result } = renderAddresses()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data).toEqual({ instance: false })
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('fails as a whole when the addresses cannot be read', async () => {
    const down = new Error('down')
    get.mockResolvedValueOnce(tenants([baseTenant()])).mockRejectedValueOnce(down)
    const { result } = renderAddresses()
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(result.current.error).toBe(down)
    // Not the provided addresses alone, passed off as the list.
    expect(result.current.data).toBeUndefined()
  })

  it('refuses a page it cannot render instead of caching it', async () => {
    get
      .mockResolvedValueOnce(tenants([baseTenant()]))
      .mockResolvedValueOnce(lastPage([{ ...first, state: 'verified' }]))
    const { result } = renderAddresses()
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(result.current.error).toEqual(new Error('Domain list response is unavailable.'))
  })

  it('is cached per organisation', () => {
    expect(addressesQueryKey('a')).toEqual(['domain-addresses', 'a'])
    expect(addressesQueryKey('a')).not.toEqual(addressesQueryKey('b'))
  })
})

it('does not cache an incomplete empty tenant page as absence', async () => {
  get.mockResolvedValueOnce({ data: { data: [], has_more: true, next_cursor: 'next' } })
  const { result } = renderAddresses()
  await waitFor(() => expect(result.current.isError).toBe(true))
  expect(result.current.error).toEqual(new Error('Tenant list response is unavailable.'))
  expect(result.current.data).toBeUndefined()
  expect(get).toHaveBeenCalledTimes(1)
})

it('does not cache an oversized domain page as a complete list', async () => {
  const rows = Array.from({ length: DOMAINS_PAGE_SIZE + 1 }, (_, index) =>
    baseDomain('visio.acme.fr', { id: domainId(index + 1) })
  )
  get.mockResolvedValueOnce(tenants([baseTenant()])).mockResolvedValueOnce(lastPage(rows))
  const { result } = renderAddresses()
  await waitFor(() => expect(result.current.isError).toBe(true))
  expect(result.current.error).toEqual(new Error('Domain list response is unavailable.'))
  expect(result.current.data).toBeUndefined()
})
