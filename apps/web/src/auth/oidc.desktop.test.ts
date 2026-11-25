import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { createElement } from 'react'
import type { DesktopOidcSessionPayload } from './desktopOidc'
import type * as DesktopOidcModule from './desktopOidc'
import type * as RouterModule from '@tanstack/react-router'

const { desktop, invoke, loadSdk, navigate } = vi.hoisted(() => ({
  desktop: vi.fn(() => true),
  invoke: vi.fn(),
  loadSdk: vi.fn(() => {
    throw new Error('Unexpected browser SDK load.')
  }),
  navigate: vi.fn(),
}))
vi.mock('./desktopOidc', async (original) => ({
  ...(await original<typeof DesktopOidcModule>()),
  isDesktopBundledOrigin: desktop,
}))
vi.mock('./oidcSdk', () => ({
  loadOidcSdk: loadSdk,
  oidcSdkLoaded: () => false,
  oidcSdk: () => {
    throw new Error('Unexpected browser SDK use.')
  },
}))
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof RouterModule>()),
  useNavigate: () => navigate,
  useSearch: () => ({ org: 'community', mode: 'tenant' }),
}))
vi.mock('../features/login/LoginScreen', () => ({ LoginScreen: () => null }))
vi.mock('../features/login/CommunityWelcome', () => ({ CommunityWelcome: () => null }))

import { OidcAuthAdapter, authAdapter } from './oidc'
import { clearMatrixSession, getMatrixSession, signInToMatrixDesktop } from './matrix'
import { LoginRoute } from '../features/login/LoginRoute'
import { rememberReturnTo } from './return-to'

const issuer = 'https://auth.kodera.io/realms/community'
const adapters: OidcAuthAdapter[] = []
function adapter() {
  const next = new OidcAuthAdapter()
  adapters.push(next)
  return next
}
function session(accessToken = 'access-in-memory'): DesktopOidcSessionPayload {
  return {
    ok: true,
    access_token: accessToken,
    expires_in: 300,
    realm: 'community',
    issuer,
    subject: 'member',
    amr: ['pwd', 'otp'],
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  desktop.mockReturnValue(true)
  vi.stubEnv('VITE_KEYCLOAK_URL', 'https://auth.kodera.io')
  vi.stubEnv('VITE_OIDC_CLIENT_ID', 'kodera-desktop')
  window.sessionStorage.clear()
  window.localStorage.clear()
  Object.defineProperty(window, 'koderaDesktop', {
    configurable: true,
    value: { identifier: 'io.kodera.desktop', invoke },
  })
  invoke.mockImplementation(async (command: string) =>
    command === 'desktop_oidc_clear_session' ? { ok: true } : session()
  )
})
afterEach(async () => {
  for (const item of adapters.splice(0)) await item.signOut()
  await authAdapter.signOut()
  clearMatrixSession()
  delete (window as unknown as Record<string, unknown>)['koderaDesktop']
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('native desktop OIDC sessions', () => {
  it('signs in and publishes a ready identity in place without loading the browser SDK', async () => {
    document.documentElement.lang = 'fr'
    const current = adapter()
    await current.signIn('community', {
      registration: true,
      prompt: 'login',
      kcAction: 'CONFIGURE_TOTP',
    })
    expect(invoke).toHaveBeenCalledWith('desktop_oidc_exchange_loopback', {
      issuer_origin: 'https://auth.kodera.io',
      realm: 'community',
      client_id: 'kodera-desktop',
      registration: true,
      ui_locales: 'fr',
      prompt: 'login',
      kc_action: 'CONFIGURE_TOTP',
    })
    expect(current.getSnapshot()).toMatchObject({
      status: 'ready',
      generation: 1,
      user: { realm: 'community', identity: { issuer, subject: 'member', amr: ['pwd', 'otp'] } },
    })
    expect(current.getAccessToken()).toBe('access-in-memory')
    expect(current.getExpiresAt()).toBe(Date.now() + 300_000)
    expect(sessionStorage.getItem('kodera.web.auth.realm')).toBe('community')
    expect(
      [...Object.values(sessionStorage), ...Object.values(localStorage)].join(' ')
    ).not.toContain('access-in-memory')
    expect(loadSdk).not.toHaveBeenCalled()
  })

  it('restores the remembered realm through one shared native refresh', async () => {
    sessionStorage.setItem('kodera.web.auth.realm', 'community')
    const current = adapter()
    const first = current.restoreSession()
    expect(current.restoreSession()).toBe(first)
    await expect(first).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('desktop_oidc_refresh_session', {
      issuer_origin: 'https://auth.kodera.io',
      realm: 'community',
      client_id: 'kodera-desktop',
    })
    expect(current.getSnapshot().status).toBe('ready')
    expect(loadSdk).not.toHaveBeenCalled()
  })

  it('leaves a fresh installation unauthenticated without launching a browser', async () => {
    const current = adapter()
    await expect(current.restoreSession()).resolves.toBe(false)
    expect(current.getSnapshot().status).toBe('unauthenticated')
    expect(invoke).not.toHaveBeenCalled()
    expect(loadSdk).not.toHaveBeenCalled()
  })

  it('coalesces renewals and publishes the next credential without replacing the identity generation', async () => {
    const current = adapter()
    await current.signIn('community')
    const renewed = vi.fn()
    current.onRenewed(renewed)
    const generation = current.getSnapshot().generation
    const credentialGeneration = current.getSnapshot().credentialGeneration
    const next = deferred<DesktopOidcSessionPayload>()
    invoke.mockImplementation((command: string) =>
      command === 'desktop_oidc_refresh_session' ? next.promise : Promise.resolve({ ok: true })
    )
    const first = current.renew()
    expect(current.renew()).toBe(first)
    next.resolve(session('renewed-access'))
    await expect(first).resolves.toBe(true)
    expect(current.getAccessToken()).toBe('renewed-access')
    expect(current.getSnapshot()).toMatchObject({
      generation,
      credentialGeneration: credentialGeneration + 1,
    })
    expect(renewed).toHaveBeenCalledTimes(1)
    expect(loadSdk).not.toHaveBeenCalled()
  })

  it('ends a refused credential and keeps the public identity for reauthentication', async () => {
    const current = adapter()
    await current.signIn('community')
    const failed = vi.fn()
    current.onRenewalFailed(failed)
    invoke.mockRejectedValueOnce(new Error('oidc_refused:invalid_grant'))
    await expect(current.renew()).resolves.toBe(false)
    expect(current.getAccessToken()).toBeUndefined()
    expect(current.getSnapshot()).toMatchObject({
      status: 'ready',
      user: { identity: { subject: 'member' } },
    })
    expect(failed).toHaveBeenCalledTimes(1)
    const calls = invoke.mock.calls.length
    await expect(current.renew()).resolves.toBe(false)
    expect(invoke).toHaveBeenCalledTimes(calls)
  })

  it('handles a missing or revoked stored refresh credential during restoration', async () => {
    sessionStorage.setItem('kodera.web.auth.realm', 'community')
    invoke.mockRejectedValueOnce(new Error('oidc_refused:no_refresh_credential'))
    const current = adapter()
    await expect(current.restoreSession()).resolves.toBe(false)
    expect(current.getSnapshot().status).toBe('unauthenticated')
    expect(current.getAccessToken()).toBeUndefined()
    expect(loadSdk).not.toHaveBeenCalled()
  })

  it('notifies before expiry, renews, and retires timers at sign-out', async () => {
    const current = adapter()
    const expiring = vi.fn()
    current.onExpiring(expiring)
    await current.signIn('community')
    invoke.mockResolvedValueOnce(session('timer-renewed'))
    await vi.advanceTimersByTimeAsync(180_000)
    expect(expiring).toHaveBeenCalledTimes(1)
    expect(current.getAccessToken()).toBe('timer-renewed')
    await current.signOut()
    expect(invoke).toHaveBeenLastCalledWith('desktop_oidc_clear_session', { realm: 'community' })
    expect(current.getSnapshot().status).toBe('unauthenticated')
    expect(current.getAccessToken()).toBeUndefined()
    expect(current.getExpiresAt()).toBeUndefined()
    expect(sessionStorage.getItem('kodera.web.auth.realm')).toBeNull()
    const calls = invoke.mock.calls.length
    await vi.advanceTimersByTimeAsync(600_000)
    expect(invoke).toHaveBeenCalledTimes(calls)
  })

  it('preserves a token after transport failure only until its expiry and permits retry', async () => {
    const current = adapter()
    const failed = vi.fn()
    current.onRenewalFailed(failed)
    await current.signIn('community')
    invoke.mockRejectedValueOnce(new Error('oidc_transport'))
    await vi.advanceTimersByTimeAsync(180_000)
    expect(current.getAccessToken()).toBe('access-in-memory')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(current.getAccessToken()).toBeUndefined()
    expect(failed).toHaveBeenCalledTimes(2)
    await expect(current.renew()).resolves.toBe(true)
  })

  it('does not accept late native results after sign-out or an identity change', async () => {
    const current = adapter()
    const pending = deferred<DesktopOidcSessionPayload>()
    invoke.mockReturnValueOnce(pending.promise)
    const signin = current.signIn('community')
    await Promise.resolve()
    await current.signOut()
    pending.resolve(session())
    await signin
    expect(current.getSnapshot().status).toBe('unauthenticated')
    expect(current.getAccessToken()).toBeUndefined()
    await current.signIn('community')
    invoke.mockResolvedValueOnce({ ...session(), subject: 'other-person' })
    await expect(current.renew()).resolves.toBe(false)
    expect(current.getSnapshot().status).toBe('unauthenticated')
    expect(current.getAccessToken()).toBeUndefined()
  })

  it.each(['resolve', 'reject'] as const)(
    'keeps the replacement renewal when retired work completes through %s',
    async (completion) => {
      const current = adapter()
      await current.signIn('community')
      const retired = deferred<DesktopOidcSessionPayload>()
      let rejectRetired!: (error: Error) => void
      const retiredResult = new Promise<DesktopOidcSessionPayload>((resolve, reject) => {
        void retired.promise.then(resolve)
        rejectRetired = reject
      })
      invoke.mockReturnValueOnce(retiredResult)
      const oldRenewal = current.renew()
      await Promise.resolve()
      await current.signIn('community')
      const replacement = deferred<DesktopOidcSessionPayload>()
      invoke.mockReturnValueOnce(replacement.promise)
      const nextRenewal = current.renew()
      await Promise.resolve()
      if (completion === 'resolve') retired.resolve(session('retired-access'))
      else rejectRetired(new Error('oidc_transport'))
      await expect(oldRenewal).resolves.toBe(false)
      expect(current.renew()).toBe(nextRenewal)
      replacement.resolve(session('replacement-access'))
      await expect(nextRenewal).resolves.toBe(true)
      expect(current.getAccessToken()).toBe('replacement-access')
      invoke.mockResolvedValueOnce(session('next-access'))
      const retry = current.renew()
      expect(retry).not.toBe(nextRenewal)
      await expect(retry).resolves.toBe(true)
      expect(current.getAccessToken()).toBe('next-access')
    }
  )

  it('rejects malformed native session payloads and mismatched issuers', async () => {
    for (const result of [
      { ...session(), issuer: 'https://evil.example/realms/community' },
      { ...session(), realm: 'other' },
      { ...session(), expires_in: 0 },
      { ...session(), subject: '' },
    ]) {
      invoke.mockResolvedValueOnce(result)
      const current = adapter()
      await expect(current.signIn('community')).rejects.toThrow()
      expect(current.getSnapshot().status).toBe('unauthenticated')
      expect(current.getAccessToken()).toBeUndefined()
    }
  })

  it('navigates the login route to its remembered destination after in-place sign-in', async () => {
    rememberReturnTo('/community/workspace')
    render(createElement(LoginRoute))
    await act(async () => {
      await authAdapter.signIn('community')
    })
    expect(navigate).toHaveBeenCalledWith({ to: '/community/workspace', replace: true })
    expect(loadSdk).not.toHaveBeenCalled()
  })
})

describe('native desktop Matrix SSO', () => {
  function mockMatrix(subject = 'member', stateOverride?: string) {
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      expect(command).toBe('desktop_matrix_sso_loopback')
      expect(args?.['homeserver_origin']).toBe('https://community.kodera.io')
      return {
        ok: true,
        callback_uri: `http://127.0.0.1:49152/espace/callback?loginToken=single-use&state=${stateOverride ?? String(args?.['state'])}`,
      }
    })
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          user_id: `@${subject}:community.kodera.io`,
          device_id: 'desktop-device',
          access_token: 'matrix-access',
          refresh_token: 'matrix-refresh',
          expires_in_ms: 300_000,
        }),
        { status: 200 }
      )
    )
    vi.stubGlobal('fetch', fetch)
    return fetch
  }
  it('exchanges the native callback and registers the Matrix session without changing the WebView URL', async () => {
    const fetch = mockMatrix()
    const replace = vi.spyOn(window.history, 'replaceState')
    const before = window.location.href
    const result = await signInToMatrixDesktop(
      'https://community.kodera.io',
      '/community/workspace',
      'member'
    )
    expect(result.returnTo).toBe('/community/workspace')
    expect(getMatrixSession()).toBe(result.session)
    expect(result.session.userId).toBe('@member:community.kodera.io')
    expect(fetch).toHaveBeenCalledWith(
      'https://community.kodera.io/_matrix/client/v3/login',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"token":"single-use"'),
      })
    )
    expect(window.location.href).toBe(before)
    expect(replace).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('kodera.web.espace.signin')).toBeNull()
  })
  it('refuses a callback state mismatch before exchanging a token', async () => {
    const fetch = mockMatrix('member', 'different-state')
    await expect(
      signInToMatrixDesktop('https://community.kodera.io', '/', 'member')
    ).rejects.toMatchObject({ problem: 'unexpected-callback' })
    expect(fetch).not.toHaveBeenCalled()
    expect(getMatrixSession()).toBeUndefined()
  })
  it('rejects a late browser callback after the Matrix session was cleared', async () => {
    const pending = deferred<{ ok: true; callback_uri: string }>()
    let state = ''
    invoke.mockImplementation((_command: string, args?: Record<string, unknown>) => {
      state = String(args?.['state'])
      return pending.promise
    })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const signin = signInToMatrixDesktop('https://community.kodera.io', '/', 'member')
    clearMatrixSession()
    pending.resolve({
      ok: true,
      callback_uri: `http://127.0.0.1:49152/espace/callback?loginToken=single-use&state=${state}`,
    })
    await expect(signin).rejects.toMatchObject({ problem: 'unexpected-callback' })
    expect(fetch).not.toHaveBeenCalled()
    expect(getMatrixSession()).toBeUndefined()
  })
  it('returns a foreign Matrix identity to the homeserver without registering it', async () => {
    const fetch = mockMatrix('other-person')
    await expect(
      signInToMatrixDesktop('https://community.kodera.io', '/', 'member')
    ).rejects.toMatchObject({ problem: 'other-person' })
    expect(fetch).toHaveBeenLastCalledWith(
      'https://community.kodera.io/_matrix/client/v3/logout',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer matrix-access' }),
      })
    )
    expect(getMatrixSession()).toBeUndefined()
  })
})
