import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginMatrixSignIn,
  clearMatrixSession,
  completeMatrixSignIn,
  getMatrixSession,
  getMatrixRegistrationStamp,
  subscribeMatrixSession,
  prepareMatrixSessionForSignOut,
  homeserverOrigin,
  MatrixSignInFailed,
  RefreshRefused,
  refreshMatrixToken,
  registerMatrixSession,
  signOutOfMatrix,
  takeMatrixSessionForSignOut,
} from './matrix'

const HS = 'https://matrix.acme-sa.kodera.io'
const CONSOLE = 'https://app.kodera.io'
const CALLBACK = `${CONSOLE}/espace/callback`
const SUB = '0b6c5a3e-7d1f-4c2a-9e8b-1f2d3c4b5a69'
const PENDING = 'kodera.web.espace.signin'
const DEVICE = `kodera.web.espace.device:${HS}`

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const login = {
  user_id: `@${SUB}:acme-sa.kodera.io`,
  access_token: 'syt_access',
  refresh_token: 'syr_refresh',
  device_id: 'KODERADEV',
}

/** Starts a sign-in and returns the callback URL Synapse would send back to. */
function started(sessionStorage: Storage = window.sessionStorage, returnTo = '/espace') {
  let target = ''
  beginMatrixSignIn(HS, returnTo, {
    sessionStorage,
    consoleOrigin: CONSOLE,
    navigate: (url) => (target = url),
  })
  const back = new URL(new URL(target).searchParams.get('redirectUrl')!)
  back.searchParams.set('loginToken', 'syl_once')
  return { target, callback: back.href, state: back.searchParams.get('state')! }
}

afterEach(() => {
  clearMatrixSession()
  window.sessionStorage.clear()
  window.localStorage.clear()
})

describe('the homeserver URL', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('refuses plain HTTP even on this machine in a production build', () => {
    vi.stubEnv('DEV', false)
    expect(() => homeserverOrigin('http://127.0.0.1:8008')).toThrow()
    expect(homeserverOrigin(HS)).toBe(HS)
  })

  it('is an https origin, or plain HTTP on this machine only', () => {
    expect(homeserverOrigin(`${HS}/`)).toBe(HS)
    expect(homeserverOrigin('http://127.0.0.1:8008')).toBe('http://127.0.0.1:8008')
    for (const refused of [
      'http://matrix.acme-sa.kodera.io',
      `${HS}/_matrix`,
      `${HS}/?next=x`,
      `${HS}/#x`,
      'https://user:pass@matrix.acme-sa.kodera.io',
      'not a url',
    ]) {
      expect(() => homeserverOrigin(refused), refused).toThrow()
    }
  })
})

describe('starting the sign-in', () => {
  it("sends the page to Synapse's SSO login, with a callback carrying a fresh state", () => {
    const first = started()
    const target = new URL(first.target)
    expect(target.origin + target.pathname).toBe(`${HS}/_matrix/client/v3/login/sso/redirect`)
    expect(first.callback.startsWith(`${CALLBACK}?state=`)).toBe(true)
    expect(first.state).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.parse(window.sessionStorage.getItem(PENDING)!)).toEqual({
      state: first.state,
      baseUrl: HS,
      returnTo: '/espace',
    })
    expect(started().state).not.toBe(first.state)
  })
})

describe('ending the sign-in', () => {
  it('removes the login token from the address bar before anything else, then signs in', async () => {
    const { callback } = started()
    const order: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      order.push(`fetch ${String(input)}`)
      expect(JSON.parse(String(init!.body))).toEqual({
        type: 'm.login.token',
        token: 'syl_once',
        refresh_token: true,
        initial_device_display_name: 'Kodera',
      })
      return json(200, login)
    })
    const { session, returnTo } = await completeMatrixSignIn(callback, SUB, {
      fetch,
      replaceUrl: (url) => order.push(`replace ${url}`),
    })
    expect(order).toEqual([`replace ${CALLBACK}`, `fetch ${HS}/_matrix/client/v3/login`])
    expect(returnTo).toBe('/espace')
    expect(session).toMatchObject({
      baseUrl: HS,
      userId: login.user_id,
      deviceId: 'KODERADEV',
      accessToken: 'syt_access',
      refreshToken: 'syr_refresh',
    })
    expect(window.localStorage.getItem(DEVICE)).toBe('KODERADEV')
    expect(window.sessionStorage.getItem(PENDING)).toBeNull()
  })

  it('signs in again on the device it remembers', async () => {
    window.localStorage.setItem(DEVICE, 'KODERADEV')
    const { callback } = started()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(200, login))
    await completeMatrixSignIn(callback, SUB, { fetch, replaceUrl: () => undefined })
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toMatchObject({
      device_id: 'KODERADEV',
    })
  })

  it('refuses a callback whose state is not the one this tab recorded, without a request', async () => {
    const { callback } = started()
    const forged = new URL(callback)
    forged.searchParams.set('state', 'f'.repeat(32))
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(
      completeMatrixSignIn(forged.href, SUB, { fetch, replaceUrl: () => undefined })
    ).rejects.toMatchObject({ problem: 'unexpected-callback' })
    expect(fetch).not.toHaveBeenCalled()
    // The recorded round trip is spent either way: a second try cannot reuse it.
    expect(window.sessionStorage.getItem(PENDING)).toBeNull()
  })

  it('refuses a callback when no sign-in was started, or with no login token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(
      completeMatrixSignIn(`${CALLBACK}?state=x&loginToken=y`, SUB, { fetch, replaceUrl: () => {} })
    ).rejects.toMatchObject({ problem: 'unexpected-callback' })
    const { callback } = started()
    const tokenless = new URL(callback)
    tokenless.searchParams.delete('loginToken')
    await expect(
      completeMatrixSignIn(tokenless.href, SUB, { fetch, replaceUrl: () => {} })
    ).rejects.toMatchObject({ problem: 'unexpected-callback' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('leaves the live session alone when « back » opens the spent callback again', async () => {
    const { callback } = started()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(200, login))
    const { session } = await completeMatrixSignIn(callback, SUB, { fetch, replaceUrl: () => {} })
    const stop = vi.fn()
    registerMatrixSession(session, stop)
    // The same address, re-mounted from the history: its round trip is spent.
    await expect(
      completeMatrixSignIn(callback, SUB, { fetch, replaceUrl: () => {} })
    ).rejects.toMatchObject({ problem: 'unexpected-callback' })
    expect(getMatrixSession()).toBe(session)
    expect(stop).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('names the refusal of a login token, and an answer that is not a login', async () => {
    const refused = vi.fn<typeof globalThis.fetch>(async () =>
      json(403, { errcode: 'M_FORBIDDEN' })
    )
    await expect(
      completeMatrixSignIn(started().callback, SUB, { fetch: refused, replaceUrl: () => {} })
    ).rejects.toMatchObject({ problem: 'refused' })
    const broken = vi.fn<typeof globalThis.fetch>(async () => json(200, { user_id: 1 }))
    await expect(
      completeMatrixSignIn(started().callback, SUB, { fetch: broken, replaceUrl: () => {} })
    ).rejects.toMatchObject({ problem: 'unreadable' })
    const failing = vi.fn<typeof globalThis.fetch>(async () => json(500, {}))
    await expect(
      completeMatrixSignIn(started().callback, SUB, { fetch: failing, replaceUrl: () => {} })
    ).rejects.toBeInstanceOf(MatrixSignInFailed)
  })

  it('gives back an access token that never expires, and refuses the sign-in', async () => {
    const calls: [string, RequestInit][] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      calls.push([String(input), init!])
      return String(input).endsWith('/login')
        ? json(200, { ...login, refresh_token: undefined })
        : json(200, {})
    })
    await expect(
      completeMatrixSignIn(started().callback, SUB, { fetch, replaceUrl: () => {} })
    ).rejects.toMatchObject({ problem: 'not-refreshable' })
    expect(calls[1]![0]).toBe(`${HS}/_matrix/client/v3/logout`)
    expect(new Headers(calls[1]![1].headers).get('Authorization')).toBe('Bearer syt_access')
    expect(window.localStorage.getItem(DEVICE)).toBeNull()
  })

  it("refuses someone else's Matrix account, and gives its token back", async () => {
    const calls: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      calls.push(String(input))
      return String(input).endsWith('/login')
        ? json(200, {
            ...login,
            user_id: '@1a2b3c4d-0000-4000-8000-000000000000:acme-sa.kodera.io',
          })
        : json(200, {})
    })
    await expect(
      completeMatrixSignIn(started().callback, SUB, { fetch, replaceUrl: () => {} })
    ).rejects.toMatchObject({ problem: 'other-person' })
    expect(calls[1]).toBe(`${HS}/_matrix/client/v3/logout`)
    expect(window.localStorage.getItem(DEVICE)).toBeNull()
  })

  it("refuses a Matrix ID that only starts with the member's sub, or has no server name", async () => {
    for (const userId of [`@${SUB}x:acme-sa.kodera.io`, `@${SUB}`, `${SUB}:acme-sa.kodera.io`]) {
      const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
        String(input).endsWith('/login') ? json(200, { ...login, user_id: userId }) : json(200, {})
      )
      await expect(
        completeMatrixSignIn(started().callback, SUB, { fetch, replaceUrl: () => {} }),
        userId
      ).rejects.toMatchObject({ problem: 'other-person' })
    }
  })

  it('gives back a token that came with an unreadable login, and reads a non-JSON answer as unreadable', async () => {
    const calls: string[] = []
    const partial = vi.fn<typeof globalThis.fetch>(async (input) => {
      calls.push(String(input))
      return json(200, { access_token: 'syt_access' })
    })
    await expect(
      completeMatrixSignIn(started().callback, SUB, { fetch: partial, replaceUrl: () => {} })
    ).rejects.toMatchObject({ problem: 'unreadable' })
    expect(calls).toEqual([`${HS}/_matrix/client/v3/login`, `${HS}/_matrix/client/v3/logout`])
    const html = vi.fn<typeof globalThis.fetch>(async () => new Response('<html>', { status: 200 }))
    await expect(
      completeMatrixSignIn(started().callback, SUB, { fetch: html, replaceUrl: () => {} })
    ).rejects.toMatchObject({ problem: 'unreadable' })
  })

  it('still signs in when the browser blocks storage for the device id', async () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    } as unknown as Storage
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(200, login))
    const { session } = await completeMatrixSignIn(started().callback, SUB, {
      fetch,
      localStorage: blocked,
      replaceUrl: () => {},
    })
    expect(session.deviceId).toBe('KODERADEV')
  })
})

describe('refreshing the access token', () => {
  it('returns the rotated pair', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json(200, { access_token: 'syt_next', refresh_token: 'syr_next' })
    )
    expect(await refreshMatrixToken(HS, 'syr_refresh', { fetch })).toEqual({
      accessToken: 'syt_next',
      refreshToken: 'syr_next',
    })
    expect(fetch.mock.calls[0]![0]).toBe(`${HS}/_matrix/client/v3/refresh`)
  })

  it('reports a refused refresh token as RefreshRefused, and nothing else as one', async () => {
    const refused = vi.fn<typeof globalThis.fetch>(async () =>
      json(401, { errcode: 'M_UNKNOWN_TOKEN' })
    )
    await expect(refreshMatrixToken(HS, 'x', { fetch: refused })).rejects.toBeInstanceOf(
      RefreshRefused
    )
    const rotated = vi.fn<typeof globalThis.fetch>(async () =>
      json(403, { errcode: 'M_FORBIDDEN' })
    )
    await expect(refreshMatrixToken(HS, 'x', { fetch: rotated })).rejects.toBeInstanceOf(
      RefreshRefused
    )
    const down = vi.fn<typeof globalThis.fetch>(async () => json(502, {}))
    const outage = refreshMatrixToken(HS, 'x', { fetch: down })
    await expect(outage).rejects.toThrow('502')
    await expect(outage).rejects.not.toBeInstanceOf(RefreshRefused)
    const offline = new TypeError('fetch failed')
    const unreachable = vi.fn<typeof globalThis.fetch>(async () => Promise.reject(offline))
    await expect(refreshMatrixToken(HS, 'x', { fetch: unreachable })).rejects.toBe(offline)
  })
})

describe('signing out', () => {
  it('forgets the device and signs it out of Synapse, without failing when Synapse is away', async () => {
    window.localStorage.setItem(DEVICE, 'KODERADEV')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Promise.reject(new TypeError('x')))
    await expect(signOutOfMatrix(HS, 'syt_now', { fetch })).resolves.toBeUndefined()
    expect(window.localStorage.getItem(DEVICE)).toBeNull()
    expect(fetch.mock.calls[0]![0]).toBe(`${HS}/_matrix/client/v3/logout`)
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).get('Authorization')).toBe(
      'Bearer syt_now'
    )
  })

  it('tracks the latest refreshed access token in memory and clears it immediately on takeMatrixSessionForSignOut', async () => {
    const { callback } = started()
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input).endsWith('/login')) return json(200, login)
      if (String(input).endsWith('/refresh')) {
        return json(200, { access_token: 'syt_rotated_2', refresh_token: 'syr_rotated_2' })
      }
      return json(200, {})
    })
    const { session } = await completeMatrixSignIn(callback, SUB, {
      fetch,
      replaceUrl: () => undefined,
    })
    expect(getMatrixSession()).toBe(session)

    const onClear = vi.fn()
    registerMatrixSession(session, onClear)
    await session.refresh(session.refreshToken)
    expect(getMatrixSession()?.accessToken).toBe('syt_rotated_2')
    expect(getMatrixSession()?.refreshToken).toBe('syr_rotated_2')

    const taken = takeMatrixSessionForSignOut()
    expect(taken).toEqual({ baseUrl: HS, accessToken: 'syt_rotated_2' })
    expect(getMatrixSession()).toBeUndefined()
    expect(onClear).toHaveBeenCalledTimes(1)
    expect(takeMatrixSessionForSignOut()).toBeUndefined()
  })

  it('revokes an in-flight login token and stays signed out when sign-out happens before /login resolves', async () => {
    const { callback } = started()
    const calls: string[] = []
    let resolveLogin!: (res: Response) => void
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      calls.push(String(input))
      if (String(input).endsWith('/login')) {
        return new Promise<Response>((resolve) => {
          resolveLogin = resolve
        })
      }
      return Promise.resolve(json(200, {}))
    })

    const inFlight = completeMatrixSignIn(callback, SUB, {
      fetch,
      replaceUrl: () => undefined,
    })

    // User signs out of Console while Synapse /login is still in flight.
    expect(takeMatrixSessionForSignOut()).toBeUndefined()

    resolveLogin(json(200, login))
    await expect(inFlight).rejects.toMatchObject({ problem: 'unexpected-callback' })
    expect(calls).toEqual([`${HS}/_matrix/client/v3/login`, `${HS}/_matrix/client/v3/logout`])
    expect(getMatrixSession()).toBeUndefined()
    expect(window.localStorage.getItem(DEVICE)).toBeNull()
  })
})

it('draft_subscription_does_not_register_or_advance_session', async () => {
  const stamp = getMatrixRegistrationStamp()
  const listener = vi.fn()
  const remove = subscribeMatrixSession(listener)
  expect(getMatrixRegistrationStamp()).toBe(stamp)
  remove()
  expect(getMatrixRegistrationStamp()).toBe(stamp)
  let release!: (value: Response) => void
  let held = false
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    if (String(input).endsWith('/login')) return json(200, login)
    if (held)
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    return json(200, { access_token: 'current-rotated', refresh_token: 'current-refresh' })
  })
  const { session } = await completeMatrixSignIn(started().callback, SUB, {
    fetch,
    replaceUrl: () => {},
  })
  const registered = getMatrixRegistrationStamp()
  await session.refresh(session.refreshToken)
  expect(session.accessToken).toBe('current-rotated')
  expect(getMatrixRegistrationStamp()).toBe(registered)
  held = true
  const pending = session.refresh(session.refreshToken)
  try {
    await Promise.resolve()
    registerMatrixSession(session)
    const replacement = getMatrixRegistrationStamp()
    expect(replacement).not.toBe(registered)
    release(json(200, { access_token: 'retired-response' }))
    await pending
    expect(session.accessToken).toBe('current-rotated')
    expect(getMatrixRegistrationStamp()).toBe(replacement)
  } finally {
    release(json(200, {}))
    await pending.catch(() => undefined)
  }
  const refused = session.refresh(session.refreshToken).catch((error: unknown) => error)
  try {
    await Promise.resolve()
    registerMatrixSession(session)
    release(json(401, {}))
    expect(await refused).toBeInstanceOf(RefreshRefused)
    expect(getMatrixSession()).toBe(session)
  } finally {
    release(json(401, {}))
    await refused
  }
})

it('draft_subscription_removal_is_per_registration_and_reentrant', () => {
  const a = {
    baseUrl: HS,
    userId: login.user_id,
    deviceId: 'a',
    accessToken: 'a',
    refreshToken: 'r',
    refresh: vi.fn(),
  }
  const b = { ...a, deviceId: 'b' }
  let depth = 0,
    maximum = 0,
    reenter = false,
    removeOnLatest = false
  const duplicate = vi.fn()
  const removeOne = subscribeMatrixSession(duplicate)
  const removeTwo = subscribeMatrixSession(duplicate)
  let removeEarly = () => {},
    removeLast = () => {},
    removeLate = () => {},
    removeSurviving = () => {}
  try {
    registerMatrixSession(a)
    expect(duplicate).toHaveBeenCalledTimes(2)
    removeOne()
    registerMatrixSession(a)
    expect(duplicate).toHaveBeenCalledTimes(3)
    const late = vi.fn()
    removeEarly = subscribeMatrixSession(() => {
      depth++
      maximum = Math.max(maximum, depth)
      if (removeOnLatest) {
        // This queued pass already captured removeLast's still-active record.
        removeOnLatest = false
        removeLast()
      } else if (reenter) {
        reenter = false
        registerMatrixSession(b)
        registerMatrixSession(a)
        removeOnLatest = true
        removeLate = subscribeMatrixSession(late)
      }
      depth--
    })
    const seen: object[] = []
    removeLast = subscribeMatrixSession(() => seen.push(getMatrixRegistrationStamp()))
    const surviving: object[] = []
    removeSurviving = subscribeMatrixSession(() => surviving.push(getMatrixRegistrationStamp()))
    const prior = getMatrixRegistrationStamp()
    reenter = true
    registerMatrixSession(a)
    expect(getMatrixRegistrationStamp()).not.toBe(prior)
    expect(seen).toEqual([])
    expect(surviving).toEqual([getMatrixRegistrationStamp()])
    expect(late).not.toHaveBeenCalled()
    registerMatrixSession(a)
    expect(late).toHaveBeenCalledTimes(1)
    expect(maximum).toBe(1)
    removeOne()
    removeTwo()
    removeEarly()
    removeLast()
    removeLate()
    removeSurviving()
  } finally {
    removeOne()
    removeTwo()
    removeEarly()
    removeLast()
    removeLate()
    removeSurviving()
  }
})

it('draft_clear_failure_preserves_target_and_all_cleanup', async () => {
  const session = {
    baseUrl: HS,
    userId: login.user_id,
    deviceId: 'device',
    accessToken: 'captured',
    refreshToken: 'r',
    refresh: vi.fn(),
  }
  const before = getMatrixRegistrationStamp()
  let legacyObservedEmpty = false
  let legacyObservedStamp: object | undefined
  const stop = vi.fn(() => {
    legacyObservedEmpty = getMatrixSession() === undefined
    legacyObservedStamp = getMatrixRegistrationStamp()
    clearMatrixSession()
    throw new Error('private legacy')
  })
  registerMatrixSession(session, stop)
  const observations: unknown[] = []
  const removeThrow = subscribeMatrixSession(() => {
    throw new Error('private observer')
  })
  const remove = subscribeMatrixSession(() => observations.push(getMatrixSession()))
  const take = prepareMatrixSessionForSignOut()
  expect(take()).toEqual({ baseUrl: HS, accessToken: 'captured' })
  expect(take()).toBeUndefined()
  expect(stop).toHaveBeenCalledTimes(1)
  expect(legacyObservedEmpty).toBe(true)
  expect(legacyObservedStamp).toBe(getMatrixRegistrationStamp())
  expect(observations).toEqual([undefined])
  const emptyStamp = getMatrixRegistrationStamp()
  expect(emptyStamp).not.toBe(before)
  clearMatrixSession()
  expect(getMatrixRegistrationStamp()).not.toBe(emptyStamp)
  removeThrow()
  remove()
  const removeRecursive = subscribeMatrixSession(() => clearMatrixSession())
  try {
    registerMatrixSession(session)
    expect(getMatrixSession()).toBeUndefined()
  } finally {
    removeRecursive()
  }
  let release!: (response: Response) => void
  const calls: string[] = []
  const fetch = vi.fn<typeof globalThis.fetch>((input) => {
    calls.push(String(input))
    return String(input).endsWith('/login')
      ? new Promise<Response>((resolve) => {
          release = resolve
        })
      : Promise.resolve(json(200, {}))
  })
  const pending = completeMatrixSignIn(started().callback, SUB, {
    fetch,
    replaceUrl: () => {},
  }).catch((error: unknown) => error)
  try {
    clearMatrixSession()
    release(json(200, login))
    expect(await pending).toMatchObject({ problem: 'unexpected-callback' })
    expect(calls).toEqual([`${HS}/_matrix/client/v3/login`, `${HS}/_matrix/client/v3/logout`])
  } finally {
    release(json(200, login))
    await pending
  }
})

it('draft_reentrant_replacement_survives_old_target_logout', async () => {
  const session = {
    baseUrl: HS,
    userId: login.user_id,
    deviceId: 'device',
    accessToken: 'old-target',
    refreshToken: 'r',
    refresh: vi.fn(),
  }
  const replacementStop = vi.fn()
  registerMatrixSession(session, () => {
    session.accessToken = 'new-target'
    registerMatrixSession(session, replacementStop)
  })
  const stamp = getMatrixRegistrationStamp()
  const take = prepareMatrixSessionForSignOut()
  const target = take()!
  expect(target).toEqual({ baseUrl: HS, accessToken: 'old-target' })
  expect(take()).toBeUndefined()
  expect(getMatrixSession()).toBe(session)
  expect(getMatrixRegistrationStamp()).not.toBe(stamp)
  await signOutOfMatrix(target.baseUrl, target.accessToken, {
    fetch: vi.fn(async () => json(200, {})),
  })
  expect(getMatrixSession()).toBe(session)
  expect(replacementStop).not.toHaveBeenCalled()
  clearMatrixSession()
  expect(replacementStop).toHaveBeenCalledTimes(1)
})
