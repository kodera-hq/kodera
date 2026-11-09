import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Script } from 'node:vm'
import * as ts from 'typescript'
import * as sdk from 'oidc-client-ts'
import type {
  INavigator,
  NavigateParams,
  NavigateResponse,
  User,
  UserManager,
  UserManagerSettings,
} from 'oidc-client-ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthAdapter, AuthCallbackResult } from './AuthAdapter'
import { OidcAuthAdapter } from './oidc'

type Context = Readonly<{
  purpose: 'owner-claim' | 'invitation'
  intentId: string
  organisationId: string
  organisationSlug: string
  realm: string
}>
type Operation = { readonly completed: Promise<void>; cancel(): void }
type Capability = { begin(context: Context): Operation; notifyCallback(): Promise<void> }
type Adapter = AuthAdapter & { readonly ownerClaimAuth?: Capability }
type Constructor = new () => Adapter
type Outcome<Value> = { ok: true; value: Value } | { ok: false; error: unknown }
type Loaded = Parameters<UserManager['events']['addUserLoaded']>[0]
type Expiring = Parameters<UserManager['events']['addAccessTokenExpiring']>[0]
type Control = 'B-M01' | 'B-M02' | 'B-M03'

const slot = vi.hoisted(() => ({ current: undefined as Fixture | undefined }))

vi.mock('oidc-client-ts', async (importOriginal) => {
  const actual = await importOriginal<typeof sdk>()
  class OwnedManager extends actual.UserManager {
    constructor(settings: UserManagerSettings) {
      const fixture = slot.current
      if (!fixture) throw new Error('B_FIXTURE_MISSING')
      const owner: { manager?: UserManager } = {}
      super(settings, fixture.redirect(), fixture.navigator(owner), fixture.silent())
      owner.manager = this
      fixture.track(this)
    }
  }
  return { ...actual, UserManager: OwnedManager }
})

const provider = 'https://id.example.test'
const issuer = `${provider}/realms/acme-sa`
const context: Context = Object.freeze({
  purpose: 'owner-claim',
  intentId: 'intent-one',
  organisationId: '11111111-1111-4111-8111-111111111111',
  organisationSlug: 'claim-org',
  realm: 'acme-sa',
})
const realmKey = 'kodera.web.auth.realm'
const returnKey = 'kodera.web.auth.returnTo'
const importedConstructor: Constructor = OidcAuthAdapter
const adapterSourcePath = join(import.meta.dirname, 'oidc.ts')
const adapterSourceBytes = readFileSync(adapterSourcePath, 'utf8')

function latch<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

function outcome<Value>(promise: Promise<Value>): Promise<Outcome<Value>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  )
}

function capability(adapter: Adapter): Capability {
  expect(adapter.ownerClaimAuth, 'B_CAPABILITY_PRESENT').toBeDefined()
  if (!adapter.ownerClaimAuth) throw new Error('B_CAPABILITY_PRESENT')
  return adapter.ownerClaimAuth
}

function token(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.synthetic`
}

interface Handle {
  manager: UserManager
  settings: UserManager['settings']
  navigation: ReturnType<typeof latch<NavigateParams>>
  response: ReturnType<typeof latch<NavigateResponse>>
  loaded: ReturnType<typeof latch<void>>
  release: ReturnType<typeof latch<void>>
  observer: Loaded
  abort: (() => void) | undefined
  signal: AbortSignal | undefined
  closed: boolean
  delivered: boolean
}

class Fixture {
  readonly adapters = new Set<Adapter>()
  readonly managers = new Set<UserManager>()
  readonly handles: Handle[] = []
  readonly calls: Promise<Outcome<User>>[] = []
  readonly removals: Promise<Outcome<void>>[] = []
  readonly operations: Promise<Outcome<void>>[] = []
  readonly registrations = new Map<UserManager, { loaded: Set<Loaded>; expiring: Set<Expiring> }>()
  readonly navigations = Array.from({ length: 4 }, () => latch<Handle>())
  readonly tokenStarted = latch<void>()
  readonly tokenRelease = latch<void>()
  readonly notifications: { handle: Handle | undefined; url: string }[] = []
  readonly initialTimers = vi.getTimerCount()
  readonly claims: Record<string, unknown>
  holdLoaded = false
  holdToken = false
  holdNotification = false
  tokenRequests = 0
  silentCalls = 0
  redirectCalls = 0
  unexpected = 0
  settled = 0
  delivery: Handle | undefined

  constructor(
    readonly Constructor: Constructor = importedConstructor,
    readonly base = '/'
  ) {
    slot.current = this
    const now = Math.floor(Date.now() / 1000)
    this.claims = { iss: issuer, sub: 'subject-one', aud: 'console', iat: now, exp: now + 300 }
    vi.stubEnv('VITE_KEYCLOAK_URL', provider)
    vi.stubEnv('VITE_OIDC_CLIENT_ID', 'console')
    vi.stubEnv('BASE_URL', base)
    vi.stubGlobal('fetch', vi.fn(this.fetch.bind(this)))
    vi.spyOn(window, 'open').mockImplementation(() => {
      this.unexpected += 1
      throw new Error('B_NATIVE_WINDOW_UNEXPECTED')
    })
  }

  create(): Adapter {
    const adapter = new this.Constructor()
    this.adapters.add(adapter)
    return adapter
  }

  begin(adapter: Adapter, value = context): Operation {
    const operation = capability(adapter).begin(value)
    this.operations.push(outcome(operation.completed))
    return operation
  }

  track(manager: UserManager): void {
    if (this.managers.size >= 6) throw new Error('B_MANAGER_CAP')
    this.managers.add(manager)
    const registrations = { loaded: new Set<Loaded>(), expiring: new Set<Expiring>() }
    this.registrations.set(manager, registrations)
    const addLoaded = manager.events.addUserLoaded.bind(manager.events)
    const removeLoaded = manager.events.removeUserLoaded.bind(manager.events)
    const addExpiring = manager.events.addAccessTokenExpiring.bind(manager.events)
    const removeExpiring = manager.events.removeAccessTokenExpiring.bind(manager.events)
    vi.spyOn(manager.events, 'addUserLoaded').mockImplementation((listener) => {
      registrations.loaded.add(listener)
      const unsubscribe = addLoaded(listener)
      return () => {
        registrations.loaded.delete(listener)
        unsubscribe()
      }
    })
    vi.spyOn(manager.events, 'removeUserLoaded').mockImplementation((listener) => {
      registrations.loaded.delete(listener)
      removeLoaded(listener)
    })
    vi.spyOn(manager.events, 'addAccessTokenExpiring').mockImplementation((listener) => {
      registrations.expiring.add(listener)
      const unsubscribe = addExpiring(listener)
      return () => {
        registrations.expiring.delete(listener)
        unsubscribe()
      }
    })
    vi.spyOn(manager.events, 'removeAccessTokenExpiring').mockImplementation((listener) => {
      registrations.expiring.delete(listener)
      removeExpiring(listener)
    })
    const popup = manager.signinPopup.bind(manager)
    vi.spyOn(manager, 'signinPopup').mockImplementation((arguments_) => {
      const request = popup(arguments_)
      const observed = outcome(request)
      this.calls.push(observed)
      void observed.then(() => {
        this.settled += 1
      })
      return request
    })
    const silent = manager.signinSilent.bind(manager)
    vi.spyOn(manager, 'signinSilent').mockImplementation((arguments_) => {
      this.silentCalls += 1
      return silent(arguments_)
    })
    const redirect = manager.signinRedirect.bind(manager)
    vi.spyOn(manager, 'signinRedirect').mockImplementation((arguments_) => {
      this.redirectCalls += 1
      return redirect(arguments_)
    })
    const remove = manager.removeUser.bind(manager)
    vi.spyOn(manager, 'removeUser').mockImplementation(() => {
      const request = remove()
      this.removals.push(outcome(request))
      return request
    })
  }

  navigator(owner: { manager?: UserManager }): INavigator {
    return {
      prepare: async (parameters: unknown) => {
        const manager = owner.manager
        if (!manager || this.handles.length >= 4) throw new Error('B_NAVIGATOR_OWNER')
        const signal = (parameters as { popupSignal?: AbortSignal }).popupSignal
        const response = latch<NavigateResponse>()
        const loaded = latch<void>()
        const release = latch<void>()
        const observer: Loaded = async () => {
          loaded.resolve(undefined)
          if (this.holdLoaded) await release.promise
        }
        expect(this.registrations.get(manager)?.loaded.size, 'B_ADAPTER_WIRED_BEFORE_PREPARE').toBe(
          1
        )
        manager.events.addUserLoaded(observer)
        const handle: Handle = {
          manager,
          settings: manager.settings,
          navigation: latch<NavigateParams>(),
          response,
          loaded,
          release,
          observer,
          signal,
          abort: undefined,
          closed: false,
          delivered: false,
        }
        const detach = () => {
          if (handle.abort) handle.signal?.removeEventListener('abort', handle.abort)
          handle.abort = undefined
        }
        const close = () => {
          detach()
          handle.closed = true
          response.reject(new Error('B_NAVIGATION_CLOSED'))
        }
        if (signal) {
          handle.abort = () => {
            detach()
            response.reject(signal.reason)
          }
          signal.addEventListener('abort', handle.abort, { once: true })
          if (signal.aborted) handle.abort()
        }
        const index = this.handles.push(handle) - 1
        return {
          navigate: async (parameters_: NavigateParams) => {
            handle.navigation.resolve(parameters_)
            this.navigations[index]!.resolve(handle)
            try {
              return await response.promise
            } finally {
              close()
            }
          },
          close,
        }
      },
      callback: async (url: string) => {
        this.notifications.push({ handle: this.delivery, url })
        if (!this.holdNotification) this.deliver()
      },
    }
  }

  redirect(): INavigator {
    return {
      prepare: async () => ({
        navigate: async () => {
          throw new Error('B_CONTROLLED_REDIRECT')
        },
        close: () => {},
      }),
      callback: async () => {
        this.unexpected += 1
        throw new Error('B_REDIRECT_CALLBACK')
      },
    }
  }

  silent(): INavigator {
    return {
      prepare: async () => ({
        navigate: async () => {
          throw new Error('B_COMPETING_SILENT')
        },
        close: () => {},
      }),
      callback: async () => {
        this.unexpected += 1
        throw new Error('B_SILENT_CALLBACK')
      },
    }
  }

  async navigation(index = 0, expected: Context = context): Promise<Handle> {
    const pending = this.navigations[index]
    if (!pending) throw new Error('B_NAVIGATION_INDEX')
    const handle = await pending.promise
    const parameters = await handle.navigation.promise
    const inspected = await new sdk.OidcClient(
      handle.settings,
      handle.manager.metadataService
    ).readSigninResponseState(this.url(handle, parameters.state), false)
    expect(inspected.state.request_type, 'B_STORED_POPUP_PREREQUISITE').toBe('si:p')
    expect(inspected.state.data, 'B_STORED_CONTEXT_PREREQUISITE').toEqual(
      index === 0 ? expected : { ...expected, intentId: 'intent-two' }
    )
    return handle
  }

  url(handle: Handle, state?: string): string {
    const value = new URL(handle.settings.popup_redirect_uri!)
    if (state !== undefined) value.searchParams.set('state', state)
    value.searchParams.set('code', 'SYN')
    value.searchParams.set('request_type', 'si:r')
    return value.href
  }

  async notify(handle: Handle): Promise<Adapter> {
    this.delivery = handle
    const parameters = await handle.navigation.promise
    history.replaceState(null, '', this.url(handle, parameters.state))
    const child = this.create()
    await expect(capability(child).notifyCallback()).resolves.toBeUndefined()
    expect(child.getAccessToken()).toBeUndefined()
    expect(child.getUser()).toBeUndefined()
    expect(child.getSnapshot().status).not.toBe('ready')
    return child
  }

  deliver(): void {
    for (const notification of this.notifications) {
      if (notification.handle && !notification.handle.delivered) {
        notification.handle.delivered = true
        notification.handle.response.resolve({ url: notification.url })
      }
    }
  }

  async stored(mode: string, marker: unknown = context): Promise<string> {
    const redirect = `${window.location.origin}${this.base}auth/claim-callback`
    const settings = {
      authority: mode === 'authority' ? `${provider}/realms/other` : issuer,
      client_id: mode === 'client' ? 'other' : 'console',
      redirect_uri: mode === 'redirect' ? `${window.location.origin}/auth/callback` : redirect,
      response_type: 'code',
      scope: 'openid',
      stateStore: new sdk.WebStorageStateStore({ store: sessionStorage }),
      metadata: {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
      },
    }
    const request = await new sdk.OidcClient(settings).createSigninRequest({
      request_type: ['si:r', 'si:s', 'unknown'].includes(mode) ? mode : 'si:p',
      state: mode === 'purpose' ? { purpose: 'ordinary' } : marker,
      skipUserInfo: true,
    })
    const url = new URL(redirect)
    if (mode !== 'missing')
      url.searchParams.set('state', mode === 'unknown-state' ? 'UNKNOWN' : request.state.id)
    url.searchParams.set('code', 'SYN')
    url.searchParams.set('request_type', 'si:p')
    sessionStorage.setItem(realmKey, 'acme-sa')
    return url.href
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (typeof input !== 'string') {
      this.unexpected += 1
      throw new Error('B_FETCH_INPUT')
    }
    if (input === `${issuer}/.well-known/openid-configuration` && (init?.method ?? 'GET') === 'GET')
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
      })
    if (input !== `${issuer}/token` || init?.method !== 'POST') {
      this.unexpected += 1
      throw new Error('B_UNEXPECTED_PROVIDER_EFFECT')
    }
    const headers = new Headers(init.headers)
    expect(headers.get('Content-Type')).toMatch(/^application\/x-www-form-urlencoded(?:;|$)/)
    const body = init.body
    expect(body instanceof URLSearchParams, 'B_FORM_KIND').toBe(true)
    if (!(body instanceof URLSearchParams)) throw new Error('B_FORM_KIND')
    expect([...body.keys()].sort(), 'B_FORM_FIELDS').toEqual([
      'client_id',
      'code',
      'code_verifier',
      'grant_type',
      'redirect_uri',
    ])
    expect(body.get('client_id')).toBe('console')
    expect(body.get('code')).toBe('SYN')
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('redirect_uri')).toBe(
      `${window.location.origin}${this.base}auth/claim-callback`
    )
    expect(body.get('code_verifier')).toEqual(expect.any(String))
    expect(body.get('code_verifier')!.length).toBeGreaterThan(0)
    this.tokenRequests += 1
    expect(this.tokenRequests, 'B_TOKEN_EFFECT_CAP').toBeLessThanOrEqual(2)
    this.tokenStarted.resolve(undefined)
    if (this.holdToken) await this.tokenRelease.promise
    return Response.json({
      access_token: 'SYN_ACCESS',
      id_token: token(this.claims),
      token_type: 'Bearer',
      scope: 'openid',
      expires_in: 300,
    })
  }

  async drain(): Promise<void> {
    await Promise.all(this.calls)
    await Promise.all(this.removals)
  }

  async cleanup(): Promise<void> {
    const errors: unknown[] = []
    const attempt = async (work: () => unknown) => {
      try {
        await work()
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    this.tokenRelease.resolve(undefined)
    for (const handle of this.handles) handle.release.resolve(undefined)
    for (const handle of this.handles) {
      if (!handle.delivered) handle.response.reject(new Error('B_FIXTURE_FINALIZATION'))
    }
    for (const adapter of this.adapters) await attempt(() => adapter.signOut())
    await attempt(() => this.drain())
    await attempt(() => Promise.all(this.operations))
    for (const handle of this.handles) {
      await attempt(() => handle.manager.events.removeUserLoaded(handle.observer))
      await attempt(() => expect(handle.abort, 'B_ABORT_LISTENER_RETIRED').toBeUndefined())
      await attempt(() => expect(handle.closed, 'B_NAVIGATION_HANDLE_CLOSED').toBe(true))
    }
    for (const manager of this.managers) {
      const registrations = this.registrations.get(manager)!
      await attempt(() => expect(registrations.loaded.size, 'B_ADAPTER_LOADED_RETIRED').toBe(0))
      await attempt(() => expect(registrations.expiring.size, 'B_ADAPTER_EXPIRING_RETIRED').toBe(0))
      await attempt(() => expect(manager.stopSilentRenew).toBeDefined())
      await attempt(() => manager.stopSilentRenew())
      await attempt(() => manager.removeUser())
      await attempt(async () => expect(await manager.getUser(), 'B_SDK_USER_DRAINED').toBeNull())
      for (const listener of registrations.loaded)
        await attempt(() => manager.events.removeUserLoaded(listener))
      for (const listener of registrations.expiring)
        await attempt(() => manager.events.removeAccessTokenExpiring(listener))
    }
    await attempt(() => expect(this.unexpected, 'B_NO_UNEXPECTED_EFFECTS').toBe(0))
    await attempt(() => expect(vi.getTimerCount(), 'B_SDK_TIMERS_RETIRED').toBe(this.initialTimers))
    await attempt(() => sessionStorage.clear())
    await attempt(() => history.replaceState(null, '', '/'))
    this.notifications.length = 0
    this.handles.length = 0
    this.calls.length = 0
    this.operations.length = 0
    this.removals.length = 0
    this.managers.clear()
    this.registrations.clear()
    this.adapters.clear()
    slot.current = undefined
    if (errors.length) throw new AggregateError(errors, 'B_OWNED_CLEANUP')
  }
}

async function owned<Value>(
  Constructor_: Constructor,
  run: (fixture: Fixture) => Promise<Value>,
  base = '/'
): Promise<Value> {
  const fixture = new Fixture(Constructor_, base)
  let failed = false
  let primary: unknown
  let value!: Value
  try {
    value = await run(fixture)
  } catch (error: unknown) {
    failed = true
    primary = error
  }
  let cleanupFailed = false
  let cleanup: unknown
  try {
    await fixture.cleanup()
  } catch (error: unknown) {
    cleanupFailed = true
    cleanup = error
  }
  if (failed && cleanupFailed) throw new AggregateError([primary, cleanup], 'B_PRIMARY_AND_CLEANUP')
  if (failed) throw primary
  if (cleanupFailed) throw cleanup
  return value
}

async function pendingProbe(Constructor_: Constructor): Promise<void> {
  await owned(Constructor_, async (fixture) => {
    fixture.holdLoaded = true
    const adapter = fixture.create()
    const snapshots: string[] = []
    const unsubscribe = adapter.subscribe(() => {
      snapshots.push(adapter.getSnapshot().status)
    })
    try {
      const operation = fixture.begin(adapter)
      const handle = await fixture.navigation()
      expect(fixture.calls.length, 'B_REAL_PARENT_STARTED').toBe(1)
      await fixture.notify(handle)
      await handle.loaded.promise
      expect(adapter.getAccessToken(), 'B_PENDING_TOKEN_LEAK').toBeUndefined()
      expect(adapter.getUser(), 'B_PENDING_USER_LEAK').toBeUndefined()
      expect(adapter.getExpiresAt(), 'B_PENDING_EXPIRY_LEAK').toBeUndefined()
      expect(adapter.getSnapshot().status, 'B_PENDING_READY_LEAK').toBe('pending')
      expect(fixture.settled, 'B_PARENT_PHASE').toBe(0)
      expect(snapshots.filter((status) => status === 'ready')).toHaveLength(0)
      handle.release.resolve(undefined)
      await expect(operation.completed).resolves.toBeUndefined()
      expect(adapter.getSnapshot().status).toBe('ready')
      expect(adapter.getAccessToken()).toBe('SYN_ACCESS')
      expect(snapshots.filter((status) => status === 'ready')).toHaveLength(1)
      expect(fixture.tokenRequests).toBe(1)
    } finally {
      unsubscribe()
    }
  })
}

async function staleProbe(Constructor_: Constructor): Promise<void> {
  await owned(Constructor_, async (fixture) => {
    fixture.holdLoaded = true
    const adapter = fixture.create()
    const operation = fixture.begin(adapter)
    const completion = outcome(operation.completed)
    const handle = await fixture.navigation()
    await fixture.notify(handle)
    await handle.loaded.promise
    expect(fixture.tokenRequests, 'B_STALE_VALID_EXCHANGE').toBe(1)
    expect(fixture.settled, 'B_STALE_PENDING_PARENT').toBe(0)
    operation.cancel()
    expect(adapter.getAccessToken()).toBeUndefined()
    handle.release.resolve(undefined)
    const result = await completion
    await fixture.drain()
    expect(adapter.getAccessToken(), 'B_STALE_TOKEN_LEAK').toBeUndefined()
    expect(adapter.getSnapshot().status, 'B_STALE_READY_LEAK').not.toBe('ready')
    expect(await handle.manager.getUser(), 'B_STALE_SDK_USER_RETIRED').toBeNull()
    expect(result.ok).toBe(false)
  })
}

async function ordinaryProbe(Constructor_: Constructor): Promise<void> {
  await owned(Constructor_, async (fixture) => {
    const url = await fixture.stored('valid')
    const inspected = await new sdk.OidcClient({
      authority: issuer,
      client_id: 'console',
      redirect_uri: `${window.location.origin}/auth/claim-callback`,
      stateStore: new sdk.WebStorageStateStore({ store: sessionStorage }),
    }).readSigninResponseState(url, false)
    expect(inspected.state.request_type, 'B_ORDINARY_VALID_STATE').toBe('si:p')
    expect(inspected.state.data, 'B_ORDINARY_VALID_PURPOSE').toEqual(context)
    history.replaceState(null, '', url)
    sessionStorage.setItem(returnKey, '/preserved')
    const adapter = fixture.create()
    const completed = await outcome(adapter.handleCallback())
    expect(fixture.notifications.length, 'B_ORDINARY_PROTECTED_NOTIFY_COUNT').toBe(0)
    expect(fixture.tokenRequests).toBe(0)
    expect(sessionStorage.getItem(returnKey)).toBe('/preserved')
    expect(adapter.getAccessToken()).toBeUndefined()
    expect(adapter.getSnapshot().status).not.toBe('ready')
    expect(completed.ok).toBe(false)
  })
}

type CorrectionControl = 'B-M04' | 'B-M05' | 'B-M06' | 'B-M07' | 'B-M08' | 'B-M09' | 'B-M10'

function load(control?: Control | CorrectionControl): Constructor {
  let source = readFileSync(adapterSourcePath, 'utf8')
  expect(source, 'B_ADAPTER_SOURCE_UNCHANGED').toBe(adapterSourceBytes)
  // Harness guards on the text this test splices and transpiles, not product limits.
  expect(Buffer.byteLength(source), 'B_ADAPTER_SOURCE_CAP').toBeLessThanOrEqual(49152)
  const windows: Record<Control | CorrectionControl, readonly [string, string, string]> = {
    'B-M01': [
      '    const loaded = (user: User) => {',
      '    const expired = () => {',
      'if (this.#claim?.pending) return',
    ],
    'B-M02': [
      '  #beginOwnerClaim(',
      '  #notifyOwnerClaim(',
      "if (!this.#isCurrentClaim(operation)) throw new Error('Owner-claim sign-in cancelled.')",
    ],
    'B-M03': [
      '  handleCallback(',
      '  async signOut(',
      "if (isOwnerClaimPurpose(inspected.state.data)) throw new Error('Use the protected owner-claim callback.')",
    ],
    'B-M04': ['  handleCallback(', '  async signOut(', 'manager.signinCallback(url)'],
    'B-M05': [
      '  handleCallback(',
      '  async signOut(',
      "if (this.#manager !== manager || this.#snapshot.generation !== generation) throw new Error('The sign-in was cancelled before its callback started.')",
    ],
    'B-M06': ['    this.#claim = operation', '    return handle', 'this.#retireManager()'],
    'B-M07': [
      '  #cancelOwnerClaim(',
      '  #isCurrentClaim(',
      'window.sessionStorage.removeItem(REALM_KEY)',
    ],
    'B-M08': ['  async #signOutClaim(', '  onExpiring(', 'await claim.handle.completed'],
    'B-M09': ['    this.#claim = operation', '    return handle', 'if (this.#claim === operation)'],
    'B-M10': [
      "    if (this.#manager === undefined) this.#publish('pending', true)",
      '    this.#realm = realm',
      "if (this.#claim?.pending) return Promise.reject(new Error('Protected parent is already active.'))",
    ],
  }
  if (control) {
    const [start, finish, anchor] = windows[control]
    expect(source.split(start).length, 'B_SOURCE_WINDOW_UNIQUE').toBe(2)
    const first = source.indexOf(start)
    const last = source.indexOf(finish, first + start.length)
    expect(last, 'B_SOURCE_WINDOW_END').toBeGreaterThan(first)
    const window_ = source.slice(first, last)
    if (control === 'B-M03') {
      const statement =
        /if \(isOwnerClaimPurpose\(inspected\.state\.data\)\)[ \t\r\n]+throw new Error\('Use the protected owner-claim callback\.'\)/g
      expect([...window_.matchAll(statement)], 'B_SOURCE_ANCHOR_UNIQUE').toHaveLength(1)
      source = source.slice(0, first) + window_.replace(statement, '') + source.slice(last)
    } else if (control === 'B-M05') {
      const statement =
        /if \(this\.#manager !== manager \|\| this\.#snapshot\.generation !== generation\)[ \t\r\n]+throw new Error\('The sign-in was cancelled before its callback started\.'\)/g
      expect([...window_.matchAll(statement)], 'B_SOURCE_ANCHOR_UNIQUE').toHaveLength(1)
      source = source.slice(0, first) + window_.replace(statement, '') + source.slice(last)
    } else if (control === 'B-M10') {
      const statement =
        /if \(this\.#claim\?\.pending\)[ \t\r\n]+return Promise\.reject\(new Error\('Protected parent is already active\.'\)\)/g
      expect([...window_.matchAll(statement)], 'B_SOURCE_ANCHOR_UNIQUE').toHaveLength(1)
      source = source.slice(0, first) + window_.replace(statement, '') + source.slice(last)
    } else {
      expect(window_.split(anchor).length, 'B_SOURCE_ANCHOR_UNIQUE').toBe(2)
      source =
        source.slice(0, first) +
        window_.replace(anchor, control === 'B-M04' ? 'manager.signinCallback()' : '') +
        source.slice(last)
    }
  }
  expect(source.split('import.meta.env.BASE_URL').length, 'B_BUILD_BASE_SINGLE').toBe(2)
  source = source.replace('import.meta.env.BASE_URL', JSON.stringify('/'))
  const converted = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  })
  expect(converted.diagnostics ?? [], 'B_SOURCE_CONVERSION').toHaveLength(0)
  expect(Buffer.byteLength(converted.outputText), 'B_OUTPUT_CAP').toBeLessThanOrEqual(98304)
  const exports_: Record<string, unknown> = {}
  const allowedRequire = (specifier: string): unknown => {
    if (specifier === 'oidc-client-ts') return sdk
    if (specifier === '../config')
      return { keycloakUrl: () => provider, oidcClientId: () => 'console' }
    throw new Error('B_SOURCE_IMPORT_REFUSED')
  }
  new Script(converted.outputText, { filename: 'owned-auth-acceptance.cjs' }).runInNewContext(
    {
      exports: exports_,
      require: allowedRequire,
      window,
      document,
      URL,
      URLSearchParams,
      AbortController,
      Date,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    },
    { timeout: 1000 }
  )
  expect(typeof exports_.OidcAuthAdapter, 'B_SOURCE_EXPORT').toBe('function')
  return exports_.OidcAuthAdapter as Constructor
}

async function ordinaryUrl(): Promise<string> {
  const redirect = `${window.location.origin}/auth/callback`
  const request = await new sdk.OidcClient({
    authority: issuer,
    client_id: 'console',
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'openid',
    stateStore: new sdk.WebStorageStateStore({ store: sessionStorage }),
    metadata: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
    },
  }).createSigninRequest({ request_type: 'si:s', state: { purpose: 'ordinary' } })
  const url = new URL(redirect)
  url.searchParams.set('state', request.state.id)
  url.searchParams.set('code', 'SYN')
  sessionStorage.setItem(realmKey, 'acme-sa')
  return url.href
}

async function inspectedProbe(
  Constructor_: Constructor,
  mode: 'swap' | 'signout' | 'replacement'
): Promise<void> {
  await owned(Constructor_, async (fixture) => {
    const original = await ordinaryUrl()
    const protectedUrl = await fixture.stored('valid')
    const client = new sdk.OidcClient({
      authority: issuer,
      client_id: 'console',
      redirect_uri: `${window.location.origin}/auth/claim-callback`,
      stateStore: new sdk.WebStorageStateStore({ store: sessionStorage }),
    })
    const protectedState = await client.readSigninResponseState(protectedUrl, false)
    expect(protectedState.state.request_type, 'B_SWAP_PROTECTED_PREREQUISITE').toBe('si:p')
    expect(protectedState.state.data).toEqual(context)
    history.replaceState(null, '', original)
    const reached = latch<void>()
    const release = latch<void>()
    const read = sdk.OidcClient.prototype.readSigninResponseState
    let first = true
    const inspection = vi
      .spyOn(sdk.OidcClient.prototype, 'readSigninResponseState')
      .mockImplementation(async function (this: sdk.OidcClient, url: string, removeState = false) {
        const result = await read.call(this, url, removeState)
        if (first && url === original && !removeState) {
          first = false
          expect(result.state.request_type, 'B_SWAP_ORDINARY_PREREQUISITE').toBe('si:s')
          expect(result.state.data).toEqual({ purpose: 'ordinary' })
          reached.resolve(undefined)
          await release.promise
        }
        return result
      })
    const silent = vi.spyOn(sdk.UserManager.prototype, 'signinSilentCallback').mockResolvedValue()
    const dispatch = vi.spyOn(sdk.UserManager.prototype, 'signinCallback')
    let completion: Promise<Outcome<AuthCallbackResult>> | undefined
    let retirement: Promise<Outcome<void>> | undefined
    let failed = false
    let primary: unknown
    try {
      const adapter = fixture.create()
      completion = outcome(adapter.handleCallback())
      await reached.promise
      expect(dispatch.mock.calls.length, 'B_INSPECTION_PRE_DISPATCH').toBe(0)
      expect(fixture.tokenRequests).toBe(0)
      if (mode === 'swap') history.replaceState(null, '', protectedUrl)
      else retirement = outcome(mode === 'signout' ? adapter.signOut() : adapter.signIn('acme-sa'))
      release.resolve(undefined)
      const result = await completion
      if (retirement) await retirement
      if (mode === 'swap') {
        expect(fixture.notifications.length, 'B_INSPECTED_URL_NOTIFY_COUNT').toBe(0)
        expect(result).toEqual({ ok: true, value: 'silent' })
        expect(dispatch).toHaveBeenCalledTimes(1)
        expect(dispatch).toHaveBeenCalledWith(original)
        expect(silent).toHaveBeenCalledTimes(1)
        expect(silent).toHaveBeenCalledWith(original)
      } else {
        expect(dispatch.mock.calls.length, 'B_RETIRED_CALLBACK_DISPATCH').toBe(0)
        expect(result.ok).toBe(false)
      }
      expect(fixture.tokenRequests).toBe(0)
      expect(adapter.getAccessToken()).toBeUndefined()
    } catch (error: unknown) {
      failed = true
      primary = error
    }
    const cleanup: unknown[] = []
    const attempt = async (work: () => unknown) => {
      try {
        await work()
      } catch (error: unknown) {
        cleanup.push(error)
      }
    }
    release.resolve(undefined)
    await attempt(async () => {
      if (completion) await completion
    })
    await attempt(async () => {
      if (retirement) await retirement
    })
    await attempt(() => dispatch.mockRestore())
    await attempt(() => silent.mockRestore())
    await attempt(() => inspection.mockRestore())
    if (failed && cleanup.length)
      throw new AggregateError([primary, ...cleanup], 'B_PRIMARY_AND_CLEANUP')
    if (failed) throw primary
    if (cleanup.length) throw new AggregateError(cleanup, 'B_OWNED_CLEANUP')
  })
}

async function publicationProbe(Constructor_: Constructor, primary: unknown): Promise<void> {
  await owned(Constructor_, async (fixture) => {
    const adapter = fixture.create()
    const unsubscribe = adapter.subscribe(() => {
      if (adapter.getSnapshot().status === 'pending') throw primary
    })
    let failed = false
    let caught: unknown
    try {
      fixture.begin(adapter)
    } catch (error: unknown) {
      failed = true
      caught = error
    } finally {
      unsubscribe()
    }
    expect(failed, 'B_PUBLICATION_THROW_PREREQUISITE').toBe(true)
    expect(caught, 'B_PUBLICATION_ORIGINAL_IDENTITY').toBe(primary)
    await Promise.resolve()
    expect(fixture.calls.length, 'B_PUBLICATION_PARENT_STARTED').toBe(0)
    expect(fixture.managers.size).toBe(0)
    expect(adapter.getSnapshot().status).toBe('unauthenticated')
    expect(adapter.getAccessToken()).toBeUndefined()
  })
}

async function protectedFinalizerProbe(
  Constructor_: Constructor,
  action: 'cancel' | 'signout',
  kind: 'error' | 'undefined' | 'combined'
): Promise<void> {
  await owned(Constructor_, async (fixture) => {
    fixture.holdLoaded = true
    const adapter = fixture.create()
    const operation = fixture.begin(adapter)
    const completion = outcome(operation.completed)
    const handle = await fixture.navigation()
    await fixture.notify(handle)
    await handle.loaded.promise
    expect(fixture.tokenRequests, 'B_FINALIZER_VALID_EXCHANGE').toBe(1)
    expect(fixture.settled, 'B_FINALIZER_PENDING_PARENT').toBe(0)
    expect(sessionStorage.getItem(realmKey), 'B_FINALIZER_HINT_PREREQUISITE').toBe('acme-sa')
    const publicationError: unknown = kind === 'error' ? new Error('SYN_PUBLISH') : undefined
    const retireError = new Error('SYN_RETIRE')
    const removalPhases: number[] = []
    const removal = vi.mocked(handle.manager.removeUser)
    const remove = removal.getMockImplementation()
    expect(typeof remove, 'B_OWNED_REMOVE_IMPLEMENTATION').toBe('function')
    if (typeof remove !== 'function') throw new Error('B_OWNED_REMOVE_IMPLEMENTATION')
    removal.mockImplementation(() => {
      if (removalPhases.length >= 4) throw new Error('B_REMOVAL_PHASE_CAP')
      removalPhases.push(fixture.settled)
      return remove()
    })
    const unsubscribe = adapter.subscribe(() => {
      if (adapter.getSnapshot().status === 'unauthenticated') throw publicationError
    })
    const retiring =
      kind === 'combined'
        ? vi.spyOn(handle.manager, 'stopSilentRenew').mockImplementationOnce(() => {
            throw retireError
          })
        : undefined
    let ending: Promise<Outcome<void>> | undefined
    let failed = false
    let caught: unknown
    let caseFailed = false
    let primary: unknown
    try {
      if (action === 'signout') ending = outcome(adapter.signOut())
      else {
        try {
          operation.cancel()
        } catch (error: unknown) {
          failed = true
          caught = error
        }
      }
      if (action === 'cancel')
        expect(sessionStorage.getItem(realmKey), 'B_CANCEL_HINT_NOT_REMOVED').toBeNull()
      else
        expect(removalPhases.filter((phase) => phase === 0).length, 'B_SIGNOUT_EARLY_REMOVE').toBe(
          0
        )
      expect(adapter.getAccessToken()).toBeUndefined()
      expect(adapter.getUser()).toBeUndefined()
      expect(adapter.getSnapshot().status).toBe('unauthenticated')
      expect(sessionStorage.getItem(realmKey)).toBeNull()
      unsubscribe()
      handle.release.resolve(undefined)
      if (ending) {
        const result = await ending
        failed = !result.ok
        if (!result.ok) caught = result.error
      }
      expect((await completion).ok).toBe(false)
      await fixture.drain()
      expect(failed).toBe(true)
      if (kind === 'combined') {
        expect(caught).toBeInstanceOf(AggregateError)
        expect((caught as AggregateError).errors).toEqual([retireError, undefined])
        expect((caught as AggregateError).errors[0]).toBe(retireError)
        expect((caught as AggregateError).errors[1]).toBeUndefined()
      } else expect(caught).toBe(publicationError)
      expect(await handle.manager.getUser(), 'B_FINALIZER_RETIRED_SDK_USER').toBeNull()
    } catch (error: unknown) {
      caseFailed = true
      primary = error
    }
    const cleanup: unknown[] = []
    const attempt = async (work: () => unknown) => {
      try {
        await work()
      } catch (error: unknown) {
        cleanup.push(error)
      }
    }
    await attempt(() => unsubscribe())
    handle.release.resolve(undefined)
    await attempt(async () => {
      if (ending) await ending
    })
    await attempt(() => completion)
    await attempt(() => fixture.drain())
    await attempt(() => removal.mockImplementation(remove))
    await attempt(() => retiring?.mockRestore())
    if (caseFailed && cleanup.length)
      throw new AggregateError([primary, ...cleanup], 'B_PRIMARY_AND_CLEANUP')
    if (caseFailed) throw primary
    if (cleanup.length) throw new AggregateError(cleanup, 'B_OWNED_CLEANUP')
  })
}

async function successorProbe(Constructor_: Constructor): Promise<void> {
  await owned(Constructor_, async (fixture) => {
    const adapter = fixture.create()
    const primary = new Error('SYN_PUBLISH')
    let entered = false
    let successor: Operation | undefined
    const unsubscribe = adapter.subscribe(() => {
      if (entered || adapter.getSnapshot().status !== 'pending') return
      entered = true
      successor = fixture.begin(adapter, { ...context, intentId: 'intent-two' })
      throw primary
    })
    let failed = false
    let caught: unknown
    try {
      fixture.begin(adapter)
    } catch (error: unknown) {
      failed = true
      caught = error
    } finally {
      unsubscribe()
    }
    expect(failed, 'B_SUCCESSOR_OUTER_THROW').toBe(true)
    expect(caught).toBe(primary)
    const current = successor
    if (!current) throw new Error('B_SUCCESSOR_HANDLE_MISSING')
    expect(adapter.getSnapshot().status, 'B_FAILED_BEGIN_SUCCESSOR_RETIRED').toBe('pending')
    const handle = await fixture.navigations[0]!.promise
    const parameters = await handle.navigation.promise
    const inspected = await new sdk.OidcClient(
      handle.settings,
      handle.manager.metadataService
    ).readSigninResponseState(fixture.url(handle, parameters.state), false)
    expect(inspected.state.request_type).toBe('si:p')
    expect(inspected.state.data).toEqual({ ...context, intentId: 'intent-two' })
    expect(fixture.calls.length).toBe(1)
    await fixture.notify(handle)
    await expect(current.completed).resolves.toBeUndefined()
    expect(adapter.getSnapshot().status).toBe('ready')
    expect(fixture.tokenRequests).toBe(1)
  })
}

async function ordinaryReentryProbe(Constructor_: Constructor): Promise<void> {
  await owned(Constructor_, async (fixture) => {
    const adapter = fixture.create()
    sessionStorage.setItem(realmKey, 'acme-sa')
    history.replaceState(null, '', '/auth/callback')
    expect(new URL(window.location.href).searchParams.has('state')).toBe(false)
    expect(fixture.managers.size).toBe(0)
    expect(fixture.calls.length).toBe(0)
    let entered = false
    let ordinaryGeneration: number | undefined
    let successor: Operation | undefined
    const unsubscribe = adapter.subscribe(() => {
      if (entered || adapter.getSnapshot().status !== 'pending') return
      entered = true
      ordinaryGeneration = adapter.getSnapshot().generation
      successor = fixture.begin(adapter)
    })
    const dispatch = vi.spyOn(sdk.UserManager.prototype, 'signinCallback')
    let callback: Promise<Outcome<AuthCallbackResult>> | undefined
    let retirement: Promise<Outcome<void>> | undefined
    let failed = false
    let primary: unknown
    try {
      callback = outcome(adapter.handleCallback())
      expect(entered, 'B_REENTRY_SUBSCRIBER_PREREQUISITE').toBe(true)
      const current = successor
      if (!current) throw new Error('B_REENTRY_HANDLE_MISSING')
      expect(ordinaryGeneration).toBe(1)
      expect(dispatch.mock.calls.length, 'B_REENTRY_ORDINARY_DISPATCH').toBe(0)
      expect(adapter.getSnapshot().status).toBe('pending')
      expect(adapter.getSnapshot().generation).toBe(2)
      unsubscribe()
      expect((await callback).ok).toBe(false)
      const handle = await fixture.navigation()
      expect(fixture.calls.length).toBe(1)
      await fixture.notify(handle)
      await expect(current.completed).resolves.toBeUndefined()
      expect(adapter.getSnapshot().status).toBe('ready')
      expect(adapter.getAccessToken()).toBe('SYN_ACCESS')
      expect(fixture.tokenRequests).toBe(1)
      expect(dispatch.mock.calls.length).toBe(0)
    } catch (error: unknown) {
      failed = true
      primary = error
    }
    const cleanup: unknown[] = []
    if (failed) {
      try {
        unsubscribe()
      } catch (error: unknown) {
        cleanup.push(error)
      }
      try {
        retirement = outcome(adapter.signOut())
      } catch (error: unknown) {
        cleanup.push(error)
      }
    }
    const attempt = async (work: () => unknown) => {
      try {
        await work()
      } catch (error: unknown) {
        cleanup.push(error)
      }
    }
    await attempt(() => unsubscribe())
    await attempt(async () => {
      if (callback) await callback
    })
    await attempt(async () => {
      if (retirement) {
        const result = await retirement
        if (!result.ok) throw result.error
      }
    })
    await attempt(() => Promise.all(fixture.operations))
    await attempt(() => fixture.drain())
    await attempt(() => dispatch.mockRestore())
    if (failed && cleanup.length)
      throw new AggregateError([primary, ...cleanup], 'B_PRIMARY_AND_CLEANUP')
    if (failed) throw primary
    if (cleanup.length) throw new AggregateError(cleanup, 'B_OWNED_CLEANUP')
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  sessionStorage.clear()
  history.replaceState(null, '', '/')
})

afterEach(() => {
  const errors: unknown[] = []
  const attempt = (work: () => unknown) => {
    try {
      work()
    } catch (error: unknown) {
      errors.push(error)
    }
  }
  slot.current = undefined
  attempt(() => vi.unstubAllGlobals())
  attempt(() => vi.unstubAllEnvs())
  attempt(() => vi.restoreAllMocks())
  attempt(() => vi.useRealTimers())
  attempt(() => sessionStorage.clear())
  attempt(() => history.replaceState(null, '', '/'))
  if (errors.length) throw new AggregateError(errors, 'B_GLOBAL_CLEANUP')
})

describe('protected owner-claim parent admission', () => {
  it('B00 optional capability is available without changing the callback union', async () => {
    const exactUnion: AuthCallbackResult extends 'interactive' | 'silent'
      ? 'interactive' | 'silent' extends AuthCallbackResult
        ? true
        : false
      : false = true
    const ordinary: AuthCallbackResult[] = ['interactive', 'silent']
    expect(exactUnion).toBe(true)
    expect(ordinary).toEqual(['interactive', 'silent'])
    expect(typeof adapterSourcePath, 'B_SOURCE_FILESYSTEM_PATH').toBe('string')
    expect(readFileSync(adapterSourcePath, 'utf8'), 'B_SOURCE_FILESYSTEM_BYTES').toBe(
      adapterSourceBytes
    )
    let nonFileFailed = false
    let nonFileError: unknown
    try {
      readFileSync(new URL('https://invalid.test/oidc.ts'), 'utf8')
    } catch (error: unknown) {
      nonFileFailed = true
      nonFileError = error
    }
    expect(nonFileFailed, 'B_NON_FILE_SOURCE_REFUSAL').toBe(true)
    expect(nonFileError).toHaveProperty('name', 'TypeError')
    expect(nonFileError).toHaveProperty('code', 'ERR_INVALID_URL_SCHEME')
    expect(readFileSync(adapterSourcePath, 'utf8'), 'B_SOURCE_FILESYSTEM_RESTORED').toBe(
      adapterSourceBytes
    )
    await owned(importedConstructor, async (fixture) => {
      const adapter = fixture.create()
      expect(capability(adapter)).toBeDefined()
      expect(capability(adapter)).toBe(capability(adapter))
      const legacy: AuthAdapter = {
        getSnapshot: adapter.getSnapshot,
        subscribe: adapter.subscribe,
        restoreSession: adapter.restoreSession,
        getAccessToken: adapter.getAccessToken,
        getExpiresAt: adapter.getExpiresAt,
        renew: adapter.renew,
        onRenewed: adapter.onRenewed,
        onRenewalFailed: adapter.onRenewalFailed,
        getUser: adapter.getUser,
        signIn: adapter.signIn,
        handleCallback: adapter.handleCallback,
        signOut: adapter.signOut,
        onExpiring: adapter.onExpiring,
      }
      expect('ownerClaimAuth' in legacy).toBe(false)
    })
  })

  it('B01 early UserLoaded stays pending until actual parent completion', async () => {
    await pendingProbe(importedConstructor)
  })

  it('B02 duplicate begin shares only identical live context', async () => {
    await owned(importedConstructor, async (fixture) => {
      const adapter = fixture.create()
      const first = fixture.begin(adapter)
      const oldCompletion = outcome(first.completed)
      await fixture.navigation()
      expect(capability(adapter).begin({ ...context })).toBe(first)
      expect(fixture.calls).toHaveLength(1)
      const second = fixture.begin(adapter, { ...context, intentId: 'intent-two' })
      expect(second).not.toBe(first)
      expect((await oldCompletion).ok).toBe(false)
      const handle = await fixture.navigation(1)
      await fixture.notify(handle)
      await expect(second.completed).resolves.toBeUndefined()
      expect(fixture.calls).toHaveLength(2)
      expect(fixture.tokenRequests).toBe(1)
      expect(fixture.redirectCalls).toBe(0)
    })
  })

  it.each(['queued', 'navigation', 'token', 'loaded'] as const)(
    'B03 cancel fences SDK phase %s',
    async (phase) => {
      await owned(importedConstructor, async (fixture) => {
        fixture.holdLoaded = phase === 'loaded'
        fixture.holdToken = phase === 'token'
        const adapter = fixture.create()
        const operation = fixture.begin(adapter)
        const completion = outcome(operation.completed)
        let handle: Handle | undefined
        if (phase === 'queued') expect(fixture.managers.size, 'B_QUEUED_BEFORE_SETUP').toBe(0)
        if (phase !== 'queued') {
          handle = await fixture.navigation()
          if (phase === 'token' || phase === 'loaded') await fixture.notify(handle)
          if (phase === 'token') await fixture.tokenStarted.promise
          if (phase === 'loaded') await handle.loaded.promise
        }
        operation.cancel()
        operation.cancel()
        expect(adapter.getAccessToken()).toBeUndefined()
        expect(adapter.getUser()).toBeUndefined()
        expect(adapter.getSnapshot().status).not.toBe('ready')
        fixture.tokenRelease.resolve(undefined)
        handle?.release.resolve(undefined)
        await fixture.drain()
        expect((await completion).ok).toBe(false)
        expect(adapter.getAccessToken(), 'B_CANCEL_LATE_TOKEN').toBeUndefined()
        expect(adapter.getSnapshot().status).not.toBe('ready')
        if (handle) expect(await handle.manager.getUser(), 'B_CANCEL_SDK_USER_RETIRED').toBeNull()
      })
    }
  )

  it.each(['signout', 'replacement'] as const)('B04 %s defeats stale completion', async (mode) => {
    await owned(importedConstructor, async (fixture) => {
      fixture.holdLoaded = true
      const adapter = fixture.create()
      const operation = fixture.begin(adapter)
      const completion = outcome(operation.completed)
      const handle = await fixture.navigation()
      await fixture.notify(handle)
      await handle.loaded.promise
      expect(fixture.tokenRequests, 'B_REPLACED_VALID_EXCHANGE').toBe(1)
      expect(fixture.settled, 'B_REPLACED_PENDING_PARENT').toBe(0)
      const replacement = outcome(
        mode === 'signout' ? adapter.signOut() : adapter.signIn('acme-sa')
      )
      expect(adapter.getAccessToken()).toBeUndefined()
      expect(adapter.getUser()).toBeUndefined()
      expect(adapter.getSnapshot().status).not.toBe('ready')
      expect(fixture.settled, 'B_REPLACED_STILL_PENDING_PARENT').toBe(0)
      handle.release.resolve(undefined)
      const replacementResult = await replacement
      await fixture.drain()
      expect(adapter.getAccessToken(), 'B_REPLACED_LATE_TOKEN').toBeUndefined()
      if (mode === 'signout' && !replacementResult.ok) throw replacementResult.error
      expect(adapter.getSnapshot().status).not.toBe('ready')
      expect((await completion).ok).toBe(false)
      expect(await handle.manager.getUser(), 'B_REPLACED_SDK_USER_RETIRED').toBeNull()
    })
  })

  it.each(['intentId', 'organisationId', 'realm'] as const)(
    'B05 returned %s mismatch cannot release current intent',
    async (field) => {
      await owned(importedConstructor, async (fixture) => {
        const adapter = fixture.create()
        const operation = fixture.begin(adapter)
        const completion = outcome(operation.completed)
        const handle = await fixture.navigation()
        const changed = {
          ...context,
          [field]:
            field === 'organisationId' ? '22222222-2222-4222-8222-222222222222' : 'different',
        }
        const alternate = await fixture.stored('valid', changed)
        handle.delivered = true
        handle.response.resolve({ url: alternate })
        expect((await completion).ok).toBe(false)
        expect(adapter.getAccessToken(), 'B_CONTEXT_RELEASE').toBeUndefined()
        expect(adapter.getSnapshot().status).not.toBe('ready')
        expect(fixture.tokenRequests).toBe(1)
      })
    }
  )

  it.each(['issuer', 'subject'] as const)(
    'B06 invalid processed %s cannot publish protected session',
    async (field) => {
      await owned(importedConstructor, async (fixture) => {
        if (field === 'issuer') fixture.claims.iss = `${provider}/realms/other`
        else delete fixture.claims.sub
        const adapter = fixture.create()
        const operation = fixture.begin(adapter)
        const completion = outcome(operation.completed)
        await fixture.notify(await fixture.navigation())
        expect((await completion).ok).toBe(false)
        expect(adapter.getAccessToken()).toBeUndefined()
        expect(adapter.getSnapshot().status).not.toBe('ready')
        expect(fixture.tokenRequests).toBe(1)
      })
    }
  )

  it.each(['missing', 'no-code', 'foreign-path'] as const)(
    'B07 child refuses a malformed callback %s before effects',
    async (mode) => {
      await owned(importedConstructor, async (fixture) => {
        const url = new URL(await fixture.stored(mode === 'missing' ? 'missing' : 'valid'))
        if (mode === 'no-code') url.searchParams.delete('code')
        if (mode === 'foreign-path')
          url.pathname = url.pathname.replace('claim-callback', 'callback')
        history.replaceState(null, '', url.href)
        sessionStorage.setItem(returnKey, '/preserved')
        const child = fixture.create()
        const completion = await outcome(capability(child).notifyCallback())
        expect(fixture.notifications.length, 'B_BAD_CHILD_NOTIFY_COUNT').toBe(0)
        expect(fixture.tokenRequests).toBe(0)
        expect(completion.ok).toBe(false)
        expect(child.getAccessToken()).toBeUndefined()
        expect(child.getSnapshot().status).not.toBe('ready')
        expect(sessionStorage.getItem(returnKey)).toBe('/preserved')
      })
    }
  )

  it('B07c child forwards a provider error so the parent settles instead of hanging', async () => {
    await owned(importedConstructor, async (fixture) => {
      const adapter = fixture.create()
      const operation = fixture.begin(adapter)
      const completion = outcome(operation.completed)
      const handle = await fixture.navigation()
      const parameters = await handle.navigation.promise
      const url = new URL(fixture.url(handle, parameters.state))
      url.searchParams.delete('code')
      url.searchParams.set('error', 'access_denied')
      fixture.delivery = handle
      history.replaceState(null, '', url.href)
      await expect(capability(fixture.create()).notifyCallback()).resolves.toBeUndefined()
      expect(fixture.notifications).toHaveLength(1)
      expect((await completion).ok).toBe(false)
      expect(fixture.tokenRequests).toBe(0)
      expect(adapter.getSnapshot().status).not.toBe('ready')
    })
  })

  it('B07d sign-out right after the callback starts fences its hand-over', async () => {
    await owned(importedConstructor, async (fixture) => {
      history.replaceState(null, '', await fixture.stored('valid'))
      const child = fixture.create()
      const notified = outcome(capability(child).notifyCallback())
      await child.signOut()
      const result = await notified
      expect(result.ok).toBe(false)
      expect(result.ok ? undefined : String(result.error)).toContain(
        'Protected callback cancelled.'
      )
      expect(fixture.notifications.length).toBe(0)
    })
  })

  it('B07b child hands its answer over without the request state it cannot have', async () => {
    await owned(importedConstructor, async (fixture) => {
      fixture.holdNotification = true
      const adapter = fixture.create()
      const operation = fixture.begin(adapter)
      const handle = await fixture.navigation()
      // A real popup's sessionStorage was copied before the SDK stored the state.
      const read = vi.spyOn(sdk.WebStorageStateStore.prototype, 'get').mockResolvedValue(null)
      try {
        await fixture.notify(handle)
      } finally {
        read.mockRestore()
      }
      expect(fixture.notifications).toHaveLength(1)
      fixture.deliver()
      await expect(operation.completed).resolves.toBeUndefined()
      expect(adapter.getSnapshot().status).toBe('ready')
    })
  })

  it('B08 stored popup purpose controls the child lane and duplicate parent exchange', async () => {
    await owned(importedConstructor, async (fixture) => {
      fixture.holdNotification = true
      const adapter = fixture.create()
      const operation = fixture.begin(adapter)
      const handle = await fixture.navigation()
      await fixture.notify(handle)
      await fixture.notify(handle)
      expect(fixture.tokenRequests).toBe(0)
      expect(fixture.notifications).toHaveLength(2)
      expect(fixture.calls).toHaveLength(1)
      fixture.deliver()
      await expect(operation.completed).resolves.toBeUndefined()
      expect(fixture.tokenRequests).toBe(1)
      expect(adapter.getSnapshot().status).toBe('ready')
    })
  })

  // The popup cannot read the request state (its storage is copied before the
  // SDK writes it), so the parent alone must refuse forged and replayed answers.
  // A forged stored redirect_uri is refused by the provider, which binds a code
  // to its redirect URI; no client-side check sees it, so it has no row here.
  it.each(['unknown-state', 'si:r', 'si:s', 'purpose', 'authority', 'client'] as const)(
    'B08b parent refuses a forged %s answer without publishing',
    async (mode) => {
      await owned(importedConstructor, async (fixture) => {
        const adapter = fixture.create()
        const operation = fixture.begin(adapter)
        const completion = outcome(operation.completed)
        const handle = await fixture.navigation()
        // Ordinary redirect and silent states, as signIn and renewal write them,
        // carry no claim context.
        const forged = await fixture.stored(mode, mode === 'si:r' || mode === 'si:s' ? {} : context)
        handle.delivered = true
        handle.response.resolve({ url: forged })
        expect((await completion).ok).toBe(false)
        // The SDK refuses unknown or foreign stored state before any exchange; the
        // adapter's claim-context check refuses the rest after it.
        expect(fixture.tokenRequests, 'B_FORGED_EXCHANGES').toBe(
          ['unknown-state', 'authority', 'client'].includes(mode) ? 0 : 1
        )
        expect(adapter.getAccessToken(), 'B_FORGED_RELEASE').toBeUndefined()
        expect(adapter.getSnapshot().status).not.toBe('ready')
      })
    }
  )

  // Pins the SDK's one-time state removal, which refuses the replay before any
  // adapter check runs.
  it('B08c parent refuses a replayed answer from a completed claim', async () => {
    await owned(importedConstructor, async (fixture) => {
      const adapter = fixture.create()
      const first = fixture.begin(adapter)
      const firstHandle = await fixture.navigation()
      const parameters = await firstHandle.navigation.promise
      const replayed = fixture.url(firstHandle, parameters.state)
      await fixture.notify(firstHandle)
      await expect(first.completed).resolves.toBeUndefined()
      expect(fixture.tokenRequests).toBe(1)
      await adapter.signOut()
      const second = fixture.begin(adapter, { ...context, intentId: 'intent-two' })
      const completion = outcome(second.completed)
      const secondHandle = await fixture.navigation(1)
      secondHandle.delivered = true
      secondHandle.response.resolve({ url: replayed })
      expect((await completion).ok).toBe(false)
      expect(fixture.tokenRequests, 'B_REPLAY_EXCHANGE').toBe(1)
      expect(adapter.getAccessToken()).toBeUndefined()
      expect(adapter.getSnapshot().status).not.toBe('ready')
    })
  })

  it('B10 pending owner excludes restoration and renewal competitors', async () => {
    await owned(importedConstructor, async (fixture) => {
      const adapter = fixture.create()
      const operation = fixture.begin(adapter)
      const handle = await fixture.navigation()
      await expect(adapter.restoreSession()).resolves.toBe(false)
      await expect(adapter.renew()).resolves.toBe(false)
      for (const listener of fixture.registrations.get(handle.manager)!.expiring) listener()
      expect(fixture.silentCalls, 'B_COMPETING_SILENT_COUNT').toBe(0)
      expect(fixture.redirectCalls).toBe(0)
      expect(fixture.calls).toHaveLength(1)
      await fixture.notify(handle)
      await expect(operation.completed).resolves.toBeUndefined()
      expect(fixture.tokenRequests).toBe(1)
    })
  })

  it.each(['error', 'undefined'] as const)(
    'B11 original SDK rejection %s survives cleanup',
    async (kind) => {
      for (const failCleanup of [false, true]) {
        await owned(importedConstructor, async (fixture) => {
          const primary: unknown = kind === 'error' ? new Error('SYN_FAILURE') : undefined
          const cleanupFailure = new Error('SYN_CLEANUP')
          const adapter = fixture.create()
          const operation = fixture.begin(adapter)
          const completion = outcome(operation.completed)
          const handle = await fixture.navigation()
          if (failCleanup)
            vi.mocked(handle.manager.removeUser).mockRejectedValueOnce(cleanupFailure)
          handle.response.reject(primary)
          const result = await completion
          expect(result.ok).toBe(false)
          if (result.ok) throw new Error('B_ORIGINAL_REJECTION_MISSING')
          if (failCleanup) {
            expect(result.error, 'B_SECONDARY_CLEANUP_DISTINCT').toBeInstanceOf(AggregateError)
            expect((result.error as AggregateError).errors).toEqual([primary, cleanupFailure])
            expect((result.error as AggregateError).errors[0]).toBe(primary)
            expect((result.error as AggregateError).errors[1]).toBe(cleanupFailure)
          } else expect(result.error, 'B_ORIGINAL_REJECTION_IDENTITY').toBe(primary)
          expect(adapter.getAccessToken()).toBeUndefined()
          await fixture.drain()
        })
      }
    }
  )

  it.each(['/', '/console/'] as const)(
    'B12 protected redirect honors trusted base %s only',
    async (base) => {
      await owned(
        importedConstructor,
        async (fixture) => {
          const adapter = fixture.create()
          const operation = fixture.begin(adapter)
          const handle = await fixture.navigation()
          expect(handle.settings.popup_redirect_uri).toBe(
            `${window.location.origin}${base}auth/claim-callback`
          )
          expect(handle.settings.redirect_uri).toBe(`${window.location.origin}/auth/callback`)
          expect(handle.settings.authority).toBe(issuer)
          expect(handle.settings.client_id).toBe('console')
          expect(handle.settings.loadUserInfo, 'B_PROTECTED_USERINFO_DISABLED').toBe(false)
          expect(
            vi.mocked(handle.manager.signinPopup).mock.calls,
            'B_PUBLIC_POPUP_ARGUMENTS'
          ).toEqual([
            [{ state: context, popupSignal: handle.signal, max_age: 0, popupAbortOnClose: true }],
          ])
          expect(handle.settings.max_age, 'B_PROTECTED_MAX_AGE_PER_REQUEST').toBeUndefined()
          expect(handle.settings.filterProtocolClaims, 'B_PROTECTED_DEFAULT_PROFILE_FILTER').toBe(
            true
          )
          // The literal `max_age=0`: an SDK that dropped a falsy 0 would send no parameter at all.
          const dispatched = new URL((await handle.navigation.promise).url)
          expect(dispatched.search, 'B_PROTECTED_MAX_AGE').toMatch(/[?&]max_age=0(&|$)/)
          expect(dispatched.searchParams.has('prompt'), 'B_PROTECTED_NO_PROMPT').toBe(false)
          await fixture.notify(handle)
          await expect(operation.completed).resolves.toBeUndefined()
        },
        base
      )
    }
  )

  it('B12b an invitation sign-in reuses the protected popup and also forces a new login', async () => {
    await owned(importedConstructor, async (fixture) => {
      const adapter = fixture.create()
      const invitation: Context = Object.freeze({ ...context, purpose: 'invitation' })
      const operation = fixture.begin(adapter, invitation)
      const handle = await fixture.navigation(0, invitation)
      expect(handle.settings.popup_redirect_uri).toBe(
        `${window.location.origin}/auth/claim-callback`
      )
      expect(vi.mocked(handle.manager.signinPopup).mock.calls).toEqual([
        [{ state: invitation, popupSignal: handle.signal, max_age: 0, popupAbortOnClose: true }],
      ])
      const dispatched = new URL((await handle.navigation.promise).url)
      expect(dispatched.search, 'B_INVITATION_MAX_AGE').toMatch(/[?&]max_age=0(&|$)/)
      await fixture.notify(handle)
      await expect(operation.completed).resolves.toBeUndefined()
      expect(adapter.getSnapshot().status).toBe('ready')
    })
  })

  it('B12c a returned state of the other purpose cannot release the current one', async () => {
    await owned(importedConstructor, async (fixture) => {
      const adapter = fixture.create()
      const operation = fixture.begin(adapter)
      const completion = outcome(operation.completed)
      const handle = await fixture.navigation()
      const alternate = await fixture.stored('valid', { ...context, purpose: 'invitation' })
      handle.delivered = true
      handle.response.resolve({ url: alternate })
      expect((await completion).ok).toBe(false)
      expect(adapter.getAccessToken(), 'B_PURPOSE_RELEASE').toBeUndefined()
    })
  })

  it('B12d refuses a purpose that is neither the claim nor an invitation', async () => {
    await owned(importedConstructor, async (fixture) => {
      const adapter = fixture.create()
      expect(() =>
        capability(adapter).begin({ ...context, purpose: 'other' } as unknown as Context)
      ).toThrow('Invalid owner-claim context.')
    })
  })

  it.each(['B-M01', 'B-M02', 'B-M03'] as const)(
    'B13 exact adapter source control %s has fresh restorations',
    async (control) => {
      const probe =
        control === 'B-M01' ? pendingProbe : control === 'B-M02' ? staleProbe : ordinaryProbe
      const marker =
        control === 'B-M01'
          ? 'B_PENDING_TOKEN_LEAK'
          : control === 'B-M02'
            ? 'B_STALE_TOKEN_LEAK'
            : 'B_ORDINARY_PROTECTED_NOTIFY_COUNT'
      await probe(importedConstructor)
      await probe(load())
      const result = await outcome(probe(load(control)))
      expect(result.ok, 'B_CONTROL_MISSING_REFUSAL').toBe(false)
      if (result.ok) throw new Error('B_CONTROL_MISSING_REFUSAL')
      expect(result.error instanceof AggregateError, 'B_CONTROL_CLEANUP_NOT_A_KILL').toBe(false)
      expect(result.error).toHaveProperty('message', expect.stringContaining(marker))
      expect(result.error).toHaveProperty('expected', control === 'B-M03' ? 0 : undefined)
      expect(result.error).toHaveProperty('actual', control === 'B-M03' ? 1 : 'SYN_ACCESS')
      await probe(load())
      await probe(importedConstructor)
    },
    30000
  )

  it('B14 inspection binds the actual SDK dispatch URL', async () => {
    await inspectedProbe(importedConstructor, 'swap')
  })

  it.each(['signout', 'replacement'] as const)(
    'B15 %s during inspection cannot dispatch its old manager',
    async (mode) => {
      await inspectedProbe(importedConstructor, mode)
    }
  )

  it.each(['error', 'undefined'] as const)(
    'B16 failed pending publication %s cannot orphan SDK setup',
    async (kind) => {
      await publicationProbe(
        importedConstructor,
        kind === 'error' ? new Error('SYN_PUBLISH') : undefined
      )
    }
  )

  it.each([
    ['cancel', 'error'],
    ['cancel', 'undefined'],
    ['cancel', 'combined'],
    ['signout', 'error'],
    ['signout', 'undefined'],
    ['signout', 'combined'],
  ] as const)('B17 protected %s independently finalizes %s failures', async (action, kind) => {
    await protectedFinalizerProbe(importedConstructor, action, kind)
  })

  it('B18 failed publication cannot retire its successor', async () => {
    await successorProbe(importedConstructor)
  })

  it.each(['B-M04', 'B-M05', 'B-M06', 'B-M07', 'B-M08', 'B-M09', 'B-M10'] as const)(
    'B19 correction source control %s has fresh restorations',
    async (control) => {
      const probes: Record<CorrectionControl, (Constructor_: Constructor) => Promise<void>> = {
        'B-M04': (Constructor_) => inspectedProbe(Constructor_, 'swap'),
        'B-M05': (Constructor_) => inspectedProbe(Constructor_, 'signout'),
        'B-M06': (Constructor_) => publicationProbe(Constructor_, new Error('SYN_PUBLISH')),
        'B-M07': (Constructor_) => protectedFinalizerProbe(Constructor_, 'cancel', 'error'),
        'B-M08': (Constructor_) => protectedFinalizerProbe(Constructor_, 'signout', 'error'),
        'B-M09': successorProbe,
        'B-M10': ordinaryReentryProbe,
      }
      const markers: Record<CorrectionControl, string> = {
        'B-M04': 'B_INSPECTED_URL_NOTIFY_COUNT',
        'B-M05': 'B_RETIRED_CALLBACK_DISPATCH',
        'B-M06': 'B_PUBLICATION_PARENT_STARTED',
        'B-M07': 'B_CANCEL_HINT_NOT_REMOVED',
        'B-M08': 'B_SIGNOUT_EARLY_REMOVE',
        'B-M09': 'B_FAILED_BEGIN_SUCCESSOR_RETIRED',
        'B-M10': 'B_REENTRY_ORDINARY_DISPATCH',
      }
      const probe = probes[control]
      await probe(importedConstructor)
      await probe(load())
      const result = await outcome(probe(load(control)))
      expect(result.ok, 'B_CONTROL_MISSING_REFUSAL').toBe(false)
      if (result.ok) throw new Error('B_CONTROL_MISSING_REFUSAL')
      expect(result.error instanceof AggregateError, 'B_CONTROL_CLEANUP_NOT_A_KILL').toBe(false)
      expect(result.error).toHaveProperty('message', expect.stringContaining(markers[control]))
      expect(result.error).toHaveProperty(
        'expected',
        control === 'B-M07' ? null : control === 'B-M09' ? 'pending' : 0
      )
      expect(result.error).toHaveProperty(
        'actual',
        control === 'B-M07' ? 'acme-sa' : control === 'B-M09' ? 'unauthenticated' : 1
      )
      await probe(load())
      await probe(importedConstructor)
    },
    30000
  )

  it('B20 ordinary callback publication cannot overwrite a new protected owner', async () => {
    await ordinaryReentryProbe(importedConstructor)
  })
})
