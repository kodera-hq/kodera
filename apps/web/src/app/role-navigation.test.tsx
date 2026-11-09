import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type * as RouterModule from '@tanstack/react-router'
import type * as CoreClientModule from '../api/client'
import '@/i18n'
import { Sidebar } from './Sidebar'
import type { OrganisationRole } from './Sidebar'
import { peopleRoute } from '../features/people/routes'
import { domainRoute } from '../features/domain/routes'
import { federationRoute } from '../features/federation/routes'

const fixture = vi.hoisted(() => ({ role: 'org_owner' as OrganisationRole }))
vi.mock('./org-route', () => ({
  orgRoute: {
    useLoaderData: () => ({
      membership: { role: fixture.role, organisation: { id: 'synthetic-organisation' } },
    }),
  },
}))
// A route that is a real screen reads the Core API once its gate lets the
// person in. This file judges the gate only: the read never resolves, so an
// allowed role stays on the screen's own loading state.
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof CoreClientModule>()),
  coreApi: () => ({ GET: () => new Promise(() => {}) }),
}))
vi.mock('./OrgSwitcher', () => ({ OrgSwitcher: () => null }))
// The guard is under test, not the People screen behind it, which needs a
// router and a query client this file does not provide.
vi.mock('../features/people/PeopleArea', () => ({
  PeopleListBody: () => <p>Personnes</p>,
  PeopleRecoveryGate: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('./UserBlock', () => ({ UserBlock: () => null }))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof RouterModule>()),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}))
afterEach(cleanup)
const roles: OrganisationRole[] = ['org_owner', 'org_admin', 'org_billing', 'org_member']

describe('explicit organisation role navigation', () => {
  it.each(roles)('sidebar grants only the allowed areas to %s', (role) => {
    render(
      <Sidebar
        org="acme-sa"
        organisation={{ name: 'ACME', slug: 'acme-sa' }}
        role={role}
        user={{ displayName: 'Synthetic', role: 'member' }}
        onSignOut={() => {}}
      />
    )
    expect(screen.getByRole('link', { name: 'Accueil' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Applications' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Aide' })).toBeInTheDocument()
    const manages = role === 'org_owner' || role === 'org_admin'
    expect(screen.queryByRole('link', { name: 'Personnes' }) !== null).toBe(manages)
    expect(screen.queryByRole('link', { name: 'Domaine & identité' }) !== null).toBe(manages)
    expect(screen.queryByRole('link', { name: 'Facturation' }) !== null).toBe(role !== 'org_member')
  })

  for (const [name, route, allowed] of [
    ['people', peopleRoute, ['org_owner', 'org_admin']],
    ['domain', domainRoute, ['org_owner', 'org_admin']],
    ['federation', federationRoute, ['org_owner', 'org_admin']],
  ] as const) {
    it.each(roles)(`${name} direct route checks role %s`, (role) => {
      fixture.role = role
      const Component = route.options.component
      if (Component === undefined) throw new Error('Missing actual route component')
      render(
        <QueryClientProvider client={new QueryClient()}>
          <Component />
        </QueryClientProvider>
      )
      const denied =
        screen.queryByText('Cette page est réservée aux administrateurs.', { exact: false }) !==
        null
      expect(denied).toBe(!(allowed as readonly OrganisationRole[]).includes(role))
    })
  }
})
