import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { IncidentBannerClaimProvider, useIncidentBannerClaims } from '@/app/incidentBannerClaim'
import { ToastProvider } from '@/ui/Toast/Toast'
import { LiveOverview } from './LiveOverview'
import type { StatusComponent } from './components'
import type { TenantStatusView } from './queries'

function baseStatus(overrides: Partial<TenantStatusView> = {}): TenantStatusView {
  return {
    tenant_id: 't-1',
    status: 'active',
    provisioning_steps: [],
    apps: [
      {
        code: 'visio',
        name: 'Visio',
        url: 'https://visio.acme.fr',
        default_url: 'https://acme.visio.kodera.io',
        state: 'live',
      },
    ],
    capacity: {
      seats: { used: 10, included: 150, pct: 6.7 },
      participants: { used: 17, included: 50, pct: 34 },
      storage: { used: 1, included: 2, pct: 50 },
      threshold_pct: 90,
      upgrade_prompt: false,
      measured_at: '2026-12-03T11:19:42Z',
    },
    components: [
      {
        id: 'c1',
        scope: 'platform',
        key: 'web',
        name: 'Web',
        state: 'operational',
        since: '2026-12-01T00:00:00Z',
      },
      {
        id: 'c2',
        scope: 'tenant',
        key: 'calls',
        name: 'Calls',
        state: 'operational',
        since: '2026-12-01T00:00:00Z',
      },
      {
        id: 'c3',
        scope: 'platform',
        key: 'console',
        name: 'Console',
        state: 'operational',
        since: '2026-12-01T00:00:00Z',
      },
    ],
    agent: { stale: false },
    ...overrides,
  }
}

const emptyComponentsQuery = {
  data: [] as StatusComponent[],
  isLoading: false,
  isError: false,
  onRetry: vi.fn(),
}
const emptyIncidentsQuery = { data: [], isLoading: false, isError: false }
const emptySubscriptionQuery = { data: undefined, isLoading: false, isError: false }
const emptyHistoryQuery = { data: [], isLoading: false, isError: false, onRetry: vi.fn() }

function renderOverview(
  status: TenantStatusView,
  overrides: Partial<Parameters<typeof LiveOverview>[0]> = {}
) {
  return render(
    <ToastProvider label="Notification" viewportLabel="Notifications" closeLabel="Fermer">
      <LiveOverview
        status={status}
        lastUpdatedText="40 s"
        canSeeBilling={true}
        componentsQuery={emptyComponentsQuery}
        incidentsQuery={emptyIncidentsQuery}
        subscriptionQuery={emptySubscriptionQuery}
        historyQuery={emptyHistoryQuery}
        historyOpen={false}
        onHistoryOpenChange={vi.fn()}
        onSeePlans={vi.fn()}
        onSeeInvoices={vi.fn()}
        onTalkToUs={vi.fn()}
        onOpenTicket={vi.fn()}
        {...overrides}
      />
    </ToastProvider>
  )
}

describe('LiveOverview', () => {
  it('shows "Tout fonctionne" when every component is operational', () => {
    renderOverview(baseStatus())
    expect(screen.getByText('Tout fonctionne')).toBeInTheDocument()
  })

  it('shows the application addresses', () => {
    renderOverview(baseStatus())
    expect(screen.getByText('https://visio.acme.fr')).toBeInTheDocument()
  })

  it('describes a degraded component by name and shows the banner, with no external status link', () => {
    const status = baseStatus({
      components: [
        {
          id: 'c1',
          scope: 'platform',
          key: 'web',
          name: 'Web',
          state: 'operational',
          since: '2026-12-01T00:00:00Z',
        },
        {
          id: 'c2',
          scope: 'tenant',
          key: 'calls',
          name: 'Calls',
          state: 'degraded',
          since: '2026-12-03T10:58:00Z',
        },
      ],
    })
    renderOverview(status)
    // Both the pill and the banner headline read "Appels vidéo perturbé" —
    // the same short fact, said once at the top and once in the banner.
    expect(screen.getAllByText('Appels vidéo perturbé').length).toBeGreaterThanOrEqual(2)
    // Owner ruling 2026-09-24: this screen is the status source; the banner
    // links to no external status page.
    expect(screen.queryByRole('link', { name: /Page d'état publique/ })).toBeNull()
    expect(document.querySelector('a[href*="status."]')).toBeNull()
  })

  it('opens the incident drawer from the degraded pill and shows the updates in order', async () => {
    const user = userEvent.setup()
    const status = baseStatus({
      components: [
        {
          id: 'c2',
          scope: 'tenant',
          key: 'calls',
          name: 'Calls',
          state: 'degraded',
          since: '2026-12-03T10:58:00Z',
        },
      ],
    })
    renderOverview(status, {
      incidentsQuery: {
        data: [
          {
            id: 'inc-1',
            state: 'open',
            component_keys: ['calls'],
            title_key: 'incident.calls.degraded',
            started_at: '2026-12-03T10:58:00Z',
            next_update_at: '2026-12-03T12:00:00Z',
            updates: [
              { at: '2026-12-03T11:05:00Z', body_key: 'incident.update.investigating' },
              { at: '2026-12-03T11:20:00Z', body_key: 'incident.update.fixing' },
            ],
          },
        ],
        isLoading: false,
        isError: false,
      },
    })

    await user.click(screen.getByRole('button', { name: /Appels vidéo perturbé/ }))
    const terms = screen.getAllByRole('term').map((el) => el.textContent)
    expect(terms).toEqual(['12:05', '12:20'])
  })

  it('distinguishes a stale heartbeat from an outage and offers a ticket', async () => {
    const user = userEvent.setup()
    const onOpenTicket = vi.fn()
    const status = baseStatus({ agent: { stale: true, last_heartbeat_at: '2026-12-03T10:00:00Z' } })
    renderOverview(status, { onOpenTicket })

    expect(
      screen.getAllByText("Nous ne recevons plus d'informations").length
    ).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText('Appels vidéo perturbé')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Nous écrire' }))
    expect(onOpenTicket).toHaveBeenCalledWith('stale')
  })

  it('keeps the apps and capacity cards usable when the components card fails', () => {
    renderOverview(baseStatus(), {
      componentsQuery: { data: undefined, isLoading: false, isError: true, onRetry: vi.fn() },
    })
    expect(screen.getByText('https://visio.acme.fr')).toBeInTheDocument()
    expect(screen.getAllByRole('meter').length).toBeGreaterThan(0)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})

it('does not claim all services operational without a component observation', () => {
  renderOverview(baseStatus({ components: [] }))
  expect(screen.queryByText('Tout fonctionne')).toBeNull()
  expect(screen.getByText('État des services indisponible')).toBeInTheDocument()
})

it('keeps pending subscription feedback distinct from successful absence', () => {
  const { rerender } = renderOverview(baseStatus(), {
    subscriptionQuery: { data: undefined, isLoading: true, isError: false },
  })
  expect(screen.getByRole('status', { name: 'Chargement de votre formule' })).toBeInTheDocument()
  rerender(
    <ToastProvider label="Notification" viewportLabel="Notifications" closeLabel="Fermer">
      <LiveOverview
        status={baseStatus()}
        lastUpdatedText="40 s"
        canSeeBilling
        componentsQuery={emptyComponentsQuery}
        incidentsQuery={emptyIncidentsQuery}
        subscriptionQuery={{ data: null, isLoading: false, isError: false }}
        historyQuery={emptyHistoryQuery}
        historyOpen={false}
        onHistoryOpenChange={vi.fn()}
        onSeePlans={vi.fn()}
        onSeeInvoices={vi.fn()}
        onTalkToUs={vi.fn()}
        onOpenTicket={vi.fn()}
      />
    </ToastProvider>
  )
  expect(screen.queryByRole('status', { name: 'Chargement de votre formule' })).toBeNull()
})

// SI-03: the shell's slot announced the same incident one line above this
// screen's own banner, with a different "next update" time. The screen now
// tells the shell it carries the incident, and the shell's slot yields.
it('tells the shell which incident it carries while its degraded banner is shown', () => {
  function ShellSlotProbe() {
    const claimed = useIncidentBannerClaims()
    return <p>{claimed.length === 0 ? 'slot shows' : `slot yields for ${claimed.join(',')}`}</p>
  }
  const degraded = baseStatus({
    components: [
      {
        id: 'c2',
        scope: 'tenant',
        key: 'calls',
        name: 'Calls',
        state: 'degraded',
        since: '2026-12-03T10:58:00Z',
      },
    ],
  })
  const { unmount } = render(
    <IncidentBannerClaimProvider>
      <ShellSlotProbe />
      <ToastProvider label="Notification" viewportLabel="Notifications" closeLabel="Fermer">
        <LiveOverview
          status={degraded}
          lastUpdatedText="40 s"
          canSeeBilling={true}
          componentsQuery={emptyComponentsQuery}
          incidentsQuery={emptyIncidentsQuery}
          subscriptionQuery={emptySubscriptionQuery}
          historyQuery={emptyHistoryQuery}
          historyOpen={false}
          onHistoryOpenChange={vi.fn()}
          onSeePlans={vi.fn()}
          onSeeInvoices={vi.fn()}
          onTalkToUs={vi.fn()}
          onOpenTicket={vi.fn()}
        />
      </ToastProvider>
    </IncidentBannerClaimProvider>
  )
  expect(screen.getByText('slot yields for calls')).toBeInTheDocument()
  unmount()

  render(
    <IncidentBannerClaimProvider>
      <ShellSlotProbe />
      <ToastProvider label="Notification" viewportLabel="Notifications" closeLabel="Fermer">
        <LiveOverview
          status={baseStatus()}
          lastUpdatedText="40 s"
          canSeeBilling={true}
          componentsQuery={emptyComponentsQuery}
          incidentsQuery={emptyIncidentsQuery}
          subscriptionQuery={emptySubscriptionQuery}
          historyQuery={emptyHistoryQuery}
          historyOpen={false}
          onHistoryOpenChange={vi.fn()}
          onSeePlans={vi.fn()}
          onSeeInvoices={vi.fn()}
          onTalkToUs={vi.fn()}
          onOpenTicket={vi.fn()}
        />
      </ToastProvider>
    </IncidentBannerClaimProvider>
  )
  expect(screen.getByText('slot shows')).toBeInTheDocument()
})

it('says the capacity is not measured yet, with no figure, while Core sends capacity: null', () => {
  renderOverview(baseStatus({ capacity: null }))
  expect(screen.getByRole('heading', { name: 'Capacité' })).toBeInTheDocument()
  expect(
    screen.getByText('Pas encore mesurée. Aucun chiffre n’est affiché avant la première mesure.')
  ).toBeInTheDocument()
  expect(screen.queryByRole('meter')).toBeNull()
  expect(screen.getByText('https://visio.acme.fr')).toBeInTheDocument()
})
