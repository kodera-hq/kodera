// The shell's banner slot (docs/specs/00-shell-and-login.md §4.5), on the
// two findings the journey audit read off it:
//
// - SH-03: the dunning banner printed the overdue invoice's raw id as its
//   "number" and a hard-coded « en retard de 0 jours ».
// - SI-03: the incident banner printed `measured_at` — when the status was
//   read — as « Prochaine mise à jour à … », and on Applications it repeated
//   the incident the page's own banner already carried, with a different time.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { components } from '../api/schema'
import { IncidentBannerClaimProvider, useClaimIncidentBanner } from './incidentBannerClaim'
import { StatusBanner } from './StatusBanner'
import type { OrganisationRole } from './Sidebar'

type Summary = components['schemas']['OrganisationStatusSummary']

const { summary } = vi.hoisted(() => ({ summary: { current: undefined as unknown } }))
vi.mock('../api/client', () => ({
  coreApi: () => ({ GET: () => Promise.resolve({ data: summary.current }) }),
}))
vi.mock('../auth/sessionExpiry', () => ({ useSessionExpiring: () => false }))
const { location } = vi.hoisted(() => ({ location: { pathname: '/acme-sa/home' } }))
vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown
  }) => select({ location }),
  Link: ({
    children,
    to,
    params,
  }: {
    children: ReactNode
    to: string
    params: Record<string, string>
  }) => (
    <a href={Object.entries(params).reduce((path, [k, v]) => path.replace(`$${k}`, v), to)}>
      {children}
    </a>
  ),
}))

const INVOICE_ID = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70'

const OPERATIONAL: Summary = {
  organisation_id: '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f',
  tenant_id: '2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b',
  billing_enabled: true,
  workspace_pack_code: null,
  overall: 'operational',
  components: [
    {
      id: '0a1b2c3d-4e5f-4607-8819-2a3b4c5d6e7f',
      scope: 'tenant',
      key: 'calls',
      name: 'Calls',
      state: 'operational',
      since: '2026-12-03T10:58:00Z',
    },
  ],
  capacity: null,
  billing: { dunning_state: 'current', oldest_overdue_invoice_id: null, amount_due: null },
  maintenance: null,
  open_incident_ids: [],
  measured_at: '2026-12-03T17:11:42Z',
}

const DUNNING: Summary = {
  ...OPERATIONAL,
  billing: {
    dunning_state: 'past_due',
    oldest_overdue_invoice_id: INVOICE_ID,
    amount_due: { amount_minor: 538560, currency: 'EUR' },
  },
}

const DEGRADED: Summary = {
  ...OPERATIONAL,
  overall: 'degraded',
  components: [{ ...OPERATIONAL.components[0]!, state: 'degraded' }],
}

function PageBanner({ component = 'calls' }: { component?: string }) {
  useClaimIncidentBanner(component)
  return <p>bandeau de la page</p>
}

const DEGRADED_AND_OVERDUE: Summary = { ...DEGRADED, billing: DUNNING.billing! }

async function settled(client: QueryClient, expected: Summary) {
  // The summary has arrived and React has rendered with it, so what the slot
  // shows is a decision, not a wait: a timer turn inside `act` lets the
  // query's notification and the render it schedules both land.
  await vi.waitFor(() => expect(client.getQueryData(['status-summary', 'org'])).toEqual(expected))
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
}

function renderBanner(role: OrganisationRole = 'org_owner', page?: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <IncidentBannerClaimProvider>
        <StatusBanner organisationId="org" org="acme-sa" role={role} />
        {page}
      </IncidentBannerClaimProvider>
    </QueryClientProvider>
  )
  return { ...view, client }
}

beforeEach(() => {
  summary.current = undefined
  location.pathname = '/acme-sa/home'
})

describe('the dunning banner', () => {
  it('states the amount due and links to the invoice, never printing its id', async () => {
    summary.current = DUNNING
    renderBanner()
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(/Une facture est en retard de paiement \(5\s385,60\s€\)\./)
    expect(banner).not.toHaveTextContent(INVOICE_ID)
    expect(banner).not.toHaveTextContent(/0 jours/)
    const link = within(banner).getByRole('link', { name: 'Voir la facture' })
    expect(link).toHaveAttribute('href', `/acme-sa/invoices/${INVOICE_ID}`)
  })

  // Ruling D: the amount and the invoice are for the roles that can open
  // Invoices; a member reads that a payment is pending and whom to ask —
  // nothing the console cannot know, such as whether the owner was told.
  it('gives a member a neutral line, with no amount and no link', async () => {
    summary.current = DUNNING
    renderBanner('org_member')
    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent(
      'Un paiement est en attente. Pour toute question, contactez le propriétaire de votre organisation.'
    )
    expect(banner).not.toHaveTextContent(/€|informé/)
    expect(within(banner).queryByRole('link')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('the incident banner', () => {
  it('claims no next-update time the status summary does not carry', async () => {
    summary.current = DEGRADED
    renderBanner()
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(/Appels vidéo : service perturbé depuis/)
    expect(banner).not.toHaveTextContent(/Prochaine mise à jour/)
    expect(banner).not.toHaveTextContent(/18:11/)
    expect(within(banner).getByRole('link', { name: 'En savoir plus' })).toHaveAttribute(
      'href',
      '/acme-sa/status'
    )
  })

  it('does not link to Applications from Applications itself', async () => {
    summary.current = DEGRADED
    location.pathname = '/acme-sa/status'
    renderBanner()
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(/Appels vidéo : service perturbé depuis/)
    expect(within(banner).queryByRole('link')).not.toBeInTheDocument()
  })

  // The page's own banner carries this incident: the slot does not repeat
  // it, and shows what comes next in the precedence instead of nothing.
  it('falls to the next banner when the page shows the same incident itself', async () => {
    summary.current = DEGRADED_AND_OVERDUE
    const { client } = renderBanner('org_owner', <PageBanner component="calls" />)
    await screen.findByText('bandeau de la page')
    await settled(client, DEGRADED_AND_OVERDUE)
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(/Une facture est en retard de paiement/)
    expect(banner).not.toHaveTextContent(/perturbé/)
  })

  it('stays empty when the page shows the incident and nothing else applies', async () => {
    summary.current = DEGRADED
    const { client } = renderBanner('org_owner', <PageBanner component="calls" />)
    await screen.findByText('bandeau de la page')
    await settled(client, DEGRADED)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('shell-banner-slot')).toBeEmptyDOMElement()
  })

  it('keeps its banner when the page names a different component', async () => {
    summary.current = DEGRADED
    const { client } = renderBanner('org_owner', <PageBanner component="web" />)
    await screen.findByText('bandeau de la page')
    await settled(client, DEGRADED)
    expect(await screen.findByRole('alert')).toHaveTextContent(/Appels vidéo : service perturbé/)
  })
})
