// The identity SDK is fetched on demand (`./oidcSdk.ts`); the rest of the suite runs with it
// already in hand. This file runs the adapter the way a first page load does: the SDK absent,
// arriving only when this test lets it. What must hold is that nothing reaches for the SDK on a
// first visit, that every step that needs it waits for it and then behaves as it always did, and
// that a fetch that fails is neither swallowed nor remembered.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OidcAuthAdapter as Adapter } from './oidc'

import.meta.env['VITE_KEYCLOAK_URL'] = 'https://id.example.test'
import.meta.env['VITE_OIDC_CLIENT_ID'] = 'console'

const REALM_KEY = 'kodera.web.auth.realm'
const issuer = 'https://id.example.test/realms/acme-sa'

const signinSilent = vi.fn()
const signinRedirect = vi.fn()
const signinCallback = vi.fn()
const constructed = vi.fn()

class FakeUserManager {
  settings: { authority?: string }
  metadataService = {}
  events = {
    addAccessTokenExpiring: vi.fn(),
    addAccessTokenExpired: vi.fn(),
    addUserLoaded: vi.fn(),
    removeAccessTokenExpiring: vi.fn(),
    removeAccessTokenExpired: vi.fn(),
    removeUserLoaded: vi.fn(),
  }
  stopSilentRenew = vi.fn()
  removeUser = vi.fn().mockResolvedValue(undefined)
  signinSilent = signinSilent
  signinRedirect = signinRedirect
  signinCallback = signinCallback
  constructor(settings: { authority?: string }) {
    this.settings = settings
    constructed(settings)
  }
}

class FakeErrorResponse extends Error {
  error: string | null = null
}

const fakeSdk = {
  UserManager: FakeUserManager,
  ErrorResponse: FakeErrorResponse,
  InMemoryWebStorage: class {},
  WebStorageStateStore: class {},
  OidcClient: class {
    readSigninResponseState = vi.fn().mockResolvedValue({ state: { data: undefined } })
  },
}

/** The loader, under this test's control: `arrive()` delivers the SDK, `fail()` loses the fetch. */
const loader = {
  loaded: false,
  requests: 0,
  pending: [] as { resolve: () => void; reject: (reason: unknown) => void }[],
  arrive() {
    this.loaded = true
    for (const request of this.pending.splice(0)) request.resolve()
  },
  fail(reason: unknown) {
    for (const request of this.pending.splice(0)) request.reject(reason)
  },
}

async function coldAdapter(): Promise<Adapter> {
  vi.resetModules()
  vi.doMock('./oidcSdk', () => ({
    oidcSdkLoaded: () => loader.loaded,
    oidcSdk: () => {
      if (!loader.loaded) throw new Error('The identity SDK was used before it was loaded.')
      return fakeSdk
    },
    loadOidcSdk: () => {
      if (loader.loaded) return Promise.resolve()
      loader.requests++
      return new Promise<void>((resolve, reject) => loader.pending.push({ resolve, reject }))
    },
  }))
  const { OidcAuthAdapter } = await import('./oidc')
  // What importing the module itself asked for is the warm-up's business, tested on its own.
  loader.requests = 0
  return new OidcAuthAdapter()
}

const user = () => ({
  access_token: 'synthetic-access-token',
  expired: false,
  expires_at: Math.floor(Date.now() / 1000) + 600,
  profile: { iss: issuer, sub: 'subject-1' },
})

/** Lets every already-queued promise reaction run, without letting timers move. */
const settled = async () => {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
  loader.loaded = false
  loader.requests = 0
  loader.pending = []
  sessionStorage.clear()
  window.history.replaceState(null, '', '/login')
  signinSilent.mockResolvedValue(user())
  signinRedirect.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.doUnmock('./oidcSdk')
})

describe('a first visit, with no sign-in in this tab', () => {
  it('finds no session without fetching the SDK', async () => {
    const adapter = await coldAdapter()
    await expect(adapter.restoreSession()).resolves.toBe(false)
    expect(adapter.getSnapshot().status).toBe('unauthenticated')
    expect(loader.requests).toBe(0)
    expect(constructed).not.toHaveBeenCalled()
  })

  it('does not start fetching it when the module is imported on /login', async () => {
    await coldAdapter()
    expect(loader.pending).toHaveLength(0)
  })

  it('answers the synchronous questions without it', async () => {
    const adapter = await coldAdapter()
    expect(adapter.getAccessToken()).toBeUndefined()
    expect(adapter.getUser()).toBeUndefined()
    expect(adapter.getExpiresAt()).toBeUndefined()
    await expect(adapter.renew()).resolves.toBe(false)
    await expect(adapter.signOut()).resolves.toBeUndefined()
    expect(loader.requests).toBe(0)
  })
})

describe('restoring a session this tab already had', () => {
  it('waits for the SDK, then restores exactly as it does with the SDK in hand', async () => {
    sessionStorage.setItem(REALM_KEY, 'acme-sa')
    const adapter = await coldAdapter()
    const restored = adapter.restoreSession()
    await settled()
    // Nothing has happened yet: no manager, and the snapshot is still the first one.
    expect(constructed).not.toHaveBeenCalled()
    expect(adapter.getSnapshot()).toMatchObject({ status: 'pending', generation: 0 })

    loader.arrive()
    await expect(restored).resolves.toBe(true)
    expect(constructed).toHaveBeenCalledTimes(1)
    expect(constructed.mock.calls[0]?.[0]).toMatchObject({ authority: issuer })
    expect(signinSilent).toHaveBeenCalledTimes(1)
    expect(adapter.getSnapshot()).toMatchObject({ status: 'ready', generation: 1 })
    expect(adapter.getAccessToken()).toBe('synthetic-access-token')
  })

  it('shares one restoration between callers that asked while the SDK was on its way', async () => {
    sessionStorage.setItem(REALM_KEY, 'acme-sa')
    const adapter = await coldAdapter()
    const first = adapter.restoreSession()
    const second = adapter.restoreSession()
    loader.arrive()
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(constructed).toHaveBeenCalledTimes(1)
    expect(signinSilent).toHaveBeenCalledTimes(1)
  })

  it('honours a sign-out that happened while the SDK was on its way', async () => {
    sessionStorage.setItem(REALM_KEY, 'acme-sa')
    const adapter = await coldAdapter()
    const restored = adapter.restoreSession()
    await adapter.signOut()
    loader.arrive()
    await expect(restored).resolves.toBe(false)
    expect(constructed).not.toHaveBeenCalled()
    expect(adapter.getSnapshot().status).toBe('unauthenticated')
  })

  it('reports a fetch that failed, and asks again the next time', async () => {
    sessionStorage.setItem(REALM_KEY, 'acme-sa')
    const adapter = await coldAdapter()
    const restored = adapter.restoreSession()
    loader.fail(new Error('chunk unavailable'))
    await expect(restored).rejects.toThrow('chunk unavailable')
    expect(constructed).not.toHaveBeenCalled()

    const again = adapter.restoreSession()
    expect(loader.requests).toBe(2)
    loader.arrive()
    await expect(again).resolves.toBe(true)
  })
})

describe('starting a sign-in', () => {
  it('publishes the pending boundary at once and redirects once the SDK is there', async () => {
    const adapter = await coldAdapter()
    const signedIn = adapter.signIn('acme-sa')
    // The boundary a screen reads to stop offering the form is published before any wait.
    expect(adapter.getSnapshot()).toMatchObject({ status: 'pending', generation: 1 })
    await settled()
    expect(constructed).not.toHaveBeenCalled()
    expect(signinRedirect).not.toHaveBeenCalled()

    loader.arrive()
    await signedIn
    expect(sessionStorage.getItem(REALM_KEY)).toBe('acme-sa')
    expect(constructed).toHaveBeenCalledTimes(1)
    expect(signinRedirect).toHaveBeenCalledTimes(1)
  })

  it('shares the request between two clicks made while the SDK was on its way', async () => {
    const adapter = await coldAdapter()
    const first = adapter.signIn('acme-sa')
    const second = adapter.signIn('acme-sa')
    loader.arrive()
    await Promise.all([first, second])
    expect(signinRedirect).toHaveBeenCalledTimes(1)
  })

  it('closes the boundary again when the SDK cannot be fetched', async () => {
    const adapter = await coldAdapter()
    const signedIn = adapter.signIn('acme-sa')
    loader.fail(new Error('chunk unavailable'))
    await expect(signedIn).rejects.toThrow('chunk unavailable')
    expect(adapter.getSnapshot().status).toBe('unauthenticated')
    expect(sessionStorage.getItem(REALM_KEY)).toBeNull()
    expect(constructed).not.toHaveBeenCalled()
  })
})

describe('answering a sign-in callback', () => {
  it('waits for the SDK, then completes the callback once for both StrictMode callers', async () => {
    sessionStorage.setItem(REALM_KEY, 'acme-sa')
    window.history.replaceState(null, '', '/auth/callback?code=synthetic&state=synthetic')
    signinCallback.mockResolvedValue(user())
    const adapter = await coldAdapter()
    const first = adapter.handleCallback()
    const second = adapter.handleCallback()
    await settled()
    expect(signinCallback).not.toHaveBeenCalled()

    loader.arrive()
    await expect(Promise.all([first, second])).resolves.toEqual(['interactive', 'interactive'])
    expect(signinCallback).toHaveBeenCalledTimes(1)
    expect(adapter.getSnapshot().status).toBe('ready')
  })

  it('still refuses a callback nobody started, without fetching anything', async () => {
    window.history.replaceState(null, '', '/auth/callback?code=synthetic&state=synthetic')
    const adapter = await coldAdapter()
    await expect(adapter.handleCallback()).rejects.toThrow('No pending sign-in.')
    expect(loader.requests).toBe(0)
  })
})

describe('the warm-up when the module is imported', () => {
  it.each([
    ['a sign-in callback', '/auth/callback?code=synthetic&state=synthetic'],
    ['the protected callback', '/auth/claim-callback?code=synthetic&state=synthetic'],
    ['an invitation', '/invitations/accept/018f2d6e-8a51-7c3e-9b1a-2f4c6d8e0a12/acme-sa'],
    ['a claim', '/claim/018f2d6e-8a51-7c3e-9b1a-2f4c6d8e0a12/acme-sa'],
  ])('starts fetching the SDK on %s, before anyone acts', async (_name, path) => {
    window.history.replaceState(null, '', path)
    await coldAdapter()
    expect(loader.pending).toHaveLength(1)
  })

  it('starts fetching it in a tab that already signed in, whatever the address', async () => {
    sessionStorage.setItem(REALM_KEY, 'acme-sa')
    window.history.replaceState(null, '', '/acme-sa/home')
    await coldAdapter()
    expect(loader.pending).toHaveLength(1)
  })

  it.each(['/', '/login', '/acme-sa/home'])(
    'fetches nothing on %s with no sign-in',
    async (path) => {
      window.history.replaceState(null, '', path)
      await coldAdapter()
      expect(loader.pending).toHaveLength(0)
    }
  )

  it('does not report a warm-up that failed: the step that needs the SDK will', async () => {
    window.history.replaceState(null, '', '/auth/callback?code=synthetic&state=synthetic')
    await coldAdapter()
    loader.fail(new Error('chunk unavailable'))
    await settled()
    // No unhandled rejection reaches the runner; Vitest fails a file that leaks one.
    expect(loader.pending).toHaveLength(0)
  })
})
