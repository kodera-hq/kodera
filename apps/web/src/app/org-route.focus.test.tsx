// The organisation layout is where a route change is announced and where the
// page heading takes focus (docs/specs/00-shell-and-login.md §10, UX audit
// SH-15). `RouteFocus.test.tsx` proves the mechanism; this proves the layout
// mounts it, and that what it announces is the title the content header shows
// for the role that is signed in — or the order's own name, where the header
// has none.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
  useRouterState,
} from '@tanstack/react-router'
import { ErrorResponse, User, UserManager } from 'oidc-client-ts'
import { afterEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { AuthProvider } from '../auth/AuthProvider'
import { authAdapter } from '../auth/oidc'
import { orgRoute } from './org-route'
import { rootRoute } from './root-route'

// The real layout, loader and router state; the frame around the page is not
// what is under test, and the real one reads the Core API.
vi.mock('./Shell', () => ({
  Shell: (props: { children: ReactNode }) => <main id="main-content">{props.children}</main>,
}))
vi.mock('./SessionExpiryDialog', () => ({
  SessionExpiryDialog: () => <div data-testid="session-expiry-dialog" />,
}))
const identity = vi.hoisted(() => ({
  mfaEnrolled: true,
  holdReload: false,
  reads: 0,
  generation: 0,
  credentialGeneration: 0,
}))
vi.mock('./currentUser', () => ({
  loadCurrentUser: async () => {
    identity.reads += 1
    if (identity.holdReload && identity.reads > 1) await new Promise<void>(() => {})
    return {
      generation: identity.generation,
      credentialGeneration: identity.credentialGeneration,
      me: {
        id: '11111111-2222-4333-8444-555555555555',
        email: 'claire@example.test',
        display_name: 'Claire Mercier',
        locale: 'fr',
        staff: false,
        identities: [
          {
            id: '3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d',
            issuer: 'https://id.example.test/realms/acme-sa',
            realm: 'acme-sa',
            subject: 'subject',
            email: 'claire@example.test',
            mfa_enrolled: identity.mfaEnrolled,
          },
        ],
        organisations: [
          {
            identity_id: '3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d',
            membership_id: '7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c',
            state: 'active',
            role: 'org_owner',
            organisation: {
              id: '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f',
              slug: 'acme-sa',
              name: 'Acme',
              realm: 'acme-sa',
            },
          },
        ],
      },
    }
  },
}))

const issuer = 'https://id.example.test/realms/acme-sa'

afterEach(async () => {
  await authAdapter.signOut()
  vi.unstubAllEnvs()
  identity.mfaEnrolled = true
  identity.holdReload = false
  identity.reads = 0
  identity.generation = 0
  identity.credentialGeneration = 0
})

/** Signs in, then opens the real layout on `initialPath` with a small tree of
 * pages under it. */
async function openLayout(initialPath: string, pages: [path: string, page: () => ReactNode][]) {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  vi.stubEnv('VITE_KEYCLOAK_URL', 'https://id.example.test')
  vi.stubEnv('VITE_OIDC_CLIENT_ID', 'console')
  sessionStorage.clear()
  vi.spyOn(UserManager.prototype, 'signinRedirect').mockResolvedValue()
  vi.spyOn(UserManager.prototype, 'signinCallback').mockResolvedValueOnce(
    new User({
      access_token: 'subject',
      token_type: 'Bearer',
      expires_at: Math.floor(Date.now() / 1000) + 300,
      profile: { iss: issuer, sub: 'subject', aud: 'console', iat: 0, exp: 9999999999 },
    })
  )
  await authAdapter.signIn('acme-sa')
  await authAdapter.handleCallback()
  const authority = authAdapter.getSnapshot()
  identity.generation = authority.generation
  identity.credentialGeneration = authority.credentialGeneration

  const router = createRouter({
    routeTree: rootRoute.addChildren([
      orgRoute.addChildren(
        pages.map(([path, component]) =>
          createRoute({ getParentRoute: () => orgRoute, path, component })
        )
      ),
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  render(
    // The organisation layout reads the workspace tenant from the query cache, as in the app.
    <QueryClientProvider client={new QueryClient()}>
      <AuthProvider adapter={authAdapter}>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  )
  return router
}

const titled = (heading: string) => () => <h1>{heading}</h1>

it('announces the header title and focuses the heading when the area changes', async () => {
  const router = await openLayout('/acme-sa/home', [
    ['home', titled('Bonjour Claire')],
    ['invoices', titled('Factures')],
    ['invoices/$invoiceId', titled('Facture F-2026-0042')],
  ])

  // Arriving is not a route change: nothing is announced, nothing is focused.
  await screen.findByRole('heading', { level: 1, name: 'Bonjour Claire' })
  await waitFor(() => expect(router.state.status).toBe('idle'))
  expect(screen.getByRole('status')).toBeEmptyDOMElement()
  expect(document.body).toHaveFocus()

  await router.navigate({ href: '/acme-sa/invoices' })
  const list = await screen.findByRole('heading', { level: 1, name: 'Factures' })
  await waitFor(() => expect(list).toHaveFocus())
  expect(screen.getByRole('status')).toHaveTextContent('Page Facturation chargée.')

  // A nested page keeps its area's title, as the content header does.
  await router.navigate({ href: '/acme-sa/invoices/abc' })
  const detail = await screen.findByRole('heading', { level: 1, name: 'Facture F-2026-0042' })
  await waitFor(() => expect(detail).toHaveFocus())
  expect(screen.getByRole('status')).toHaveTextContent('Page Facturation chargée.')
})

it('hides the old shell and invalidates once while fresh token authority is loading', async () => {
  const router = await openLayout('/acme-sa/home', [['home', titled('Bonjour Claire')]])
  await screen.findByRole('heading', { level: 1, name: 'Bonjour Claire' })
  await waitFor(() => expect(router.state.status).toBe('idle'))
  identity.holdReload = true
  const invalidate = vi.spyOn(router, 'invalidate')
  const renewedUser = (accessToken: string) =>
    new User({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_at: Math.floor(Date.now() / 1000) + 300,
      profile: { iss: issuer, sub: 'subject', aud: 'console', iat: 0, exp: 9999999999 },
    })
  vi.spyOn(UserManager.prototype, 'signinSilent')
    .mockResolvedValueOnce(renewedUser('renewed'))
    .mockResolvedValueOnce(renewedUser('renewed'))

  await act(async () => {
    await expect(authAdapter.renew()).resolves.toBe(true)
  })
  await waitFor(() => expect(document.querySelector('main[aria-busy="true"]')).not.toBeNull())
  expect(screen.queryByRole('heading', { level: 1, name: 'Bonjour Claire' })).toBeNull()
  expect(invalidate).toHaveBeenCalledTimes(1)

  await act(async () => {
    await expect(authAdapter.renew()).resolves.toBe(true)
  })
  expect(invalidate).toHaveBeenCalledTimes(1)
})

it('keeps only the expiry dialog when credential authority ends', async () => {
  const router = await openLayout('/acme-sa/home', [['home', titled('Bonjour Claire')]])
  await screen.findByRole('heading', { level: 1, name: 'Bonjour Claire' })
  await waitFor(() => expect(router.state.status).toBe('idle'))
  const invalidate = vi.spyOn(router, 'invalidate')
  const redirect = vi.mocked(UserManager.prototype.signinRedirect)
  redirect.mockClear()
  vi.spyOn(UserManager.prototype, 'signinSilent').mockRejectedValueOnce(
    new ErrorResponse({ error: 'invalid_grant' })
  )

  await act(async () => {
    await expect(authAdapter.renew()).resolves.toBe(false)
  })

  expect(screen.getByTestId('session-expiry-dialog')).toBeInTheDocument()
  expect(screen.queryByRole('heading', { level: 1, name: 'Bonjour Claire' })).toBeNull()
  expect(document.querySelector('main[aria-busy="true"]')).toBeNull()
  expect(invalidate).not.toHaveBeenCalled()
  expect(redirect).not.toHaveBeenCalled()
})

// The order flow (docs/specs/01-order.md §10). Its screens draw the flow's
// name in a visually hidden `h1` above the step's own title; the header has no
// title for it; and the wizard announces each step itself.
it('announces the order by its own name, and leaves its steps to the wizard', async () => {
  /** What an order step draws, as far as this layout is concerned. */
  function Step() {
    const step = useRouterState({ select: (state) => state.location.pathname.split('/')[4] })
    return (
      <>
        <h1 className="sr-only">Commander votre instance</h1>
        <h1 key={step}>{step === 'plan' ? 'Choisissez votre formule' : 'Votre organisation'}</h1>
      </>
    )
  }
  const router = await openLayout('/acme-sa/home', [
    ['home', titled('Bonjour Claire')],
    ['order/$draftId/$step', Step],
  ])
  await screen.findByRole('heading', { level: 1, name: 'Bonjour Claire' })
  await waitFor(() => expect(router.state.status).toBe('idle'))

  // Entering the order is a route change like any other, under a real title:
  // the content header has only « Console » for this area.
  await router.navigate({ href: '/acme-sa/order/draft-1/plan' })
  const plan = await screen.findByRole('heading', { level: 1, name: 'Choisissez votre formule' })
  await waitFor(() => expect(plan).toHaveFocus())
  const region = screen.getByRole('status')
  expect(region).toHaveTextContent('Page Commander votre instance chargée.')

  // A step: focus moves to the step's visible title, and this region is left
  // exactly as it was. Anything written to it would be a second announcement
  // beside the wizard's « Étape 2 sur 4 ».
  const said = region.firstElementChild
  const written: MutationRecord[] = []
  const observer = new MutationObserver((records) => written.push(...records))
  observer.observe(region, { childList: true, characterData: true, subtree: true })
  await router.navigate({ href: '/acme-sa/order/draft-1/contacts' })
  const contacts = await screen.findByRole('heading', { level: 1, name: 'Votre organisation' })
  expect(contacts).not.toBe(plan)
  expect(plan).not.toBeInTheDocument()
  await waitFor(() => expect(contacts).toHaveFocus())
  observer.disconnect()
  expect(written).toEqual([])
  expect(region.firstElementChild).toBe(said)
  expect(
    screen.getByRole('heading', { level: 1, name: 'Commander votre instance' })
  ).not.toHaveAttribute('tabindex')
})

// §10: arriving is not a route change, "nor is a redirect on the way to a
// page". A person with no second factor is sent to the enrolment guide by an
// effect, once the layout is mounted and before any page is drawn: they have
// arrived on the guide, and the guide was announced as a page change.
it('does not announce the enrolment guide to a person the guard sends there on arrival', async () => {
  identity.mfaEnrolled = false
  const router = await openLayout('/acme-sa/home', [
    ['home', titled('Bonjour Claire')],
    ['security/mfa', titled('Sécurisez votre compte')],
  ])

  const guide = await screen.findByRole('heading', { level: 1, name: 'Sécurisez votre compte' })
  await waitFor(() => expect(router.state.status).toBe('idle'))
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
  expect(router.state.location.pathname).toBe('/acme-sa/security/mfa')
  expect(screen.queryByRole('heading', { level: 1, name: 'Bonjour Claire' })).toBeNull()

  // The guide's own branch of the layout mounts the region: this query fails
  // without it. And the region has said nothing.
  expect(screen.getByRole('status')).toBeEmptyDOMElement()
  expect(document.body).toHaveFocus()
  expect(guide).not.toHaveAttribute('tabindex')
})
