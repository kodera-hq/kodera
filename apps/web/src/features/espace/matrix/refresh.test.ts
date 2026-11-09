import { describe, expect, it, vi } from 'vitest'
import { RefreshRefused, refreshingFetch } from './refresh'

const expired = () =>
  new Response(JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN', soft_logout: true }), { status: 401 })
const ok = (body = '{}') => new Response(body, { status: 200 })
const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } })

function tokens(start = 'old', next = 'new') {
  let token = start
  // As the store does: the new token is installed only once the homeserver answered.
  const refresh = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    token = next
    return next
  })
  return { source: { current: () => token, refresh }, refresh }
}

describe('a Matrix request whose access token expired', () => {
  it('buys a new token and retries the request with it', async () => {
    const { source, refresh } = tokens()
    const base = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(ok('"done"'))
    const response = await refreshingFetch(base, source)(
      'https://hs/_matrix/client/v3/sync',
      auth('old')
    )
    expect(await response.json()).toBe('done')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(new Headers(base.mock.calls[1]![1]!.headers).get('Authorization')).toBe('Bearer new')
  })

  it('buys one token for many requests that failed together', async () => {
    const { source, refresh } = tokens()
    const base = vi.fn<typeof fetch>(async (_input, init) =>
      new Headers(init?.headers).get('Authorization') === 'Bearer old' ? expired() : ok()
    )
    const call = refreshingFetch(base, source)
    const answers = await Promise.all([1, 2, 3].map(() => call('https://hs/x', auth('old'))))
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('uses a token another request already bought, rather than buying another', async () => {
    const { source, refresh } = tokens('already-new')
    const base = vi.fn<typeof fetch>().mockResolvedValueOnce(expired()).mockResolvedValueOnce(ok())
    await refreshingFetch(base, source)('https://hs/x', auth('stale'))
    expect(refresh).not.toHaveBeenCalled()
    expect(new Headers(base.mock.calls[1]![1]!.headers).get('Authorization')).toBe(
      'Bearer already-new'
    )
  })

  it('hands back the refusal when the refresh token is refused, so the session ends', async () => {
    const source = {
      current: () => 'old',
      refresh: vi.fn(async () => Promise.reject(new RefreshRefused())),
    }
    const base = vi.fn<typeof fetch>().mockResolvedValue(expired())
    const response = await refreshingFetch(base, source)('https://hs/x', auth('old'))
    expect(response.status).toBe(401)
    expect(base).toHaveBeenCalledTimes(1)
  })

  it('fails the request as a network error when the homeserver could not be asked', async () => {
    const offline = new TypeError('fetch failed')
    const source = { current: () => 'old', refresh: vi.fn(async () => Promise.reject(offline)) }
    const base = vi.fn<typeof fetch>().mockResolvedValue(expired())
    await expect(refreshingFetch(base, source)('https://hs/x', auth('old'))).rejects.toBe(offline)
  })

  it('retries a Request with its body, and reads its token from the Request itself', async () => {
    const { source, refresh } = tokens()
    const bodies: string[] = []
    const base = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init)
      bodies.push(await request.text())
      return request.headers.get('Authorization') === 'Bearer old' ? expired() : ok()
    })
    const request = new Request('https://hs/_matrix/client/v3/rooms/r/send', {
      method: 'PUT',
      headers: { Authorization: 'Bearer old', 'Content-Type': 'application/json' },
      body: '{"body":"bonjour"}',
    })
    const response = await refreshingFetch(base, source)(request)
    expect(response.status).toBe(200)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(bodies).toEqual(['{"body":"bonjour"}', '{"body":"bonjour"}'])
  })

  it('leaves every other answer alone: another 401, a 403, a request without a token', async () => {
    const { source, refresh } = tokens()
    const forbidden = new Response(JSON.stringify({ errcode: 'M_FORBIDDEN' }), { status: 403 })
    const otherUnauthorised = new Response(JSON.stringify({ errcode: 'M_MISSING_TOKEN' }), {
      status: 401,
    })
    const base = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(forbidden)
      .mockResolvedValueOnce(otherUnauthorised)
      .mockResolvedValueOnce(expired())
    const call = refreshingFetch(base, source)
    expect((await call('https://hs/x', auth('old'))).status).toBe(403)
    expect((await call('https://hs/x', auth('old'))).status).toBe(401)
    expect((await call('https://hs/x')).status).toBe(401)
    expect(refresh).not.toHaveBeenCalled()
  })
})
