import { render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import '@/i18n'
import { StatusScreen } from './StatusScreen'

// `HelpLink` is a router link; these tests render without a router, so it
// renders the URL `helpHref` writes for the same context.
vi.mock('../support/HelpLink', async () => {
  const { helpHref } = await import('../support/helpHref')
  return {
    HelpLink: ({
      org,
      search,
      children,
    }: {
      org: string
      search?: Parameters<typeof helpHref>[1]
      children: ReactNode
    }) => <a href={helpHref(org, search)}>{children}</a>,
  }
})
const f = vi.hoisted(() => ({
  org: 'acme-sa',
  role: 'org_owner',
  tenant: { id: 'tenant' } as { id: string } | null | undefined,
  tenantError: false,
  statusError: false,
  status: 'active' as string | undefined,
  subscription: vi.fn(),
}))
vi.mock('../../app/org-route', () => ({
  orgRoute: {
    useLoaderData: () => ({
      membership: { role: f.role, organisation: { id: 'org-id', slug: 'acme-sa', name: 'Acme' } },
    }),
    useParams: () => ({ org: f.org }),
  },
}))
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ navigate: vi.fn() }) }))
vi.mock('@/ui/LinkButton/LinkButton', () => ({
  LinkButton: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))
vi.mock('./LiveOverview', () => ({ LiveOverview: () => <div data-testid="live" /> }))
vi.mock('./ProvisioningOverview', () => ({
  ProvisioningOverview: () => <div data-testid="setup" />,
}))
vi.mock('./queries', () => ({
  useOrganisationTenant: () => ({
    data: f.tenant,
    isLoading: false,
    isError: f.tenantError,
    refetch: vi.fn(),
  }),
  useTenantStatus: () => ({
    data: { status: f.status, agent: { stale: false }, components: [], provisioning_steps: [] },
    isLoading: false,
    isError: f.statusError,
    dataUpdatedAt: 1,
    refetch: vi.fn(),
  }),
  useActiveSubscription: (...args: unknown[]) => {
    f.subscription(...args)
    return { data: null, isLoading: false, isError: false }
  },
  useOpenIncidents: () => ({ data: [], isLoading: false, isError: false }),
  useStatusComponents: () => ({ data: [], isLoading: false, isError: false }),
  useTenantAvailability: () => ({ data: [], isLoading: false, isError: false }),
}))
beforeEach(() => {
  f.org = 'acme-sa'
  f.role = 'org_owner'
  f.tenant = { id: 'tenant' }
  f.tenantError = false
  f.statusError = false
  f.status = 'active'
  f.subscription.mockClear()
})
it('never mistakes failed discovery for permission to order', () => {
  f.tenant = undefined
  f.tenantError = true
  render(<StatusScreen />)
  expect(screen.queryByRole('link', { name: 'Commander' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
})
it.each(['org_owner', 'org_admin', 'org_billing', 'org_member'])(
  'limits order and subscription reads for %s',
  (role) => {
    f.role = role
    f.tenant = null
    render(<StatusScreen />)
    expect(screen.queryByRole('link', { name: 'Commander' }) !== null).toBe(role === 'org_owner')
    expect(f.subscription).toHaveBeenCalledWith('org-id', role !== 'org_member')
  }
)
it.each(['ordered', 'provisioning', 'ready'])('keeps %s out of live service', (status) => {
  f.status = status
  render(<StatusScreen />)
  expect(screen.queryByTestId('live')).toBeNull()
})
it.each([
  'maintenance',
  'upgrading',
  'suspended',
  'decommissioning',
  'deleted',
  'failed',
  'unknown',
  'toString',
  undefined,
])('does not claim live or initial setup for %s', (status) => {
  f.status = status
  render(<StatusScreen />)
  expect(screen.queryByTestId('live')).toBeNull()
  expect(screen.queryByTestId('setup')).toBeNull()
  expect(screen.queryByRole('link', { name: 'Préparer la liste de vos collaborateurs' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Commander' })).toBeNull()
})
it('preserves active live service', () => {
  render(<StatusScreen />)
  expect(screen.getByTestId('live')).toBeInTheDocument()
})

it.each(['ready', 'maintenance', 'suspended', 'failed', 'active'])(
  'shows failed refresh and retry over cached %s lifecycle',
  (status) => {
    f.status = status
    f.statusError = true
    render(<StatusScreen />)
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
  }
)

it.each(['org_owner', 'org_admin', 'org_billing', 'org_member'])(
  'scopes provisioning preparation for %s',
  (role) => {
    f.org = 'another-org'
    f.role = role
    f.status = 'provisioning'
    render(<StatusScreen />)
    const prepare = screen.queryByRole('link', { name: 'Préparer la liste de vos collaborateurs' })
    if (role === 'org_owner' || role === 'org_admin') {
      expect(prepare).toHaveAttribute('href', '/another-org/people/import?from=status')
    } else {
      expect(prepare).toBeNull()
    }
    expect(screen.queryByRole('link', { name: 'Réserver votre adresse' })).toBeNull()
  }
)
