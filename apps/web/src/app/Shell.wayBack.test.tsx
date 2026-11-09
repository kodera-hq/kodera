// On a phone the console's tab bar is how a person moves between places. A rail surface that
// draws another tab bar instead — the workspace, « Messages », draws the rail's places
// (docs/specs/11-workspace.md §4.2) — leaves the narrow layout with no rail, no sidebar and no
// console tab bar, so its own bar has to carry a way back to the console, or a member who enters
// the surface is stranded in it.
//
// Every DECLARED surface is held to that, released or not. Checking only the released ones would
// check nothing while a surface waits for Core, and releasing it is one flag in `railModules.ts`
// that nothing else would stop. What is checked is what `Shell` renders, not what the registry
// says: a surface that drops the console's tab bar by not rendering it is caught, whatever decides
// that. jsdom applies no CSS, so a link rendered and then hidden by a style is not seen here.

import { cleanup, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import type * as RouterModule from '@tanstack/react-router'
import type * as TenantApplicationsModule from './tenantApplications'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { railSurfaces } from './railModules'
import type { RailSurface, RailSurfaceItem } from './railModules'
import { Shell } from './Shell'
import type { OrganisationRole } from './Sidebar'

vi.mock('./useNarrowViewport', () => ({ useNarrowViewport: () => true }))
vi.mock('./StatusBanner', () => ({ StatusBanner: () => null }))
vi.mock('./tenantApplications', async (importOriginal) => ({
  ...(await importOriginal<typeof TenantApplicationsModule>()),
  useTenantApplications: () => ({ apps: [], noTenantYet: false }),
}))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof RouterModule>()),
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname: '/acme-sa/workspace' } }),
}))

afterEach(cleanup)

const ROLE: OrganisationRole = 'org_member'
const TAB_BAR = 'Navigation par onglets'

function renderNarrowShell(surface: RailSurface) {
  return render(
    <Shell
      org="acme-sa"
      organisationId="org-1"
      organisation={{ name: 'ACME Construction', slug: 'acme-sa' }}
      user={{ displayName: 'Henri Duflot', role: 'member' }}
      role={ROLE}
      onSignOut={() => {}}
      surface={surface}
    >
      <h1>Page</h1>
    </Shell>
  )
}

function describeSurface(item: RailSurfaceItem): string {
  return `« ${item.surface} » (${item.released === false ? 'not released yet' : 'RELEASED'})`
}

const DECLARED = railSurfaces({ includeUnreleased: true })

describe('a phone always has a way out of a rail surface', () => {
  it('is checked against at least one surface without the console tab bar', () => {
    // Without one, the check below passes on the console's tab bar alone and proves nothing about
    // a surface's own way back.
    const without = DECLARED.filter((item) => {
      renderNarrowShell(item.surface)
      const absent = screen.queryByRole('navigation', { name: TAB_BAR }) === null
      cleanup()
      return absent
    })
    expect(
      without.map((item) => item.surface),
      '« workspace » renders the console tab bar on a phone, so no declared surface draws its own ' +
        'and the way-back check below would pass on the console tab bar alone. If the workspace ' +
        'now keeps the console tab bar on purpose, point this check at the surface that does not.'
    ).toContain('workspace')
  })

  it.each(DECLARED.map((item) => [item.surface, item] as const))(
    '%s offers « Accueil », the console home, in a navigation on a phone',
    (_, item) => {
      renderNarrowShell(item.surface)
      const home = screen
        .getAllByRole('navigation')
        .flatMap((nav) => within(nav).queryAllByRole('link', { name: 'Accueil' }))
      expect(
        home.map((link) => link.getAttribute('href')),
        `${describeSurface(item)} offers no « Accueil » link to the console in any navigation on ` +
          'a phone: a member who opens it there is stranded. Draw `NarrowModuleBar` for it ' +
          '(src/app/Shell.tsx) before releasing it.'
      ).toContain('/$org/home')
    }
  )

  it("keeps the console's own tab bar on the console's pages", () => {
    renderNarrowShell('console')

    expect(screen.getByRole('navigation', { name: TAB_BAR })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Modules' })).toBeNull()
  })

  it("puts the workspace's way back in its tab bar only, and keeps the maker's mark on top", () => {
    renderNarrowShell('workspace')

    expect(screen.getByRole('navigation', { name: 'Modules' })).toBeInTheDocument()
    expect(within(screen.getByRole('banner')).queryAllByRole('link')).toHaveLength(0)
    expect(screen.getAllByRole('link', { name: 'Accueil' })).toHaveLength(1)
  })
})
