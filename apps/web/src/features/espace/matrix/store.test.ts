import { Room } from 'matrix-js-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backoff, createEspaceStore, matrixClientForTests } from './store'
import { NotRenewable } from './refresh'
import type { RawEvent } from './timeline'

const HS = 'https://matrix.acme-sa.kodera.test'

const expired = () =>
  new Response(JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN', soft_logout: true }), { status: 401 })
const me = () =>
  new Response(JSON.stringify({ user_id: '@me:acme-sa.kodera.test', device_id: 'DEV1' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

function bearerOf(input: RequestInfo | URL, init?: RequestInit): string | null {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined)
  )
  return headers.get('Authorization')
}

/** A store whose refresh the test answers when it wants, and a homeserver that knows one token. */
function setup() {
  let answer: (tokens: { accessToken: string; refreshToken?: string }) => void = () => undefined
  const refresh = vi.fn(
    (_refreshToken: string) =>
      new Promise<{ accessToken: string; refreshToken?: string }>((resolve) => (answer = resolve))
  )
  const base = vi.fn<typeof fetch>(async (input, init) =>
    bearerOf(input, init) === 'Bearer new' ? me() : expired()
  )
  const store = createEspaceStore(
    {
      baseUrl: HS,
      userId: '@me:acme-sa.kodera.test',
      deviceId: 'DEV1',
      accessToken: 'old',
      refreshToken: 'refresh-1',
      refresh,
    },
    base
  )
  return {
    store,
    refresh,
    base,
    answer: (tokens: { accessToken: string; refreshToken?: string }) => answer(tokens),
  }
}

describe("the store's one refresh, shared with the room-access call", () => {
  it('buys one token when the SDK is refused while the room-access call is already renewing', async () => {
    const { store, refresh, base, answer } = setup()
    const renewing = store.renewAccessToken('old')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenLastCalledWith('refresh-1')

    // The SDK's own request, refused with the same token while that refresh is on its way.
    const whoami = matrixClientForTests(store).whoami()
    await vi.waitFor(() => expect(base).toHaveBeenCalledTimes(1))
    answer({ accessToken: 'new', refreshToken: 'refresh-2' })

    await expect(renewing).resolves.toBe('new')
    await expect(whoami).resolves.toMatchObject({ user_id: '@me:acme-sa.kodera.test' })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(base.mock.calls.map(([input, init]) => bearerOf(input, init))).toEqual([
      'Bearer old',
      'Bearer new',
    ])
    expect(store.accessToken()).toBe('new')
  })

  it('buys nothing for a token already replaced: the one bought since is the answer', async () => {
    const { store, refresh, answer } = setup()
    const first = store.renewAccessToken('old')
    answer({ accessToken: 'new', refreshToken: 'refresh-2' })
    await expect(first).resolves.toBe('new')
    expect(refresh).toHaveBeenCalledTimes(1)

    await expect(store.renewAccessToken('old')).resolves.toBe('new')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('buys the next one with the rotated refresh token', async () => {
    const { store, refresh, answer } = setup()
    const first = store.renewAccessToken('old')
    answer({ accessToken: 'new', refreshToken: 'refresh-2' })
    await first
    void store.renewAccessToken('new')
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenLastCalledWith('refresh-2')
  })

  it('spends nothing of the session once stopped', async () => {
    const { store, refresh } = setup()
    store.stop()
    const renewing = store.renewAccessToken('old')
    expect(refresh).not.toHaveBeenCalled()
    await expect(renewing).rejects.toBeInstanceOf(NotRenewable)
  })

  it('says a session without a refresh token is not renewable', async () => {
    const store = createEspaceStore(
      { baseUrl: HS, userId: '@me:acme-sa.kodera.test', deviceId: 'DEV1', accessToken: 'old' },
      vi.fn<typeof fetch>()
    )
    await expect(store.renewAccessToken('old')).rejects.toBeInstanceOf(NotRenewable)
  })
})

describe("a channel's room, found by its alias in the room directory", () => {
  const SERVER = 'acme-sa.kodera.test'
  const GENERAL = '0b4e7c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b'
  const LOUNGE = '7d8e9f0a-1b2c-4d3e-9f4a-5b6c7d8e9f0a'
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  const notFound = () => json(404, { errcode: 'M_NOT_FOUND', error: 'Room alias not found' })

  /** A homeserver whose directory holds `rooms`, by alias exactly as written, and nothing else. */
  function directory(rooms: Record<string, string | (() => Response | Promise<Response>)>) {
    const asked: string[] = []
    const base = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      const prefix = '/_matrix/client/v3/directory/room/'
      if (!url.pathname.startsWith(prefix)) throw new Error(`unexpected request: ${url.pathname}`)
      const alias = decodeURIComponent(url.pathname.slice(prefix.length))
      asked.push(alias)
      const room = rooms[alias]
      if (room === undefined) return notFound()
      if (typeof room === 'function') return room()
      return json(200, { room_id: room, servers: [SERVER] })
    })
    const store = createEspaceStore(
      { baseUrl: HS, userId: `@me:${SERVER}`, deviceId: 'DEV1', accessToken: 'tok' },
      base
    )
    return { store, base, asked }
  }

  it('resolves the exact alias `#kodera-ch-{channel id}:{server name}` to its room', async () => {
    const { store, asked } = directory({
      [`#kodera-ch-${GENERAL}:${SERVER}`]: '!general:acme-sa.kodera.test',
      [`#kodera-ch-${LOUNGE}:${SERVER}`]: '!lounge:acme-sa.kodera.test',
    })
    const seen = vi.fn()
    store.subscribe(seen)
    await store.resolveChannels([GENERAL, LOUNGE])
    expect(asked.sort()).toEqual(
      [`#kodera-ch-${GENERAL}:${SERVER}`, `#kodera-ch-${LOUNGE}:${SERVER}`].sort()
    )
    expect(store.getSnapshot().channels).toEqual(
      new Map([
        [GENERAL, { state: 'resolved', roomId: '!general:acme-sa.kodera.test' }],
        [LOUNGE, { state: 'resolved', roomId: '!lounge:acme-sa.kodera.test' }],
      ])
    )
    expect(seen).toHaveBeenCalled()
    store.stop()
  })

  it('finds nothing under a look-alike: a suffix, another server, upper case, a longer alias', async () => {
    const { store, asked } = directory({
      [`#kodera-ch-${GENERAL}x:${SERVER}`]: '!suffix:acme-sa.kodera.test',
      [`#kodera-ch-${GENERAL}:other.kodera.test`]: '!elsewhere:other.kodera.test',
      [`#KODERA-CH-${GENERAL.toUpperCase()}:${SERVER}`]: '!upper:acme-sa.kodera.test',
      [`#channel-kodera-ch-${GENERAL}:${SERVER}`]: '!longer:acme-sa.kodera.test',
    })
    await store.resolveChannels([GENERAL])
    // Asked under the one alias the contract names, which the directory does not hold.
    expect(asked).toEqual([`#kodera-ch-${GENERAL}:${SERVER}`])
    expect(store.getSnapshot().channels.get(GENERAL)).toEqual({ state: 'pending' })
    store.stop()
  })

  it('never asks for a channel id that is not a lower-case UUID, and says so once per id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { store, base } = directory({})
    await store.resolveChannels([GENERAL.toUpperCase(), `${GENERAL}x`, 'general'])
    await store.resolveChannels([GENERAL.toUpperCase(), `${GENERAL}x`, 'general'])
    expect(base).not.toHaveBeenCalled()
    expect(store.getSnapshot().channels.size).toBe(0)
    expect(warn).toHaveBeenCalledTimes(3)
    expect(warn.mock.calls.map(([text]) => String(text))).toEqual([
      expect.stringContaining(`"${GENERAL.toUpperCase()}" is not a lower-case UUID`),
      expect.stringContaining(`"${GENERAL}x" is not a lower-case UUID`),
      expect.stringContaining('"general" is not a lower-case UUID'),
    ])
    store.stop()
  })

  it('says once per channel that a session without a server name cannot look rooms up', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const base = vi.fn<typeof fetch>()
    const store = createEspaceStore(
      { baseUrl: HS, userId: '@me', deviceId: 'DEV1', accessToken: 'secret-token' },
      base
    )
    await store.resolveChannels([GENERAL, LOUNGE])
    await store.resolveChannels([GENERAL, LOUNGE])
    expect(base).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(2)
    for (const [text] of warn.mock.calls) {
      expect(String(text)).toContain('no usable server name')
      expect(String(text)).not.toContain('secret-token')
    }
    store.stop()
  })

  it('takes a 404 for a missing room only when the directory says M_NOT_FOUND', async () => {
    const { store } = directory({
      [`#kodera-ch-${GENERAL}:${SERVER}`]: () =>
        json(404, { errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' }),
      [`#kodera-ch-${LOUNGE}:${SERVER}`]: () =>
        new Response('<html>Not Found</html>', { status: 404 }),
    })
    await store.resolveChannels([GENERAL, LOUNGE])
    expect(store.getSnapshot().channels.size).toBe(0)
    store.stop()
  })

  it('says a 404 is a room that does not exist yet, and asks again only once it has aged', async () => {
    const { store, base } = directory({})
    await store.resolveChannels([GENERAL])
    expect(store.getSnapshot().channels.get(GENERAL)).toEqual({ state: 'pending' })
    await store.resolveChannels([GENERAL])
    expect(base).toHaveBeenCalledTimes(1)

    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 16_000)
    try {
      await store.resolveChannels([GENERAL])
      expect(base).toHaveBeenCalledTimes(2)
    } finally {
      clock.mockRestore()
      store.stop()
    }
  })

  it('keeps a room found, and keeps no failure: the next ask goes to the homeserver', async () => {
    let answers: (() => Response | Promise<Response>)[] = [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => json(502, { errcode: 'M_UNKNOWN', error: 'Bad gateway' }),
      () => json(200, { room_id: '!general:acme-sa.kodera.test', servers: [SERVER] }),
    ]
    const { store, base } = directory({
      [`#kodera-ch-${GENERAL}:${SERVER}`]: () => answers.shift()!(),
    })
    await store.resolveChannels([GENERAL])
    expect(store.getSnapshot().channels.has(GENERAL)).toBe(false)
    await store.resolveChannels([GENERAL])
    expect(store.getSnapshot().channels.has(GENERAL)).toBe(false)
    expect(base).toHaveBeenCalledTimes(2)

    await store.resolveChannels([GENERAL])
    expect(store.getSnapshot().channels.get(GENERAL)).toEqual({
      state: 'resolved',
      roomId: '!general:acme-sa.kodera.test',
    })
    answers = []
    await store.resolveChannels([GENERAL])
    expect(base).toHaveBeenCalledTimes(3)
    store.stop()
  })

  it('asks once for two asks at the same time', async () => {
    const { store, base } = directory({
      [`#kodera-ch-${GENERAL}:${SERVER}`]: '!general:acme-sa.kodera.test',
    })
    await Promise.all([store.resolveChannels([GENERAL]), store.resolveChannels([GENERAL])])
    expect(base).toHaveBeenCalledTimes(1)
    store.stop()
  })

  it('takes no answer that is not a room id', async () => {
    const { store } = directory({ [`#kodera-ch-${GENERAL}:${SERVER}`]: 'general' })
    await store.resolveChannels([GENERAL])
    expect(store.getSnapshot().channels.has(GENERAL)).toBe(false)
    store.stop()
  })
})

describe("a channel's room, asked again on time", () => {
  const SERVER = 'acme-sa.kodera.test'
  const GENERAL = '0b4e7c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b'
  const ALIAS = `#kodera-ch-${GENERAL}:${SERVER}`
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  const notFound = () => json(404, { errcode: 'M_NOT_FOUND', error: 'Room alias not found' })
  const found = (roomId: string) => json(200, { room_id: roomId, servers: [SERVER] })

  beforeEach(() => {
    // The jitter at its top: each wait is the whole of what `backoff` allows.
    vi.spyOn(Math, 'random').mockReturnValue(1)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** A directory that gives `answers` in turn for the channel's alias, then 404s. */
  function directory(...answers: (() => Response | Promise<Response>)[]) {
    const base = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      if (decodeURIComponent(url.pathname) !== `/_matrix/client/v3/directory/room/${ALIAS}`) {
        throw new Error(`unexpected request: ${url.pathname}`)
      }
      return (answers.shift() ?? notFound)()
    })
    const store = createEspaceStore(
      { baseUrl: HS, userId: `@me:${SERVER}`, deviceId: 'DEV1', accessToken: 'tok' },
      base
    )
    return { store, base }
  }

  it('asks again 15 s after a 404, and finds the room once it exists', async () => {
    vi.useFakeTimers()
    const { store, base } = directory(notFound, () => found('!general:acme-sa.kodera.test'))
    await store.resolveChannels([GENERAL])
    expect(store.getSnapshot().channels.get(GENERAL)).toEqual({ state: 'pending' })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(base).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(base).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().channels.get(GENERAL)).toEqual({
      state: 'resolved',
      roomId: '!general:acme-sa.kodera.test',
    })
    // Found: nothing is planned any more.
    expect(vi.getTimerCount()).toBe(0)
    store.stop()
  })

  it('asks again on time even when the wall clock steps back', async () => {
    vi.useFakeTimers()
    const { store, base } = directory(notFound, notFound)
    await store.resolveChannels([GENERAL])
    vi.setSystemTime(Date.now() - 60_000)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(base).toHaveBeenCalledTimes(2)
    // And the next 404 is planned again.
    expect(vi.getTimerCount()).toBe(1)
    store.stop()
  })

  it('waits twice as long after each failure in a row, up to a minute', async () => {
    vi.useFakeTimers()
    const fail = () => Promise.reject(new TypeError('Failed to fetch'))
    const { store, base } = directory(fail, fail, fail, fail, fail, fail, fail)
    await store.resolveChannels([GENERAL])
    for (const [n, wait] of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000].entries()) {
      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(base).toHaveBeenCalledTimes(n + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(base).toHaveBeenCalledTimes(n + 2)
    }
    store.stop()
  })

  it('lets a 404 stand twice as long each time, up to two minutes', async () => {
    vi.useFakeTimers()
    const { store, base } = directory()
    await store.resolveChannels([GENERAL])
    for (const [n, wait] of [15_000, 30_000, 60_000, 120_000, 120_000].entries()) {
      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(base).toHaveBeenCalledTimes(n + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(base).toHaveBeenCalledTimes(n + 2)
    }
    store.stop()
  })

  it('starts the count over when the answer changes kind', async () => {
    vi.useFakeTimers()
    const fail = () => Promise.reject(new TypeError('Failed to fetch'))
    const { store, base } = directory(fail, fail, fail, notFound)
    await store.resolveChannels([GENERAL])
    await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000)
    expect(base).toHaveBeenCalledTimes(4)
    // The first 404 after three failures stands its first 15 s, not 15 s doubled three times.
    await vi.advanceTimersByTimeAsync(14_999)
    expect(base).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(base).toHaveBeenCalledTimes(5)
    store.stop()
  })

  it('keeps no count for a channel unwatched while it was being asked', async () => {
    vi.useFakeTimers()
    let refuse: (error: Error) => void = () => undefined
    const fail = () => Promise.reject(new TypeError('Failed to fetch'))
    const { store, base } = directory(
      fail,
      () => new Promise<Response>((_, reject) => (refuse = reject)),
      fail
    )
    await store.resolveChannels([GENERAL])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(base).toHaveBeenCalledTimes(2)
    await store.resolveChannels([])
    refuse(new TypeError('Failed to fetch'))
    await vi.advanceTimersByTimeAsync(0)
    await store.resolveChannels([GENERAL])
    expect(base).toHaveBeenCalledTimes(3)
    // Its first wait again, not the third.
    await vi.advanceTimersByTimeAsync(4_999)
    expect(base).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(base).toHaveBeenCalledTimes(4)
    store.stop()
  })

  it('starts the wait over for a channel watched again', async () => {
    vi.useFakeTimers()
    const fail = () => Promise.reject(new TypeError('Failed to fetch'))
    const { store, base } = directory(fail, fail, fail)
    await store.resolveChannels([GENERAL])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(base).toHaveBeenCalledTimes(2)
    await store.resolveChannels([])
    await store.resolveChannels([GENERAL])
    expect(base).toHaveBeenCalledTimes(3)
    // Back to the first wait, not the third.
    await vi.advanceTimersByTimeAsync(4_999)
    expect(base).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(base).toHaveBeenCalledTimes(4)
    store.stop()
  })

  it('asks again 5 s after a failure', async () => {
    vi.useFakeTimers()
    const { store, base } = directory(
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => found('!general:acme-sa.kodera.test')
    )
    await store.resolveChannels([GENERAL])
    expect(store.getSnapshot().channels.has(GENERAL)).toBe(false)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(base).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(base).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().channels.get(GENERAL)?.state).toBe('resolved')
    store.stop()
  })

  it('asks nothing more once stopped', async () => {
    vi.useFakeTimers()
    const { store, base } = directory(notFound)
    await store.resolveChannels([GENERAL])
    expect(vi.getTimerCount()).toBe(1)
    store.stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(base).toHaveBeenCalledTimes(1)
  })

  it('plans the next ask again for a channel watched anew while its 404 still stands', async () => {
    vi.useFakeTimers()
    const { store, base } = directory(notFound, () => found('!general:acme-sa.kodera.test'))
    await store.resolveChannels([GENERAL])
    await store.resolveChannels([])
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    await store.resolveChannels([GENERAL])
    // The 404 still stands: no new ask now, but one planned for when it ages.
    expect(base).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(base).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().channels.get(GENERAL)?.state).toBe('resolved')
    store.stop()
  })
})

describe('a found room that a live sync does not know', () => {
  const SERVER = 'acme-sa.kodera.test'
  const GENERAL = '0b4e7c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b'
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

  it('is asked for once more, and the room now under the alias replaces it', async () => {
    const directoryAnswers = ['!gone:acme-sa.kodera.test', '!new:acme-sa.kodera.test']
    let directoryAsks = 0
    let syncs = 0
    const base = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      const path = decodeURIComponent(url.pathname)
      if (path.startsWith('/_matrix/client/v3/directory/room/')) {
        directoryAsks += 1
        return json(200, { room_id: directoryAnswers.shift(), servers: [SERVER] })
      }
      if (path === '/_matrix/client/versions') return json(200, { versions: ['v1.11'] })
      if (path.endsWith('/pushrules/')) return json(200, { global: {} })
      if (path.includes('/filter')) return json(200, { filter_id: 'f1' })
      if (path.endsWith('/sync')) {
        syncs += 1
        if (syncs === 1) return json(200, { next_batch: 's1', rooms: { join: {} } })
        // The long poll: open until the store stops.
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')))
        )
      }
      return json(404, { errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' })
    })
    const store = createEspaceStore(
      { baseUrl: HS, userId: `@me:${SERVER}`, deviceId: 'DEV1', accessToken: 'tok' },
      base
    )
    await store.resolveChannels([GENERAL])
    expect(store.getSnapshot().channels.get(GENERAL)).toEqual({
      state: 'resolved',
      roomId: '!gone:acme-sa.kodera.test',
    })
    await store.start()
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('live'))
    await vi.waitFor(() =>
      expect(store.getSnapshot().channels.get(GENERAL)).toEqual({
        state: 'resolved',
        roomId: '!new:acme-sa.kodera.test',
      })
    )
    // Once per disappearance: the new room is absent too, and is not asked for again.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(directoryAsks).toBe(2)
    store.stop()
  })
})

describe('backoff', () => {
  it('doubles from the first wait, up to the most', () => {
    const top = () => 1
    expect([1, 2, 3, 4, 5, 6].map((n) => backoff(5_000, 60_000, n, top))).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000,
    ])
    expect(backoff(5_000, 60_000, 0, top)).toBe(5_000)
  })

  it('draws each wait between half of it and all of it', () => {
    expect(backoff(5_000, 60_000, 3, () => 0)).toBe(10_000)
    expect(backoff(5_000, 60_000, 3, () => 0.5)).toBe(15_000)
    expect(backoff(5_000, 60_000, 3, () => 1)).toBe(20_000)
    for (let i = 0; i < 200; i += 1) {
      const wait = backoff(15_000, 120_000, 40)
      expect(wait).toBeGreaterThanOrEqual(60_000)
      expect(wait).toBeLessThanOrEqual(120_000)
    }
  })
})

// Subscription regressions use real SDK rooms/events, with no external server.
type SnapshotEvent = RawEvent & { state_key?: string; redacts?: string }
const SNAPSHOT_ROOM = '!general:matrix.acme.kodera.io'
const SNAPSHOT_CHANNEL = 'a1111111-1111-4111-8111-000000000001'
const SNAPSHOT_ME = '@me:matrix.acme.kodera.io'
const SNAPSHOT_ALICE = '@henri.duflot:matrix.acme.kodera.io'
const SNAPSHOT_BODY = 'Snapshot <b>&</b> {literal} é 👍'
const SNAPSHOT_TIME = Date.UTC(2026, 9, 23, 8, 15)

function snapshotMessage(
  eventId: string,
  body: string,
  patch: Partial<SnapshotEvent> = {}
): SnapshotEvent {
  return {
    event_id: eventId,
    type: 'm.room.message',
    sender: SNAPSHOT_ALICE,
    origin_server_ts: SNAPSHOT_TIME,
    content: { msgtype: 'm.text', body },
    ...patch,
  }
}

function snapshotFixture(
  initialEvents = [snapshotMessage('$root', SNAPSHOT_BODY)],
  /**
   * Display names in the room's member events, extra room state, and the members only the full
   * member list (`/members`) has.
   */
  room: {
    names?: Record<string, string>
    state?: SnapshotEvent[]
    members?: SnapshotEvent[]
    /** The room's account data for the signed-in member, as the first sync carries it. */
    accountData?: { type: string; content: Record<string, unknown> }[]
    /** The sync's room summary (`m.joined_member_count` and the like). */
    summary?: Record<string, unknown>
    /** Who the first sync says is typing (`m.typing`). */
    typing?: string[]
  } = {}
) {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  const unexpected: string[] = []
  const requests: { path: string; body: Record<string, unknown> }[] = []
  const typingNotices: Record<string, unknown>[] = []
  let syncCount = 0
  let holdSend = false
  let sendAnswer: ((response: Response) => void) | undefined
  let pollAnswer: ((response: Response) => void) | undefined
  let batch = 0
  let memberLists = 0
  const member = (user: string, membership: 'join' | 'leave'): SnapshotEvent => ({
    ...snapshotMessage(`$${membership}-${user}`, ''),
    type: 'm.room.member',
    state_key: user,
    sender: user,
    content: {
      membership,
      ...(room.names?.[user] === undefined ? {} : { displayname: room.names[user] }),
    },
  })
  const initialState: SnapshotEvent[] = [
    {
      ...snapshotMessage('$create', ''),
      type: 'm.room.create',
      state_key: '',
      content: { creator: SNAPSHOT_ME, room_version: '10' },
    },
    member(SNAPSHOT_ME, 'join'),
    member(SNAPSHOT_ALICE, 'join'),
    {
      ...snapshotMessage('$name', ''),
      type: 'm.room.name',
      state_key: '',
      content: { name: 'général' },
    },
    ...(room.state ?? []),
  ]
  const roomData = (events: SnapshotEvent[], state: SnapshotEvent[] = []) => ({
    state: { events: state },
    timeline: { events, limited: false, prev_batch: 'previous' },
    account_data: { events: room.accountData ?? [] },
    ...(room.summary === undefined ? {} : { summary: room.summary }),
    ephemeral: {
      events:
        room.typing === undefined ? [] : [{ type: 'm.typing', content: { user_ids: room.typing } }],
    },
    unread_notifications: { notification_count: 0, highlight_count: 0 },
  })
  const response = (rooms: unknown) => json(200, { next_batch: `s${++batch}`, rooms })
  const base = vi.fn<typeof fetch>(async (input, init) => {
    const path = decodeURIComponent(
      new URL(String(input instanceof Request ? input.url : input)).pathname
    )
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    // No `org.matrix.msc4143` in `unstable_features`, as on our Synapse: matrix-js-sdk 45 then
    // never asks for RTC transports, and `cachedRtcTransports` stays unset.
    if (method === 'GET' && path === '/_matrix/client/versions') {
      return json(200, { versions: ['v1.11'] })
    }
    if (method === 'GET' && path === '/_matrix/client/v3/capabilities') {
      return json(200, { capabilities: {} })
    }
    if (method === 'GET' && path === '/_matrix/client/v3/pushrules/') {
      return json(200, { global: {} })
    }
    if (method === 'POST' && path === `/_matrix/client/v3/user/${SNAPSHOT_ME}/filter`) {
      return json(200, { filter_id: 'snapshot-filter' })
    }
    if (
      method === 'GET' &&
      path ===
        `/_matrix/client/v3/directory/room/#kodera-ch-${SNAPSHOT_CHANNEL}:matrix.acme.kodera.io`
    ) {
      return json(200, { room_id: SNAPSHOT_ROOM, servers: ['matrix.acme.kodera.io'] })
    }
    if (method === 'GET' && path === '/_matrix/client/v3/sync') {
      syncCount++
      if (syncCount === 1) {
        return response({ join: { [SNAPSHOT_ROOM]: roomData(initialEvents, initialState) } })
      }
      return new Promise<Response>((resolve, reject) => {
        const answer = (value: Response) => {
          pollAnswer = undefined
          init?.signal?.removeEventListener('abort', abort)
          resolve(value)
        }
        const abort = () => {
          pollAnswer = undefined
          reject(new DOMException('Stopped test sync', 'AbortError'))
        }
        pollAnswer = answer
        init?.signal?.addEventListener('abort', abort, { once: true })
        if (init?.signal?.aborted) abort()
      })
    }
    if (
      method === 'PUT' &&
      path === `/_matrix/client/v3/rooms/${SNAPSHOT_ROOM}/typing/${SNAPSHOT_ME}`
    ) {
      typingNotices.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return json(200, {})
    }
    if (method === 'PUT' && path.startsWith(`/_matrix/client/v3/rooms/${SNAPSHOT_ROOM}/send/`)) {
      requests.push({
        path,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      })
      if (holdSend) {
        holdSend = false
        return new Promise<Response>((resolve) => {
          sendAnswer = (value) => {
            sendAnswer = undefined
            resolve(value)
          }
        })
      }
      return json(200, { event_id: `$accepted-${requests.length}` })
    }
    if (
      method === 'GET' &&
      path === `/_matrix/client/v3/rooms/${SNAPSHOT_ROOM}/members` &&
      room.members !== undefined
    ) {
      memberLists++
      return json(200, {
        chunk: [...initialState.filter((e) => e.type === 'm.room.member'), ...room.members],
      })
    }
    unexpected.push(`${method} ${path}`)
    throw new Error(`Unexpected snapshot fixture request: ${method} ${path}`)
  })
  const store = createEspaceStore(
    {
      baseUrl: 'https://matrix.acme.kodera.io',
      userId: SNAPSHOT_ME,
      deviceId: 'SNAPSHOT-TEST',
      accessToken: 'synthetic-test-token',
    },
    base
  )
  async function settleSync(rooms: unknown) {
    await vi.waitFor(() => expect(pollAnswer).toBeDefined())
    const next = syncCount + 1
    pollAnswer!(response(rooms))
    await vi.waitFor(() => {
      expect(syncCount).toBeGreaterThanOrEqual(next)
      expect(pollAnswer).toBeDefined()
    })
  }
  return {
    store,
    requests,
    typingNotices,
    memberLists: () => memberLists,
    /** The homeserver says who is typing in the room now (`m.typing`, an ephemeral event). */
    typing: (userIds: string[]) =>
      settleSync({
        join: {
          [SNAPSHOT_ROOM]: {
            ephemeral: { events: [{ type: 'm.typing', content: { user_ids: userIds } }] },
          },
        },
      }),
    async start() {
      await store.start()
      await store.resolveChannels([SNAPSHOT_CHANNEL])
      await vi.waitFor(() => {
        expect(matrixClientForTests(store).getCachedCapabilities()).toEqual({})
        expect(matrixClientForTests(store).cachedRtcTransports.get()).toBeUndefined()
        expect(store.getSnapshot().status).toBe('live')
        expect(store.getSnapshot().channels.get(SNAPSHOT_CHANNEL)).toEqual({
          state: 'resolved',
          roomId: SNAPSHOT_ROOM,
        })
        expect(pollAnswer).toBeDefined()
      })
      const room = matrixClientForTests(store).getRoom(SNAPSHOT_ROOM)
      expect(room?.getMyMembership()).toBe('join')
      expect(
        room
          ?.getLiveTimeline()
          .getEvents()
          .map((event) => event.getId())
      ).toEqual(initialEvents.map((event) => event.event_id))
    },
    holdNextSend() {
      holdSend = true
    },
    async finishSend(status = 200, body: unknown = { event_id: '$released' }) {
      await vi.waitFor(() => expect(sendAnswer).toBeDefined())
      sendAnswer!(json(status, body))
    },
    async releaseHeldSend() {
      if (holdSend || sendAnswer !== undefined) {
        await vi.waitFor(() => expect(sendAnswer).toBeDefined())
        sendAnswer!(json(200, { event_id: '$cleanup' }))
      }
    },
    publish: (events: SnapshotEvent[]) =>
      settleSync({ join: { [SNAPSHOT_ROOM]: roomData(events) } }),
    idle: () => settleSync({}),
    leave: () =>
      settleSync({ leave: { [SNAPSHOT_ROOM]: roomData([member(SNAPSHOT_ME, 'leave')]) } }),
    rejoin: () =>
      settleSync({ join: { [SNAPSHOT_ROOM]: roomData([member(SNAPSHOT_ME, 'join')]) } }),
    stop() {
      store.stop()
      expect(sendAnswer).toBeUndefined()
      expect(unexpected).toEqual([])
    },
  }
}

const SNAPSHOT_BOB = '@b0b0c4fe-1111-4111-8111-000000000001:matrix.acme.kodera.io'

function audioState(participants: string[]): SnapshotEvent[] {
  return [
    {
      ...snapshotMessage('$policy', ''),
      type: 'io.kodera.room.policy',
      state_key: '',
      content: { kind: 'audio' },
    },
    {
      ...snapshotMessage('$occupancy', ''),
      type: 'io.kodera.room.occupancy',
      state_key: '',
      content: {
        version: 1,
        participants: participants.map((user_id) => ({ user_id, devices: 1 })),
      },
    },
  ]
}

describe("a channel's members at a glance, for its header (G10)", () => {
  const AGENT = '@kodera-agent:matrix.acme.kodera.io'
  const ROOM_ACCESS = '@room-access:matrix.acme.kodera.io'
  const BOB = '@bob.dupont:matrix.acme.kodera.io'
  const membership = (
    user: string,
    name: string | null,
    state: 'join' | 'leave' = 'join'
  ): SnapshotEvent => ({
    ...snapshotMessage(`$${state}-${user}`, ''),
    type: 'm.room.member',
    state_key: user,
    sender: user,
    content: { membership: state, ...(name === null ? {} : { displayname: name }) },
  })
  const createdByAgent: SnapshotEvent = {
    ...snapshotMessage('$create-agent', ''),
    type: 'm.room.create',
    state_key: '',
    sender: AGENT,
    content: { room_version: '10' },
  }
  const said = (eventId: string, sender: string, msgtype = 'm.text') =>
    snapshotMessage(eventId, 'Bonjour', { sender, content: { msgtype, body: 'Bonjour' } })

  it("counts the homeserver's members, without the tenant agent that created the room", async () => {
    // The agent created the room and stays in it, but its member event is not loaded.
    const fixture = snapshotFixture(undefined, {
      names: { [SNAPSHOT_ALICE]: 'Henri Duflot' },
      state: [createdByAgent],
      summary: { 'm.joined_member_count': 19 },
    })
    try {
      await fixture.start()
      expect(fixture.store.getSnapshot().rooms[0]?.joined).toBe(18)
    } finally {
      fixture.stop()
    }
    // A person who created the room, not loaded either, is counted.
    const byBob = snapshotFixture(undefined, {
      state: [{ ...createdByAgent, sender: BOB }],
      summary: { 'm.joined_member_count': 19 },
    })
    try {
      await byBob.start()
      expect(byBob.store.getSnapshot().rooms[0]?.joined).toBe(19)
    } finally {
      byBob.stop()
    }
  })

  it("takes a loaded service account out once, and the loaded members' count without a summary", async () => {
    const withSummary = snapshotFixture(undefined, {
      state: [createdByAgent, membership(AGENT, 'Kodera'), membership(ROOM_ACCESS, null)],
      summary: { 'm.joined_member_count': 19 },
    })
    try {
      await withSummary.start()
      expect(withSummary.store.getSnapshot().rooms[0]?.joined).toBe(17)
    } finally {
      withSummary.stop()
    }
    // No summary: the member and Alice are the loaded members, and the agent is not among them.
    const without = snapshotFixture(undefined, { state: [createdByAgent] })
    try {
      await without.start()
      expect(without.store.getSnapshot().rooms[0]?.joined).toBe(2)
    } finally {
      without.stop()
    }
  })

  it('shows the latest three people to write, still in the room, never the member or Kodera', async () => {
    const CAROL = '@carol.roux:matrix.acme.kodera.io'
    const DAVE = '@dave.petit:matrix.acme.kodera.io'
    const EVE = '@eve.blanc:matrix.acme.kodera.io'
    const fixture = snapshotFixture(
      [
        said('$1', DAVE),
        said('$2', CAROL),
        said('$3', SNAPSHOT_ALICE),
        said('$4', BOB),
        said('$5', EVE),
        said('$6', SNAPSHOT_ME),
        said('$7', AGENT, 'm.notice'),
        said('$8', BOB),
        // A reaction is not writing.
        {
          event_id: '$9',
          type: 'm.reaction',
          sender: DAVE,
          origin_server_ts: SNAPSHOT_TIME,
          content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$8', key: '👍' } },
        },
      ],
      {
        state: [
          membership(SNAPSHOT_ALICE, 'Henri Duflot'),
          membership(BOB, 'Marie Dupont'),
          membership(CAROL, 'Marie Dupont'),
          membership(DAVE, 'Dave Petit'),
          membership(EVE, 'Eve Blanc', 'leave'),
          membership(AGENT, 'Kodera'),
        ],
      }
    )
    try {
      await fixture.start()
      // Newest first, once each: Bob, then Alice, then Carol. Eve left; Dave is the fourth.
      // Two « Marie Dupont » are drawn by the name alone: a face shows initials, not an id.
      expect(fixture.store.getSnapshot().rooms[0]?.faces).toEqual([
        { userId: BOB, name: 'Marie Dupont' },
        { userId: SNAPSHOT_ALICE, name: 'Henri Duflot' },
        { userId: CAROL, name: 'Marie Dupont' },
      ])
    } finally {
      fixture.stop()
    }
  })

  it('fills the faces with the other joined members, by name, after the latest writers', async () => {
    const CAROL = '@carol.roux:matrix.acme.kodera.io'
    const DAVE = '@dave.petit:matrix.acme.kodera.io'
    const EVE = '@eve.blanc:matrix.acme.kodera.io'
    // Staging's #général: the member is the only one to write, and the others never did.
    const alone = snapshotFixture([said('$1', SNAPSHOT_ME)], {
      state: [
        membership(SNAPSHOT_ALICE, 'Henri Duflot'),
        membership(CAROL, 'Carol Roux'),
        membership(BOB, 'Bob Dupont'),
        // Both would sort first by name: only the filters keep them out of three faces.
        membership(EVE, 'Ada Blanc', 'leave'),
        membership(AGENT, 'Aaron'),
        membership(ROOM_ACCESS, null),
      ],
    })
    try {
      await alone.start()
      // By name; never the member, someone who left or Kodera's accounts.
      expect(alone.store.getSnapshot().rooms[0]?.faces).toEqual([
        { userId: BOB, name: 'Bob Dupont' },
        { userId: CAROL, name: 'Carol Roux' },
        { userId: SNAPSHOT_ALICE, name: 'Henri Duflot' },
      ])
    } finally {
      alone.stop()
    }
    // A writer comes first and is not drawn twice; the rest are filled in by name, up to three.
    const oneWriter = snapshotFixture([said('$1', CAROL), said('$2', SNAPSHOT_ME)], {
      state: [
        membership(DAVE, 'Marie Dupont'),
        membership(SNAPSHOT_ALICE, 'Marie Dupont'),
        membership(CAROL, 'Carol Roux'),
        membership(BOB, 'Bob Dupont'),
      ],
    })
    try {
      await oneWriter.start()
      expect(oneWriter.store.getSnapshot().rooms[0]?.faces).toEqual([
        { userId: CAROL, name: 'Carol Roux' },
        { userId: BOB, name: 'Bob Dupont' },
        // Two « Marie Dupont »: drawn by the name alone, as a writer's face is.
        { userId: DAVE, name: 'Marie Dupont' },
      ])
    } finally {
      oneWriter.stop()
    }
  })

  it('gives no name to a face whose display name is only its id, writer or not', async () => {
    // Staging's #général, once its faces showed: faces of « 9 », « 9 » and « F ». An account the identity
    // provider made has its subject for a localpart, and the homeserver gives it that as a name.
    const SUBJECT = '@9f3c2b1a-0d4e-4c55-9a77-1b2c3d4e5f60:matrix.acme.kodera.io'
    const fixture = snapshotFixture([said('$1', SUBJECT), said('$2', SNAPSHOT_ME)], {
      state: [
        membership(SUBJECT, '9f3c2b1a-0d4e-4c55-9a77-1b2c3d4e5f60'),
        membership(SNAPSHOT_ALICE, 'henri.duflot'),
        membership(BOB, 'Bob Dupont'),
      ],
    })
    try {
      await fixture.start()
      // The writer first, then the others; a real name is kept.
      expect(fixture.store.getSnapshot().rooms[0]?.faces).toEqual([
        { userId: SUBJECT },
        { userId: BOB, name: 'Bob Dupont' },
        { userId: SNAPSHOT_ALICE },
      ])
    } finally {
      fixture.stop()
    }
  })

  it("never offers Kodera's own accounts as someone to mention", async () => {
    const fixture = snapshotFixture(undefined, {
      names: { [SNAPSHOT_ALICE]: 'Henri Duflot' },
      state: [membership(AGENT, 'Kodera'), membership(ROOM_ACCESS, null)],
    })
    try {
      await fixture.start()
      expect(fixture.store.getMembers(SNAPSHOT_ROOM)).toEqual([
        { userId: SNAPSHOT_ALICE, name: 'Henri Duflot' },
      ])
    } finally {
      fixture.stop()
    }
  })

  it('counts and shows no one in an audio room', async () => {
    const fixture = snapshotFixture(undefined, {
      state: [
        {
          ...snapshotMessage('$policy', ''),
          type: 'io.kodera.room.policy',
          state_key: '',
          content: { kind: 'audio' },
        },
      ],
      summary: { 'm.joined_member_count': 4 },
    })
    try {
      await fixture.start()
      const [room] = fixture.store.getSnapshot().rooms
      expect(room?.kind).toBe('audio')
      expect(room).not.toHaveProperty('joined')
      expect(room).not.toHaveProperty('faces')
    } finally {
      fixture.stop()
    }
  })
})

describe("a member's name, from the room's member events (M1)", () => {
  it('asks for the member list once, even when someone in a call is not in it either', async () => {
    const original = Room.prototype.loadMembersIfNeeded
    let asked = 0
    vi.spyOn(Room.prototype, 'loadMembersIfNeeded').mockImplementation(function (this: Room) {
      // A store asking on every rebuild would never settle: cut it here, so this case fails
      // instead of hanging.
      if (++asked > 5) return Promise.reject(new Error('asked again and again'))
      return original.call(this)
    })
    const fixture = snapshotFixture(undefined, {
      state: audioState([SNAPSHOT_ALICE, SNAPSHOT_BOB]),
      members: [],
    })
    try {
      await fixture.start()
      await vi.waitFor(() => expect(fixture.memberLists()).toBe(1))
      await fixture.idle()
      expect(asked).toBe(1)
      expect(fixture.store.getSnapshot().rooms[0]?.names).toEqual({})
    } finally {
      vi.restoreAllMocks()
      fixture.stop()
    }
  })

  it('tells two members of one name apart by the start of their id, not the whole id', async () => {
    const fixture = snapshotFixture(undefined, {
      names: { [SNAPSHOT_ALICE]: 'Henri Duflot', [SNAPSHOT_ME]: 'Henri Duflot' },
    })
    try {
      await fixture.start()
      expect(fixture.store.getTimeline(SNAPSHOT_ROOM)[0]?.senderName).toBe('Henri Duflot (henr)')
    } finally {
      fixture.stop()
    }
  })

  it('loads the member list, once, for someone in a call who never wrote in the room', async () => {
    const bob: SnapshotEvent = {
      ...snapshotMessage('$join-bob', ''),
      type: 'm.room.member',
      state_key: SNAPSHOT_BOB,
      sender: SNAPSHOT_BOB,
      content: { membership: 'join', displayname: 'Bob Dupont' },
    }
    const fixture = snapshotFixture(undefined, {
      state: audioState([SNAPSHOT_ALICE, SNAPSHOT_BOB]),
      members: [bob],
    })
    try {
      await fixture.start()
      await vi.waitFor(() =>
        expect(fixture.store.getSnapshot().rooms[0]?.names?.[SNAPSHOT_BOB]).toBe('Bob Dupont')
      )
      await fixture.idle()
      expect(fixture.memberLists()).toBe(1)
    } finally {
      fixture.stop()
    }
  })

  it('says who is typing in the room, by name, but never the member themself', async () => {
    const fixture = snapshotFixture(undefined, {
      names: { [SNAPSHOT_ALICE]: 'Henri Duflot', [SNAPSHOT_ME]: 'Moi' },
    })
    try {
      await fixture.start()
      expect(fixture.store.getTyping(SNAPSHOT_ROOM)).toEqual([])
      // A sync that changes nothing keeps the snapshot; one that says who types replaces it, so
      // a view subscribed to it draws the line again.
      await fixture.idle()
      const quiet = fixture.store.getSnapshot()
      await fixture.idle()
      expect(fixture.store.getSnapshot()).toBe(quiet)
      await fixture.typing([SNAPSHOT_ALICE, SNAPSHOT_ME])
      await vi.waitFor(() => expect(fixture.store.getSnapshot()).not.toBe(quiet))
      await vi.waitFor(() =>
        expect(fixture.store.getTyping(SNAPSHOT_ROOM)).toEqual([
          { userId: SNAPSHOT_ALICE, name: 'Henri Duflot' },
        ])
      )
      // The same array while nothing about it changes: the view re-renders only on a change.
      const typing = fixture.store.getTyping(SNAPSHOT_ROOM)
      await fixture.idle()
      expect(fixture.store.getTyping(SNAPSHOT_ROOM)).toBe(typing)
      // Someone the client has not loaded as a member (lazy loading brings only the last
      // messages' senders): still on the line, by id.
      await fixture.typing([SNAPSHOT_ALICE, SNAPSHOT_BOB])
      await vi.waitFor(() =>
        expect(fixture.store.getTyping(SNAPSHOT_ROOM)).toEqual([
          { userId: SNAPSHOT_BOB },
          { userId: SNAPSHOT_ALICE, name: 'Henri Duflot' },
        ])
      )
      expect(
        matrixClientForTests(fixture.store).getRoom(SNAPSHOT_ROOM)?.getMember(SNAPSHOT_BOB)
      ).toBeNull()
      // A typing change is a new snapshot; the messages stay the same array.
      const timeline = fixture.store.getTimeline(SNAPSHOT_ROOM)
      const before = fixture.store.getSnapshot()
      await fixture.typing([])
      await vi.waitFor(() => expect(fixture.store.getTyping(SNAPSHOT_ROOM)).toEqual([]))
      expect(fixture.store.getSnapshot()).not.toBe(before)
      expect(fixture.store.getTimeline(SNAPSHOT_ROOM)).toBe(timeline)
      expect(fixture.store.getTyping('!unknown:matrix.acme.kodera.io')).toEqual([])
      // Out of the room, its typing stops reaching the member: back in, no one is shown until
      // the room's next `m.typing`.
      await fixture.typing([SNAPSHOT_ALICE])
      await vi.waitFor(() => expect(fixture.store.getTyping(SNAPSHOT_ROOM)).toHaveLength(1))
      await fixture.leave()
      await fixture.rejoin()
      await vi.waitFor(() =>
        expect(matrixClientForTests(fixture.store).getRoom(SNAPSHOT_ROOM)?.getMyMembership()).toBe(
          'join'
        )
      )
      expect(fixture.store.getSnapshot().rooms).toHaveLength(1)
      expect(fixture.store.getTyping(SNAPSHOT_ROOM)).toEqual([])
      // …and the room's next `m.typing` is read again.
      await fixture.typing([SNAPSHOT_ALICE])
      await vi.waitFor(() =>
        expect(fixture.store.getTyping(SNAPSHOT_ROOM)).toEqual([
          { userId: SNAPSHOT_ALICE, name: 'Henri Duflot' },
        ])
      )
    } finally {
      fixture.stop()
    }
  })

  it('says who types from the very first sync, through the members it loaded', async () => {
    const fixture = snapshotFixture(undefined, {
      names: { [SNAPSHOT_ALICE]: 'Henri Duflot' },
      typing: [SNAPSHOT_ALICE, SNAPSHOT_BOB],
    })
    try {
      await fixture.start()
      // The room's first `m.typing` reaches the client before the room reaches the store: only
      // the members loaded are read, and Bob, sending none of the room's messages, is not one.
      await vi.waitFor(() =>
        expect(fixture.store.getTyping(SNAPSHOT_ROOM)).toEqual([
          { userId: SNAPSHOT_ALICE, name: 'Henri Duflot' },
        ])
      )
      // From the room's next `m.typing` on, the event is the list.
      await fixture.typing([SNAPSHOT_BOB])
      await vi.waitFor(() =>
        expect(fixture.store.getTyping(SNAPSHOT_ROOM)).toEqual([{ userId: SNAPSHOT_BOB }])
      )
    } finally {
      fixture.stop()
    }
  })

  it('sends « typing » once per stretch of keys, and « no longer » only after one', async () => {
    const fixture = snapshotFixture()
    try {
      await fixture.start()
      const notices = () => fixture.typingNotices.map((notice) => ({ ...notice }))
      fixture.store.setTyping(SNAPSHOT_ROOM, false, 0)
      fixture.store.setTyping(SNAPSHOT_ROOM, true, 1_000)
      fixture.store.setTyping(SNAPSHOT_ROOM, true, 8_999)
      await vi.waitFor(() => expect(notices()).toEqual([{ typing: true, timeout: 10_000 }]))
      // Before the first notice runs out, it is sent again.
      fixture.store.setTyping(SNAPSHOT_ROOM, true, 9_000)
      fixture.store.setTyping(SNAPSHOT_ROOM, false, 9_500)
      fixture.store.setTyping(SNAPSHOT_ROOM, false, 9_600)
      await vi.waitFor(() =>
        expect(notices()).toEqual([
          { typing: true, timeout: 10_000 },
          { typing: true, timeout: 10_000 },
          { typing: false },
        ])
      )
      // A stretch after « no longer » starts over at once.
      fixture.store.setTyping(SNAPSHOT_ROOM, true, 9_700)
      await vi.waitFor(() => expect(notices()).toHaveLength(4))
      // The view going stops the store: the standing « typing » ends with it, once.
      fixture.store.stop()
      fixture.store.setTyping(SNAPSHOT_ROOM, true, 30_000)
      await vi.waitFor(() => expect(notices()).toHaveLength(5))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(notices().slice(3)).toEqual([{ typing: true, timeout: 10_000 }, { typing: false }])
    } finally {
      fixture.stop()
    }
  })

  it('says nothing more on stopping when no « typing » stands, or the session is signed out', async () => {
    const quiet = snapshotFixture()
    try {
      await quiet.start()
      quiet.store.setTyping(SNAPSHOT_ROOM, true, 1_000)
      quiet.store.setTyping(SNAPSHOT_ROOM, false, 2_000)
      await vi.waitFor(() => expect(quiet.typingNotices).toHaveLength(2))
      quiet.store.stop()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(quiet.typingNotices).toHaveLength(2)
    } finally {
      quiet.stop()
    }
    const signedOut = snapshotFixture()
    try {
      await signedOut.start()
      signedOut.store.setTyping(SNAPSHOT_ROOM, true, 1_000)
      await vi.waitFor(() => expect(signedOut.typingNotices).toHaveLength(1))
      signedOut.store.stop('signed-out')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(signedOut.typingNotices).toHaveLength(1)
    } finally {
      signedOut.stop()
    }
  })

  it("reads the member's fully-read marker, and none for a room never read", async () => {
    const read = snapshotFixture(
      [snapshotMessage('$root', SNAPSHOT_BODY), snapshotMessage('$later', 'Plus tard')],
      { accountData: [{ type: 'm.fully_read', content: { event_id: '$root' } }] }
    )
    try {
      await read.start()
      expect(read.store.getReadMarker(SNAPSHOT_ROOM)).toBe('$root')
      expect(read.store.getReadMarker('!unknown:matrix.acme.kodera.io')).toBeNull()
    } finally {
      read.stop()
    }
    const unread = snapshotFixture()
    try {
      await unread.start()
      expect(unread.store.getReadMarker(SNAPSHOT_ROOM)).toBeNull()
    } finally {
      unread.stop()
    }
  })

  it('finds where the unread messages start after a read marker on any event', async () => {
    const reaction = (eventId: string, target: string) => ({
      event_id: eventId,
      type: 'm.reaction',
      sender: SNAPSHOT_ALICE,
      origin_server_ts: SNAPSHOT_TIME,
      content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: target, key: '👍' } },
    })
    const fixture = snapshotFixture([
      reaction('$first', '$elsewhere'),
      snapshotMessage('$root', SNAPSHOT_BODY),
      reaction('$liked', '$root'),
      snapshotMessage('$later', 'Plus tard'),
    ])
    try {
      await fixture.start()
      const after = (eventId: string) => fixture.store.firstShownAfter(SNAPSHOT_ROOM, eventId)
      expect(after('$first')).toBe('$root')
      expect(after('$root')).toBe('$later')
      expect(after('$liked')).toBe('$later')
      expect(after('$later')).toBeNull()
      expect(after('$before-the-loaded-page')).toBeNull()
      expect(fixture.store.firstShownAfter('!unknown:matrix.acme.kodera.io', '$root')).toBeNull()
    } finally {
      fixture.stop()
    }
  })

  it("names a message's sender by their display name, and leaves an unnamed one unnamed", async () => {
    const named = snapshotFixture(undefined, { names: { [SNAPSHOT_ALICE]: 'Henri Duflot' } })
    try {
      await named.start()
      expect(named.store.getTimeline(SNAPSHOT_ROOM)[0]?.senderName).toBe('Henri Duflot')
    } finally {
      named.stop()
    }
    const unnamed = snapshotFixture()
    try {
      await unnamed.start()
      expect(unnamed.store.getTimeline(SNAPSHOT_ROOM)[0]).not.toHaveProperty('senderName')
    } finally {
      unnamed.stop()
    }
  })

  it("names an audio room's occupants that have a display name", async () => {
    const audio: SnapshotEvent[] = [
      {
        ...snapshotMessage('$policy', ''),
        type: 'io.kodera.room.policy',
        state_key: '',
        content: { kind: 'audio' },
      },
      {
        ...snapshotMessage('$occupancy', ''),
        type: 'io.kodera.room.occupancy',
        state_key: '',
        content: {
          version: 1,
          participants: [
            { user_id: SNAPSHOT_ALICE, devices: 1 },
            { user_id: SNAPSHOT_ME, devices: 1 },
          ],
        },
      },
    ]
    const fixture = snapshotFixture(undefined, {
      names: { [SNAPSHOT_ALICE]: 'Henri Duflot' },
      state: audio,
    })
    try {
      await fixture.start()
      expect(fixture.store.getSnapshot().rooms[0]?.names).toEqual({
        [SNAPSHOT_ALICE]: 'Henri Duflot',
      })
    } finally {
      fixture.stop()
    }
  })
})

describe('cached message subscription snapshots', () => {
  it('publishes a new snapshot for a local echo with unchanged room summaries', async () => {
    const fixture = snapshotFixture()
    const { store } = fixture
    let sending: Promise<unknown> | undefined
    let unsubscribe = () => {}
    try {
      await fixture.start()
      expect(store.getTimeline(SNAPSHOT_ROOM)[0]?.body).toBe(SNAPSHOT_BODY)
      const before = store.getSnapshot()
      const witnessed: { snapshot: ReturnType<typeof store.getSnapshot>; pending: boolean }[] = []
      unsubscribe = store.subscribe(() =>
        witnessed.push({
          snapshot: store.getSnapshot(),
          pending: store
            .getTimeline(SNAPSHOT_ROOM)
            .some(
              (message) => message.body === 'Raw pending <b>&</b>' && message.delivery === 'pending'
            ),
        })
      )
      fixture.holdNextSend()
      sending = store.send(SNAPSHOT_ROOM, 'Raw pending <b>&</b>').catch((error: unknown) => error)
      await vi.waitFor(() => expect(witnessed.some((entry) => entry.pending)).toBe(true))
      const observed = witnessed.find((entry) => entry.pending)!
      expect(store.getTimeline(SNAPSHOT_ROOM).at(-1)?.body).toBe('Raw pending <b>&</b>')
      expect(observed.snapshot.rooms).toBe(before.rooms)
      expect(observed.snapshot.invites).toBe(before.invites)
      expect(observed.snapshot.channels).toBe(before.channels)
      expect(observed.snapshot.status).toBe(before.status)
      expect(observed.snapshot).not.toBe(before)
      expect(store.getSnapshot()).toBe(observed.snapshot)
    } finally {
      unsubscribe()
      if (sending !== undefined) {
        await fixture.finishSend()
        await sending
      }
      fixture.stop()
    }
  })
})

function snapshotThreadReply(eventId: string, body: string): SnapshotEvent {
  return snapshotMessage(eventId, body, {
    content: {
      msgtype: 'm.text',
      body,
      'm.relates_to': {
        rel_type: 'm.thread',
        event_id: '$root',
        is_falling_back: true,
        'm.in_reply_to': { event_id: '$root' },
      },
    },
  })
}

function expectSameSummaries(
  before: ReturnType<ReturnType<typeof snapshotFixture>['store']['getSnapshot']>,
  after: ReturnType<ReturnType<typeof snapshotFixture>['store']['getSnapshot']>
) {
  expect(after.rooms).toBe(before.rooms)
  expect(after.invites).toBe(before.invites)
  expect(after.channels).toBe(before.channels)
  expect(after.status).toBe(before.status)
}

describe('message cache invalidation with stable summaries', () => {
  it('publishes incoming edits, reactions and redactions while reusing unchanged messages and idle snapshots', async () => {
    const fixture = snapshotFixture()
    const { store } = fixture
    try {
      await fixture.start()
      const root = store.getTimeline(SNAPSHOT_ROOM)[0]!
      let before = store.getSnapshot()
      await fixture.idle()
      expect(store.getSnapshot()).toBe(before)
      const initialTimeline = store.getTimeline(SNAPSHOT_ROOM)
      await fixture.publish([snapshotMessage('$incoming', 'Incoming <i>&</i>')])
      expect(store.getTimeline(SNAPSHOT_ROOM).at(-1)?.body).toBe('Incoming <i>&</i>')
      expect(store.getTimeline(SNAPSHOT_ROOM)).not.toBe(initialTimeline)
      expect(store.getTimeline(SNAPSHOT_ROOM)[0]).toBe(root)
      expectSameSummaries(before, store.getSnapshot())
      expect(store.getSnapshot()).not.toBe(before)

      before = store.getSnapshot()
      await fixture.publish([
        snapshotMessage('$edit', '* edited', {
          origin_server_ts: SNAPSHOT_TIME + 1,
          content: {
            msgtype: 'm.text',
            body: '* edited',
            'm.new_content': { msgtype: 'm.text', body: 'Edited {literal} <b>&</b>' },
            'm.relates_to': { rel_type: 'm.replace', event_id: '$incoming' },
          },
        }),
      ])
      expect(store.getTimeline(SNAPSHOT_ROOM).at(-1)).toMatchObject({
        eventId: '$incoming',
        body: 'Edited {literal} <b>&</b>',
        edited: true,
      })
      expect(store.getTimeline(SNAPSHOT_ROOM)[0]).toBe(root)
      expectSameSummaries(before, store.getSnapshot())
      expect(store.getSnapshot()).not.toBe(before)

      before = store.getSnapshot()
      await fixture.publish([
        snapshotMessage('$reaction', '', {
          type: 'm.reaction',
          sender: SNAPSHOT_ME,
          content: {
            'm.relates_to': { rel_type: 'm.annotation', event_id: '$incoming', key: '👍' },
          },
        }),
      ])
      expect(store.getTimeline(SNAPSHOT_ROOM).at(-1)?.reactions).toEqual([
        { key: '👍', count: 1, mine: true },
      ])
      expectSameSummaries(before, store.getSnapshot())
      expect(store.getSnapshot()).not.toBe(before)

      before = store.getSnapshot()
      await fixture.publish([
        snapshotMessage('$redact', '', {
          type: 'm.room.redaction',
          redacts: '$incoming',
          content: {},
        }),
      ])
      expect(store.getTimeline(SNAPSHOT_ROOM).at(-1)).toMatchObject({
        eventId: '$incoming',
        body: '',
        redacted: true,
        reactions: [],
      })
      expect(store.getTimeline(SNAPSHOT_ROOM)[0]).toBe(root)
      expectSameSummaries(before, store.getSnapshot())
      expect(store.getSnapshot()).not.toBe(before)
      before = store.getSnapshot()
      const unchangedTimeline = store.getTimeline(SNAPSHOT_ROOM)
      await fixture.idle()
      expect(store.getSnapshot()).toBe(before)
      expect(store.getTimeline(SNAPSHOT_ROOM)).toBe(unchangedTimeline)
      expect(store.getSnapshot()).toBe(store.getSnapshot())
    } finally {
      fixture.stop()
    }
  })

  it('invalidates thread-only changes with the main timeline reused and clears caches on leaving', async () => {
    const fixture = snapshotFixture()
    const { store } = fixture
    try {
      await fixture.start()
      const main = store.getTimeline(SNAPSHOT_ROOM)
      let before = store.getSnapshot()
      expect(store.getThread(SNAPSHOT_ROOM, '$root')).toEqual([])
      await fixture.publish([snapshotThreadReply('$reply1', 'First thread <b>&</b>')])
      expect(store.getTimeline(SNAPSHOT_ROOM)).toBe(main)
      const first = store.getThread(SNAPSHOT_ROOM, '$root')
      expect(first.map((message) => message.body)).toEqual(['First thread <b>&</b>'])
      expectSameSummaries(before, store.getSnapshot())
      expect(store.getSnapshot()).not.toBe(before)

      before = store.getSnapshot()
      await fixture.publish([snapshotThreadReply('$reply2', 'Second thread {literal}')])
      const second = store.getThread(SNAPSHOT_ROOM, '$root')
      expect(store.getTimeline(SNAPSHOT_ROOM)).toBe(main)
      expect(second).not.toBe(first)
      expect(second[0]).toBe(first[0])
      expect(second.map((message) => message.eventId)).toEqual(['$reply1', '$reply2'])
      expectSameSummaries(before, store.getSnapshot())
      expect(store.getSnapshot()).not.toBe(before)

      before = store.getSnapshot()
      await fixture.leave()
      expect(store.getSnapshot()).not.toBe(before)
      expect(store.getSnapshot().rooms).toEqual([])
      expect(store.getTimeline(SNAPSHOT_ROOM)).toEqual([])
      expect(store.getThread(SNAPSHOT_ROOM, '$root')).toEqual([])
      expect(store.getSnapshot().status).toBe('live')
    } finally {
      fixture.stop()
    }
  })

  it('publishes failed, retried, acknowledged and cancelled local delivery without changing targets', async () => {
    const fixture = snapshotFixture()
    const { store } = fixture
    let sending: Promise<unknown> | undefined
    try {
      await fixture.start()
      const summaries = store.getSnapshot()
      const root = store.getTimeline(SNAPSHOT_ROOM)[0]
      fixture.holdNextSend()
      sending = store
        .send(SNAPSHOT_ROOM, 'Raw delivery <b>&</b>', { replyTo: '$root' })
        .catch((error: unknown) => error)
      await vi.waitFor(() =>
        expect(store.getTimeline(SNAPSHOT_ROOM).at(-1)?.delivery).toBe('pending')
      )
      const pending = store.getTimeline(SNAPSHOT_ROOM).at(-1)!
      const beforeFailure = store.getSnapshot()
      await fixture.finishSend(403, { errcode: 'M_FORBIDDEN', error: 'Controlled send failure' })
      expect(await sending).toMatchObject({ errcode: 'M_FORBIDDEN' })
      await vi.waitFor(() =>
        expect(store.getTimeline(SNAPSHOT_ROOM).at(-1)?.delivery).toBe('failed')
      )
      expect(store.getSnapshot()).not.toBe(beforeFailure)
      const failed = store.getSnapshot()
      fixture.holdNextSend()
      sending = store.resend(SNAPSHOT_ROOM, pending.key).catch((error: unknown) => error)
      await vi.waitFor(() =>
        expect(store.getTimeline(SNAPSHOT_ROOM).at(-1)?.delivery).toBe('pending')
      )
      expect(store.getSnapshot()).not.toBe(failed)
      await fixture.finishSend(200, { event_id: '$delivery' })
      await sending
      expect(fixture.requests).toHaveLength(2)
      expect(fixture.requests[1]).toEqual(fixture.requests[0])
      expect(fixture.requests[0]!.path).toContain(
        `/${SNAPSHOT_ROOM}/send/m.room.message/${pending.key}`
      )
      expect(fixture.requests[0]!.body).toEqual({
        msgtype: 'm.text',
        body: 'Raw delivery <b>&</b>',
        'm.relates_to': { 'm.in_reply_to': { event_id: '$root' } },
      })
      const beforeAck = store.getSnapshot()
      await fixture.publish([
        snapshotMessage('$delivery', 'Raw delivery <b>&</b>', {
          sender: SNAPSHOT_ME,
          unsigned: { transaction_id: pending.key },
          content: fixture.requests[0]!.body,
        }),
      ])
      expect(store.getTimeline(SNAPSHOT_ROOM).at(-1)).toMatchObject({
        key: pending.key,
        eventId: '$delivery',
        body: 'Raw delivery <b>&</b>',
        delivery: 'sent',
        replyTo: '$root',
      })
      expect(store.getTimeline(SNAPSHOT_ROOM)).toHaveLength(2)
      expect(store.getTimeline(SNAPSHOT_ROOM)[0]).toBe(root)
      expect(store.getSnapshot()).not.toBe(beforeAck)
      expectSameSummaries(summaries, store.getSnapshot())

      fixture.holdNextSend()
      sending = store.send(SNAPSHOT_ROOM, 'Cancel this exact echo').catch((error: unknown) => error)
      await fixture.finishSend(403, { errcode: 'M_FORBIDDEN', error: 'Controlled cancellation' })
      await sending
      await vi.waitFor(() =>
        expect(store.getTimeline(SNAPSHOT_ROOM).at(-1)?.delivery).toBe('failed')
      )
      const cancelled = store.getTimeline(SNAPSHOT_ROOM).at(-1)!
      const beforeCancel = store.getSnapshot()
      store.cancel(SNAPSHOT_ROOM, cancelled.key)
      await vi.waitFor(() => expect(store.getTimeline(SNAPSHOT_ROOM)).toHaveLength(2))
      expect(store.getSnapshot()).not.toBe(beforeCancel)
      expect(
        store.getTimeline(SNAPSHOT_ROOM).some((message) => message.key === cancelled.key)
      ).toBe(false)
      expectSameSummaries(summaries, store.getSnapshot())
    } finally {
      await fixture.releaseHeldSend()
      await sending
      fixture.stop()
    }
  })
})

describe('mentions (M8)', () => {
  const bobJoins: SnapshotEvent = {
    ...snapshotMessage('$join-bob', ''),
    type: 'm.room.member',
    state_key: SNAPSHOT_BOB,
    sender: SNAPSHOT_BOB,
    content: { membership: 'join', displayname: 'Bob Dupont' },
  }

  it('offers the joined members but the viewer, by name, the whole list once it is loaded', async () => {
    const fixture = snapshotFixture(undefined, {
      names: { [SNAPSHOT_ALICE]: 'Henri Duflot', [SNAPSHOT_ME]: 'Moi' },
      members: [bobJoins],
    })
    try {
      await fixture.start()
      const synced = fixture.store.getMembers(SNAPSHOT_ROOM)
      expect(synced).toEqual([{ userId: SNAPSHOT_ALICE, name: 'Henri Duflot' }])
      // The same array while nothing changed: a screen memoised on it does not redraw.
      expect(fixture.store.getMembers(SNAPSHOT_ROOM)).toBe(synced)
      fixture.store.loadMembers(SNAPSHOT_ROOM)
      await vi.waitFor(() =>
        expect(fixture.store.getMembers(SNAPSHOT_ROOM)).toEqual([
          { userId: SNAPSHOT_BOB, name: 'Bob Dupont' },
          { userId: SNAPSHOT_ALICE, name: 'Henri Duflot' },
        ])
      )
      expect(fixture.store.getMembers('!unknown:matrix.acme.kodera.io')).toEqual([])
    } finally {
      fixture.stop()
    }
  })

  it('leaves a member with no display name unnamed, and offers no one in a room left', async () => {
    const fixture = snapshotFixture()
    try {
      await fixture.start()
      expect(fixture.store.getMembers(SNAPSHOT_ROOM)).toEqual([{ userId: SNAPSHOT_ALICE }])
      await fixture.leave()
      expect(fixture.store.getMembers(SNAPSHOT_ROOM)).toEqual([])
    } finally {
      fixture.stop()
    }
  })

  it('sends the named members as `m.mentions`, and nothing when it names none', async () => {
    const fixture = snapshotFixture()
    try {
      await fixture.start()
      await fixture.store.send(SNAPSHOT_ROOM, '@Henri Duflot bonjour', {
        mentions: [SNAPSHOT_ALICE],
      })
      await fixture.store.send(SNAPSHOT_ROOM, 'bonjour')
      const sent = fixture.requests.filter(({ path }) => path.includes('/send/m.room.message/'))
      expect(sent.map(({ body }) => body['m.mentions'])).toEqual([
        { user_ids: [SNAPSHOT_ALICE] },
        undefined,
      ])
    } finally {
      fixture.stop()
    }
  })
})

describe('outgoing Matrix room invitations', () => {
  it('posts the invitee to the standard Matrix Client-Server endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    )
    const store = createEspaceStore(
      { baseUrl: HS, userId: '@me:example.test', deviceId: 'TEST', accessToken: 'synthetic' },
      fetcher
    )
    await store.inviteToRoom('!room:example.test', '@marie:dinum.gouv.fr')
    const [url, request] = fetcher.mock.calls[0]!
    expect(String(url)).toBe(`${HS}/_matrix/client/v3/rooms/!room%3Aexample.test/invite`)
    expect(request?.method).toBe('POST')
    expect(JSON.parse(request?.body as string)).toEqual({ user_id: '@marie:dinum.gouv.fr' })
  })

  it('uses the standard SDK invitation and propagates homeserver refusals', async () => {
    const { store } = setup()
    const invite = vi.spyOn(matrixClientForTests(store), 'invite').mockResolvedValue({})
    await store.inviteToRoom('!room:example.test', '@marie:dinum.gouv.fr')
    expect(invite).toHaveBeenCalledWith('!room:example.test', '@marie:dinum.gouv.fr')
    const refused = new Error('M_FORBIDDEN')
    invite.mockRejectedValueOnce(refused)
    await expect(store.inviteToRoom('!room:example.test', '@marie:dinum.gouv.fr')).rejects.toBe(
      refused
    )
  })

  it('rejects malformed IDs before contacting the homeserver', async () => {
    const { store } = setup()
    const invite = vi.spyOn(matrixClientForTests(store), 'invite')
    for (const invalid of [
      'marie:dinum.gouv.fr',
      '@marie',
      '@marie:',
      '@:example.test',
      '@marie:bad/path',
    ]) {
      await expect(store.inviteToRoom('!room:example.test', invalid)).rejects.toThrow()
    }
    expect(invite).not.toHaveBeenCalled()
  })
})
