// The pilot build (`src/app/capabilities.ts`, every capability unserved, no mock override): each
// hidden surface stays hidden, and no screen that remains sends a request to an operation Core does
// not route. Every request is answered by MSW, which records it, so "sent nothing" is measured, not
// inferred from a mocked hook.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { CAPABILITIES, offers, type Capability } from '@/app/capabilities'
import { server } from '@/mocks/server'
import { scenario as defaultPeople } from '@/mocks/overlays/people.default'
import { scenario as emptyPeople } from '@/mocks/overlays/people.empty'
import { CALLER_MEMBERSHIP_ID } from '@/mocks/overlays/support/people'
import { ORG_ID, renderWithApi, signInSynthetic } from '@/features/people/test-support'
import { PeopleScreen } from '@/features/people/PeopleScreen'
import { PeoplePreparation } from '@/features/people/PeoplePreparation'
import { InviteDrawer } from '@/features/people/InviteDrawer'
import { useEnrolmentTokensQuery } from '@/features/people/queries'
import { useMemberImportQuery } from '@/features/people/memberImport'
import { useAddressesQuery } from '@/features/domain/queries'
import { LiveOverview, type LiveOverviewProps } from '@/features/status/LiveOverview'
import {
  useOpenIncidents,
  useStatusComponents,
  useTenantAvailability,
  type TenantStatusView,
} from '@/features/status/queries'
import { IncidentBannerClaimProvider } from '@/app/incidentBannerClaim'
import { ToastProvider } from '@/ui/Toast/Toast'
import { DomainScreen } from '@/features/domain/DomainScreen'

vi.mock('@/app/org-route', () => ({
  orgRoute: {
    useParams: () => ({ org: 'acme-sa' }),
    useLoaderData: () => ({
      membership: {
        role: 'org_owner',
        membership_id: 'm-1',
        organisation: { id: '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f', name: 'ACME' },
      },
    }),
  },
}))

// The Core paths of every unserved operation, as MSW sees them.
const UNSERVED_PATHS = [
  /\/enrolment-tokens/,
  /\/member-imports/,
  /\/status\/components/,
  /\/status\/incidents/,
  /\/availability/,
  /\/domains/,
  /\/entitlements/,
]
let requested: string[] = []

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
beforeEach(() => {
  signInSynthetic()
  // The pilot: no mock override, whatever the suite's default.
  vi.stubEnv('VITE_ENABLE_MSW', '')
  vi.stubEnv('VITE_MOCK_UNSERVED', '')
  requested = []
  server.events.on('request:start', ({ request }) => {
    requested.push(new URL(request.url).pathname)
  })
})
afterEach(() => {
  server.events.removeAllListeners()
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

const unservedRequests = () => requested.filter((path) => UNSERVED_PATHS.some((p) => p.test(path)))

function hookWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

// Give a mounted query the chance to fire before measuring that none did.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('offers()', () => {
  it('offers nothing unserved in a build that talks to Core', () => {
    for (const capability of Object.keys(CAPABILITIES) as Capability[])
      expect(offers(capability), capability).toBe(false)
  })

  it('needs both the mock worker and the explicit override to show them', () => {
    vi.stubEnv('VITE_MOCK_UNSERVED', '1')
    expect(offers('domain-addresses')).toBe(false)
    vi.stubEnv('VITE_ENABLE_MSW', '1')
    expect(offers('domain-addresses')).toBe(true)
    vi.stubEnv('VITE_MOCK_UNSERVED', '')
    expect(offers('domain-addresses')).toBe(false)
  })
})

describe('People in the pilot', () => {
  function renderPeople(overlay: Parameters<typeof renderWithApi>[1]) {
    const onNavigate = vi.fn()
    renderWithApi(
      <PeopleScreen
        organisationId={ORG_ID}
        callerRole="org_owner"
        callerMembershipId={CALLER_MEMBERSHIP_ID}
        tab="members"
        onNavigate={onNavigate}
        onSite={<p>on-site panel</p>}
      />,
      overlay
    )
    return onNavigate
  }

  it('has no « Accès sur site » tab', async () => {
    renderPeople([defaultPeople()])
    await screen.findByRole('table', { name: 'Personnes' })
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent)
    expect(tabs).toHaveLength(2)
    expect(screen.queryByRole('tab', { name: /Accès sur site/ })).toBeNull()
  })

  it('invites by e-mail straight away, with no menu offering a CSV import or an on-site access', async () => {
    const onNavigate = renderPeople([defaultPeople()])
    await screen.findByRole('table', { name: 'Personnes' })
    const invite = screen.getByRole('button', { name: 'Inviter' })
    expect(invite).not.toHaveAttribute('aria-haspopup')
    await userEvent.click(invite)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onNavigate).toHaveBeenCalledWith({ to: 'invite' })
  })

  it('offers one way forward when the owner is alone, and says only that one: by e-mail', async () => {
    renderPeople([emptyPeople()])
    expect(await screen.findByRole('heading', { name: "Personne pour l'instant" })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Inviter par e-mail' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Importer un CSV' })).toBeNull()
    expect(
      screen.getByText(
        'Invitez vos collègues par e-mail. Ils recevront un lien pour activer leur compte.'
      )
    ).toBeVisible()
    expect(screen.queryByText(/CSV|importez/)).toBeNull()
  })

  it('never points to an import when too many addresses are pasted', async () => {
    renderWithApi(
      <InviteDrawer
        organisationId={ORG_ID}
        callerRole="org_admin"
        onClose={vi.fn()}
        onSent={vi.fn()}
      />,
      [defaultPeople()]
    )
    const field = screen.getByRole('textbox', { name: 'Adresses e-mail, une par ligne' })
    const addresses = Array.from({ length: 201 }, (_, i) => `p${i}@acme.fr`).join('\n')
    fireEvent.change(field, { target: { value: addresses } })
    fireEvent.blur(field)
    await userEvent.click(screen.getByRole('button', { name: /Envoyer/ }))
    expect(
      await screen.findByText(
        'Vous pouvez inviter 200 personnes à la fois. Envoyez-les en plusieurs fois.'
      )
    ).toBeVisible()
    expect(screen.queryByText(/importez/)).toBeNull()
  })

  it('never fetches enrolment tokens or a member import, even where a screen mounts the hook', async () => {
    const wrapper = hookWrapper()
    const tokens = renderHook(() => useEnrolmentTokensQuery(ORG_ID), { wrapper })
    const memberImport = renderHook(() => useMemberImportQuery('imp-1'), { wrapper })
    await settle()
    expect(tokens.result.current.fetchStatus).toBe('idle')
    expect(tokens.result.current.isFetched).toBe(false)
    expect(memberImport.result.current.fetchStatus).toBe('idle')
    expect(memberImport.result.current.isFetched).toBe(false)
    expect(unservedRequests()).toEqual([])
  })

  it('draws no « prepare your people » link, which leads to the import', () => {
    const owner = 'org_owner' as const
    const { container } = render(<PeoplePreparation org="acme-sa" role={owner} source="status" />)
    expect(container).toBeEmptyDOMElement()
  })
})

function status(overrides: Partial<TenantStatusView> = {}): TenantStatusView {
  return {
    tenant_id: 't-1',
    status: 'active',
    provisioning_steps: [],
    apps: [],
    capacity: null,
    components: [
      {
        id: 'c1',
        scope: 'tenant',
        key: 'calls',
        name: 'Calls',
        state: 'major_outage',
        since: '2026-12-01T00:00:00Z',
      },
    ],
    agent: { stale: false },
    ...overrides,
  } as TenantStatusView
}

const idle = { data: undefined, isLoading: false, isError: false }

function renderOverview(props: Partial<LiveOverviewProps> = {}) {
  render(
    <IncidentBannerClaimProvider>
      <ToastProvider label="Notification" viewportLabel="Notifications" closeLabel="Fermer">
        <LiveOverview
          status={status()}
          lastUpdatedText="à l'instant"
          canSeeBilling={false}
          componentsQuery={{ ...idle, onRetry: vi.fn() }}
          incidentsQuery={idle}
          subscriptionQuery={idle}
          historyQuery={{ ...idle, onRetry: vi.fn() }}
          historyOpen={false}
          onHistoryOpenChange={vi.fn()}
          onSeeInvoices={vi.fn()}
          onSeePlans={vi.fn()}
          onTalkToUs={vi.fn()}
          onOpenTicket={vi.fn()}
          {...props}
        />
      </ToastProvider>
    </IncidentBannerClaimProvider>
  )
}

describe('Status in the pilot', () => {
  it('draws no components card and no seven-day history', () => {
    renderOverview()
    expect(screen.queryByRole('heading', { name: 'État du service' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Historique sur sept jours' })).toBeNull()
  })

  it('still says what is degraded, from the tenant status, with no incident detail to open', () => {
    renderOverview()
    // The pill is plain text: no button opens an incident drawer that has nothing to read.
    expect(screen.getByRole('status')).toHaveTextContent(/Appels/)
    expect(within(screen.getByRole('status')).queryByRole('button')).toBeNull()
  })

  it('keeps the way to support on the degraded banner', async () => {
    const onOpenTicket = vi.fn()
    renderOverview({ onOpenTicket })
    await userEvent.click(screen.getByRole('button', { name: 'Nous écrire' }))
    expect(onOpenTicket).toHaveBeenCalledWith('incident')
  })

  it('sends no components, incidents or availability request', async () => {
    const wrapper = hookWrapper()
    const components = renderHook(() => useStatusComponents('t-1'), { wrapper })
    const incidents = renderHook(() => useOpenIncidents('t-1'), { wrapper })
    const history = renderHook(() => useTenantAvailability('t-1', true), { wrapper })
    await settle()
    for (const query of [components, incidents, history])
      expect(query.result.current.fetchStatus).toBe('idle')
    expect(components.result.current.isFetched).toBe(false)
    expect(incidents.result.current.isFetched).toBe(false)
    expect(history.result.current.isFetched).toBe(false)
    expect(unservedRequests()).toEqual([])
  })
})

describe('Domain in the pilot', () => {
  it('names the page, says it is not available yet, and lists no address', async () => {
    renderWithApi(<DomainScreen />)
    expect(screen.getByRole('heading', { level: 1, name: 'Domaine & identité' })).toBeVisible()
    expect(screen.getByText("Cette page n'est pas encore disponible.")).toBeVisible()
    expect(screen.queryByRole('table')).toBeNull()
    await settle()
    expect(unservedRequests()).toEqual([])
    expect(requested).toEqual([])
  })

  it('never fetches the address list, even where a screen mounts the hook', async () => {
    const addresses = renderHook(() => useAddressesQuery(ORG_ID), { wrapper: hookWrapper() })
    await settle()
    expect(addresses.result.current.fetchStatus).toBe('idle')
    expect(addresses.result.current.isFetched).toBe(false)
    expect(requested).toEqual([])
  })
})
