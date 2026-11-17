import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'

const signOut = vi.hoisted(() => vi.fn(async () => {}))
const signIn = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ signOut }) }))
vi.mock('../../auth/oidc', () => ({ authAdapter: { signIn } }))
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  sessionStorage.clear()
  window.history.replaceState(null, '', '/')
  await i18n.changeLanguage('fr')
})

describe('real MFA enrollment remains unavailable', () => {
  it('focuses truthful guidance and offers no simulated enrollment controls', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    vi.stubEnv('VITE_ENABLE_MSW', '0')
    const { MfaEnrolScreen } = await import('./MfaEnrolScreen')
    const onEnrolled = vi.fn()
    const { container } = render(
      <MfaEnrolScreen accountEmail="synthetic@example.test" onEnrolled={onEnrolled} />
    )
    expect(
      screen.getByRole('heading', { name: 'Double authentification requise', level: 1 })
    ).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Son activation n’est pas encore disponible dans cette console.'
    )
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations).toEqual([])
    await userEvent.setup().click(screen.getByRole('button', { name: 'Se déconnecter' }))
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(onEnrolled).not.toHaveBeenCalled()
  })
})

describe('Community OIDC MFA enrolment and step-up', () => {
  it('offers Keycloak TOTP setup, 2FA step-up sign-in, and sign-out on /community/security/mfa', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    vi.stubEnv('VITE_ENABLE_MSW', '0')
    window.history.replaceState(null, '', '/community/security/mfa')
    const { MfaEnrolScreen } = await import('./MfaEnrolScreen')
    const { container } = render(
      <MfaEnrolScreen accountEmail="owner@kodera.test" onEnrolled={vi.fn()} />
    )
    expect(
      screen.getByRole('heading', { name: 'Double authentification requise', level: 1 })
    ).toHaveFocus()
    expect(screen.getByText('owner@kodera.test')).toBeVisible()
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations).toEqual([])

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Configurer la double authentification' }))
    expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe('/community/workspace')
    expect(signIn).toHaveBeenCalledWith('community', {
      kcAction: 'CONFIGURE_TOTP',
      prompt: 'login',
    })
  })

  it('starts a 2FA verification login and supports English copy and sign-out', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    vi.stubEnv('VITE_ENABLE_MSW', '0')
    await i18n.changeLanguage('en')
    window.history.replaceState(null, '', '/community/security/mfa')
    const { MfaEnrolScreen } = await import('./MfaEnrolScreen')
    const { unmount } = render(
      <MfaEnrolScreen accountEmail="owner@kodera.test" onEnrolled={vi.fn()} />
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in with my 2FA code' }))
    expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe('/community/workspace')
    expect(signIn).toHaveBeenCalledWith('community', { prompt: 'login' })
    unmount()

    signIn.mockRejectedValueOnce(new Error('upstream oidc detail'))
    render(<MfaEnrolScreen accountEmail="owner@kodera.test" onEnrolled={vi.fn()} />)
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Set up two-factor authentication' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeVisible())
    expect(screen.queryByText('upstream oidc detail')).not.toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }))
    expect(signOut).toHaveBeenCalledTimes(1)
  })
})
