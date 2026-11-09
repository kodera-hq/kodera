import { tenantStatusBody } from '@/mocks/overlays/support/status-fixtures'
import type { PropsWithChildren } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  useOrganisationTenant,
  useActiveSubscription,
  useStatusComponents,
  useTenantStatus,
} from './queries'
const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/api/client', () => ({ coreApi: () => ({ GET: get }) }))
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
describe('actual status query boundaries before recovery', () => {
  it.each([
    ['tenant', useOrganisationTenant],
    ['subscription', useActiveSubscription],
  ] as const)('represents successful empty %s as explicit absence', async (_name, hook) => {
    get.mockResolvedValue({ data: { data: [] } })
    const { result } = renderHook(() => hook('org'), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toBeNull()
  })
  it.each([{}, { data: null }, { data: {} }])(
    'refuses malformed status components %j',
    async (payload) => {
      get.mockResolvedValue({ data: payload })
      const { result } = renderHook(() => useStatusComponents('tenant'), { wrapper: wrapper() })
      await waitFor(() => expect(result.current.isError).toBe(true))
    }
  )
  it('preserves explicit empty components as success', async () => {
    get.mockResolvedValue({ data: { data: [] } })
    const { result } = renderHook(() => useStatusComponents('tenant'), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual([])
  })
  it('preserves a nonempty tenant result', async () => {
    get.mockResolvedValue({ data: { data: [{ id: 'tenant', status: 'active' }] } })
    const { result } = renderHook(() => useOrganisationTenant('org'), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toMatchObject({ id: 'tenant' })
  })
})

it('refuses a completed malformed tenant status instead of crashing its consumer', async () => {
  get.mockResolvedValue({ data: {} })
  const { result } = renderHook(() => useTenantStatus('tenant'), { wrapper: wrapper() })
  await waitFor(() => expect(result.current.isError).toBe(true))
})
it('refuses tenant rows with no usable identifier', async () => {
  get.mockResolvedValue({ data: { data: [{}] } })
  const { result } = renderHook(() => useOrganisationTenant('org'), { wrapper: wrapper() })
  await waitFor(() => expect(result.current.isError).toBe(true))
})

it('admits the contract optional absence of embedded components', async () => {
  const body = tenantStatusBody({ status: 'active' })
  delete body.components
  get.mockResolvedValue({ data: body })
  const { result } = renderHook(() => useTenantStatus('tenant'), { wrapper: wrapper() })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
})
it('refuses an active response without the capacity object its view requires', async () => {
  const body: Record<string, unknown> = { ...tenantStatusBody({ status: 'active' }) }
  delete body.capacity
  get.mockResolvedValue({ data: body })
  const { result } = renderHook(() => useTenantStatus('tenant'), { wrapper: wrapper() })
  await waitFor(() => expect(result.current.isError).toBe(true))
})

it.each(['apps', 'provisioning_steps', 'components'])(
  'refuses null rows inside consumed status %s',
  async (key) => {
    const body: Record<string, unknown> = { ...tenantStatusBody({ status: 'active' }) }
    body[key] = [null]
    get.mockResolvedValue({ data: body })
    const { result } = renderHook(() => useTenantStatus('tenant'), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isError).toBe(true))
  }
)
