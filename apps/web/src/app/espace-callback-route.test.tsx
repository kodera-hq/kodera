import { render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import {
  beginMatrixSignIn,
  clearMatrixSession,
  getMatrixSession,
  type MatrixSignInProblem,
} from '../auth/matrix'

const { navigate, useAuthMock, restoreSessionMock, getUserMock } = vi.hoisted(() => ({
  navigate: vi.fn(),
  useAuthMock: vi.fn(),
  restoreSessionMock: vi.fn(),
  getUserMock: vi.fn(),
}))

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => useAuthMock(),
}))

vi.mock('../auth/oidc', () => ({
  authAdapter: {
    restoreSession: (...args: unknown[]) => restoreSessionMock(...args),
    getUser: (...args: unknown[]) => getUserMock(...args),
  },
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  useRouter: () => ({ navigate }),
}))

import { espaceCallbackRoute } from './espace-callback-route'

const EspaceCallback = espaceCallbackRoute.options.component!

const HS = 'https://matrix.acme-sa.kodera.io'
const SUB = '0b6c5a3e-7d1f-4c2a-9e8b-1f2d3c4b5a69'
const LOGIN_TOKEN = 'syl_single_use_secret'

function startPendingCallback(returnTo = '/acme-sa/workspace'): string {
  let redirectTarget = ''
  beginMatrixSignIn(HS, returnTo, {
    consoleOrigin: window.location.origin,
    navigate: (url) => {
      redirectTarget = url
    },
  })
  const callbackUrl = new URL(new URL(redirectTarget).searchParams.get('redirectUrl')!)
  callbackUrl.searchParams.set('loginToken', LOGIN_TOKEN)
  window.history.replaceState(null, '', `${callbackUrl.pathname}${callbackUrl.search}`)
  return callbackUrl.href
}

function assertLoginTokenNeverStored() {
  for (const storage of [window.sessionStorage, window.localStorage]) {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i)!
      expect(storage.getItem(key)).not.toContain(LOGIN_TOKEN)
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearMatrixSession()
  window.sessionStorage.clear()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  useAuthMock.mockReturnValue({
    user: {
      realm: 'acme-sa',
      identity: { issuer: 'https://id.kodera.io/realms/acme-sa', subject: SUB },
    },
  })
  getUserMock.mockReturnValue({
    realm: 'acme-sa',
    identity: { issuer: 'https://id.kodera.io/realms/acme-sa', subject: SUB },
  })
  restoreSessionMock.mockResolvedValue(true)
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearMatrixSession()
  window.sessionStorage.clear()
  window.localStorage.clear()
})

describe('EspaceCallback route under StrictMode', () => {
  it('strips loginToken immediately, exchanges once with the member sub, and navigates to returnTo', async () => {
    startPendingCallback('/acme-sa/workspace')
    const fetchSpy = vi.fn<typeof globalThis.fetch>(async () => {
      // By the time the Synapse login POST starts, loginToken is already stripped from the URL.
      expect(window.location.search).toBe('')
      expect(window.location.href).not.toContain(LOGIN_TOKEN)
      return new Response(
        JSON.stringify({
          user_id: `@${SUB}:acme-sa.kodera.io`,
          access_token: 'syt_matrix_access',
          refresh_token: 'syr_matrix_refresh',
          device_id: 'KODERADEV',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })
    vi.stubGlobal('fetch', fetchSpy)

    render(
      <StrictMode>
        <EspaceCallback />
      </StrictMode>
    )

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1))
    expect(navigate).toHaveBeenCalledWith({ href: '/acme-sa/workspace', replace: true })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(window.location.href).not.toContain(LOGIN_TOKEN)
    expect(getMatrixSession()?.accessToken).toBe('syt_matrix_access')
    assertLoginTokenNeverStored()
  })

  it('strips loginToken before awaiting restoreSession when the SPA reloads on the callback URL', async () => {
    startPendingCallback('/acme-sa/workspace')
    useAuthMock.mockReturnValue({ user: undefined })
    getUserMock.mockReturnValueOnce(undefined).mockReturnValue({
      realm: 'acme-sa',
      identity: { issuer: 'https://id.kodera.io/realms/acme-sa', subject: SUB },
    })

    let resolveRestore!: (restored: boolean) => void
    restoreSessionMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          // Even before restoreSession settles, loginToken is already removed from window.location.
          expect(window.location.search).toBe('')
          expect(window.location.href).not.toContain(LOGIN_TOKEN)
          resolveRestore = resolve
        })
    )

    const fetchSpy = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            user_id: `@${SUB}:acme-sa.kodera.io`,
            access_token: 'syt_restored_access',
            refresh_token: 'syr_restored_refresh',
            device_id: 'KODERADEV',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    )
    vi.stubGlobal('fetch', fetchSpy)

    render(
      <StrictMode>
        <EspaceCallback />
      </StrictMode>
    )

    expect(window.location.href).not.toContain(LOGIN_TOKEN)
    resolveRestore(true)

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1))
    expect(navigate).toHaveBeenCalledWith({ href: '/acme-sa/workspace', replace: true })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    assertLoginTokenNeverStored()
  })

  it('fails closed without calling Synapse when no Console member session can be restored', async () => {
    startPendingCallback('/acme-sa/workspace')
    useAuthMock.mockReturnValue({ user: undefined })
    getUserMock.mockReturnValue(undefined)
    restoreSessionMock.mockResolvedValue(false)
    const fetchSpy = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('fetch', fetchSpy)

    render(
      <StrictMode>
        <EspaceCallback />
      </StrictMode>
    )

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveAttribute('data-problem', 'unexpected-callback')
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      i18n.t('console.shell._.error-load-failed')
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    expect(window.location.href).not.toContain(LOGIN_TOKEN)
    expect(window.sessionStorage.getItem('kodera.web.espace.signin')).toBeNull()
    assertLoginTokenNeverStored()
  })

  it('fails closed and revokes the token when Synapse signs in another person (other-person)', async () => {
    startPendingCallback('/acme-sa/workspace')
    const calls: string[] = []
    const fetchSpy = vi.fn<typeof globalThis.fetch>(async (input) => {
      calls.push(String(input))
      if (String(input).endsWith('/login')) {
        return new Response(
          JSON.stringify({
            user_id: '@different-sub:acme-sa.kodera.io',
            access_token: 'syt_wrong_person',
            refresh_token: 'syr_wrong_person',
            device_id: 'KODERADEV',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchSpy)

    render(
      <StrictMode>
        <EspaceCallback />
      </StrictMode>
    )

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveAttribute('data-problem', 'other-person')
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      i18n.t('console.shell.session.body-restore-failed')
    )
    expect(calls).toEqual([`${HS}/_matrix/client/v3/login`, `${HS}/_matrix/client/v3/logout`])
    expect(navigate).not.toHaveBeenCalled()
    expect(getMatrixSession()).toBeUndefined()
    assertLoginTokenNeverStored()
  })

  it.each<[MatrixSignInProblem, number, unknown]>([
    ['refused', 403, { errcode: 'M_FORBIDDEN' }],
    [
      'not-refreshable',
      200,
      { user_id: `@${SUB}:acme-sa.kodera.io`, access_token: 'syt_x', device_id: 'D1' },
    ],
    ['unreadable', 200, { user_id: 123 }],
  ])('fails closed without navigating on %s', async (expectedProblem, status, body) => {
    startPendingCallback('/acme-sa/workspace')
    const fetchSpy = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetchSpy)

    render(
      <StrictMode>
        <EspaceCallback />
      </StrictMode>
    )

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveAttribute('data-problem', expectedProblem)
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      i18n.t('console.shell._.error-load-failed')
    )
    expect(navigate).not.toHaveBeenCalled()
    expect(getMatrixSession()).toBeUndefined()
    assertLoginTokenNeverStored()
  })

  it.each([
    'https://evil.example/phish',
    '//evil.example/phish',
    '/\\evil.example/phish',
    'javascript:alert(1)',
  ])('normalizes unsafe returnTo %s back to /', async (unsafeReturnTo) => {
    startPendingCallback(unsafeReturnTo)
    const fetchSpy = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            user_id: `@${SUB}:acme-sa.kodera.io`,
            access_token: 'syt_matrix_access',
            refresh_token: 'syr_matrix_refresh',
            device_id: 'KODERADEV',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    )
    vi.stubGlobal('fetch', fetchSpy)

    render(
      <StrictMode>
        <EspaceCallback />
      </StrictMode>
    )

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1))
    expect(navigate).toHaveBeenCalledWith({ href: '/', replace: true })
    assertLoginTokenNeverStored()
  })
})
