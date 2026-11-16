import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../i18n'

const { handleCallback, signIn, navigate, authState } = vi.hoisted(() => ({
  handleCallback: vi.fn(),
  signIn: vi.fn(),
  navigate: vi.fn(),
  authState: { isAuthenticated: false },
}))
vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ handleCallback, signIn, isAuthenticated: authState.isAuthenticated }),
}))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  useRouter: () => ({ navigate }),
}))
import { CALLBACK_BOUNCE_KEY, callbackRoute } from './callback-route'
const Callback = callbackRoute.options.component!

beforeEach(() => {
  vi.clearAllMocks()
  authState.isAuthenticated = false
  sessionStorage.clear()
  sessionStorage.setItem('kodera.web.auth.returnTo', '/acme-sa/home?preserve=1')
  window.history.replaceState(null, '', '/auth/callback')
  signIn.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  window.history.replaceState(null, '', '/')
})

describe('callback route under StrictMode', () => {
  it('does not navigate or consume the parent destination after silent notification', async () => {
    handleCallback.mockResolvedValue('silent')
    render(
      <StrictMode>
        <Callback />
      </StrictMode>
    )
    await waitFor(() => expect(handleCallback).toHaveBeenCalled())
    expect(navigate).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe('/acme-sa/home?preserve=1')
  })

  it('navigates only once after interactive completion and clears any prior bounce marker', async () => {
    sessionStorage.setItem(CALLBACK_BOUNCE_KEY, String(Date.now()))
    handleCallback.mockResolvedValue('interactive')
    render(
      <StrictMode>
        <Callback />
      </StrictMode>
    )
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1))
    expect(navigate).toHaveBeenCalledWith({ href: '/acme-sa/home?preserve=1' })
    expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBeNull()
    expect(sessionStorage.getItem(CALLBACK_BOUNCE_KEY)).toBeNull()
  })

  it('keeps a failed callback truthful and leaves the destination untouched', async () => {
    handleCallback.mockRejectedValue(new Error('Invalid transaction'))
    render(
      <StrictMode>
        <Callback />
      </StrictMode>
    )
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        i18n.t('console.shell._.error-load-failed')
      )
    )
    expect(signIn).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe('/acme-sa/home?preserve=1')
  })

  it('restarts sign-in once on authentication_expired and stops if repeated within 60s', async () => {
    sessionStorage.setItem('kodera.web.auth.realm', 'acme-sa')
    window.history.replaceState(
      null,
      '',
      '/auth/callback?error=temporarily_unavailable&error_description=authentication_expired'
    )
    handleCallback.mockRejectedValue(new Error('authentication_expired'))

    const first = render(
      <StrictMode>
        <Callback />
      </StrictMode>
    )
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1))
    expect(signIn).toHaveBeenCalledWith('acme-sa')
    expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe('/acme-sa/home?preserve=1')
    expect(screen.getByRole('status')).toHaveTextContent(
      i18n.t('console.login.handoff.a11y-redirecting')
    )
    first.unmount()

    // A second expired return inside the 60s single-bounce window stops instead of looping.
    signIn.mockClear()
    render(
      <StrictMode>
        <Callback />
      </StrictMode>
    )
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        i18n.t('console.shell.session.body-unrecognized')
      )
    )
    expect(signIn).not.toHaveBeenCalled()
    const retryButton = screen.getByRole('button', {
      name: i18n.t('console.shell.session.action-sign-in-again'),
    })
    fireEvent.click(retryButton)
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1))
    expect(signIn).toHaveBeenCalledWith('acme-sa')
  })

  it('recovers cross-tab Community verification callbacks with no sessionStorage realm hint', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.io')
    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new URL(
        'https://community.kodera.io/auth/callback?code=other-tab-code&state=other-tab-state'
      ),
    })
    sessionStorage.clear()
    handleCallback.mockRejectedValue(new Error('No pending sign-in. Start again from /login.'))

    try {
      render(
        <StrictMode>
          <Callback />
        </StrictMode>
      )
      await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1))
      expect(signIn).toHaveBeenCalledWith('community')
      expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe('/community/workspace')
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      })
    }
  })

  it('never auto-retries protected owner-claim callbacks or permanent OAuth refusals', async () => {
    sessionStorage.setItem('kodera.web.auth.realm', 'acme-sa')
    window.history.replaceState(null, '', '/auth/callback?error=login_required&state=claim-1')
    handleCallback.mockRejectedValue(new Error('Use the protected owner-claim callback.'))

    const claim = render(
      <StrictMode>
        <Callback />
      </StrictMode>
    )
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        i18n.t('console.shell._.error-load-failed')
      )
    )
    expect(signIn).not.toHaveBeenCalled()
    claim.unmount()

    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.io')
    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new URL('https://community.kodera.io/auth/callback?error=access_denied&state=s1'),
    })
    sessionStorage.clear()
    handleCallback.mockRejectedValue(new Error('No pending sign-in.'))
    try {
      render(
        <StrictMode>
          <Callback />
        </StrictMode>
      )
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(
          i18n.t('console.shell._.error-load-failed')
        )
      )
      expect(signIn).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      })
    }
  })

  it('allows one fresh auto-retry again once the 60s bounce TTL has elapsed', async () => {
    sessionStorage.setItem('kodera.web.auth.realm', 'acme-sa')
    sessionStorage.setItem(CALLBACK_BOUNCE_KEY, String(Date.now() - 61_000))
    window.history.replaceState(null, '', '/auth/callback?error=login_required')
    handleCallback.mockRejectedValue(new Error('login_required'))

    render(
      <StrictMode>
        <Callback />
      </StrictMode>
    )
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1))
    expect(signIn).toHaveBeenCalledWith('acme-sa')
  })

  it('navigates directly instead of calling signIn when an authenticated session already exists', async () => {
    authState.isAuthenticated = true
    sessionStorage.setItem('kodera.web.auth.realm', 'acme-sa')
    window.history.replaceState(
      null,
      '',
      '/auth/callback?error=temporarily_unavailable&error_description=authentication_expired'
    )
    handleCallback.mockRejectedValue(new Error('authentication_expired'))

    render(
      <StrictMode>
        <Callback />
      </StrictMode>
    )
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1))
    expect(navigate).toHaveBeenCalledWith({ href: '/acme-sa/home?preserve=1', replace: true })
    expect(signIn).not.toHaveBeenCalled()
  })

  it('retains the pending realm for manual retry when automatic signIn rejects and clears sessionStorage', async () => {
    sessionStorage.setItem('kodera.web.auth.realm', 'acme-sa')
    window.history.replaceState(
      null,
      '',
      '/auth/callback?error=temporarily_unavailable&error_description=authentication_expired'
    )
    handleCallback.mockRejectedValue(new Error('authentication_expired'))
    signIn.mockImplementationOnce(async () => {
      sessionStorage.removeItem('kodera.web.auth.realm')
      throw new Error('Transient metadata fetch failure')
    })

    render(
      <StrictMode>
        <Callback />
      </StrictMode>
    )
    const retryButton = await screen.findByRole('button', {
      name: i18n.t('console.shell.session.action-sign-in-again'),
    })
    expect(sessionStorage.getItem('kodera.web.auth.realm')).toBeNull()

    signIn.mockClear()
    signIn.mockResolvedValueOnce(undefined)
    fireEvent.click(retryButton)
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1))
    expect(signIn).toHaveBeenCalledWith('acme-sa')
  })

  it('still invokes signIn on manual retry when sessionStorage.setItem throws on Community host', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.io')
    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new URL('https://community.kodera.io/auth/callback?error=login_required'),
    })
    sessionStorage.clear()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })
    handleCallback.mockRejectedValue(new Error('login_required'))

    try {
      render(
        <StrictMode>
          <Callback />
        </StrictMode>
      )
      const retryButton = await screen.findByRole('button', {
        name: i18n.t('console.shell.session.action-sign-in-again'),
      })
      fireEvent.click(retryButton)
      await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1))
      expect(signIn).toHaveBeenCalledWith('community')
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      })
    }
  })
})
