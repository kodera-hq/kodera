import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import type * as RouterModule from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ModuleRail } from './ModuleRail'
import { registerInteractiveDemo } from './interactiveDemo'
import { createLocalWorkspaceStore } from '../mocks/demo/workspaceStore'
import type { TenantApp } from '../features/status/AppsCard'

// The two queries the rail shares with the Applications screen, stubbed at
// the module the rail actually imports — the point being that the rail reads
// THOSE hooks and no endpoint of its own. A test that faked `fetch` would
// pass just as happily against a rail that invented a `/branding` call.
const fixture = vi.hoisted(() => ({
  tenantId: 'tenant-1' as string | undefined,
  /** `none`: the read answered, and the organisation has no tenant yet. */
  tenant: 'present' as 'present' | 'none' | 'loading' | 'failed' | 'none-refetch-failed',
  apps: [] as TenantApp[],
}))
vi.mock('../features/status/queries', () => ({
  useOrganisationTenant: () =>
    fixture.tenant === 'loading'
      ? { isSuccess: false, isError: false, data: undefined }
      : fixture.tenant === 'failed'
        ? { isSuccess: false, isError: true, data: undefined }
        : fixture.tenant === 'none'
          ? { isSuccess: true, isError: false, data: null }
          : fixture.tenant === 'none-refetch-failed'
            ? // TanStack v5 keeps the last answer when a later refetch fails.
              { isSuccess: false, isError: true, data: null }
            : { isSuccess: true, isError: false, data: { id: fixture.tenantId } },
  useTenantStatus: (tenantId: string | undefined) => ({
    data: tenantId === undefined ? undefined : { apps: fixture.apps },
  }),
}))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof RouterModule>()),
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}))

afterEach(() => {
  cleanup()
  registerInteractiveDemo(undefined)
  fixture.tenantId = 'tenant-1'
  fixture.tenant = 'present'
  fixture.apps = []
})

function app(overrides: Partial<TenantApp> & Pick<TenantApp, 'code'>): TenantApp {
  return {
    name: overrides.code,
    url: `https://${overrides.code}.vercelli.kodera.io`,
    state: 'live',
    ...overrides,
  }
}

const VISIO = app({ code: 'visio', name: 'Visio' })
const DOCS = app({ code: 'docs', name: 'Docs' })
const ESPACE = app({ code: 'messaging', name: 'Espace' })

function renderRail(
  surface?: 'console' | 'workspace',
  role: 'org_owner' | 'org_admin' | 'org_billing' | 'org_member' = 'org_admin'
) {
  return render(
    <ModuleRail
      org="vercelli"
      organisationId="org-1"
      organisationName="Groupe Vercelli"
      user={{ displayName: 'Claire Mercier', role: role === 'org_admin' ? 'org_admin' : 'member' }}
      role={role}
      {...(surface === undefined ? {} : { surface })}
    />
  )
}

describe('module rail', () => {
  it('is its own named landmark, so two navigation landmarks can be told apart', () => {
    renderRail()
    expect(screen.getByRole('navigation', { name: 'Modules' })).toBeInTheDocument()
  })

  it('renders one item per application the Applications screen would list', () => {
    fixture.apps = [VISIO, DOCS]
    renderRail()

    const visio = screen.getByRole('link', { name: /^Visio —/ })
    const docs = screen.getByRole('link', { name: /^Docs —/ })
    expect(visio).toHaveAttribute('href', VISIO.url)
    expect(docs).toHaveAttribute('href', DOCS.url)
    // Icons only: the name is the link's accessible name and its tooltip, not text under the glyph.
    expect(visio).toHaveTextContent('')
    expect(docs).toHaveTextContent('')
  })

  it('opens an application in a new tab and says so in the accessible name', () => {
    fixture.apps = [VISIO]
    renderRail()

    const visio = screen.getByRole('link', { name: 'Visio — Ouvre un nouvel onglet' })
    expect(visio).toHaveAttribute('target', '_blank')
    expect(visio).toHaveAttribute('rel', 'noreferrer')
  })

  it('opens unified settings without navigating away from the active room', async () => {
    const listener = vi.fn()
    window.addEventListener('kodera:workspace-command', listener)
    renderRail('workspace')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Réglages' }))
    expect(listener.mock.calls[0]?.[0].detail).toBe('settings')
    expect(screen.getByRole('link', { name: 'Messages' })).toHaveAttribute('aria-current', 'page')
    window.removeEventListener('kodera:workspace-command', listener)
  })

  it('gives every icon-only item an accessible name', () => {
    fixture.apps = [VISIO, DOCS]
    renderRail()

    const rail = screen.getByRole('navigation', { name: 'Modules' })
    for (const link of within(rail).getAllByRole('link')) {
      expect(link).toHaveAccessibleName()
    }
    expect(within(rail).queryByRole('img', { name: 'Claire Mercier' })).not.toBeInTheDocument()
  })

  it('carries the maker mark as a link to the organisation home', () => {
    renderRail()
    const home = screen.getByRole('link', { name: 'Accueil de Groupe Vercelli' })
    expect(home).toHaveAttribute('href', '/$org/home')
    // The published asset, referenced by path — never copied into `src/` and
    // never recoloured (public/README.md).
    expect(home.querySelector('img')).toHaveAttribute('src', '/kodera-mark-white.svg')
  })

  it('draws the white mark straight on the rail, with no tile that turns dark', () => {
    // SH-07: the slate mark on a `c-surface` tile was 1.45 : 1 in dark and
    // 1.69 : 1 in black, where the tile follows the theme and the mark does not.
    renderRail()
    const home = screen.getByRole('link', { name: 'Accueil de Groupe Vercelli' })
    expect([...home.classList].filter((name) => /^bg-/.test(name))).toEqual([])
  })

  it('paints the current item on the action tile, idle items on none', () => {
    // SH-07: `c-inverse-2` against the rail is 1.16 / 1.16 / 1.19 : 1;
    // the mock's `c-action` is 2.65 / 3.97 / 4.18.
    fixture.apps = [VISIO]
    renderRail('workspace')
    const current = screen.getByRole('link', { name: 'Messages' })
    expect(current).toHaveClass('bg-c-action', 'text-c-on-inverse')
    expect(current).not.toHaveClass('bg-c-inverse-2')
    const idle = screen.getByRole('link', { name: /^Visio/ })
    expect([...idle.classList].filter((name) => /^bg-/.test(name))).toEqual([])
    expect(idle).toHaveClass('text-c-on-inverse-dim')
  })

  it.each(['present', 'none', 'loading'] as const)(
    'still renders its constants for an administrator when the tenant is %s',
    (tenant) => {
      fixture.tenant = tenant
      fixture.tenantId = undefined
      renderRail()

      expect(screen.getByRole('link', { name: 'Accueil de Groupe Vercelli' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Réglages' })).toBeInTheDocument()
      // Messages is not a constant: it is drawn once the tenant is known to have it.
      expect(screen.queryByRole('link', { name: 'Messages' })).toBeNull()
      const rail = screen.getByRole('navigation', { name: 'Modules' })
      expect(within(rail).getAllByRole('link')).toHaveLength(1)
    }
  )

  it('offers « Messages » to a member before the organisation has a tenant', () => {
    fixture.tenant = 'none'
    renderRail('console', 'org_member')
    const messages = screen.getByRole('link', { name: 'Messages' })
    expect(messages).toHaveAttribute('href', '/$org/workspace')
  })

  it.each(['org_owner', 'org_admin', 'org_billing'] as const)(
    'does not offer « Messages » to %s before the organisation has a tenant',
    (role) => {
      fixture.tenant = 'none'
      renderRail('console', role)
      expect(screen.queryByRole('link', { name: 'Messages' })).toBeNull()
    }
  )

  it.each(['loading', 'failed'] as const)(
    'does not offer « Messages » to a member while the first tenant read is %s',
    (tenant) => {
      fixture.tenant = tenant
      renderRail('console', 'org_member')
      expect(screen.queryByRole('link', { name: 'Messages' })).toBeNull()
    }
  )

  it('keeps « Messages » for a member when a later tenant refetch fails', () => {
    fixture.tenant = 'none-refetch-failed'
    renderRail('console', 'org_member')
    expect(screen.getByRole('link', { name: 'Messages' })).toHaveAttribute(
      'href',
      '/$org/workspace'
    )
  })

  it('draws no « Messages » for an organisation without it, Visio alone say, whatever the role', () => {
    fixture.apps = [VISIO]
    for (const role of ['org_admin', 'org_member'] as const) {
      const { unmount } = renderRail('console', role)
      const rail = screen.getByRole('navigation', { name: 'Modules' })
      expect(within(rail).queryByRole('link', { name: /^Messages/ })).toBeNull()
      unmount()
    }
  })

  it('draws « Messages » once, as the workspace surface, for an organisation that has it', () => {
    fixture.apps = [VISIO, ESPACE]
    renderRail()
    const rail = screen.getByRole('navigation', { name: 'Modules' })
    const messages = within(rail).getAllByRole('link', { name: /^Messages/ })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toHaveAttribute('href', '/$org/workspace')
    expect(messages[0]).not.toHaveAttribute('target')
    // Not a second time as the tenant's application, under the server's name for it.
    expect(within(rail).queryByRole('link', { name: /^Espace/ })).toBeNull()
  })

  it('keeps « Messages », current, while it is on screen', () => {
    fixture.apps = [VISIO]
    renderRail('workspace')
    expect(screen.getByRole('link', { name: 'Messages' })).toHaveAttribute('aria-current', 'page')
  })

  it('draws an application code the contract does not name without borrowing another mark', () => {
    fixture.apps = [app({ code: 'quantum-fax' as TenantApp['code'], name: 'Quantum Fax' })]
    renderRail()
    expect(screen.getByRole('link', { name: /^Quantum Fax —/ })).toBeInTheDocument()
  })

  // The rail must not become a way around `role-navigation.test.tsx`: it is
  // built from applications and the console, never from the management areas
  // the sidebar gates by role, so no role can reach People, Domain,
  // Federation or Billing through it.
  it.each(['Personnes', 'Domaine & identité', 'Facturation'])(
    'offers no route to %s, whatever the role',
    (label) => {
      fixture.apps = [VISIO, DOCS]
      renderRail()
      const rail = screen.getByRole('navigation', { name: 'Modules' })
      expect(within(rail).queryByRole('link', { name: label })).toBeNull()
      for (const link of within(rail).getAllByRole('link')) {
        const href = link.getAttribute('href') ?? ''
        expect(href).not.toMatch(/people|domain|federation|invoices/)
      }
    }
  )

  it('draws « Messages » with the modules and « Réglages » after them, at the foot', () => {
    fixture.apps = [ESPACE]
    renderRail()
    const rail = screen.getByRole('navigation', { name: 'Modules' })
    const names = within(rail)
      .getAllByRole('link')
      .map((link) => link.getAttribute('aria-label'))
    expect(names.at(-1)).toBe('Messages')
    expect(
      within(screen.getAllByRole('list')[1]!).getByRole('button', { name: 'Réglages' })
    ).toBeInTheDocument()
  })

  it('does not call the console current on the workspace', () => {
    renderRail('workspace')
    expect(screen.getByRole('button', { name: 'Réglages' })).not.toHaveAttribute('aria-current')
  })
  it('offers personal settings to a member', () => {
    fixture.apps = [VISIO, ESPACE]
    renderRail('workspace', 'org_member')
    const rail = screen.getByRole('navigation', { name: 'Modules' })
    expect(within(rail).getByRole('button', { name: 'Réglages' })).toBeInTheDocument()
    expect(
      within(rail).getByRole('button', { name: 'Groupe Vercelli, changer d’organisation' })
    ).toBeInTheDocument()
  })

  it.each(['org_owner', 'org_admin', 'org_billing'] as const)(
    'offers « Réglages » to %s, at the foot of the rail, after the modules',
    (role) => {
      fixture.apps = [VISIO, ESPACE]
      renderRail('workspace', role)
      const [modules, foot] = screen.getAllByRole('list')
      expect(within(modules!).queryByRole('button', { name: 'Réglages' })).toBeNull()
      expect(within(foot!).getByRole('button', { name: 'Réglages' })).toBeInTheDocument()
    }
  )

  it('draws each item as a 48 px icon square with no title', () => {
    fixture.apps = [VISIO]
    renderRail()
    for (const link of [
      screen.getByRole('link', { name: /^Visio/ }),
      screen.getByRole('button', { name: 'Réglages' }),
    ]) {
      expect(link).toHaveClass('h-12', 'w-12')
      // A title would draw the browser's own tooltip over the rail's.
      expect(link).not.toHaveAttribute('title')
    }
  })

  it('shows an item’s name beside it on focus and under the pointer, read once', async () => {
    const user = userEvent.setup()
    fixture.apps = [VISIO]
    renderRail()
    const settings = screen.getByRole('button', { name: 'Réglages' })
    settings.focus()
    await user.keyboard('{Shift>}{Tab}{/Shift}{Tab}')
    expect(settings).toHaveFocus()
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('Réglages')
    expect(settings).toHaveAccessibleDescription('')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
    expect(settings).toHaveFocus()

    await user.hover(screen.getByRole('link', { name: /^Visio/ }))
    expect(await screen.findByRole('tooltip', { hidden: true })).toHaveTextContent('Visio')
  })

  it('names the maker’s mark with a tooltip too, and never as a description', async () => {
    const user = userEvent.setup()
    fixture.apps = []
    renderRail()
    await user.tab()
    const home = screen.getByRole('link', { name: /^Accueil/ })
    expect(home).toHaveFocus()
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent(
      home.getAttribute('aria-label') ?? '—'
    )
    expect(home).toHaveAccessibleDescription('')
  })

  it('draws « Messages » as a speech bubble, as the reference does', () => {
    fixture.apps = [ESPACE]
    renderRail()
    const messages = screen.getByRole('link', { name: 'Messages' })
    expect(messages.querySelector('svg')).toHaveAttribute('data-glyph', 'messaging')
  })

  it('keeps personal settings available while the role is not known', () => {
    fixture.apps = [VISIO]
    render(
      <ModuleRail
        org="vercelli"
        organisationId="org-1"
        organisationName="Groupe Vercelli"
        user={{ displayName: 'Claire Mercier', role: 'member' }}
      />
    )
    expect(screen.getByRole('button', { name: 'Réglages' })).toBeInTheDocument()
  })
})

it('keeps Messages available in the registered demo when tenant fixtures only list Visio', () => {
  fixture.apps = [VISIO]
  registerInteractiveDemo({ slug: 'vercelli', createStore: createLocalWorkspaceStore })
  renderRail('console')
  expect(screen.getByRole('link', { name: 'Messages' })).toHaveAttribute('href', '/$org/workspace')
})
