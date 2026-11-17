import { describe, expect, it, vi } from 'vitest'
import { retryLimitedLogin } from './loginRetry'

const limited = (delay?: number, header?: string) =>
  new Response(JSON.stringify({ errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: delay }), {
    status: 429,
    headers: header === undefined ? {} : { 'Retry-After': header },
  })

describe('bounded Matrix login recovery', () => {
  it('honours the longer body/header delay and returns the recovered response', async () => {
    const ok = new Response('{}')
    const retry = vi.fn().mockResolvedValue(ok)
    const wait = vi.fn().mockResolvedValue(undefined)
    await expect(retryLimitedLogin(limited(250, '1'), retry, () => true, wait)).resolves.toBe(ok)
    expect(wait).toHaveBeenCalledExactlyOnceWith(1000)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('honours an HTTP-date Retry-After even when the body is not JSON', async () => {
    const now = Date.parse('2030-01-01T00:00:00Z')
    vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const response = new Response('busy', {
        status: 429,
        headers: { 'Retry-After': new Date(now + 2000).toUTCString() },
      })
      const wait = vi.fn().mockResolvedValue(undefined)
      await retryLimitedLogin(
        response,
        async () => new Response('{}'),
        () => true,
        wait
      )
      expect(wait).toHaveBeenCalledExactlyOnceWith(2000)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('bounds both attempts and total waiting, and never shortens a server cooldown', async () => {
    const retry = vi.fn().mockImplementation(async () => limited(10000))
    const wait = vi.fn().mockResolvedValue(undefined)
    const first = limited(10000)
    expect((await retryLimitedLogin(first, retry, () => true, wait)).status).toBe(429)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(wait).toHaveBeenCalledTimes(1)
    retry.mockClear()
    wait.mockClear()
    const long = limited(15001)
    await expect(retryLimitedLogin(long, retry, () => true, wait)).resolves.toBe(long)
    expect(retry).not.toHaveBeenCalled()
    expect(wait).not.toHaveBeenCalled()
    await retryLimitedLogin(
      limited(),
      retry.mockImplementation(async () => limited()),
      () => true,
      wait
    )
    expect(retry).toHaveBeenCalledTimes(2)
    expect(wait.mock.calls).toEqual([[1000], [2000]])
  })

  it('does not retry a revoked session or any non-rate-limit error', async () => {
    let current = true
    const retry = vi.fn()
    const first = limited(10)
    await expect(
      retryLimitedLogin(
        first,
        retry,
        () => current,
        async () => {
          current = false
        }
      )
    ).resolves.toBe(first)
    expect(retry).not.toHaveBeenCalled()
    const refused = new Response('{}', { status: 403 })
    await expect(retryLimitedLogin(refused, retry, () => true)).resolves.toBe(refused)
    expect(retry).not.toHaveBeenCalled()
  })
})

it('stops after two retries when repeated 429 responses omit retry hints', async () => {
  const retry = vi.fn().mockImplementation(async () => limited())
  const wait = vi.fn().mockResolvedValue(undefined)
  expect((await retryLimitedLogin(limited(), retry, () => true, wait)).status).toBe(429)
  expect(retry).toHaveBeenCalledTimes(2)
  expect(wait.mock.calls.map(([delay]) => delay)).toEqual([1000, 2000])
})
