import { renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { authAdapter } from '../../auth/oidc'
import { useInvoiceActionLease } from './useInvoiceActionLease'
let generation = 1
let token: string | undefined = 'synthetic'
beforeEach(() => {
  generation = 1
  token = 'synthetic'
  vi.spyOn(authAdapter, 'getSnapshot').mockImplementation(() => ({
    status: 'ready',
    generation,
    credentialGeneration: 1,
    user: { realm: 'acme-sa' },
  }))
  vi.spyOn(authAdapter, 'getAccessToken').mockImplementation(() => token)
})
it('allows a live action and rejects both its lease and saved starter after the view changes', () => {
  const { result, rerender } = renderHook(({ view }) => useInvoiceActionLease(view), {
    initialProps: { view: 'org-a/invoice-a/owner' },
  })
  const oldStart = result.current
  const current = oldStart()
  expect(current()).toBe(true)
  rerender({ view: 'org-b/invoice-b/owner' })
  expect(current()).toBe(false)
  expect(oldStart()()).toBe(false)
  expect(result.current()()).toBe(true)
})
it('retires callbacks on session change, expiry and unmount', () => {
  const { result, unmount } = renderHook(() => useInvoiceActionLease('invoice'))
  const current = result.current()
  generation++
  expect(current()).toBe(false)
  const renewed = result.current()
  token = undefined
  expect(renewed()).toBe(false)
  token = 'synthetic'
  const beforeUnmount = result.current()
  unmount()
  expect(beforeUnmount()).toBe(false)
  expect(result.current()()).toBe(false)
})
