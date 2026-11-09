// SH-08: the router joins a link's `className` with its active or inactive
// `className`, and `cx` does not merge. With `text-c-ink` in the shared base,
// the current item carried `text-c-ink` AND `text-c-accent-ink`, and the
// stylesheet order painted it `c-ink`. These run the real router so the joined
// class list is the one a browser receives.
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { conflictKey } from '../../tests/unit/ui/classConflicts'
import { Sidebar } from './Sidebar'
import type { OrganisationRole } from './Sidebar'

vi.mock('./OrgSwitcher', () => ({ OrgSwitcher: () => null }))
vi.mock('./UserBlock', () => ({ UserBlock: () => null }))

const ROLE: OrganisationRole = 'org_owner'

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
})

async function renderSidebarAt(path: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <Sidebar
        org="acme-sa"
        organisation={{ name: 'ACME', slug: 'acme-sa' }}
        role={ROLE}
        user={{ displayName: 'Synthetic', role: 'member' }}
        onSignOut={() => {}}
      />
    ),
  })
  const pages = ['/$org/home', '/$org/status', '/$org/people'].map((routePath) =>
    createRoute({ getParentRoute: () => rootRoute, path: routePath, component: () => null })
  )
  const router = createRouter({
    routeTree: rootRoute.addChildren(pages),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  render(<RouterProvider router={router} />)
  return screen.findByRole('link', { name: 'Accueil' })
}

/** The text colour classes an item could carry, `hover:` and the like excluded. */
const INKS = new Set([
  'text-c-ink',
  'text-c-ink-2',
  'text-c-ink-3',
  'text-c-accent-ink',
  'text-c-action',
])
const inks = (element: Element) => [...element.classList].filter((name) => INKS.has(name))

/** No two colour classes for one property under one variant. */
function expectNoColourConflict(element: Element) {
  const keys = [...element.classList].map(conflictKey).filter((key) => key !== undefined)
  expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([])
}

describe('sidebar item colours', () => {
  it('paints the current item in the accent ink at 600, with an accent ink edge', async () => {
    const current = await renderSidebarAt('/acme-sa/home')
    expect(current).toHaveAttribute('aria-current', 'page')
    expect(inks(current)).toEqual(['text-c-accent-ink'])
    expect(current).toHaveClass(
      'font-semibold',
      'bg-c-accent-soft',
      'border-c-accent-ink',
      'before:bg-c-action'
    )
    expect(current).not.toHaveClass('font-medium', 'border-transparent')
    expectNoColourConflict(current)
  })

  it('paints an idle item in the second ink at 500, on a muted hover', async () => {
    await renderSidebarAt('/acme-sa/home')
    const idle = screen.getByRole('link', { name: 'Applications' })
    expect(idle).not.toHaveAttribute('aria-current')
    expect(inks(idle)).toEqual(['text-c-ink-2'])
    expect(idle).toHaveClass('font-medium', 'border-transparent', 'hover:bg-c-muted')
    // One class at a time: `not.toHaveClass(a, b)` passes when either one is missing.
    for (const name of [
      'font-semibold',
      'bg-c-accent-soft',
      'border-c-accent-ink',
      'before:bg-c-action',
    ])
      expect(idle).not.toHaveClass(name)
    expectNoColourConflict(idle)
  })

  it('moves the colour with the route', async () => {
    await renderSidebarAt('/acme-sa/status')
    expect(inks(screen.getByRole('link', { name: 'Applications' }))).toEqual(['text-c-accent-ink'])
    expect(inks(screen.getByRole('link', { name: 'Accueil' }))).toEqual(['text-c-ink-2'])
  })
})
