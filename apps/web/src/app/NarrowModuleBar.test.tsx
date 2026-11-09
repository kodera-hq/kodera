// The workspace's tab bar on a phone (docs/specs/11-workspace.md §4.2, gap report G11): the rail's
// places, « Accueil », « Messages » and the tenant's other applications, in a `nav` named
// « Modules ». Rendered under a real router, so « Messages » is current by the router's own rule.
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { TenantApp } from '../features/status/AppsCard'
import { NarrowModuleBar } from './NarrowShell'
import type * as TenantApplicationsModule from './tenantApplications'

const tenant = vi.hoisted(() => ({ apps: [] as readonly TenantApp[] }))

vi.mock('./tenantApplications', async (importOriginal) => ({
  ...(await importOriginal<typeof TenantApplicationsModule>()),
  useTenantApplications: () => ({ apps: tenant.apps, noTenantYet: false }),
}))

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  tenant.apps = []
})

function app(code: TenantApp['code'], name: string): TenantApp {
  return { code, name, url: `https://${code}.acme.example/`, state: 'live' }
}

async function openAt(path: string) {
  const root = createRootRoute()
  const layout = createRoute({
    getParentRoute: () => root,
    path: '$org',
    component: () => (
      <>
        <NarrowModuleBar org="acme-sa" organisationId="org-1" />
        <Outlet />
      </>
    ),
  })
  const home = createRoute({ getParentRoute: () => layout, path: 'home', component: () => null })
  const workspace = createRoute({
    getParentRoute: () => layout,
    path: 'workspace',
    component: () => <Outlet />,
  })
  const channel = createRoute({
    getParentRoute: () => workspace,
    path: '$channelId',
    component: () => null,
  })
  const router = createRouter({
    routeTree: root.addChildren([layout.addChildren([home, workspace.addChildren([channel])])]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  render(<RouterProvider router={router} />)
  return await screen.findByRole('navigation', { name: 'Modules' })
}

describe("the workspace's tab bar on a phone (G11)", () => {
  it('draws « Accueil », « Messages », then the other applications, Espace left out', async () => {
    tenant.apps = [app('visio', 'Visio'), app('messaging', 'Espace'), app('docs', 'Docs')]
    const bar = await openAt('/acme-sa/workspace/room-1')

    const links = within(bar).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(['Accueil', 'Messages', 'Visio', 'Docs'])
    expect(within(bar).getByRole('list')).toHaveClass('grid-cols-5')
  })

  it('leads « Accueil » to the console home, and marks « Messages » current on a channel', async () => {
    const bar = await openAt('/acme-sa/workspace/room-1')

    const home = within(bar).getByRole('link', { name: 'Accueil' })
    expect(home).toHaveAttribute('href', '/acme-sa/home')
    expect(home).not.toHaveAttribute('aria-current')
    const messages = within(bar).getByRole('link', { name: 'Messages' })
    expect(messages).toHaveAttribute('href', '/acme-sa/workspace')
    expect(messages).toHaveAttribute('aria-current', 'page')
    // Told apart by more than its colour: weight and edge, as the console's tab bar.
    expect(messages).toHaveClass('font-semibold', 'border-c-accent-ink', 'text-c-accent-ink')
    expect(home).toHaveClass('font-medium', 'border-transparent', 'text-c-ink-3')
  })

  it('opens each application in a new tab and says so in its name', async () => {
    tenant.apps = [app('visio', 'Visio')]
    const bar = await openAt('/acme-sa/workspace')

    const visio = within(bar).getByRole('link', { name: 'Visio — Ouvre un nouvel onglet' })
    expect(visio).toHaveAttribute('href', 'https://visio.acme.example/')
    expect(visio).toHaveAttribute('target', '_blank')
    expect(visio).toHaveAttribute('rel', 'noreferrer')
    expect(visio.querySelector('svg')).toHaveAttribute('data-glyph', 'visio')
  })

  it('draws home, messages, and settings when the tenant runs only Espace', async () => {
    tenant.apps = [app('messaging', 'Espace')]
    const bar = await openAt('/acme-sa/workspace')

    expect(
      within(bar)
        .getAllByRole('link')
        .map((link) => link.textContent)
    ).toEqual(['Accueil', 'Messages'])
    expect(within(bar).getByRole('list')).toHaveClass('grid-cols-3')
  })

  it('gives every application and settings a column', async () => {
    tenant.apps = [
      app('visio', 'Visio'),
      app('docs', 'Docs'),
      app('drive', 'Drive'),
      app('grist', 'Grist'),
    ]
    const bar = await openAt('/acme-sa/workspace')

    expect(within(bar).getAllByRole('link')).toHaveLength(6)
    expect(within(bar).getByRole('list')).toHaveClass('grid-cols-7')
  })

  it("draws every glyph at the tab's size, beside the console tab bar's", async () => {
    tenant.apps = [app('docs', 'Docs')]
    const bar = await openAt('/acme-sa/workspace')

    for (const glyph of bar.querySelectorAll('svg')) {
      expect(glyph).toHaveAttribute('width', '17')
      expect(glyph).toHaveAttribute('stroke-width', '1.8')
    }
    expect(bar.querySelectorAll('svg')).toHaveLength(4)
  })

  it('publishes its height for the toasts and focused controls to clear', async () => {
    await openAt('/acme-sa/workspace')

    expect(document.documentElement.style.getPropertyValue('--shell-tab-bar-block')).not.toBe('')
  })
})

it('opens unified settings from the mobile module bar without changing the current room', async () => {
  const listener = vi.fn()
  window.addEventListener('kodera:workspace-command', listener)
  const bar = await openAt('/acme-sa/workspace/room-1')
  await userEvent.setup().click(within(bar).getByRole('button', { name: 'Réglages' }))
  expect(listener.mock.calls[0]?.[0].detail).toBe('settings')
  expect(within(bar).getByRole('link', { name: 'Messages' })).toHaveAttribute(
    'aria-current',
    'page'
  )
  window.removeEventListener('kodera:workspace-command', listener)
})
