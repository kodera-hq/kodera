import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router'
import { ApiProblem } from '../../api/client'
import type * as RouterModule from '@tanstack/react-router'
import type * as DesktopModule from '../../auth/desktopOidc'
import i18n from '../../i18n'

const { desktop, invoke, navigate, search, discover } = vi.hoisted(() => ({
  desktop: vi.fn(() => true),
  invoke: vi.fn(),
  navigate: vi.fn(),
  search: { org: undefined as string | undefined, mode: undefined as 'tenant' | undefined },
  discover: { mutateAsync: vi.fn(), isPending: false },
}))
vi.mock('../../auth/desktopOidc', async (original) => ({
  ...(await original<typeof DesktopModule>()),
  isDesktopBundledOrigin: desktop,
}))
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof RouterModule>()),
  useNavigate: () => navigate,
  useSearch: () => search,
}))
vi.mock('./useDiscoverRealm', () => ({ useDiscoverRealm: () => discover }))

import { authAdapter } from '../../auth/oidc'
import { consumeReturnTo, rememberReturnTo } from '../../auth/return-to'
import { consumeDesktopWorkspaceCreation } from '../../auth/desktopWorkspaceCreation'
import { LoginRoute } from './LoginRoute'

function renderLogin() {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/login'] }),
  })
  return {
    ...render(
      <RouterContextProvider router={router}>
        <LoginRoute />
      </RouterContextProvider>
    ),
    router,
  }
}

const session = {
  ok: true,
  access_token: 'short-lived-access',
  expires_in: 300,
  realm: 'community',
  issuer: 'https://auth.example.test/realms/community',
  subject: 'new-member',
}

beforeEach(async () => {
  vi.clearAllMocks()
  discover.mutateAsync.mockReset()
  discover.isPending = false
  desktop.mockReturnValue(true)
  search.org = undefined
  search.mode = undefined
  vi.stubEnv('VITE_AUTH_MODE', 'oidc')
  vi.stubEnv('VITE_KEYCLOAK_URL', 'https://auth.example.test')
  vi.stubEnv('VITE_OIDC_CLIENT_ID', 'kodera-desktop')
  Object.defineProperty(window, 'koderaDesktop', {
    configurable: true,
    value: { identifier: 'io.kodera.desktop', invoke },
  })
  invoke.mockResolvedValue(session)
  consumeDesktopWorkspaceCreation('community')
  sessionStorage.clear()
  await i18n.changeLanguage('fr')
})
afterEach(async () => {
  await authAdapter.signOut()
  consumeDesktopWorkspaceCreation('community')
  delete (window as unknown as Record<string, unknown>)['koderaDesktop']
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  await i18n.changeLanguage('fr')
})

describe('Desktop workspace creation from initial sign-in', () => {
  it.each([
    ['fr', 'Créer un espace'],
    ['en', 'Create a workspace'],
  ])('renders accessible %s copy without inline styles', async (language, label) => {
    await i18n.changeLanguage(language)
    const { container } = renderLogin()
    const action = screen.getByRole('button', { name: label })
    expect(action).toBeVisible()
    expect(action).toHaveClass('narrow:min-h-[44px]')
    expect(container.querySelector('[style]')).toBeNull()
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations
    ).toEqual([])
  })

  it('registers through native PKCE once and consumes the intent after authentication', async () => {
    let resolve!: (value: typeof session) => void
    invoke.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    rememberReturnTo('/old/workspace')
    const user = userEvent.setup()
    renderLogin()
    const action = screen.getByRole('button', { name: 'Créer un espace' })
    action.focus()
    await user.keyboard('{Enter}')
    expect(action).toHaveFocus()
    expect(action).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(action)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('desktop_oidc_exchange_loopback', {
      issuer_origin: 'https://auth.example.test',
      realm: 'community',
      client_id: 'kodera-desktop',
      registration: true,
      ui_locales: 'fr',
    })
    expect(navigate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Continuer' })).toBeDisabled()
    await act(async () => resolve(session))
    expect(navigate).toHaveBeenCalledWith({ to: '/workspaces/new', replace: true })
    expect(consumeDesktopWorkspaceCreation('community')).toBeUndefined()
    expect(consumeReturnTo()).toBe('/')
    expect(
      [...Object.values(sessionStorage), ...Object.values(localStorage)].join(' ')
    ).not.toContain(session.access_token)
  })

  it('clears a refused intent, announces failure, and permits retry', async () => {
    invoke.mockRejectedValueOnce(new Error('oidc_refused:registration_disabled'))
    renderLogin()
    await userEvent.click(screen.getByRole('button', { name: 'Créer un espace' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "La connexion n'a pas pu démarrer. Réessayez."
    )
    expect(consumeDesktopWorkspaceCreation('community')).toBeUndefined()
    expect(navigate).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Créer un espace' }))
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: '/workspaces/new', replace: true })
    )
  })

  it('discards an expired intent before a late native result', async () => {
    let resolve!: (value: typeof session) => void
    invoke.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    renderLogin()
    fireEvent.click(screen.getByRole('button', { name: 'Créer un espace' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000)
    await act(async () => resolve(session))
    expect(navigate).toHaveBeenCalledWith({ to: '/', replace: true })
  })

  it('does not carry a failed creation into ordinary sign-in', async () => {
    rememberReturnTo('/community/workspace')
    invoke.mockRejectedValueOnce(new Error('oidc_loopback'))
    renderLogin()
    await userEvent.click(screen.getByRole('button', { name: 'Créer un espace' }))
    await screen.findByRole('alert')
    await act(async () => authAdapter.signIn('community'))
    expect(navigate).toHaveBeenCalledWith({ to: '/community/workspace', replace: true })
  })

  it('does not apply the intent to a replacement authentication transaction', async () => {
    let resolve!: (value: typeof session) => void
    invoke.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    renderLogin()
    fireEvent.click(screen.getByRole('button', { name: 'Créer un espace' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    await act(async () => authAdapter.signIn('community'))
    expect(navigate).toHaveBeenCalledWith({ to: '/', replace: true })
    await act(async () => resolve(session))
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it('keeps web realm discovery unchanged', () => {
    desktop.mockReturnValue(false)
    renderLogin()
    expect(screen.queryByRole('button', { name: 'Créer un espace' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Continuer' })).toBeVisible()
  })

  it('also offers creation in the identifier fallback', async () => {
    renderLogin()
    await userEvent.click(
      screen.getByRole('button', { name: "Utiliser l'identifiant de votre organisation" })
    )
    expect(screen.getByRole('button', { name: 'Créer un espace' })).toBeVisible()
  })

  it.each([429, 503])(
    'keeps creation interactive during a %s discovery cooldown',
    async (status) => {
      discover.mutateAsync.mockRejectedValueOnce(
        new ApiProblem({
          type:
            status === 429
              ? 'https://kodera.io/problems/rate-limited'
              : 'https://kodera.io/problems/service-unavailable',
          status,
          title: 'Discovery unavailable',
          retryAfterS: 3600,
        })
      )
      renderLogin()
      const user = userEvent.setup()
      await user.type(screen.getByLabelText('Adresse e-mail'), 'member@example.test')
      await user.click(screen.getByRole('button', { name: 'Continuer' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Continuer' })).toBeDisabled())
      const create = screen.getByRole('button', { name: 'Créer un espace' })
      expect(create).toBeEnabled()
      expect(create).toHaveClass('w-full')
      await user.click(create)
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith(
          'desktop_oidc_exchange_loopback',
          expect.objectContaining({ registration: true })
        )
      )
      expect(discover.mutateAsync).toHaveBeenCalledTimes(1)
    }
  )

  it('disables creation while realm discovery is in flight', () => {
    discover.isPending = true
    renderLogin()
    expect(screen.getByRole('button', { name: 'Créer un espace' })).toBeDisabled()
  })

  it('blocks the real Dedicated link until pending Community creation completes', async () => {
    search.org = 'community'
    let resolve!: (value: typeof session) => void
    invoke.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const { router } = renderLogin()
    const user = userEvent.setup()
    const create = await screen.findByRole('button', { name: 'Créer un espace' })
    expect(create).not.toHaveClass('w-full')
    const dedicated = screen.getByRole('link', { name: 'Connexion organisation dédiée' })
    expect(dedicated).toHaveAttribute('href', '/login?mode=tenant')
    await user.click(create)
    expect(dedicated).toHaveAttribute('aria-disabled', 'true')
    await user.click(dedicated)
    dedicated.focus()
    await user.keyboard('{Enter}')
    expect(router.state.location.search).toEqual({})
    expect(navigate).not.toHaveBeenCalled()
    await act(async () => resolve(session))
    expect(navigate).toHaveBeenCalledWith({ to: '/workspaces/new', replace: true })
  })

  it('opens workspace creation from Desktop Community registration too', async () => {
    search.org = 'community'
    renderLogin()
    await userEvent.click(await screen.findByRole('button', { name: 'Créer un espace' }))
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: '/workspaces/new', replace: true })
    )
  })
})
