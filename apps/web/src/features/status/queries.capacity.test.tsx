import { QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/app/providers'
import { tenantStatusBody, TENANT_ID } from '@/mocks/overlays/support/status-fixtures'
import { useTenantStatus } from './queries'

const slot = vi.hoisted(() => ({ body: undefined as unknown }))

vi.mock('@/api/client', () => ({
  coreApi: () => ({ GET: () => Promise.resolve({ data: slot.body }) }),
}))

function statusWith(capacity: unknown) {
  slot.body = { ...tenantStatusBody({ status: 'active' }), capacity }
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { retry: false } })
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(() => useTenantStatus(TENANT_ID), { wrapper }).result
}

// Contract 0.30.0: `capacity` is null until the tenant is measured, and present in every body.
describe('tenant status capacity guard', () => {
  it('accepts a capacity not measured yet', async () => {
    const result = statusWith(null)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.capacity).toBeNull()
  })

  it.each([
    ['absent', undefined],
    ['a gauge without participants', { threshold_pct: 90, upgrade_prompt: false }],
    ['not an object', 42],
  ])('rejects a capacity that is %s', async (_label, capacity) => {
    const result = statusWith(capacity)
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('Invalid tenant status response.')
  })
})
