// Espace's sign-in to the organisation's Synapse (messaging-pilot design §2.4, E7). The member
// already holds a Keycloak session, so Synapse's SSO login is a redirect with no prompt:
//
// 1. `beginMatrixSignIn` sends the whole page to Synapse's SSO redirect. Synapse sends it on to
//    Keycloak, and Keycloak back to Synapse.
// 2. Synapse returns the browser to the Console's callback with a single-use `loginToken`. The
//    Console's origin is in Synapse's `sso.client_whitelist`, so Synapse asks nothing.
// 3. `completeMatrixSignIn` removes the token from the address bar, checks the round trip is the
//    one this tab started, and exchanges the token for a refreshable access token.
//
// What is stored, and where:
// - The access and refresh tokens live in memory only (console ADR-0007). Synapse makes access
//   tokens expire within minutes, so a token left behind by a reload dies on its own.
// - The Matrix `device_id`, which is not a secret, goes to `localStorage`, so a reload signs in
//   again on the same device rather than adding one each time.
// - For the length of the redirect only, `sessionStorage` holds a random `state` and the path to
//   return to, as `oidc.ts` keeps its PKCE state. They are read once and removed.
//
// Every key starts with `kodera.web.`, so the Console's sign-out clears them
// (`localSession.ts`).
//
// The round trip proves the tab started it; it does not prove who signed in. Synapse signs in
// whoever holds the browser's Keycloak session, so the Matrix ID must be the Console member's own
// (`expectedSub`), or the token is handed back.
//
// The callback runs before the router's organisation guard: a guard that remembered the URL to
// return to would put the login token into `sessionStorage` before it is removed.
//
// One device per homeserver per browser: two tabs share it, and signing out in one ends the
// other's session too, since Synapse's `/logout` deletes the device.

const DEVICE_KEY = 'kodera.web.espace.device:'
/**
 * The Console page Synapse returns to. Every tenant's `sso.client_whitelist` names the Console's
 * origin (ADR-0009) with a trailing `/`: Synapse matches by prefix, and without the slash
 * `https://app.kodera.io.elsewhere.example/` would receive the login token too.
 */
export const MATRIX_CALLBACK_PATH = '/espace/callback'
/** Signing out never waits on the homeserver longer than this. */
const SIGN_OUT_WAIT_MS = 3_000
const PENDING_KEY = 'kodera.web.espace.signin'
/** How Synapse lists the Console's devices to the member. */
const DEVICE_NAME = 'Kodera'

/** The homeserver refused the refresh token: the session is over. */
export class RefreshRefused extends Error {
  constructor(message = 'The homeserver refused the refresh token.') {
    super(message)
    this.name = 'RefreshRefused'
  }
}

export type MatrixSignInProblem =
  /** The callback was not the end of a sign-in this tab started. */
  | 'unexpected-callback'
  /** Synapse refused the login token: used already, expired, or not its own. */
  | 'refused'
  /** Synapse issued an access token that does not expire. */
  | 'not-refreshable'
  /** Synapse signed in someone other than the Console's member: another Keycloak session. */
  | 'other-person'
  /** Synapse answered something other than a login. */
  | 'unreadable'

export class MatrixSignInFailed extends Error {
  constructor(readonly problem: MatrixSignInProblem) {
    super(`The sign-in to the workspace's homeserver failed: ${problem}.`)
    this.name = 'MatrixSignInFailed'
  }
}

/** A Synapse access token, and how to buy the next one. The shape Espace's store takes. */
export interface MatrixSession {
  baseUrl: string
  userId: string
  deviceId: string
  accessToken: string
  refreshToken: string
  refresh: (refreshToken: string) => Promise<{ accessToken: string; refreshToken?: string }>
}

let activeSession: MatrixSession | undefined
let activeSessionStop: (() => void) | undefined
let sessionGeneration = 0
let registrationStamp: object = {}
let registrationRevision = 0
let deliveredRevision = -1
let clearedRevision = -1
let dispatching = false
let queued = false
let clearDepth = 0
let observerFailures = 0
const sessionListeners = new Set<{ listener: () => void; active: boolean; added: number }>()

function containMatrixCallback(callback: (() => void) | undefined): void {
  try {
    callback?.()
  } catch {
    observerFailures = Math.min(observerFailures + 1, 1000)
  }
}

function publishMatrixSession(): void {
  if (!dispatching && deliveredRevision === registrationRevision) return
  queued = true
  if (dispatching) return
  dispatching = true
  try {
    while (queued) {
      queued = false
      const revision = registrationRevision
      const records = [...sessionListeners]
      for (const record of records) {
        if (revision !== registrationRevision) break
        if (record.active && record.added < revision) containMatrixCallback(record.listener)
      }
      if (revision === registrationRevision) deliveredRevision = revision
    }
  } finally {
    dispatching = false
  }
}

export function getMatrixSession(): MatrixSession | undefined {
  return activeSession
}

/** Opaque registration identity; never contains credentials or user metadata. */
export function getMatrixRegistrationStamp(): object {
  return registrationStamp
}

export function subscribeMatrixSession(listener: () => void): () => void {
  const record = { listener, active: true, added: registrationRevision }
  sessionListeners.add(record)
  return () => {
    if (!record.active) return
    record.active = false
    sessionListeners.delete(record)
  }
}

export function registerMatrixSession(session: MatrixSession, onClear?: () => void): void {
  sessionGeneration += 1
  registrationRevision += 1
  registrationStamp = {}
  activeSession = session
  activeSessionStop = onClear
  publishMatrixSession()
}

export function clearMatrixSession(): void {
  if (
    activeSession === undefined &&
    (clearDepth > 0 || (dispatching && clearedRevision === registrationRevision))
  )
    return
  sessionGeneration += 1
  registrationRevision += 1
  registrationStamp = {}
  clearedRevision = registrationRevision
  const stop = activeSessionStop
  activeSession = undefined
  activeSessionStop = undefined
  clearDepth += 1
  try {
    containMatrixCallback(stop)
    publishMatrixSession()
  } finally {
    clearDepth -= 1
  }
}

/** Captures the exact registration and primitive revocation target before callbacks. */
export function prepareMatrixSessionForSignOut(): () =>
  { baseUrl: string; accessToken: string } | undefined {
  let captured = activeSession
  let stamp: object | undefined = registrationStamp
  let target =
    captured === undefined
      ? undefined
      : { baseUrl: captured.baseUrl, accessToken: captured.accessToken }
  let spent = false
  return () => {
    if (spent) return undefined
    spent = true
    const pair = target
    try {
      if (registrationStamp === stamp && activeSession === captured) clearMatrixSession()
      return pair
    } finally {
      captured = undefined
      stamp = undefined
      target = undefined
    }
  }
}

export function takeMatrixSessionForSignOut():
  { baseUrl: string; accessToken: string } | undefined {
  return prepareMatrixSessionForSignOut()()
}

interface Dependencies {
  fetch?: typeof fetch
  /** The Console's origin; the page's own by default. */
  consoleOrigin?: string
  sessionStorage?: Storage
  localStorage?: Storage
}

const network = (deps: Dependencies): typeof fetch =>
  deps.fetch ?? globalThis.fetch.bind(globalThis)

/**
 * The homeserver's origin. Its client-server API is the only path this file calls on it, so a
 * path, a query or credentials in the URL are refused rather than dropped. Plain HTTP is only
 * for a homeserver on this machine (the test stack), in development.
 */
export function homeserverOrigin(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error('The homeserver URL is not a URL.')
  }
  // Plain HTTP on this machine is for the development stack, never a production build.
  const loopback = import.meta.env.DEV && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (
    !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('The homeserver URL must be an https origin.')
  }
  return url.origin
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

interface Pending {
  state: string
  baseUrl: string
  returnTo: string
}

/**
 * Starts the sign-in: records the round trip and sends the page to Synapse's SSO login.
 *
 * @param baseUrl the homeserver, as Core names it for the workspace
 * @param returnTo the Console path to show once signed in
 */
export function beginMatrixSignIn(
  baseUrl: string,
  returnTo: string,
  deps: Dependencies & { navigate?: (url: string) => void } = {}
): void {
  const origin = homeserverOrigin(baseUrl)
  const state = randomState()
  const pending: Pending = { state, baseUrl: origin, returnTo }
  ;(deps.sessionStorage ?? window.sessionStorage).setItem(PENDING_KEY, JSON.stringify(pending))
  const back = new URL(MATRIX_CALLBACK_PATH, deps.consoleOrigin ?? window.location.origin)
  back.searchParams.set('state', state)
  const target = `${origin}/_matrix/client/v3/login/sso/redirect?redirectUrl=${encodeURIComponent(back.href)}`
  ;(deps.navigate ?? ((url: string) => window.location.assign(url)))(target)
}

function readPending(storage: Storage): Pending | null {
  const raw = storage.getItem(PENDING_KEY)
  storage.removeItem(PENDING_KEY)
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as Partial<Pending>
    return typeof value.state === 'string' &&
      typeof value.baseUrl === 'string' &&
      typeof value.returnTo === 'string'
      ? (value as Pending)
      : null
  } catch {
    return null
  }
}

async function post(
  call: typeof fetch,
  url: string,
  body: unknown,
  accessToken?: string,
  signal?: AbortSignal
): Promise<Response> {
  return call(url, {
    method: 'POST',
    ...(signal === undefined ? {} : { signal }),
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` }),
    },
    body: JSON.stringify(body),
  })
}

/**
 * Buys a new access token. Rejects with `RefreshRefused` when Synapse refuses the refresh token,
 * and with any other error when it could not be asked, so that only a refusal ends the session.
 */
export async function refreshMatrixToken(
  baseUrl: string,
  refreshToken: string,
  deps: Dependencies = {}
): Promise<{ accessToken: string; refreshToken?: string }> {
  const response = await post(
    network(deps),
    `${homeserverOrigin(baseUrl)}/_matrix/client/v3/refresh`,
    { refresh_token: refreshToken }
  )
  // Synapse answers 401 M_UNKNOWN_TOKEN to a refresh token it does not know, and 403 to one
  // rotated away, expired, or whose session ended.
  if (response.status === 401 || response.status === 403) throw new RefreshRefused()
  if (!response.ok) throw new Error(`The homeserver could not refresh: ${response.status}.`)
  const body = (await response.json()) as { access_token?: unknown; refresh_token?: unknown }
  if (typeof body.access_token !== 'string') throw new Error('The homeserver sent no token.')
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
  }
}

/**
 * Ends the sign-in Synapse returned to: removes the login token from the address bar, checks the
 * round trip, and exchanges the token for a session.
 *
 * @param href the callback's full URL, `window.location.href`
 * @param expectedSub the Console member's Keycloak `sub`, which Synapse's Matrix ID is made of
 * @returns the session, and the Console path the member was on
 */
export async function completeMatrixSignIn(
  href: string,
  expectedSub: string,
  deps: Dependencies & { replaceUrl?: (url: string) => void } = {}
): Promise<{ session: MatrixSession; returnTo: string }> {
  const url = new URL(href)
  const loginToken = url.searchParams.get('loginToken')
  const state = url.searchParams.get('state')
  // First of all: the token must not stay in the address bar or the history.
  url.searchParams.delete('loginToken')
  url.searchParams.delete('state')
  ;(deps.replaceUrl ?? ((clean: string) => window.history.replaceState(null, '', clean)))(url.href)

  const pending = readPending(deps.sessionStorage ?? window.sessionStorage)
  if (pending === null || loginToken === null || state !== pending.state) {
    throw new MatrixSignInFailed('unexpected-callback')
  }
  // Only a sign-in this tab started replaces the session. A callback opened again with nothing
  // pending (« back » onto it) leaves the live one alone.
  clearMatrixSession()
  const generation = sessionGeneration

  const call = network(deps)
  const local = deps.localStorage ?? window.localStorage
  const deviceKey = DEVICE_KEY + pending.baseUrl
  let deviceId: string | null = null
  try {
    deviceId = local.getItem(deviceKey)
  } catch {
    // Storage blocked: a new device, which is all it costs.
  }
  const response = await post(call, `${pending.baseUrl}/_matrix/client/v3/login`, {
    type: 'm.login.token',
    token: loginToken,
    refresh_token: true,
    initial_device_display_name: DEVICE_NAME,
    ...(deviceId === null ? {} : { device_id: deviceId }),
  })
  if (response.status === 401 || response.status === 403) throw new MatrixSignInFailed('refused')
  if (!response.ok) throw new MatrixSignInFailed('unreadable')
  let body: Record<string, unknown>
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch {
    throw new MatrixSignInFailed('unreadable')
  }
  const { user_id: userId, access_token: accessToken, device_id: device } = body
  // Whatever goes wrong from here, a token Synapse issued must not live on: give it back.
  const refuse = async (problem: MatrixSignInProblem): Promise<never> => {
    if (typeof accessToken === 'string') await logout(call, pending.baseUrl, accessToken)
    throw new MatrixSignInFailed(problem)
  }
  if (sessionGeneration !== generation) {
    return refuse('unexpected-callback')
  }
  if (typeof userId !== 'string' || typeof accessToken !== 'string' || typeof device !== 'string') {
    return refuse('unreadable')
  }
  // `@{sub}:{server name}`: the localpart is exactly the member's `sub`. A Keycloak `sub` that
  // Synapse has to escape (a federated user's `f:…`) never matches, and fails closed.
  const separator = userId.indexOf(':')
  if (separator < 2 || !userId.startsWith('@') || userId.slice(1, separator) !== expectedSub) {
    return refuse('other-person')
  }
  if (typeof body['refresh_token'] !== 'string') return refuse('not-refreshable')
  try {
    local.setItem(deviceKey, device)
  } catch {
    // Storage blocked: the next reload adds a device.
  }
  const baseUrl = pending.baseUrl
  const session: MatrixSession = {
    baseUrl,
    userId,
    deviceId: device,
    accessToken,
    refreshToken: body['refresh_token'],
    refresh: async (token) => {
      const admittedStamp = registrationStamp
      try {
        const refreshed = await refreshMatrixToken(baseUrl, token, deps)
        if (activeSession === session && registrationStamp === admittedStamp) {
          session.accessToken = refreshed.accessToken
          if (refreshed.refreshToken !== undefined) {
            session.refreshToken = refreshed.refreshToken
          }
        }
        return refreshed
      } catch (err) {
        if (
          err instanceof RefreshRefused &&
          activeSession === session &&
          registrationStamp === admittedStamp
        ) {
          clearMatrixSession()
        }
        throw err
      }
    },
  }
  registerMatrixSession(session)
  return {
    returnTo: pending.returnTo,
    session,
  }
}

/**
 * Signs the device out of Synapse, which revokes its tokens, and forgets the device. Best effort:
 * the Console's own sign-out must not wait on the homeserver.
 *
 * @param accessToken the token in use now, which the store may have refreshed since sign-in
 */
export async function signOutOfMatrix(
  baseUrl: string,
  accessToken: string,
  deps: Dependencies = {}
): Promise<void> {
  // An explicit captured target never clears a later active registration.
  const origin = homeserverOrigin(baseUrl)
  try {
    ;(deps.localStorage ?? window.localStorage).removeItem(DEVICE_KEY + origin)
  } catch {
    // Storage blocked: nothing was kept.
  }
  await logout(network(deps), origin, accessToken)
}

/** Signs a token's device out of Synapse, best effort and briefly. */
async function logout(call: typeof fetch, origin: string, accessToken: string): Promise<void> {
  await post(
    call,
    `${origin}/_matrix/client/v3/logout`,
    {},
    accessToken,
    AbortSignal.timeout(SIGN_OUT_WAIT_MS)
  ).catch(() => undefined)
}
