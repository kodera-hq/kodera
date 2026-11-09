import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from '../../api/client'
import { ApiProblem } from '../../api/client'
import { payOnline } from './payment'
const activeLink = (overrides: Record<string, unknown> = {}) => ({
  id: 'synthetic-link',
  invoice_id: 'invoice',
  state: 'active',
  url: 'https://payments.example.test/existing',
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  ...overrides,
})
const { get, mutate } = vi.hoisted(() => ({ get: vi.fn(), mutate: vi.fn() }))
vi.mock('../../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof ClientModule>()
  return { ...original, coreApi: () => ({ GET: get }) }
})
vi.mock('../../api/mutations', () => ({ mutate }))
beforeEach(() => {
  get.mockReset()
  mutate.mockReset()
})
describe('payment issuance requires explicit absence evidence', () => {
  it('does not issue a payment link after a successful response with no body', async () => {
    get.mockResolvedValueOnce({ data: undefined })
    mutate.mockResolvedValueOnce({ url: 'https://payments.example.test/new' })
    await expect(
      payOnline('invoice', 'https://console.example.test/return', 'fr', () => true)
    ).rejects.toThrow()
    expect(mutate).not.toHaveBeenCalled()
  })
  it('returns an existing link without issuing another', async () => {
    const link = activeLink()
    get.mockResolvedValueOnce({ data: link })
    expect(
      await payOnline('invoice', 'https://console.example.test/return', 'fr', () => true)
    ).toBe(link)
    expect(mutate).not.toHaveBeenCalled()
  })
  it('preserves provider refusal instead of converting it to absence', async () => {
    get.mockRejectedValueOnce(
      new ApiProblem({
        type: null,
        title: 'Unavailable',
        status: 503,
      })
    )
    await expect(
      payOnline('invoice', 'https://console.example.test/return', 'fr', () => true)
    ).rejects.toMatchObject({ status: 503 })
    expect(mutate).not.toHaveBeenCalled()
  })
})

it('does not issue after an action ends while its lookup is pending', async () => {
  let reject!: (error: Error) => void
  let active = true
  get.mockReturnValueOnce(
    new Promise((_resolve, no) => {
      reject = no
    })
  )
  const pending = payOnline('invoice', 'https://console.example.test/return', 'fr', () => active)
  active = false
  reject(
    new ApiProblem({
      type: 'https://kodera.io/problems/not-found',
      status: 404,
      title: 'Not found',
    })
  )
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(mutate).not.toHaveBeenCalled()
})
it('issues only after an explicit absence while the action remains current', async () => {
  get.mockRejectedValueOnce(
    new ApiProblem({
      type: 'https://kodera.io/problems/not-found',
      status: 404,
      title: 'Not found',
    })
  )
  const link = activeLink({ url: 'https://payments.example.test/issued' })
  mutate.mockResolvedValueOnce(link)
  expect(await payOnline('invoice', 'https://console.example.test/return', 'fr', () => true)).toBe(
    link
  )
  expect(mutate).toHaveBeenCalledTimes(1)
})

// Consumer contract: only a usable HTTPS, credential-free, currently active link
// for the requested invoice may leave this action. A malformed GET is never
// absence evidence, and a malformed POST result never becomes a started flow.
const invalidLinks = [
  ['empty body', {}],
  ['missing URL', activeLink({ url: undefined })],
  ['non-web URL', activeLink({ url: 'javascript:alert(1)' })],
  ['insecure URL', activeLink({ url: 'http://payments.example.test/path' })],
  ['URL credentials', activeLink({ url: 'https://synthetic:private@payments.example.test/path' })],
  ['wrong invoice', activeLink({ invoice_id: 'other-invoice' })],
  ['inactive link', activeLink({ state: 'used' })],
  ['unknown link state', activeLink({ state: 'toString' })],
  ['expired link', activeLink({ expires_at: new Date(0).toISOString() })],
  ['invalid expiry', activeLink({ expires_at: 'invalid' })],
] as const
it.each(invalidLinks)('refuses GET %s without issuing a replacement', async (_label, link) => {
  get.mockResolvedValueOnce({ data: link })
  await expect(
    payOnline('invoice', 'https://console.example.test/return', 'fr', () => true)
  ).rejects.toThrow()
  expect(mutate).not.toHaveBeenCalled()
})
it.each(invalidLinks)('refuses POST %s after explicit absence', async (_label, link) => {
  get.mockRejectedValueOnce(new ApiProblem({ type: null, status: 404, title: 'Not found' }))
  mutate.mockResolvedValueOnce(link)
  await expect(
    payOnline('invoice', 'https://console.example.test/return', 'fr', () => true)
  ).rejects.toThrow()
  expect(mutate).toHaveBeenCalledTimes(1)
})
