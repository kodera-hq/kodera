import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, render, screen } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { AuthProvider, useAuth } from './AuthProvider'
import type * as OidcClientTs from 'oidc-client-ts'

import.meta.env['VITE_KEYCLOAK_URL'] = 'https://id.example.test'
import.meta.env['VITE_OIDC_CLIENT_ID'] = 'console'

const issuer = 'https://id.example.test/realms/acme-sa'
const signinSilent = vi.fn()
const signinRedirect = vi.fn().mockResolvedValue(undefined)
const signinRedirectCallback = vi.fn()
const removeUser = vi.fn().mockResolvedValue(undefined)
const addAccessTokenExpiring = vi.fn()
const addAccessTokenExpired = vi.fn()
const addUserLoaded = vi.fn()
const stopSilentRenew = vi.fn()
const removeAccessTokenExpiring = vi.fn()
const removeAccessTokenExpired = vi.fn()
const removeUserLoaded = vi.fn()
const constructorSpy = vi.fn()
const managers: unknown[] = []

// oidc-client-ts drives a real browser redirect; nothing here exercises that,
// only the adapter's own wiring: what it passes to `UserManager`, and how it
// turns the library's calls into `AuthAdapter`'s surface.
vi.mock('oidc-client-ts', async (importOriginal) => {
  const actual = await importOriginal<typeof OidcClientTs>()
  class FakeUserManager {
    settings: { authority?: string }
    events = {
      addAccessTokenExpiring,
      addAccessTokenExpired,
      addUserLoaded,
      removeAccessTokenExpiring,
      removeAccessTokenExpired,
      removeUserLoaded,
    }
    stopSilentRenew = stopSilentRenew
    constructor(settings: unknown) {
      this.settings = settings as { authority?: string }
      constructorSpy(settings)
      managers.push(this)
    }
    signinSilent = signinSilent
    signinRedirect = signinRedirect
    signinCallback = signinRedirectCallback
    removeUser = removeUser
  }
  return { ...actual, UserManager: FakeUserManager }
})

import { ErrorResponse } from 'oidc-client-ts'
import { OidcAuthAdapter } from '@/auth/oidc'

beforeEach(() => {
  vi.clearAllMocks()
  managers.length = 0
  window.sessionStorage.clear()
})

describe('OidcAuthAdapter', () => {
  it('has no session by default', () => {
    const adapter = new OidcAuthAdapter()
    expect(adapter.getAccessToken()).toBeUndefined()
    expect(adapter.getUser()).toBeUndefined()
  })

  it('signIn sets the authority from the given realm and records it for the callback', async () => {
    const adapter = new OidcAuthAdapter()
    await adapter.signIn('acme-sa')

    expect(constructorSpy).toHaveBeenCalledTimes(1)
    const settings = constructorSpy.mock.calls[0]?.[0] as Record<string, unknown>
    expect(settings['authority']).toBe('https://id.example.test/realms/acme-sa')
    expect(settings['client_id']).toBe('console')
    expect(settings['redirect_uri']).toBe(`${window.location.origin}/auth/callback`)
    expect(signinRedirect).toHaveBeenCalledTimes(1)
  })

  it('an ordinary sign-in reuses the SSO session: no max_age, no forced prompt', async () => {
    const adapter = new OidcAuthAdapter()
    await adapter.signIn('acme-sa')

    const settings = constructorSpy.mock.calls[0]?.[0] as Record<string, unknown>
    expect(settings).not.toHaveProperty('max_age')
    expect(settings).not.toHaveProperty('prompt')
    expect(signinRedirect.mock.calls).toEqual([[]])
  })

  it('handleCallback rebuilds the same authority from the realm recorded by signIn', async () => {
    // A fresh adapter, not the one `signIn` used: the redirect is a full page
    // load, so the callback page never has the original object — only what
    // `signIn` left in `sessionStorage`.
    const signingIn = new OidcAuthAdapter()
    await signingIn.signIn('acme-sa')
    constructorSpy.mockClear()

    signinRedirectCallback.mockResolvedValue({
      access_token: 'token-123',
      expired: false,
      profile: { iss: issuer, sub: 'user-1' },
    })

    const onCallback = new OidcAuthAdapter()
    await onCallback.handleCallback()

    const settings = constructorSpy.mock.calls[0]?.[0] as Record<string, unknown>
    expect(settings['authority']).toBe('https://id.example.test/realms/acme-sa')
    expect(onCallback.getAccessToken()).toBe('token-123')
  })

  it('handleCallback throws when no sign-in was recorded', async () => {
    const adapter = new OidcAuthAdapter()
    await expect(adapter.handleCallback()).rejects.toThrow()
  })

  it('signOut clears the current user', async () => {
    const adapter = new OidcAuthAdapter()
    await adapter.signIn('acme-sa')
    signinRedirectCallback.mockResolvedValue({
      access_token: 'token-123',
      expired: false,
      profile: { iss: issuer, sub: 'user-1' },
    })
    await adapter.handleCallback()
    expect(adapter.getAccessToken()).toBe('token-123')

    await adapter.signOut()
    expect(adapter.getAccessToken()).toBeUndefined()
    expect(removeUser).toHaveBeenCalledTimes(1)
  })

  it('onExpiring returns an unsubscribe function', () => {
    const adapter = new OidcAuthAdapter()
    const callback = vi.fn()
    const unsubscribe = adapter.onExpiring(callback)
    expect(typeof unsubscribe).toBe('function')
    unsubscribe()
  })

  it('retires renewal listeners and ignores a late user-loaded event after logout', async () => {
    const adapter = new OidcAuthAdapter()
    await adapter.signIn('acme-sa')
    const lateUserLoaded = addUserLoaded.mock.calls[0]?.[0] as (user: unknown) => void
    await adapter.signOut()
    lateUserLoaded({ access_token: 'retired-token', expired: false })
    expect(adapter.getAccessToken()).toBeUndefined()
    expect(stopSilentRenew).toHaveBeenCalledTimes(1)
    expect(removeUserLoaded).toHaveBeenCalledWith(lateUserLoaded)
    expect(removeAccessTokenExpiring).toHaveBeenCalledTimes(1)
    expect(removeAccessTokenExpired).toHaveBeenCalledTimes(1)
  })

  it('does not restore a user when an in-flight callback completes after logout', async () => {
    const adapter = new OidcAuthAdapter()
    await adapter.signIn('acme-sa')
    let resolveCallback!: (user: unknown) => void
    signinRedirectCallback.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCallback = resolve
      })
    )
    const callback = adapter.handleCallback()
    await adapter.signOut()
    resolveCallback({ access_token: 'retired-token', expired: false })
    await callback.catch(() => {})
    expect(adapter.getAccessToken()).toBeUndefined()
    // The SDK stored that late user in the retired manager; it is dropped too.
    expect(removeUser).toHaveBeenCalledTimes(2)
    expect(removeUser.mock.contexts).toEqual([managers[0], managers[0]])
  })

  it('forgets the token even if stopping SDK renewal fails', async () => {
    const adapter = new OidcAuthAdapter()
    await adapter.signIn('acme-sa')
    signinRedirectCallback.mockResolvedValueOnce({
      access_token: 'old-token',
      expired: false,
      profile: { iss: issuer, sub: 'user-1' },
    })
    await adapter.handleCallback()
    stopSilentRenew.mockImplementationOnce(() => {
      throw new Error('SDK cleanup failed')
    })

    removeUser.mockRejectedValueOnce(new Error('SDK removal failed'))
    await expect(adapter.signOut()).rejects.toThrow('SDK cleanup failed')
    expect(adapter.getAccessToken()).toBeUndefined()
    expect(removeUser).toHaveBeenCalledTimes(1)
    expect(adapter.getSnapshot().status).toBe('unauthenticated')
    expect(adapter.getSnapshot().user).toBeUndefined()
  })
})

describe('renewal belongs to the current adapter session', () => {
  const issuer = 'https://id.example.test/realms/acme-sa'
  const renewedUser = () => ({
    access_token: 'renewed-token',
    expired: false,
    expires_at: Math.floor(Date.now() / 1000) + 300,
    profile: { iss: issuer, sub: 'user-1' },
  })
  async function signedIn() {
    const adapter = new OidcAuthAdapter()
    await adapter.signIn('acme-sa')
    signinRedirectCallback.mockResolvedValueOnce({ ...renewedUser(), access_token: 'old-token' })
    await adapter.handleCallback()
    return adapter
  }

  it('coordinates expiry and concurrent manual requests as one SDK exchange', async () => {
    const adapter = await signedIn()
    let resolve!: (user: unknown) => void
    signinSilent.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const onRenewed = vi.fn()
    adapter.onRenewed(onRenewed)
    const expiry = addAccessTokenExpiring.mock.calls[0]?.[0] as () => void
    expiry()
    const first = adapter.renew()
    const second = adapter.renew()
    expect(first).toBe(second)
    expect(signinSilent).toHaveBeenCalledTimes(1)
    const user = renewedUser()
    const loaded = addUserLoaded.mock.calls[0]?.[0] as (user: unknown) => void
    loaded(user)
    resolve(user)
    await expect(first).resolves.toBe(true)
    expect(onRenewed).toHaveBeenCalledTimes(1)
    expect(adapter.getExpiresAt()).toBe(user.expires_at * 1000)
    expect(constructorSpy.mock.calls[0]?.[0]).toMatchObject({
      automaticSilentRenew: false,
      accessTokenExpiringNotificationTimeInSeconds: 120,
    })
  })

  it('does not advance credential authority for duplicate delivery of identical bytes', async () => {
    const adapter = await signedIn()
    const before = adapter.getSnapshot()
    const duplicate = { ...renewedUser(), access_token: 'old-token' }
    const loaded = addUserLoaded.mock.calls[0]?.[0] as (user: unknown) => void
    signinSilent.mockImplementationOnce(async () => {
      loaded(duplicate)
      return duplicate
    })
    await expect(adapter.renew()).resolves.toBe(true)
    expect(adapter.getSnapshot().generation).toBe(before.generation)
    expect(adapter.getSnapshot().credentialGeneration).toBe(before.credentialGeneration)
  })

  it.each([null, { access_token: 'expired', expires_at: 0 }])(
    'rejects an unusable SDK result: %j',
    async (user) => {
      const adapter = await signedIn()
      const failed = vi.fn()
      adapter.onRenewalFailed(failed)
      signinSilent.mockResolvedValueOnce(user)
      await expect(adapter.renew()).resolves.toBe(false)
      expect(failed).toHaveBeenCalledTimes(1)
      expect(adapter.getAccessToken()).toBe('old-token')
    }
  )

  it('reports one failure without an unhandled rejection and permits a later retry', async () => {
    const adapter = await signedIn()
    const failed = vi.fn()
    adapter.onRenewalFailed(failed)
    signinSilent.mockRejectedValueOnce(new Error('synthetic network failure'))
    await expect(adapter.renew()).resolves.toBe(false)
    expect(failed).toHaveBeenCalledTimes(1)
    signinSilent.mockResolvedValueOnce(renewedUser())
    await expect(adapter.renew()).resolves.toBe(true)
  })

  it('publishes actual token expiry and accepts a later fresh credential', async () => {
    const adapter = await signedIn()
    const before = adapter.getSnapshot()
    const failed = vi.fn()
    adapter.onRenewalFailed(failed)

    let resolve!: (user: ReturnType<typeof renewedUser>) => void
    signinSilent.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const pending = adapter.renew()

    expect(adapter.getExpiresAt()).toBeDefined()
    const expired = addAccessTokenExpired.mock.calls[0]?.[0] as () => void
    // The SDK only raises this event after User.expired has become true. Model
    // the adapter getter at that exact boundary before delivering the event.
    const accessToken = vi.spyOn(adapter, 'getAccessToken').mockReturnValue(undefined)
    expired()
    accessToken.mockRestore()

    expect(adapter.getSnapshot()).toMatchObject({
      status: 'ready',
      user: before.user,
      generation: before.generation,
      credentialGeneration: before.credentialGeneration + 1,
    })
    expect(failed).toHaveBeenCalledTimes(1)

    resolve(renewedUser())
    await expect(pending).resolves.toBe(true)
    expect(adapter.getAccessToken()).toBe('renewed-token')
    expect(adapter.getSnapshot().generation).toBe(before.generation)
    expect(adapter.getSnapshot().credentialGeneration).toBe(before.credentialGeneration + 2)
  })

  it.each([
    ['another subject', () => ({ ...renewedUser(), profile: { iss: issuer, sub: 'user-2' } })],
    [
      'another issuer',
      () => ({
        ...renewedUser(),
        profile: { iss: 'https://id.example.test/realms/other', sub: 'user-1' },
      }),
    ],
    ['an invalid profile', () => ({ ...renewedUser(), profile: { iss: issuer, sub: '' } })],
  ] as const)('signs out when an expired in-flight renewal returns %s', async (_case, result) => {
    const adapter = await signedIn()
    const before = adapter.getSnapshot()
    let resolve!: (user: ReturnType<typeof renewedUser>) => void
    signinSilent.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const pending = adapter.renew()
    const expired = addAccessTokenExpired.mock.calls[0]?.[0] as () => void
    const accessToken = vi.spyOn(adapter, 'getAccessToken').mockReturnValue(undefined)
    expired()
    accessToken.mockRestore()

    resolve(result())
    await expect(pending).resolves.toBe(false)
    expect(adapter.getAccessToken()).toBeUndefined()
    expect(adapter.getUser()).toBeUndefined()
    expect(adapter.getSnapshot()).toMatchObject({
      status: 'unauthenticated',
      user: undefined,
      generation: before.generation + 1,
      credentialGeneration: before.credentialGeneration + 1,
    })
    expect(sessionStorage.getItem('kodera.web.auth.realm')).toBeNull()
    expect(removeUser.mock.contexts).toContain(managers[0])
  })

  it('does not notify failure when a retired renewal rejects', async () => {
    const adapter = await signedIn()
    let reject!: (reason: Error) => void
    signinSilent.mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail
      })
    )
    const failed = vi.fn()
    adapter.onRenewalFailed(failed)
    const pending = adapter.renew()
    await adapter.signOut()
    reject(new Error('late synthetic failure'))
    await expect(pending).resolves.toBe(false)
    expect(failed).not.toHaveBeenCalled()
  })

  it.each(['logout', 'replace'] as const)('ignores a late renewal after %s', async (action) => {
    const adapter = await signedIn()
    let resolve!: (user: unknown) => void
    signinSilent.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const onRenewed = vi.fn()
    const failed = vi.fn()
    adapter.onRenewed(onRenewed)
    adapter.onRenewalFailed(failed)
    const loaded = addUserLoaded.mock.calls[0]?.[0] as (user: unknown) => void
    const pending = adapter.renew()
    if (action === 'logout') await adapter.signOut()
    else await adapter.signIn('other-realm')
    loaded(renewedUser())
    resolve(renewedUser())
    await expect(pending).resolves.toBe(false)
    expect(adapter.getAccessToken()).toBeUndefined()
    expect(onRenewed).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
  })

  it.each([
    'invalid_grant',
    'interaction_required',
    'consent_required',
    'account_selection_required',
    'access_denied',
    'invalid_token',
    'invalid_client',
    'unauthorized_client',
    'invalid_scope',
    'invalid_request',
  ])('treats %s as a refusal', async (code) => {
    const adapter = await signedIn()
    signinSilent.mockRejectedValueOnce(new ErrorResponse({ error: code }))
    await expect(adapter.renew()).resolves.toBe(false)
    expect(adapter.getAccessToken()).toBeUndefined()
  })

  it('signs out when a silent renewal returns another person', async () => {
    const adapter = await signedIn()
    const loaded = addUserLoaded.mock.calls[0]?.[0] as (user: unknown) => void
    signinSilent.mockImplementationOnce(async () => {
      const other = {
        ...renewedUser(),
        access_token: 'other-token',
        profile: { iss: issuer, sub: 'user-2' },
      }
      loaded(other)
      return other
    })
    await expect(adapter.renew()).resolves.toBe(false)
    expect(adapter.getAccessToken()).toBeUndefined()
    expect(adapter.getSnapshot().status).toBe('unauthenticated')
    expect(constructorSpy.mock.calls[0]?.[0]).toMatchObject({ validateSubOnSilentRenew: false })
  })

  it('ends the credential in place when the provider refuses renewal', async () => {
    const adapter = await signedIn()
    const before = adapter.getSnapshot()
    let tokenSeenByConsumer: string | undefined = 'unset'
    const failed = vi.fn(() => {
      tokenSeenByConsumer = adapter.getAccessToken()
    })
    adapter.onRenewalFailed(failed)
    signinSilent.mockRejectedValueOnce(new ErrorResponse({ error: 'invalid_grant' }))
    await expect(adapter.renew()).resolves.toBe(false)
    expect(failed).toHaveBeenCalledTimes(1)
    expect(tokenSeenByConsumer).toBeUndefined()
    expect(adapter.getAccessToken()).toBeUndefined()
    expect(adapter.getExpiresAt()).toBeUndefined()
    expect(removeUser.mock.contexts).toEqual([managers[0]])
    // The route stays mounted for the expired dialog's in-place sign-in, but
    // every previous `/me` authority observes the missing credential.
    expect(adapter.getSnapshot()).toMatchObject({
      status: 'ready',
      user: before.user,
      generation: before.generation,
      credentialGeneration: before.credentialGeneration + 1,
    })
    // A refused session never asks the provider again; sign-in replaces it.
    await expect(adapter.renew()).resolves.toBe(false)
    expect(signinSilent).toHaveBeenCalledTimes(1)
  })

  it.each([
    new Error('synthetic network failure'),
    new ErrorResponse({ error: 'server_error' }),
    new ErrorResponse({ error: 'temporarily_unavailable' }),
    new ErrorResponse({ error: 'unknown_error' }),
    new ErrorResponse({ error: 'too_many_requests' }),
    // Silent prompt=none answers: a retry can succeed (blocked third-party cookies).
    new ErrorResponse({ error: 'login_required' }),
  ])('keeps the live credential after a transient failure: %s', async (error) => {
    const adapter = await signedIn()
    signinSilent.mockRejectedValueOnce(error)
    await expect(adapter.renew()).resolves.toBe(false)
    expect(adapter.getAccessToken()).toBe('old-token')
    expect(removeUser).not.toHaveBeenCalled()
    signinSilent.mockResolvedValueOnce(renewedUser())
    await expect(adapter.renew()).resolves.toBe(true)
    expect(signinSilent).toHaveBeenCalledTimes(2)
  })

  it('isolates a throwing consumer from the outcome and from other consumers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const adapter = await signedIn()
      const failed = vi.fn()
      const second = vi.fn()
      adapter.onRenewed(() => {
        throw new Error('synthetic consumer failure')
      })
      adapter.onRenewed(second)
      adapter.onRenewalFailed(failed)
      signinSilent.mockResolvedValueOnce(renewedUser())
      await expect(adapter.renew()).resolves.toBe(true)
      expect(second).toHaveBeenCalledTimes(1)
      expect(failed).not.toHaveBeenCalled()
      expect(adapter.getAccessToken()).toBe('renewed-token')
      // Not swallowed: reported on its own task.
      expect(() => vi.runAllTimers()).toThrow('synthetic consumer failure')

      const otherFailed = vi.fn()
      adapter.onRenewalFailed(() => {
        throw new Error('synthetic failure consumer')
      })
      adapter.onRenewalFailed(otherFailed)
      signinSilent.mockRejectedValueOnce(new Error('synthetic network failure'))
      await expect(adapter.renew()).resolves.toBe(false)
      expect(otherFailed).toHaveBeenCalledTimes(1)
      expect(() => vi.runAllTimers()).toThrow('synthetic failure consumer')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a throwing expiring consumer does not skip the renewal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const adapter = await signedIn()
      const other = vi.fn()
      adapter.onExpiring(() => {
        throw new Error('synthetic expiring consumer failure')
      })
      adapter.onExpiring(other)
      signinSilent.mockResolvedValueOnce(renewedUser())
      const expiring = addAccessTokenExpiring.mock.calls[0]?.[0] as () => void
      expect(() => expiring()).not.toThrow()
      expect(other).toHaveBeenCalledTimes(1)
      expect(signinSilent).toHaveBeenCalledTimes(1)
      expect(() => vi.runAllTimers()).toThrow('synthetic expiring consumer failure')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends the renewal when a consumer signs out from the SDK user-loaded event', async () => {
    const adapter = await signedIn()
    const loaded = addUserLoaded.mock.calls[0]?.[0] as (user: unknown) => void
    // The installed SDK raises user-loaded inside signinSilent, before it resolves.
    signinSilent.mockImplementationOnce(async () => {
      const user = renewedUser()
      loaded(user)
      return user
    })
    adapter.onRenewed(() => void adapter.signOut())
    await expect(adapter.renew()).resolves.toBe(false)
    expect(adapter.getAccessToken()).toBeUndefined()
    expect(adapter.getSnapshot().status).toBe('unauthenticated')
  })

  it('lets a failure consumer start a fresh renewal', async () => {
    const adapter = await signedIn()
    let retry: Promise<boolean> | undefined
    adapter.onRenewalFailed(() => {
      retry ??= adapter.renew()
    })
    signinSilent
      .mockRejectedValueOnce(new Error('synthetic network failure'))
      .mockResolvedValueOnce(renewedUser())
    const first = adapter.renew()
    await expect(first).resolves.toBe(false)
    expect(retry).not.toBe(first)
    await expect(retry).resolves.toBe(true)
    expect(signinSilent).toHaveBeenCalledTimes(2)
  })

  it('does not report success when a consumer signs out during notification', async () => {
    const adapter = await signedIn()
    adapter.onRenewed(() => void adapter.signOut())
    signinSilent.mockResolvedValueOnce(renewedUser())
    await expect(adapter.renew()).resolves.toBe(false)
    expect(adapter.getAccessToken()).toBeUndefined()
    expect(adapter.getSnapshot().status).toBe('unauthenticated')
  })

  it('a retired renewal drops its own tokens without touching the successor', async () => {
    const adapter = await signedIn()
    let resolveOld!: (user: unknown) => void
    signinSilent.mockReturnValueOnce(
      new Promise((done) => {
        resolveOld = done
      })
    )
    const old = adapter.renew()
    await adapter.signIn('other-realm')
    signinRedirectCallback.mockResolvedValueOnce({
      ...renewedUser(),
      access_token: 'new-token',
      profile: { iss: 'https://id.example.test/realms/other-realm', sub: 'user-1' },
    })
    await adapter.handleCallback()
    let resolveNew!: (user: unknown) => void
    signinSilent.mockReturnValueOnce(
      new Promise((done) => {
        resolveNew = done
      })
    )
    const current = adapter.renew()
    resolveOld(renewedUser())
    await expect(old).resolves.toBe(false)
    expect(removeUser.mock.contexts).toEqual([managers[0]])
    expect(adapter.getAccessToken()).toBe('new-token')
    expect(adapter.renew()).toBe(current)
    resolveNew({
      ...renewedUser(),
      access_token: 'new-renewed-token',
      profile: { iss: 'https://id.example.test/realms/other-realm', sub: 'user-1' },
    })
    await expect(current).resolves.toBe(true)
    expect(adapter.getAccessToken()).toBe('new-renewed-token')
  })

  it('a retired refusal does not end the successor credential', async () => {
    const adapter = await signedIn()
    let rejectOld!: (error: unknown) => void
    signinSilent.mockReturnValueOnce(
      new Promise((_done, fail) => {
        rejectOld = fail
      })
    )
    const old = adapter.renew()
    await adapter.signIn('other-realm')
    signinRedirectCallback.mockResolvedValueOnce({
      ...renewedUser(),
      access_token: 'new-token',
      profile: { iss: 'https://id.example.test/realms/other-realm', sub: 'user-1' },
    })
    await adapter.handleCallback()
    rejectOld(new ErrorResponse({ error: 'invalid_grant' }))
    await expect(old).resolves.toBe(false)
    expect(adapter.getAccessToken()).toBe('new-token')
    signinSilent.mockResolvedValueOnce({
      ...renewedUser(),
      profile: { iss: 'https://id.example.test/realms/other-realm', sub: 'user-1' },
    })
    await expect(adapter.renew()).resolves.toBe(true)
  })
})

describe('one-shot reload restoration', () => {
  const live = () => ({
    access_token: 'restored',
    expired: false,
    expires_at: Math.floor(Date.now() / 1000) + 300,
    profile: { iss: issuer, sub: 'synthetic' },
  })

  it('shares one restoration and publishes stable snapshots without changing generation on renewal', async () => {
    sessionStorage.setItem('kodera.web.auth.realm', 'acme-sa')
    const adapter = new OidcAuthAdapter()
    const initial = adapter.getSnapshot()
    expect(adapter.getSnapshot()).toBe(initial)
    let resolve!: (user: unknown) => void
    signinSilent.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const listener = vi.fn()
    adapter.subscribe(listener)
    const first = adapter.restoreSession()
    const second = adapter.restoreSession()
    expect(first).toBe(second)
    expect(signinSilent).toHaveBeenCalledTimes(1)
    expect(adapter.getSnapshot().status).toBe('pending')
    const generation = adapter.getSnapshot().generation
    resolve(live())
    await expect(first).resolves.toBe(true)
    expect(adapter.getSnapshot()).toMatchObject({ status: 'ready', generation })
    const credentialGeneration = adapter.getSnapshot().credentialGeneration
    expect(adapter.getSnapshot()).toBe(adapter.getSnapshot())
    await expect(adapter.restoreSession()).resolves.toBe(true)
    expect(signinSilent).toHaveBeenCalledTimes(1)
    signinSilent.mockResolvedValueOnce({ ...live(), access_token: 'renewed' })
    await adapter.renew()
    expect(adapter.getSnapshot().generation).toBe(generation)
    expect(adapter.getSnapshot().credentialGeneration).toBe(credentialGeneration + 1)
    expect(adapter.getAccessToken()).toBe('renewed')
    expect(listener).toHaveBeenCalled()
    expect(Object.keys(sessionStorage)).toEqual(['kodera.web.auth.realm'])
  })

  it.each([
    null,
    '',
    '../other',
    'https://evil.test',
    'acme-sa?x=1',
    'acme-sa#fragment',
    '%2e%2e',
    'a/b',
  ])('refuses absent or invalid realm hint %j without SDK calls', async (hint) => {
    if (hint !== null) sessionStorage.setItem('kodera.web.auth.realm', hint)
    const adapter = new OidcAuthAdapter()
    await expect(adapter.restoreSession()).resolves.toBe(false)
    const settled = adapter.getSnapshot()
    await expect(adapter.restoreSession()).resolves.toBe(false)
    expect(adapter.getSnapshot()).toBe(settled)
    expect(settled.status).toBe('unauthenticated')
    expect(constructorSpy).not.toHaveBeenCalled()
    expect(signinSilent).not.toHaveBeenCalled()
  })

  it('treats blocked storage as no hint without preventing an explicit later session', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError')
    })
    const adapter = new OidcAuthAdapter()
    await expect(adapter.restoreSession()).resolves.toBe(false)
    expect(adapter.getSnapshot().status).toBe('unauthenticated')
    expect(constructorSpy).not.toHaveBeenCalled()
  })

  it('settles a failed SSO once and deduplicates the explicit interactive handoff', async () => {
    sessionStorage.setItem('kodera.web.auth.realm', 'acme-sa')
    const adapter = new OidcAuthAdapter()
    signinSilent.mockRejectedValueOnce(new Error('login_required'))
    await expect(adapter.restoreSession()).resolves.toBe(false)
    await expect(adapter.restoreSession()).resolves.toBe(false)
    expect(signinSilent).toHaveBeenCalledTimes(1)
    const settled = adapter.getSnapshot()
    const lateLoaded = addUserLoaded.mock.calls[0]?.[0] as (user: unknown) => void
    lateLoaded(live())
    expect(adapter.getSnapshot()).toBe(settled)
    await Promise.all([adapter.signIn('acme-sa'), adapter.signIn('acme-sa')])
    expect(signinRedirect).toHaveBeenCalledTimes(1)
    await expect(adapter.restoreSession()).resolves.toBe(false)
    expect(signinSilent).toHaveBeenCalledTimes(1)
  })

  it.each(['logout', 'replace'] as const)('ignores late restoration after %s', async (action) => {
    sessionStorage.setItem('kodera.web.auth.realm', 'acme-sa')
    const adapter = new OidcAuthAdapter()
    let resolve!: (user: unknown) => void
    signinSilent.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const pending = adapter.restoreSession()
    if (action === 'logout') await adapter.signOut()
    else await adapter.signIn('bravo')
    const snapshot = adapter.getSnapshot()
    resolve(live())
    await expect(pending).resolves.toBe(false)
    expect(adapter.getSnapshot()).toBe(snapshot)
    expect(adapter.getAccessToken()).toBeUndefined()
  })
})

function ReplacementProbe() {
  const auth = useAuth()
  return createElement('p', { 'data-testid': 'replacement-session' }, String(auth.isAuthenticated))
}

describe('replacement setup failures', () => {
  it('does not let a late redirect failure retire a newer authenticated session', async () => {
    const adapter = new OidcAuthAdapter()
    let reject!: (error: Error) => void
    signinRedirect.mockReturnValueOnce(
      new Promise<void>((_, fail) => {
        reject = fail
      })
    )
    const first = adapter.signIn('acme-sa')
    const failure = expect(first).rejects.toThrow('old redirect failed')
    await Promise.resolve()
    await adapter.signIn('bravo')
    signinRedirectCallback.mockResolvedValueOnce({
      access_token: 'new-token',
      expired: false,
      profile: { iss: 'https://id.example.test/realms/bravo', sub: 'new-user' },
    })
    await adapter.handleCallback()
    const current = adapter.getSnapshot()
    reject(new Error('old redirect failed'))
    await failure
    expect(adapter.getSnapshot()).toBe(current)
    expect(adapter.getAccessToken()).toBe('new-token')
    expect(sessionStorage.getItem('kodera.web.auth.realm')).toBe('bravo')
  })

  it('does not start queued redirect setup after immediate logout', async () => {
    const adapter = new OidcAuthAdapter()
    const pending = adapter.signIn('acme-sa')
    await adapter.signOut()
    await pending
    expect(signinRedirect).not.toHaveBeenCalled()
    expect(constructorSpy).not.toHaveBeenCalled()
    expect(adapter.getSnapshot().status).toBe('unauthenticated')
  })

  it.each(['storage', 'constructor', 'sync redirect', 'rejected redirect'] as const)(
    'closes the mounted user and private cache when %s fails',
    async (failure) => {
      const adapter = new OidcAuthAdapter()
      await adapter.signIn('acme-sa')
      signinRedirectCallback.mockResolvedValueOnce({
        access_token: 'old-token',
        expired: false,
        expires_at: Math.floor(Date.now() / 1000) + 300,
        profile: { iss: issuer, sub: 'old-user' },
      })
      await adapter.handleCallback()
      const previous = adapter.getSnapshot()
      const client = new QueryClient()
      client.setQueryData(['private-record'], { secret: 'previous-user-content' })
      render(
        createElement(AuthProvider, {
          adapter,
          onSessionEnded: () => client.clear(),
          children: createElement(ReplacementProbe),
        })
      )
      expect(screen.getByTestId('replacement-session')).toHaveTextContent('true')
      const error = new Error('replacement setup failed')
      const fail = () => {
        expect(adapter.getSnapshot().status).toBe('pending')
        expect(adapter.getSnapshot().user).toBeUndefined()
        expect(client.getQueryCache().getAll()).toEqual([])
        throw error
      }
      const storage =
        failure === 'storage'
          ? vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(fail)
          : undefined
      if (failure === 'constructor') constructorSpy.mockImplementationOnce(fail)
      if (failure === 'sync redirect') signinRedirect.mockImplementationOnce(fail)
      if (failure === 'rejected redirect') signinRedirect.mockRejectedValueOnce(error)
      await act(async () => {
        await expect(adapter.signIn('bravo')).rejects.toBe(error)
      })
      storage?.mockRestore()
      expect(adapter.getAccessToken()).toBeUndefined()
      expect(adapter.getSnapshot().user).toBeUndefined()
      expect(adapter.getSnapshot().generation).toBe(previous.generation + 1)
      expect(adapter.getSnapshot().status).toBe('unauthenticated')
      expect(screen.getByTestId('replacement-session')).toHaveTextContent('false')
      expect(client.getQueryCache().getAll()).toEqual([])
      await expect(adapter.restoreSession()).resolves.toBe(false)
      const settled = adapter.getSnapshot()
      addUserLoaded.mock.calls.at(-1)?.[0]({
        access_token: 'late-token',
        expired: false,
        expires_at: Math.floor(Date.now() / 1000) + 300,
      })
      expect(adapter.getSnapshot()).toBe(settled)
      expect(adapter.getAccessToken()).toBeUndefined()
    }
  )
})

describe('community registration', () => {
  it('uses the registration authorization endpoint with the same PKCE state store', async () => {
    const adapter = new OidcAuthAdapter()
    await adapter.signIn('community', { registration: true })
    expect(constructorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: 'https://id.example.test/realms/community',
        response_type: 'code',
        disablePKCE: false,
        metadataSeed: {
          authorization_endpoint:
            'https://id.example.test/realms/community/protocol/openid-connect/registrations',
        },
      })
    )
    expect(signinRedirect).toHaveBeenCalledTimes(1)
  })
})
