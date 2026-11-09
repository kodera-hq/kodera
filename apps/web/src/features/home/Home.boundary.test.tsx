import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import '@/i18n'
import { Home } from './Home'

const fixture = vi.hoisted(() => ({
  org: 'acme-sa',
  role: 'org_owner' as 'org_owner' | 'org_admin' | 'org_billing' | 'org_member',
  summary: {
    data: undefined as
      | { tenant_id: string | null; billing_enabled?: boolean; workspace_pack_code?: string | null }
      | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  fallback: {
    data: undefined as string | null | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  tenant: {
    data: undefined as
      | {
          status?: string
          provisioning_steps?: { customer_label_key: string; status: string; job_id?: string }[]
        }
      | undefined,
    isError: false,
    isLoading: false,
    refetch: vi.fn(),
  },
}))
vi.mock('../../app/org-route', () => ({
  orgRoute: {
    useLoaderData: () => ({
      membership: {
        organisation: { id: 'immutable-org-id', slug: 'acme-sa', name: 'Acme SA' },
        role: fixture.role,
      },
    }),
    useParams: () => ({ org: fixture.org }),
  },
}))
vi.mock('./queries', () => ({
  useStatusSummaryQuery: () => fixture.summary,
  useFallbackTenantIdQuery: () => fixture.fallback,
  useTenantStatusQuery: () => fixture.tenant,
}))
vi.mock('./HomeDefault', () => ({
  HomeDefault: ({ tenantId }: { tenantId?: string }) => (
    <p data-testid="active-tenant">{tenantId ?? 'missing'}</p>
  ),
}))
vi.mock('../status/ProvisioningView', () => ({
  ProvisioningView: ({ support, preparation }: { support: ReactNode; preparation?: ReactNode }) => (
    <section data-testid="provisioning">
      {preparation}
      {support}
    </section>
  ),
}))
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
vi.mock('../workspace-create/CreateWorkspace', () => ({
  CreateWorkspace: ({
    packCode,
    organisationName,
  }: {
    packCode: string
    organisationName: string
  }) => <p data-testid="create-workspace">{`${organisationName} ${packCode}`}</p>,
}))
vi.mock('../../ui/LinkButton/LinkButton', () => ({
  LinkButton: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

beforeEach(() => {
  fixture.org = 'acme-sa'
  fixture.role = 'org_owner'
  fixture.summary = { data: undefined, isLoading: false, isError: false, refetch: vi.fn() }
  fixture.fallback = { data: undefined, isLoading: false, isError: false, refetch: vi.fn() }
  fixture.tenant = { data: undefined, isError: false, isLoading: false, refetch: vi.fn() }
})

describe('initial tenant status discovery', () => {
  it('keeps a temporary lifecycle heading out of the loading state', () => {
    fixture.summary.data = { tenant_id: 'tenant-1' }
    fixture.tenant.isLoading = true
    render(<Home />)
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Chargement' })).toBeInTheDocument()
  })
})

describe('home discovery boundary', () => {
  it.each(['summary', 'fallback'] as const)(
    'does not offer a new order when %s discovery fails',
    (failure) => {
      fixture[failure].isError = true
      if (failure === 'fallback') fixture.summary.data = { tenant_id: null }
      render(<Home />)
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'Commander' })).toBeNull()
    }
  )

  it('preserves the empty state after successful absence discovery', () => {
    fixture.summary.data = { tenant_id: null }
    fixture.fallback.data = null
    render(<Home />)
    expect(screen.getByRole('link', { name: 'Commander' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('carries a resolved fallback tenant into active application rendering', () => {
    fixture.summary.data = { tenant_id: null }
    fixture.fallback.data = 'fallback-tenant-id'
    fixture.tenant.data = { status: 'active' }
    render(<Home />)
    expect(screen.getByTestId('active-tenant')).toHaveTextContent('fallback-tenant-id')
  })
})

it.each(['org_owner', 'org_admin', 'org_billing', 'org_member'] as const)(
  'scopes provisioning preparation and preserves support for %s',
  (role) => {
    fixture.org = 'another-org'
    fixture.role = role
    fixture.summary.data = { tenant_id: 'tenant-id' }
    fixture.tenant.data = { status: 'provisioning' }
    render(<Home />)
    const prepare = screen.queryByRole('link', { name: 'Préparer la liste de vos collaborateurs' })
    if (role === 'org_owner' || role === 'org_admin') {
      expect(prepare).toHaveAttribute('href', '/another-org/people/import?from=status')
    } else {
      expect(prepare).toBeNull()
    }
    expect(screen.getByRole('link', { name: 'Nous écrire' })).toHaveAttribute(
      'href',
      '/another-org/help?reason=late'
    )
    expect(screen.queryByRole('link', { name: 'Préparer votre domaine' })).toBeNull()
  }
)

it("carries a failed step's reference to Aide", () => {
  fixture.summary.data = { tenant_id: 'tenant-id' }
  fixture.tenant.data = {
    status: 'provisioning',
    provisioning_steps: [
      { customer_label_key: 'order', status: 'succeeded' },
      { customer_label_key: 'server', status: 'failed', job_id: 'job-42' },
    ],
  }
  render(<Home />)
  expect(screen.getByRole('link', { name: 'Nous écrire' })).toHaveAttribute(
    'href',
    '/acme-sa/help?reason=step-failed&job_id=job-42'
  )
})

it.each(['upgrading', 'maintenance', 'suspended', 'decommissioning', 'deleted', 'failed'])(
  'sends %s support to Aide with the state',
  (status) => {
    fixture.summary.data = { tenant_id: 'tenant-id' }
    fixture.tenant.data = { status }
    render(<Home />)
    expect(screen.getByRole('link', { name: 'Écrire au support' })).toHaveAttribute(
      'href',
      `/acme-sa/help?state=${status}`
    )
  }
)

it.each(['org_owner', 'org_admin', 'org_billing', 'org_member'] as const)(
  'limits empty ordering and setup actions for %s',
  (role) => {
    fixture.role = role
    fixture.summary.data = { tenant_id: null }
    const { rerender } = render(<Home />)
    expect(screen.queryByRole('link', { name: 'Commander' }) !== null).toBe(role === 'org_owner')
    fixture.summary.data = { tenant_id: 'tenant-id' }
    fixture.tenant.data = { status: 'provisioning' }
    rerender(<Home />)
    expect(screen.queryByRole('link', { name: 'Commander' })).toBeNull()
  }
)

it.each([
  'upgrading',
  'maintenance',
  'suspended',
  'decommissioning',
  'deleted',
  'failed',
  'unknown',
])('does not call %s initial provisioning', (status) => {
  fixture.summary.data = { tenant_id: 'tenant-id' }
  fixture.tenant.data = { status }
  render(<Home />)
  expect(screen.queryByTestId('provisioning')).toBeNull()
  expect(screen.queryByRole('link', { name: 'Préparer la liste de vos collaborateurs' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Commander' })).toBeNull()
})

it.each(['ordered', 'provisioning', 'ready'])('retains initial setup for %s', (status) => {
  fixture.summary.data = { tenant_id: 'tenant-id' }
  fixture.tenant.data = { status }
  render(<Home />)
  expect(screen.getByTestId('provisioning')).toBeInTheDocument()
})

it('refuses inherited object keys as lifecycle states', () => {
  fixture.summary.data = { tenant_id: 'tenant-id' }
  fixture.tenant.data = { status: 'toString' }
  render(<Home />)
  expect(screen.getByRole('alert')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
})

it('shows error for a completed status response with no lifecycle state', () => {
  fixture.summary.data = { tenant_id: 'tenant-id' }
  fixture.tenant.data = {}
  render(<Home />)
  expect(screen.getByRole('alert')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
})

it('retains loading feedback only while the lifecycle query is loading', () => {
  fixture.summary.data = { tenant_id: 'tenant-id' }
  fixture.tenant.isLoading = true
  render(<Home />)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull()
  expect(screen.getByRole('status')).toBeInTheDocument()
})

describe('home navigation headings', () => {
  it.each(['org_owner', 'org_admin', 'org_billing', 'org_member'] as const)(
    'gives a successfully empty home one page heading for %s',
    (role) => {
      fixture.role = role
      fixture.summary.data = { tenant_id: null }
      render(<Home />)
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
        role === 'org_member'
          ? "Votre espace n'est pas encore prêt"
          : "Aucune instance pour l'instant"
      )
      expect(screen.queryByRole('link', { name: 'Commander' }) !== null).toBe(role === 'org_owner')
    }
  )

  it('tells a member who sets the organisation up, not how to order', () => {
    fixture.role = 'org_member'
    fixture.summary.data = { tenant_id: null }
    render(<Home />)
    expect(
      screen.getByText(
        "Un propriétaire ou un administrateur de votre organisation doit d'abord le mettre en place. Vous n'avez rien à faire pour l'instant."
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/commande/i)).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it.each(['summary', 'fallback'] as const)(
    'gives %s discovery failure one page heading without offering an order',
    (failure) => {
      fixture[failure].isError = true
      if (failure === 'fallback') fixture.summary.data = { tenant_id: null }
      render(<Home />)
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('État de votre espace')
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Réessayer' })).toBeEnabled()
      expect(screen.queryByRole('link', { name: 'Commander' })).toBeNull()
    }
  )
})

describe('a deployment that does not bill (§4.4)', () => {
  function unbilled(packCode: string | null = 'workspace') {
    fixture.summary.data = {
      tenant_id: null,
      billing_enabled: false,
      workspace_pack_code: packCode,
    }
    fixture.fallback.data = null
  }

  it('gives the owner « Créez votre espace » on the summary’s pack, and no order', () => {
    unbilled()
    render(<Home />)
    expect(screen.getByTestId('create-workspace')).toHaveTextContent('Acme SA workspace')
    expect(screen.queryByRole('link', { name: 'Commander' })).toBeNull()
  })

  it.each(['org_admin', 'org_billing', 'org_member'] as const)(
    'tells a %s that the owner creates the workspace, with no form and no order',
    (role) => {
      fixture.role = role
      unbilled()
      render(<Home />)
      expect(screen.queryByTestId('create-workspace')).toBeNull()
      expect(screen.queryByRole('link', { name: 'Commander' })).toBeNull()
      expect(
        screen.getByText(/Le propriétaire de votre organisation crée l’espace/)
      ).toBeInTheDocument()
      expect(screen.queryByText(/La commande prend/)).toBeNull()
    }
  )

  it('says creation is unavailable when Core names no pack', () => {
    unbilled(null)
    render(<Home />)
    expect(screen.queryByTestId('create-workspace')).toBeNull()
    expect(
      screen.getByText(/La création d’espaces est momentanément indisponible/)
    ).toBeInTheDocument()
  })

  it.each(['summary', 'fallback'] as const)(
    'keeps the form when a background read of the %s fails after an answer',
    (failure) => {
      unbilled()
      fixture[failure].isError = true
      render(<Home />)
      expect(screen.getByTestId('create-workspace')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).toBeNull()
    }
  )

  it('offers neither while the summary loads', () => {
    fixture.summary.isLoading = true
    render(<Home />)
    expect(screen.queryByTestId('create-workspace')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Commander' })).toBeNull()
  })

  it('keeps the order for the owner when billing is on', () => {
    fixture.summary.data = { tenant_id: null, billing_enabled: true, workspace_pack_code: null }
    fixture.fallback.data = null
    render(<Home />)
    expect(screen.queryByTestId('create-workspace')).toBeNull()
    expect(screen.getByRole('link', { name: 'Commander' })).toBeInTheDocument()
  })
})
