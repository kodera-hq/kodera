// The unknown-organisation screen (docs/specs/00-shell-and-login.md §3). It is
// drawn in two places: as the whole page, when the address names an
// organisation the person does not belong to, and inside the shell, when the
// address names no page of their organisation. The axe scan of the first found
// a page with no `main` landmark (`landmark-one-main`, `region`); the second
// already sits in the shell's `main` and must not add another.
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
} from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { NotFoundOrganisation } from './NotFoundOrganisation'

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
})

/** A stand-in for the organisation layout: same id (`/$org`), the same
 * not-found screen, and a `main` of its own, as the shell has. */
function openAt(path: string, membership: boolean) {
  const root = createRootRoute()
  const layout = createRoute({
    getParentRoute: () => root,
    path: '$org',
    loader: () => {
      if (!membership) throw notFound()
    },
    notFoundComponent: NotFoundOrganisation,
    component: () => (
      <main>
        <Outlet />
      </main>
    ),
  })
  const home = createRoute({
    getParentRoute: () => layout,
    path: 'home',
    component: () => <h1>Bonjour Julie</h1>,
  })
  const router = createRouter({
    routeTree: root.addChildren([layout.addChildren([home])]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  render(<RouterProvider router={router} />)
}

describe('NotFoundOrganisation', () => {
  it('names the cause in French, from the catalogue', async () => {
    openAt('/nowhere/home', false)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Organisation introuvable' })
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Aucune organisation ne correspond à cette adresse. Vérifiez le lien, ou connectez-vous pour retrouver la vôtre.'
      )
    ).toBeInTheDocument()
  })

  it('is the page’s main landmark when no shell is drawn around it', async () => {
    openAt('/nowhere/home', false)
    const heading = await screen.findByRole('heading', { name: 'Organisation introuvable' })
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getByRole('main')).toContainElement(heading)
  })

  it('adds no second main inside the shell', async () => {
    openAt('/acme-sa/no-such-page', true)
    const heading = await screen.findByRole('heading', { name: 'Organisation introuvable' })
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getByRole('main')).toContainElement(heading)
  })
})
