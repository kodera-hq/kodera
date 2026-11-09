import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RefreshRefused } from '@/auth/matrix'
import { NotRenewable } from '../matrix/refresh'
import { fetchRoomGrant, requestRoomToken, RoomAccessFailed } from './roomAccess'

const HS = 'https://matrix.acme-sa.kodera.test'
const ROOM = '!standup:matrix.acme-sa.kodera.test'
const SERVER = 'acme-sa.kodera.test'
const GRANT = { url: 'wss://rtc.acme-sa.kodera.test', token: 'lk.jwt', listen_only: false }

function answer(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

function serving(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    const next = responses.shift()
    if (next === undefined) throw new Error('No more fixture responses')
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

async function problemOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(RoomAccessFailed)
    return (error as RoomAccessFailed).problem
  }
  throw new Error('Expected a refusal')
}

beforeEach(() => {
  vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('requestRoomToken', () => {
  it("posts the room id with the member's Matrix token to the homeserver's own origin", async () => {
    const { fetchImpl, calls } = serving(answer(200, GRANT))
    await expect(requestRoomToken(HS, 'syt_member', ROOM, SERVER, fetchImpl)).resolves.toEqual({
      url: GRANT.url,
      token: GRANT.token,
      listenOnly: false,
    })
    expect(calls).toHaveLength(1)
    const [{ url, init }] = calls as [{ url: string; init: RequestInit }]
    expect(url).toBe(`${HS}/_kodera/rooms/token`)
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer syt_member')
    expect(headers.get('Content-Type')).toBe('application/json')
    // A string body: fetch sends it with a Content-Length, never chunked.
    expect(typeof init.body).toBe('string')
    expect(JSON.parse(init.body as string)).toEqual({ room_id: ROOM })
    expect(init.credentials).toBe('omit')
    expect(init.cache).toBe('no-store')
  })

  it('reads a listen-only grant', async () => {
    const { fetchImpl } = serving(answer(200, { ...GRANT, listen_only: true }))
    await expect(requestRoomToken(HS, 't', ROOM, SERVER, fetchImpl)).resolves.toMatchObject({
      listenOnly: true,
    })
  })

  it.each([
    [400, { error: 'malformed' }, 'malformed'],
    [401, { error: 'unauthenticated' }, 'unauthenticated'],
    [403, { error: 'forbidden' }, 'forbidden'],
    [503, { error: 'unavailable' }, 'unavailable'],
    [500, 'Internal Server Error', 'unavailable'],
    [502, '<html>Bad gateway</html>', 'unavailable'],
    [404, 'Not found', 'unavailable'],
  ])('names the problem of a %i answer', async (status, body, problem) => {
    const { fetchImpl } = serving(answer(status, body))
    expect(await problemOf(requestRoomToken(HS, 't', ROOM, SERVER, fetchImpl))).toBe(problem)
  })

  it('names a request that never got an answer a network problem', async () => {
    const { fetchImpl } = serving(new TypeError('Failed to fetch'))
    expect(await problemOf(requestRoomToken(HS, 't', ROOM, SERVER, fetchImpl))).toBe('network')
  })

  it.each([
    ['not JSON', 'nope'],
    ['an array', []],
    ['no url', { token: 't', listen_only: false }],
    ['no token', { url: GRANT.url, listen_only: false }],
    ['an empty token', { ...GRANT, token: '' }],
    ['no listen_only', { url: GRANT.url, token: 't' }],
    ['a listen_only that is not a boolean', { ...GRANT, listen_only: 'false' }],
    ['an https url', { ...GRANT, url: 'https://rtc.acme-sa.kodera.test' }],
    ['a plain ws url to another machine', { ...GRANT, url: 'ws://rtc.acme-sa.kodera.test' }],
    ['credentials in the url', { ...GRANT, url: 'wss://user:pw@rtc.acme-sa.kodera.test' }],
    ['a url that is not one', { ...GRANT, url: 'wss://' }],
    ['a server outside the matrix domain', { ...GRANT, url: 'wss://rtc.elsewhere.example' }],
    ['the matrix domain itself', { ...GRANT, url: 'wss://kodera.test' }],
    ['a look-alike of the matrix domain', { ...GRANT, url: 'wss://rtc.evilkodera.test' }],
    // Another tenant under the same matrix domain: the CSP lets it through, this check does not.
    ["another organisation's server", { ...GRANT, url: 'wss://rtc.other-org.kodera.test' }],
    ["another organisation's server name", { ...GRANT, url: 'wss://other-org.kodera.test' }],
    ['a look-alike of the server name', { ...GRANT, url: 'wss://xacme-sa.kodera.test' }],
    ['a port the CSP does not name', { ...GRANT, url: 'wss://rtc.acme-sa.kodera.test:7443' }],
    ['a path the CSP does not name', { ...GRANT, url: 'wss://rtc.acme-sa.kodera.test/livekit' }],
    ['a wss url to this machine', { ...GRANT, url: 'wss://127.0.0.1:7880' }],
  ])('refuses a grant with %s', async (_label, body) => {
    const { fetchImpl } = serving(answer(200, body))
    expect(await problemOf(requestRoomToken(HS, 't', ROOM, SERVER, fetchImpl))).toBe('malformed')
  })

  it('accepts the server name or a server under it, at any depth, with a trailing slash', async () => {
    for (const url of [
      'wss://acme-sa.kodera.test',
      'wss://rtc.acme-sa.kodera.test/',
      'wss://a.b.acme-sa.kodera.test',
    ]) {
      const { fetchImpl } = serving(answer(200, { ...GRANT, url }))
      await expect(requestRoomToken(HS, 't', ROOM, SERVER, fetchImpl)).resolves.toMatchObject({
        url,
      })
    }
  })

  it('refuses every wss server when the deployment names no matrix domain', async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', '')
    const { fetchImpl } = serving(answer(200, GRANT))
    expect(await problemOf(requestRoomToken(HS, 't', ROOM, SERVER, fetchImpl))).toBe('malformed')
  })

  it('accepts plain ws only to this machine, in development, as for an http homeserver', async () => {
    for (const host of ['127.0.0.1:7880', 'localhost:7880', '[::1]:7880']) {
      const { fetchImpl } = serving(answer(200, { ...GRANT, url: `ws://${host}` }))
      await expect(requestRoomToken(HS, 't', ROOM, SERVER, fetchImpl)).resolves.toMatchObject({
        url: `ws://${host}`,
      })
    }
    vi.stubEnv('DEV', false)
    const { fetchImpl } = serving(answer(200, { ...GRANT, url: 'ws://127.0.0.1:7880' }))
    expect(await problemOf(requestRoomToken(HS, 't', ROOM, SERVER, fetchImpl))).toBe('malformed')
  })

  it('refuses a homeserver that is not an https origin before calling anything', async () => {
    const { fetchImpl } = serving(answer(200, GRANT))
    await expect(
      requestRoomToken('http://matrix.acme-sa.kodera.test', 't', ROOM, SERVER, fetchImpl)
    ).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('fetchRoomGrant', () => {
  function tokens(current: string, renewed: Promise<string>) {
    let now = current
    return {
      current: () => now,
      renew: vi.fn(async (stale: string) => {
        expect(stale).toBe(current)
        now = await renewed
        return now
      }),
    }
  }

  it('asks once with the token in use when it is accepted', async () => {
    const { fetchImpl } = serving(answer(200, GRANT))
    const source = tokens('old', Promise.resolve('new'))
    await expect(fetchRoomGrant(HS, source, ROOM, SERVER, fetchImpl)).resolves.toMatchObject({
      token: GRANT.token,
    })
    expect(source.renew).not.toHaveBeenCalled()
  })

  it('refreshes the Matrix session once after a 401, and asks again with the new token', async () => {
    const { fetchImpl, calls } = serving(
      answer(401, { error: 'unauthenticated' }),
      answer(200, GRANT)
    )
    const source = tokens('old', Promise.resolve('new'))
    await expect(fetchRoomGrant(HS, source, ROOM, SERVER, fetchImpl)).resolves.toMatchObject({
      token: GRANT.token,
    })
    expect(source.renew).toHaveBeenCalledTimes(1)
    expect(calls.map((call) => new Headers(call.init.headers).get('Authorization'))).toEqual([
      'Bearer old',
      'Bearer new',
    ])
  })

  it('gives up after one retry: a second 401 is the answer', async () => {
    const { fetchImpl } = serving(
      answer(401, { error: 'unauthenticated' }),
      answer(401, { error: 'unauthenticated' })
    )
    const source = tokens('old', Promise.resolve('new'))
    expect(await problemOf(fetchRoomGrant(HS, source, ROOM, SERVER, fetchImpl))).toBe(
      'unauthenticated'
    )
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(source.renew).toHaveBeenCalledTimes(1)
  })

  it('is unauthenticated when the homeserver refuses the refresh: the session is over', async () => {
    const { fetchImpl } = serving(answer(401, { error: 'unauthenticated' }))
    const source = tokens('old', Promise.reject(new RefreshRefused()))
    expect(await problemOf(fetchRoomGrant(HS, source, ROOM, SERVER, fetchImpl))).toBe(
      'unauthenticated'
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('is unavailable, not an expired session, when the session has no refresh token', async () => {
    const { fetchImpl } = serving(answer(401, { error: 'unauthenticated' }))
    const source = tokens('old', Promise.reject(new NotRenewable()))
    expect(await problemOf(fetchRoomGrant(HS, source, ROOM, SERVER, fetchImpl))).toBe('unavailable')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('is a network problem when the refresh could not reach the homeserver', async () => {
    const { fetchImpl } = serving(answer(401, { error: 'unauthenticated' }))
    const source = tokens('old', Promise.reject(new TypeError('Failed to fetch')))
    expect(await problemOf(fetchRoomGrant(HS, source, ROOM, SERVER, fetchImpl))).toBe('network')
  })

  it('never refreshes for any other refusal', async () => {
    const { fetchImpl } = serving(answer(403, { error: 'forbidden' }))
    const source = tokens('old', Promise.resolve('new'))
    expect(await problemOf(fetchRoomGrant(HS, source, ROOM, SERVER, fetchImpl))).toBe('forbidden')
    expect(source.renew).not.toHaveBeenCalled()
  })
})
