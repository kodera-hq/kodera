import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  channelRoomAlias,
  HomeserverUnresolved,
  isMatrixDomain,
  isUnderMatrixDomain,
  isWithinServerName,
  resolveHomeserver,
  serverNameFor,
  serverNameOf,
  sessionBelongsTo,
} from './homeserver'
import type { HomeserverProblem, ResolveOptions } from './homeserver'

const DOMAIN = 'kodera.test'
const SLUG = 'acme-sa'
const SERVER = `${SLUG}.${DOMAIN}`
const WELL_KNOWN = `https://${SERVER}/.well-known/matrix/client`

function json(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function serving(answer: Response | Error) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    if (answer instanceof Error) throw answer
    return answer
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

async function problemOf(promise: Promise<unknown>): Promise<HomeserverProblem> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(HomeserverUnresolved)
    return (error as HomeserverUnresolved).problem
  }
  throw new Error('Expected a refusal')
}

const resolve = (answer: Response | Error, options: Partial<ResolveOptions> = {}) => {
  const { fetchImpl, calls } = serving(answer)
  return {
    result: resolveHomeserver(SLUG, { matrixDomain: DOMAIN, fetch: fetchImpl, ...options }),
    calls,
    fetchImpl,
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the matrix domain', () => {
  it('is a lowercase DNS name of two labels at least', () => {
    for (const accepted of ['kodera.io', 'staging.kodera.io', 'xn--kdera-xxa.io', 'a-b.c9.io']) {
      expect(isMatrixDomain(accepted), accepted).toBe(true)
    }
    for (const refused of [
      '',
      'kodera',
      'https://kodera.io',
      'kodera.io:443',
      '*.kodera.io',
      'kodera.io.',
      '.kodera.io',
      'kodera..io',
      'Kodera.io',
      '-kodera.io',
      'kodera-.io',
      'kod_era.io',
      'kodera.io/x',
      'kodera.io ',
      '127.0.0.1',
      `${'a'.repeat(64)}.io`,
      `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`,
    ]) {
      expect(isMatrixDomain(refused), refused).toBe(false)
    }
  })

  it('has under it its subdomains, at any depth, and nothing else', () => {
    expect(isUnderMatrixDomain('acme-sa.kodera.io', 'kodera.io')).toBe(true)
    expect(isUnderMatrixDomain('matrix.acme-sa.kodera.io', 'kodera.io')).toBe(true)
    expect(isUnderMatrixDomain('kodera.io', 'kodera.io')).toBe(false)
    expect(isUnderMatrixDomain('evilkodera.io', 'kodera.io')).toBe(false)
    expect(isUnderMatrixDomain('kodera.io.evil.example', 'kodera.io')).toBe(false)
    expect(isUnderMatrixDomain('acme-sa.kodera.io', '*.io')).toBe(false)
  })
})

describe('resolveHomeserver', () => {
  it("asks the server name's well-known, without credentials, and reads its base URL", async () => {
    const { result, calls } = resolve(
      json(200, { 'm.homeserver': { base_url: `https://matrix.${SERVER}/` } })
    )
    await expect(result).resolves.toEqual({
      serverName: SERVER,
      baseUrl: `https://matrix.${SERVER}`,
    })
    expect(calls).toHaveLength(1)
    const [{ url, init }] = calls as [{ url: string; init: RequestInit }]
    expect(url).toBe(WELL_KNOWN)
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('omit')
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    // No header that would turn a simple CORS request into a preflighted one.
    expect(init.headers).toBeUndefined()
  })

  it('accepts the server name itself, or any host under it', async () => {
    for (const [baseUrl, expected] of [
      [`https://${SERVER}`, `https://${SERVER}`],
      [`https://${SERVER}:443/`, `https://${SERVER}`],
      [`https://matrix.${SERVER}`, `https://matrix.${SERVER}`],
      [`https://a.b.${SERVER}`, `https://a.b.${SERVER}`],
    ] as const) {
      const { result } = resolve(json(200, { 'm.homeserver': { base_url: baseUrl } }))
      await expect(result, baseUrl).resolves.toEqual({ serverName: SERVER, baseUrl: expected })
    }
  })

  it('falls back to the server name on a 404, as the spec says', async () => {
    const { result } = resolve(json(404, { errcode: 'M_NOT_FOUND' }))
    await expect(result).resolves.toEqual({ serverName: SERVER, baseUrl: `https://${SERVER}` })
  })

  it.each([
    // A document that names no homeserver is the spec's FAIL_PROMPT, not its IGNORE.
    ['no m.homeserver', json(200, { 'm.identity_server': { base_url: 'https://id.x' } })],
    ['an empty object', json(200, {})],
    ['not JSON', json(200, 'nope')],
    ['an array', json(200, [])],
    ['null', json(200, 'null')],
    ['m.homeserver that is not an object', json(200, { 'm.homeserver': 'https://x' })],
    ['m.homeserver that is null', json(200, { 'm.homeserver': null })],
    ['no base_url', json(200, { 'm.homeserver': {} })],
    ['a base_url that is not a string', json(200, { 'm.homeserver': { base_url: 42 } })],
    ['a base_url that is not a URL', json(200, { 'm.homeserver': { base_url: 'not a url' } })],
    ['plain HTTP', json(200, { 'm.homeserver': { base_url: `http://${SERVER}` } })],
    ['another domain', json(200, { 'm.homeserver': { base_url: 'https://matrix.example' } })],
    ['the bare matrix domain', json(200, { 'm.homeserver': { base_url: `https://${DOMAIN}` } })],
    // Another tenant under the same matrix domain, which the CSP's wildcard would let through.
    [
      "another organisation's server name",
      json(200, { 'm.homeserver': { base_url: `https://other-org.${DOMAIN}` } }),
    ],
    [
      "a host under another organisation's server name",
      json(200, { 'm.homeserver': { base_url: `https://matrix.other-org.${DOMAIN}` } }),
    ],
    [
      'a look-alike of the server name',
      json(200, { 'm.homeserver': { base_url: `https://x${SERVER}` } }),
    ],
    [
      'a look-alike domain',
      json(200, { 'm.homeserver': { base_url: `https://${SLUG}.evil${DOMAIN}` } }),
    ],
    ['a port', json(200, { 'm.homeserver': { base_url: `https://${SERVER}:8448` } })],
    ['a path', json(200, { 'm.homeserver': { base_url: `https://${SERVER}/matrix` } })],
    ['a query', json(200, { 'm.homeserver': { base_url: `https://${SERVER}/?x=1` } })],
    ['a fragment', json(200, { 'm.homeserver': { base_url: `https://${SERVER}/#x` } })],
    ['credentials', json(200, { 'm.homeserver': { base_url: `https://u:p@${SERVER}` } })],
  ])('refuses an answer with %s as malformed', async (_label, answer) => {
    expect(await problemOf(resolve(answer).result)).toBe('malformed')
  })

  it.each([400, 401, 403, 500, 502, 503])('names an HTTP %i unavailable', async (status) => {
    expect(await problemOf(resolve(json(status, {})).result)).toBe('unavailable')
  })

  it('names a request that never got an answer a network problem', async () => {
    expect(await problemOf(resolve(new TypeError('Failed to fetch')).result)).toBe('network')
  })

  it('gives up after its wait, as a network problem', async () => {
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })
    ) as unknown as typeof fetch
    const result = resolveHomeserver(SLUG, {
      matrixDomain: DOMAIN,
      fetch: fetchImpl,
      timeoutMs: 10,
    })
    expect(await problemOf(result)).toBe('network')
  })

  it.each([
    ['a slug that is not one', 'ACME', DOMAIN],
    ['a slug that is a host', 'acme.sa', DOMAIN],
    ['an empty slug', '', DOMAIN],
    ['a matrix domain that is not one', SLUG, '*.kodera.test'],
    ['a matrix domain with a scheme', SLUG, 'https://kodera.test'],
  ])('refuses %s before asking anything', async (_label, slug, matrixDomain) => {
    const { fetchImpl } = serving(json(200, {}))
    const result = resolveHomeserver(slug, { matrixDomain, fetch: fetchImpl })
    expect(await problemOf(result)).toBe('misconfigured')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  describe('with the development override', () => {
    it("uses the local stack's homeserver in place of discovery", async () => {
      const { result, fetchImpl } = resolve(json(500, {}), {
        devHomeserver: 'http://127.0.0.1:8008/',
      })
      // The local stack's own server name, not the organisation's.
      await expect(result).resolves.toEqual({
        serverName: 'kodera.test',
        baseUrl: 'http://127.0.0.1:8008',
      })
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('names the server name the local stack is given, and refuses one that is not a name', async () => {
      const { result } = resolve(json(500, {}), {
        devHomeserver: 'http://127.0.0.1:8008',
        devServerName: 'stack.localhost',
      })
      await expect(result).resolves.toMatchObject({ serverName: 'stack.localhost' })
      const refused = resolve(json(500, {}), {
        devHomeserver: 'http://127.0.0.1:8008',
        devServerName: 'kodera.test:8448',
      })
      expect(await problemOf(refused.result)).toBe('misconfigured')
    })

    it.each([
      'https://matrix.example',
      'http://matrix.example',
      'http://127.0.0.1:8008/_matrix',
      'not a url',
    ])('refuses %s, which is not a loopback HTTP origin', async (devHomeserver) => {
      const { result, fetchImpl } = resolve(json(200, {}), { devHomeserver })
      expect(await problemOf(result)).toBe('misconfigured')
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('refuses it in a production build, without asking anything', async () => {
      vi.stubEnv('DEV', false)
      const { result, fetchImpl } = resolve(json(200, {}), {
        devHomeserver: 'http://127.0.0.1:8008',
      })
      expect(await problemOf(result)).toBe('misconfigured')
      expect(fetchImpl).not.toHaveBeenCalled()
    })
  })
})

describe("an organisation's server name", () => {
  it("is the slug under the matrix domain, or the local stack's with the override", () => {
    expect(serverNameFor(SLUG, { matrixDomain: DOMAIN })).toBe(SERVER)
    expect(
      serverNameFor(SLUG, { matrixDomain: 'kodera.io', devHomeserver: 'http://127.0.0.1:8008' })
    ).toBe('kodera.test')
    vi.stubEnv('DEV', false)
    expect(() =>
      serverNameFor(SLUG, { matrixDomain: 'kodera.io', devHomeserver: 'http://127.0.0.1:8008' })
    ).toThrow(HomeserverUnresolved)
  })

  it("takes a tenant's slug by the tenant rule, 3 to 32 characters", () => {
    const longest = `a${'b'.repeat(30)}c`
    expect(serverNameFor('acm', { matrixDomain: DOMAIN })).toBe(`acm.${DOMAIN}`)
    expect(serverNameFor('acme', { matrixDomain: DOMAIN })).toBe(`acme.${DOMAIN}`)
    expect(serverNameFor(longest, { matrixDomain: DOMAIN })).toBe(`${longest}.${DOMAIN}`)
    expect(() => serverNameFor('ac', { matrixDomain: DOMAIN })).toThrow(HomeserverUnresolved)
    expect(() => serverNameFor(`${longest}d`, { matrixDomain: DOMAIN })).toThrow(
      HomeserverUnresolved
    )
    expect(() => serverNameFor('-acme', { matrixDomain: DOMAIN })).toThrow(HomeserverUnresolved)
  })

  it('has on it the name itself and the hosts under it, and nothing else', () => {
    expect(isWithinServerName(SERVER, SERVER)).toBe(true)
    expect(isWithinServerName(`matrix.${SERVER}`, SERVER)).toBe(true)
    expect(isWithinServerName(`other-org.${DOMAIN}`, SERVER)).toBe(false)
    expect(isWithinServerName(`x${SERVER}`, SERVER)).toBe(false)
    expect(isWithinServerName(DOMAIN, SERVER)).toBe(false)
    expect(isWithinServerName(SERVER, '')).toBe(false)
    expect(isWithinServerName('.x', '')).toBe(false)
  })

  it("is what follows a Matrix ID's first colon", () => {
    expect(serverNameOf(`@sub-1:${SERVER}`)).toBe(SERVER)
    expect(serverNameOf('@sub-1:kodera.test:8448')).toBe('kodera.test:8448')
    expect(serverNameOf(`sub-1:${SERVER}`)).toBeUndefined()
    expect(serverNameOf(`@:${SERVER}`)).toBeUndefined()
    expect(serverNameOf('@sub-1')).toBeUndefined()
  })
})

describe('a Matrix session', () => {
  const options = { matrixDomain: DOMAIN }

  it("belongs to the organisation whose server name its user ID carries, and no other's", () => {
    const session = { userId: `@sub-1:${SERVER}` }
    expect(sessionBelongsTo(session, SLUG, options)).toBe(true)
    expect(sessionBelongsTo(session, 'other-org', options)).toBe(false)
    // A host under the server name is a homeserver's, never a user's server name.
    expect(sessionBelongsTo({ userId: `@sub-1:matrix.${SERVER}` }, SLUG, options)).toBe(false)
    expect(sessionBelongsTo({ userId: `@sub-1:x${SERVER}` }, SLUG, options)).toBe(false)
    expect(sessionBelongsTo({ userId: `@sub-1:${SERVER}:8448` }, SLUG, options)).toBe(false)
  })

  it('belongs to nobody where the server name cannot be known', () => {
    const session = { userId: `@sub-1:${SERVER}` }
    expect(sessionBelongsTo(session, SLUG, { matrixDomain: '' })).toBe(false)
    expect(sessionBelongsTo(session, 'ACME', options)).toBe(false)
    expect(sessionBelongsTo({ userId: 'not-an-id' }, SLUG, options)).toBe(false)
  })

  it("belongs, with the development override, to the local stack's server name", () => {
    const dev = { ...options, devHomeserver: 'http://127.0.0.1:8008' }
    expect(sessionBelongsTo({ userId: '@sub-1:kodera.test' }, SLUG, dev)).toBe(true)
    expect(sessionBelongsTo({ userId: `@sub-1:${SERVER}` }, SLUG, dev)).toBe(false)
    expect(
      sessionBelongsTo({ userId: '@sub-1:stack.localhost' }, SLUG, {
        ...dev,
        devServerName: 'stack.localhost',
      })
    ).toBe(true)
    vi.stubEnv('DEV', false)
    expect(sessionBelongsTo({ userId: '@sub-1:kodera.test' }, SLUG, dev)).toBe(false)
  })
})

describe("a channel's room alias", () => {
  const CHANNEL = '0b4e7c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b'

  it('is `#kodera-ch-{channel id}:{server name}`, the channel id as Core writes it', () => {
    expect(channelRoomAlias(CHANNEL, SERVER)).toBe(`#kodera-ch-${CHANNEL}:${SERVER}`)
    expect(channelRoomAlias(CHANNEL, 'kodera.test:8448')).toBe(
      `#kodera-ch-${CHANNEL}:kodera.test:8448`
    )
  })

  it.each([
    ['an upper-case id', CHANNEL.toUpperCase()],
    ['an id without dashes', CHANNEL.replaceAll('-', '')],
    ['an id with one more character', `${CHANNEL}x`],
    ['an id inside a longer string', `ch-${CHANNEL}`],
    ['a slug', 'general'],
    ['nothing', ''],
  ])('is refused for %s: no room may be looked up under it', (_case, channelId) => {
    expect(channelRoomAlias(channelId, SERVER)).toBeUndefined()
  })

  it.each([
    ['no server name', ''],
    ['a server name with a path', `${SERVER}/evil`],
    ['a server name carrying an alias', `${SERVER}:x#y`],
  ])('is refused with %s', (_case, serverName) => {
    expect(channelRoomAlias(CHANNEL, serverName)).toBeUndefined()
  })
})
