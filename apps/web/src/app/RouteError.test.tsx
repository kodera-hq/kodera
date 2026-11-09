// SH-01: a 401 on `GET /me` reached the router's own boundary, which printed
// « Something went wrong! », a « Hide Error » toggle and the raw problem URI
// in red monospace — English, no shell, no way out. Spec 00 §5 (`shell`, Error
// row) asks for a full-page error with retry and support, and §9 sends
// `unauthenticated` to the session-expired path. These run the real route
// tree with the app router's own options, so the boundary under test is the
// one a customer would hit.
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import '@/i18n'
import { ApiProblem } from '../api/client'
import { authAdapter } from '../auth/oidc'
import type * as Analytics from './analytics'
import { AppProviders, createQueryClient } from './providers'
import { createAppRouter } from './routeTree'

const { loadCurrentUser, trackSessionExpiryDialogShown } = vi.hoisted(() => ({
  loadCurrentUser: vi.fn(),
  trackSessionExpiryDialogShown: vi.fn(),
}))
vi.mock('./currentUser', () => ({ loadCurrentUser }))
vi.mock('./analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof Analytics>()),
  trackSessionExpiryDialogShown,
}))

const MARKER = 'kodera.web.session.reauthenticatingFromError'

const UNAUTHENTICATED = new ApiProblem({
  type: 'https://kodera.io/problems/unauthenticated',
  status: 401,
  title: 'Unauthenticated',
})

// Contract 0.28.0: a token that verifies, for an identity Core does not know
// or has disabled. No `WWW-Authenticate`; signing in again changes nothing.
const IDENTITY_UNKNOWN = new ApiProblem({
  type: 'https://kodera.io/problems/identity-unknown',
  status: 403,
  title: 'Identity Unknown',
})

/** Per-test time limit on the identity-unknown cases; see their note. */
const IDENTITY_UNKNOWN_TIMEOUT_MS = 4_000

const FORBIDDEN = new ApiProblem({
  type: 'https://kodera.io/problems/forbidden',
  status: 403,
  title: 'Forbidden',
})

beforeEach(() => {
  // jsdom has no scrolling; the router restores scroll on every navigation.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  vi.spyOn(authAdapter, 'restoreSession').mockResolvedValue(true)
  vi.spyOn(authAdapter, 'getAccessToken').mockReturnValue('synthetic')
  vi.spyOn(authAdapter, 'getUser').mockReturnValue({ realm: 'acme-sa' })
  vi.spyOn(authAdapter, 'signIn').mockResolvedValue(undefined)
  vi.spyOn(authAdapter, 'signOut').mockResolvedValue(undefined)
  loadCurrentUser.mockReset()
  trackSessionExpiryDialogShown.mockReset()
  sessionStorage.clear()
})

/** `router.invalidate` of the last router `openConsoleAt` built, watched from
 * before the first render so a reload started on mount is counted. */
let invalidate: MockInstance

/** Lets a screen that has just appeared run its mount effects and any load
 * they start, so a count read afterwards is the settled one. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

/** Refuses the first `/me` read with `problem` and holds every later one open.
 * Core would refuse a re-read the same way, so a screen that reloaded itself
 * would spin through reads without yielding to the test's timers, and the run
 * would hang rather than fail. Holding the second read stops that spin where
 * the call count can see it. */
function refuseOnceThenHold(problem: ApiProblem) {
  loadCurrentUser.mockRejectedValueOnce(problem).mockReturnValue(new Promise(() => {}))
}

/** The app's own router — route tree and options — on a memory history. */
async function openConsoleAt(path: string) {
  // The browser's own address too: signing in again remembers
  // `window.location`, which a memory history alone would leave at `/`.
  window.history.replaceState(null, '', path)
  const app = await createAppRouter()
  const router = createRouter({
    ...app.options,
    routeTree: app.routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  invalidate = vi.spyOn(router, 'invalidate')
  render(
    <AppProviders queryClient={createQueryClient()}>
      <RouterProvider router={router} />
    </AppProviders>
  )
  return router
}

describe('a 401 while the page loads', () => {
  it('offers to sign in again, in French, keeping the destination', async () => {
    loadCurrentUser.mockRejectedValue(UNAUTHENTICATED)
    await openConsoleAt('/acme-sa/invoices')

    const heading = await screen.findByRole('heading', {
      level: 1,
      name: "Votre session n'est pas reconnue",
    })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(screen.getByRole('alert')).toContainElement(heading)
    expect(screen.getByRole('main')).toContainElement(heading)
    expect(screen.queryByText(/Something went wrong/)).not.toBeInTheDocument()
    expect(screen.queryByText(/problems\/unauthenticated/)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Se reconnecter' }))
    expect(authAdapter.signIn).toHaveBeenCalledWith('acme-sa')
    expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe('/acme-sa/invoices')
    // Not the expiry dialog: its analytics event is not this screen's.
    expect(trackSessionExpiryDialogShown).not.toHaveBeenCalled()
  })

  // The loop the first version had: back from signing in, 401 again, and
  // « Se reconnecter » again, forever.
  it('offers signing out and support when it fails again right after signing in', async () => {
    loadCurrentUser.mockRejectedValue(UNAUTHENTICATED)
    sessionStorage.setItem(MARKER, '1')
    const router = await openConsoleAt('/acme-sa/invoices')

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: "Nous n'avons pas pu rétablir votre session",
      })
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Déconnectez-vous, puis reconnectez-vous. Si cela persiste, écrivez-nous à support@kodera.io.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Se reconnecter' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Nous écrire' })).toHaveAttribute(
      'href',
      'mailto:support@kodera.io'
    )

    await userEvent.click(screen.getByRole('button', { name: 'Se déconnecter' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(authAdapter.signOut).toHaveBeenCalled()
    expect(authAdapter.signIn).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(MARKER)).toBeNull()
  })

  it('sends « Se reconnecter » to the sign-in screen when the URL names no organisation', async () => {
    loadCurrentUser.mockRejectedValue(UNAUTHENTICATED)
    const router = await openConsoleAt('/')

    const heading = await screen.findByRole('heading', {
      level: 1,
      name: "Votre session n'est pas reconnue",
    })
    expect(screen.getByRole('main')).toContainElement(heading)
    await userEvent.click(screen.getByRole('button', { name: 'Se reconnecter' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(authAdapter.signIn).not.toHaveBeenCalled()
  })
})

describe('any other failure while the page loads', () => {
  it('shows the console error screen, with retry and the support address', async () => {
    loadCurrentUser.mockRejectedValue(
      new ApiProblem({
        type: 'https://kodera.io/problems/service-unavailable',
        status: 503,
        title: 'Service Unavailable',
        requestId: 'req-7f3a',
      })
    )
    await openConsoleAt('/acme-sa/home')

    const heading = await screen.findByRole('heading', {
      level: 1,
      name: "Impossible d'afficher votre console",
    })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(screen.getByRole('main')).toContainElement(heading)
    expect(
      screen.getByText(
        'Réessayez dans quelques instants. Si cela persiste, écrivez-nous à support@kodera.io.'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('Référence : req-7f3a')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Nous écrire' })).toHaveAttribute(
      'href',
      'mailto:support@kodera.io'
    )
    expect(screen.queryByText(/Something went wrong|Service Unavailable/)).not.toBeInTheDocument()

    loadCurrentUser.mockResolvedValue({ organisations: [] })
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(loadCurrentUser).toHaveBeenCalledTimes(2)
  })

  // `/` has no shell: the default screen draws the whole page there.
  it('draws the whole page on a route outside the organisation', async () => {
    loadCurrentUser.mockRejectedValue(new Error('network down'))
    await openConsoleAt('/')
    const heading = await screen.findByRole('heading', {
      level: 1,
      name: "Impossible d'afficher votre console",
    })
    expect(screen.getByRole('main')).toContainElement(heading)
  })
})

describe('the default error screen', () => {
  async function renderFailingRoute(withOrganisationLayout: boolean) {
    const app = await createAppRouter()
    const failing = () => {
      throw new Error('render failure')
    }
    const root = createRootRoute()
    // A stand-in for the organisation layout: same id (`/$org`), and a `main`
    // of its own, as the shell has.
    const layout = createRoute({
      getParentRoute: () => root,
      path: '$org',
      component: () => (
        <main>
          <Outlet />
        </main>
      ),
    })
    const tree = withOrganisationLayout
      ? root.addChildren([
          layout.addChildren([
            createRoute({ getParentRoute: () => layout, path: 'boom', component: failing }),
          ]),
        ])
      : root.addChildren([
          createRoute({ getParentRoute: () => root, path: 'boom', component: failing }),
        ])
    const router = createRouter({
      routeTree: tree,
      // The app router's own default, spread so that on a router with none the
      // test reaches the framework's default screen and fails there.
      ...(app.options.defaultErrorComponent === undefined
        ? {}
        : { defaultErrorComponent: app.options.defaultErrorComponent }),
      history: createMemoryHistory({
        initialEntries: [withOrganisationLayout ? '/acme-sa/boom' : '/boom'],
      }),
    })
    render(
      <AppProviders queryClient={createQueryClient()}>
        <RouterProvider router={router} />
      </AppProviders>
    )
  }

  it('is the console screen, full page, where no shell is drawn', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await renderFailingRoute(false)
    const heading = await screen.findByRole('heading', {
      level: 1,
      name: "Impossible d'afficher votre console",
    })
    expect(screen.getByRole('main')).toContainElement(heading)
    expect(screen.queryByText(/Something went wrong/)).not.toBeInTheDocument()
  })

  it('fills the shell, adding no second main, below the organisation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await renderFailingRoute(true)
    const heading = await screen.findByRole('heading', {
      level: 1,
      name: "Impossible d'afficher votre console",
    })
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getByRole('main')).toContainElement(heading)
  })
})

it('keeps a staff/customer 403 as a refusal without expiry or automatic sign-in', async () => {
  loadCurrentUser.mockRejectedValue(
    new ApiProblem({ type: null, status: 403, title: 'Synthetic refusal' })
  )
  await openConsoleAt('/acme-sa/invoices')
  await screen.findByRole('button', { name: 'Réessayer' })
  expect(screen.queryByText('Votre session a expiré')).not.toBeInTheDocument()
  expect(screen.queryByText("Votre session n'est pas reconnue")).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Se reconnecter' })).not.toBeInTheDocument()
  expect(authAdapter.signIn).not.toHaveBeenCalled()
})

describe('a 403 identity-unknown while the page loads', () => {
  it.each([
    ['an organisation route', '/acme-sa/home'],
    ['`/`, which reads `/me` before choosing an organisation', '/'],
  ])(
    'on %s, says the person is signed in but in no organisation yet, never signing in again',
    async (_, path) => {
      refuseOnceThenHold(IDENTITY_UNKNOWN)
      const router = await openConsoleAt(path)

      const heading = await screen.findByRole('heading', {
        level: 1,
        name: "Pas encore d'organisation",
      })
      await waitFor(() => expect(heading).toHaveFocus())
      // One `/me` read and no reload: a token Core refuses this way is refused
      // again, so a screen that reloaded would only re-read it, in a loop.
      await settle()
      expect(invalidate, 'router.invalidate calls').not.toHaveBeenCalled()
      expect(loadCurrentUser, '/me reads').toHaveBeenCalledTimes(1)
      expect(screen.getByRole('alert')).toContainElement(heading)
      expect(screen.getByRole('main')).toContainElement(heading)
      // An invitee whose set-up mail returned them here, before accepting, is sent back to the
      // invitation link: it is the one way into the organisation they were invited to.
      expect(
        screen.getByText(
          "Votre connexion a réussi, mais votre compte n'est rattaché à aucune organisation. Si vous avez reçu une invitation, rouvrez le lien de l'e-mail d'invitation pour la rejoindre. Sinon, demandez aux propriétaires de l'organisation de vous y ajouter."
        )
      ).toBeInTheDocument()
      // Neither the re-authentication screen nor the generic one.
      expect(screen.queryByRole('button', { name: 'Se reconnecter' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Réessayer' })).not.toBeInTheDocument()
      expect(screen.queryByText("Impossible d'afficher votre console")).not.toBeInTheDocument()
      expect(screen.queryByText(/problems\/identity-unknown/)).not.toBeInTheDocument()
      expect(authAdapter.signIn).not.toHaveBeenCalled()
      // No dead end: support, and signing out.
      expect(screen.getByRole('link', { name: 'Nous écrire' })).toHaveAttribute(
        'href',
        'mailto:support@kodera.io'
      )
      sessionStorage.setItem(MARKER, '1')
      await userEvent.click(screen.getByRole('button', { name: 'Se déconnecter' }))
      await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
      expect(authAdapter.signOut).toHaveBeenCalled()
      expect(authAdapter.signIn).not.toHaveBeenCalled()
      expect(sessionStorage.getItem(MARKER)).toBeNull()
    },
    // A guard, not a budget: a screen that reloads itself fails here quickly
    // instead of holding the run until the suite's own limit.
    IDENTITY_UNKNOWN_TIMEOUT_MS
  )

  it(
    'keeps that screen even right after a sign-in round trip',
    async () => {
      // The loop marker is about 401s; an unknown identity is not one.
      refuseOnceThenHold(IDENTITY_UNKNOWN)
      sessionStorage.setItem(MARKER, '1')
      await openConsoleAt('/acme-sa/invoices')
      expect(
        await screen.findByRole('heading', { level: 1, name: "Pas encore d'organisation" })
      ).toBeInTheDocument()
      await settle()
      expect(invalidate, 'router.invalidate calls').not.toHaveBeenCalled()
      expect(loadCurrentUser, '/me reads').toHaveBeenCalledTimes(1)
      expect(
        screen.queryByText("Nous n'avons pas pu rétablir votre session")
      ).not.toBeInTheDocument()
    },
    IDENTITY_UNKNOWN_TIMEOUT_MS
  )
})

describe('other 403s and unregistered problems, as before identity-unknown', () => {
  it('shows the generic console error for a 403 forbidden, without signing in again', async () => {
    loadCurrentUser.mockRejectedValue(FORBIDDEN)
    await openConsoleAt('/acme-sa/home')
    expect(
      await screen.findByRole('heading', { level: 1, name: "Impossible d'afficher votre console" })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
    expect(screen.queryByText("Pas encore d'organisation")).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Se reconnecter' })).not.toBeInTheDocument()
    expect(authAdapter.signIn).not.toHaveBeenCalled()
  })

  it('still starts re-authentication on a 401', async () => {
    loadCurrentUser.mockRejectedValue(UNAUTHENTICATED)
    await openConsoleAt('/acme-sa/home')
    await userEvent.click(await screen.findByRole('button', { name: 'Se reconnecter' }))
    expect(authAdapter.signIn).toHaveBeenCalledWith('acme-sa')
    expect(screen.queryByText("Pas encore d'organisation")).not.toBeInTheDocument()
  })

  it('falls back to the generic screen for a 403 whose type the registry does not hold', async () => {
    // What the client builds for an unregistered type: `type` null (`../api/client.ts`).
    loadCurrentUser.mockRejectedValue(
      new ApiProblem({ type: null, status: 403, title: 'Identity Unknown' })
    )
    await openConsoleAt('/acme-sa/home')
    expect(
      await screen.findByRole('heading', { level: 1, name: "Impossible d'afficher votre console" })
    ).toBeInTheDocument()
    expect(screen.queryByText("Pas encore d'organisation")).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Se reconnecter' })).not.toBeInTheDocument()
  })
})
