import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'

const signOut = vi.hoisted(() => vi.fn(async () => {}))
const signIn = vi.hoisted(() => vi.fn(async () => {}))
const authState = vi.hoisted(() => ({
  realm: undefined as string | undefined,
  amr: undefined as readonly string[] | undefined,
}))
vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => ({
    user:
      authState.realm === undefined
        ? undefined
        : {
            realm: authState.realm,
            ...(authState.amr === undefined
              ? {}
              : {
                  identity: {
                    issuer: `https://auth.kodera.test/realms/${authState.realm}`,
                    subject: 'owner-1',
                    amr: authState.amr,
                  },
                }),
          },
    signOut,
  }),
}))
vi.mock('../../auth/oidc', () => ({ authAdapter: { signIn } }))
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  authState.realm = undefined
  authState.amr = undefined
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
  it.each(['/testing/security/mfa', '/testing/security/mfa/', '/%74esting/security/mfa'])(
    'returns shared-realm MFA enrollment to its own workspace (%s)',
    async (path) => {
      const realm = 'community'
      vi.stubEnv('VITE_AUTH_MODE', 'oidc')
      vi.stubEnv('VITE_ENABLE_MSW', '0')
      authState.realm = realm
      window.history.replaceState(null, '', path)
      const { MfaEnrolScreen } = await import('./MfaEnrolScreen')
      const { container } = render(
        <MfaEnrolScreen
          accountEmail="owner@example.test"
          org="testing"
          sharedRealm={true}
          onEnrolled={vi.fn()}
        />
      )
      expect(container.querySelector('[style]')).toBeNull()
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Vérifier avec mon code 2FA' }))
      expect(signIn).toHaveBeenCalledWith(realm, { prompt: 'login' })
      expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe('/testing/workspace')
    }
  )

  it('uses the router pathname when memory history differs from the browser URL', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    vi.stubEnv('VITE_ENABLE_MSW', '0')
    authState.realm = 'community'
    const { MfaEnrolScreen } = await import('./MfaEnrolScreen')
    const root = createRootRoute({
      component: () => (
        <MfaEnrolScreen
          accountEmail="owner@example.test"
          org="testing"
          sharedRealm={true}
          onEnrolled={vi.fn()}
        />
      ),
    })
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({ initialEntries: ['/%74esting/security/mfa/'] }),
    })
    render(<RouterProvider router={router} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Vérifier avec mon code 2FA' }))
    expect(signIn).toHaveBeenCalledExactlyOnceWith('community', { prompt: 'login' })
    expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe('/testing/workspace')
  })

  it.each([
    { org: 'testing', sharedRealm: false, realm: 'community' },
    { org: 'another', sharedRealm: true, realm: 'community' },
    { org: undefined, sharedRealm: true, realm: 'community' },
    { org: 'testing', sharedRealm: true, realm: 'acme-sa' },
    { org: 'testing', sharedRealm: true, realm: 'kodera-staff' },
  ])(
    'refuses enrollment without the exact shared-realm route and issuer: %j',
    async ({ org, sharedRealm, realm }) => {
      vi.stubEnv('VITE_AUTH_MODE', 'oidc')
      authState.realm = realm
      window.history.replaceState(null, '', '/testing/security/mfa')
      const { MfaEnrolScreen } = await import('./MfaEnrolScreen')
      render(
        <MfaEnrolScreen
          accountEmail="owner@example.test"
          org={org}
          sharedRealm={sharedRealm}
          onEnrolled={vi.fn()}
        />
      )
      expect(screen.getAllByRole('button')).toHaveLength(1)
      expect(signIn).not.toHaveBeenCalled()
    }
  )

  it('offers Keycloak TOTP setup, 2FA step-up sign-in, and sign-out for the community realm', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    vi.stubEnv('VITE_ENABLE_MSW', '0')
    authState.realm = 'community'
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
    authState.realm = 'community'
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

  it('steps up kodera-staff with prompt=login only and refuses cross-realm signIn for tenant realms', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    vi.stubEnv('VITE_ENABLE_MSW', '0')
    authState.realm = 'kodera-staff'
    window.history.replaceState(null, '', '/community/security/mfa')
    const { MfaEnrolScreen } = await import('./MfaEnrolScreen')
    const { unmount } = render(
      <MfaEnrolScreen accountEmail="staff@kodera.test" onEnrolled={vi.fn()} />
    )
    expect(
      screen.queryByRole('button', { name: 'Configurer la double authentification' })
    ).not.toBeInTheDocument()
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Vérifier avec mon code 2FA' }))
    expect(signIn).toHaveBeenCalledWith('kodera-staff', { prompt: 'login' })
    unmount()

    signIn.mockClear()
    authState.realm = 'acme-sa'
    render(<MfaEnrolScreen accountEmail="member@acme.test" onEnrolled={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Son activation n’est pas encore disponible dans cette console.'
    )
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Se déconnecter' })).toBeVisible()
    expect(signIn).not.toHaveBeenCalled()
  })

  it('hides CONFIGURE_TOTP when the current identity already carries otp or hwk in amr', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    vi.stubEnv('VITE_ENABLE_MSW', '0')
    authState.realm = 'community'
    authState.amr = ['pwd', 'otp']
    window.history.replaceState(null, '', '/community/security/mfa')
    const { MfaEnrolScreen } = await import('./MfaEnrolScreen')
    render(<MfaEnrolScreen accountEmail="owner@kodera.test" onEnrolled={vi.fn()} />)
    expect(
      screen.queryByRole('button', { name: 'Configurer la double authentification' })
    ).not.toBeInTheDocument()
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Vérifier avec mon code 2FA' }))
    expect(signIn).toHaveBeenCalledWith('community', { prompt: 'login' })
  })

  it('shows voluntary personal security copy instead of admin lockout warning for org_member (issue 221)', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    vi.stubEnv('VITE_ENABLE_MSW', '0')
    authState.realm = 'community'
    window.history.replaceState(null, '', '/community/security/mfa')
    const { MfaEnrolScreen } = await import('./MfaEnrolScreen')
    render(
      <MfaEnrolScreen
        accountEmail="member@kodera.test"
        memberRole="org_member"
        onEnrolled={vi.fn()}
      />
    )
    expect(
      screen.getByRole('heading', { name: 'Protéger votre compte (2FA)', level: 1 })
    ).toBeInTheDocument()
    expect(screen.queryByText(/accès administrateur/i)).not.toBeInTheDocument()
  })
})
