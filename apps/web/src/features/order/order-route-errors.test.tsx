// The order route's own error screen (« owner unavailable ») caught every
// failure under it: a 401 or a render error in the wizard read as an
// ownership problem, with a retry that could not help. It now keeps that
// screen for ownership only and hands everything else to the console's.
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { ApiProblem } from '../../api/client'
import { AppProviders, createQueryClient } from '../../app/providers'
import { OrderOwnershipUnavailable } from './freshOwner'
import type * as FreshOwner from './freshOwner'
import { orderRoute } from './routes'

const { loadFreshOrderContext } = vi.hoisted(() => ({ loadFreshOrderContext: vi.fn() }))
vi.mock('./freshOwner', async (importOriginal) => ({
  ...(await importOriginal<typeof FreshOwner>()),
  loadFreshOrderContext,
}))

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

/** The order route's error component, under a stand-in organisation layout. */
function renderOrderFailure(failure: () => never) {
  const errorComponent = orderRoute.options.errorComponent
  if (errorComponent === undefined || errorComponent === false) {
    throw new Error('the order route declares no error component')
  }
  const root = createRootRoute()
  const layout = createRoute({
    getParentRoute: () => root,
    path: '$org',
    component: () => (
      <main>
        <Outlet />
      </main>
    ),
  })
  const order = createRoute({
    getParentRoute: () => layout,
    path: 'order',
    beforeLoad: failure,
    errorComponent,
  })
  const router = createRouter({
    routeTree: root.addChildren([layout.addChildren([order])]),
    history: createMemoryHistory({ initialEntries: ['/acme-sa/order'] }),
  })
  render(
    <AppProviders queryClient={createQueryClient()}>
      <RouterProvider router={router} />
    </AppProviders>
  )
}

it('sends a 401 to the expired-session screen, not to « owner unavailable »', async () => {
  renderOrderFailure(() => {
    throw new ApiProblem({
      type: 'https://kodera.io/problems/unauthenticated',
      status: 401,
      title: 'Unauthenticated',
    })
  })
  expect(
    await screen.findByRole('heading', { level: 1, name: "Votre session n'est pas reconnue" })
  ).toBeInTheDocument()
  expect(screen.queryByText(/vérifier vos droits/)).not.toBeInTheDocument()
})

it('shows the console error screen for a failure that is not about ownership', async () => {
  renderOrderFailure(() => {
    throw new Error('render failure')
  })
  expect(
    await screen.findByRole('heading', { level: 1, name: "Impossible d'afficher votre console" })
  ).toBeInTheDocument()
})

it('keeps its own screen when ownership could not be established', async () => {
  renderOrderFailure(() => {
    throw new OrderOwnershipUnavailable()
  })
  expect(
    await screen.findByText(/Nous n’avons pas pu vérifier vos droits pour cette commande/)
  ).toBeInTheDocument()
  expect(
    screen.queryByRole('heading', { level: 1, name: "Impossible d'afficher votre console" })
  ).not.toBeInTheDocument()
})

// Contract 0.28.0: an identity Core does not know is the person's state, not
// the order's. The route's own guard must hand it on unwrapped, or the console
// would say it could not check order rights instead of "no organisation yet".
it('hands a 403 identity-unknown to the console screen instead of « owner unavailable »', async () => {
  const unknown = new ApiProblem({
    type: 'https://kodera.io/problems/identity-unknown',
    status: 403,
    title: 'Identity Unknown',
  })
  loadFreshOrderContext.mockRejectedValue(unknown)
  const beforeLoad = orderRoute.options.beforeLoad
  if (beforeLoad === undefined) throw new Error('the order route declares no guard')
  const guard = beforeLoad as unknown as (context: {
    params: { org: string }
    abortController: AbortController
  }) => Promise<unknown>
  await expect(
    guard({ params: { org: 'acme-sa' }, abortController: new AbortController() })
  ).rejects.toBe(unknown)

  renderOrderFailure(() => {
    throw unknown
  })
  expect(
    await screen.findByRole('heading', { level: 1, name: "Pas encore d'organisation" })
  ).toBeInTheDocument()
  expect(screen.queryByText(/vérifier vos droits/)).not.toBeInTheDocument()
})

it('still wraps a 403 forbidden as this route’s own ownership failure', async () => {
  const forbidden = new ApiProblem({
    type: 'https://kodera.io/problems/forbidden',
    status: 403,
    title: 'Forbidden',
  })
  loadFreshOrderContext.mockRejectedValue(forbidden)
  const guard = orderRoute.options.beforeLoad as unknown as (context: {
    params: { org: string }
    abortController: AbortController
  }) => Promise<unknown>
  const failure = await guard({
    params: { org: 'acme-sa' },
    abortController: new AbortController(),
  }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(OrderOwnershipUnavailable)
})
