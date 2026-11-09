// SI-01: with a billing dispute open, `dunning.hold_until` freezes the ladder
// and no suspension step is dated. The banner still printed the overdue
// sentence with its suspension clause and an empty date: « Sans règlement
// avant le , l'accès sera suspendu. » The same sentence could also name a
// suspension date already gone, and « 0 jours » for a day count the API did
// not send. Today is pinned to 20 April 2027 for every case.
import { render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { authAdapter } from '../../auth/oidc'
import { baseInvoice } from '../../mocks/fixtures/invoiceFixtures'
import { InvoiceListScreen } from './InvoiceListScreen'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}))
vi.mock('../../app/org-route', () => ({
  orgRoute: {
    useParams: () => ({ org: 'acme-sa' }),
    useLoaderData: () => ({ membership: { role: 'org_owner', organisation: { id: 'org' } } }),
  },
}))
vi.mock('../../ui/Toast/Toast', () => ({ useToast: () => vi.fn() }))
vi.mock('./payment', () => ({ payOnline: vi.fn() }))

const { dunning } = vi.hoisted(() => ({ dunning: { current: {} as Record<string, unknown> } }))
const OVERDUE = baseInvoice({ state: 'overdue', due_at: '2027-03-31T23:59:59Z' })

vi.mock('./queries', () => ({
  useBillingProfileQuery: () => ({ data: undefined, isLoading: false, isError: false }),
  useInvoicesQuery: () => ({
    data: { pages: [{ data: [OVERDUE], has_more: false, next_cursor: null }] },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  }),
  useActiveSubscriptionQuery: () => ({ data: null, isLoading: false, isError: false }),
  useDunningQuery: () => ({
    data: dunning.current,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useInvoiceQuery: () => ({ data: undefined, isError: false, refetch: vi.fn() }),
  fetchInvoiceDownloadLink: vi.fn(),
}))

const LADDER_WITHOUT_SUSPENSION = [
  { state: 'past_due', due_at: '2027-03-31T23:59:59Z', done: true },
  { state: 'notice', due_at: '2027-04-07T00:00:00Z', done: true },
]

const TODAY = Date.parse('2027-04-20T09:00:00Z')

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(TODAY)
  vi.spyOn(authAdapter, 'getSnapshot').mockReturnValue({
    status: 'ready',
    generation: 1,
    credentialGeneration: 1,
    user: { realm: 'acme-sa' },
  })
  vi.spyOn(authAdapter, 'getAccessToken').mockReturnValue('synthetic')
})

function banner(): HTMLElement {
  const headline = screen.getByText(/La facture INV-2026-0142/)
  const container = headline.closest<HTMLElement>('[role="alert"], [role="status"]')
  if (container === null) throw new Error('the headline is not inside a banner')
  return container
}

function payAction(): HTMLElement {
  return within(banner()).getByRole('link', { name: /Payer/ })
}

function view(overrides: Record<string, unknown>) {
  dunning.current = {
    state: 'notice',
    ladder: 'invoice',
    oldest_overdue_invoice_id: OVERDUE.id,
    days_overdue: 12,
    amount_due: { amount_minor: 538560, currency: 'EUR' },
    hold_until: null,
    steps: LADDER_WITHOUT_SUSPENSION,
    ...overrides,
  }
}

describe('while a dispute holds the ladder', () => {
  it('names the hold, threatens no suspension, and asks for no payment first', () => {
    view({
      hold_until: '2027-05-01T00:00:00Z',
      steps: [
        ...LADDER_WITHOUT_SUSPENSION,
        { state: 'suspended', due_at: '2027-06-06T00:00:00Z', done: false },
      ],
    })
    render(<InvoiceListScreen />)
    expect(banner()).toHaveAttribute('role', 'status')
    expect(banner()).toHaveTextContent('La facture INV-2026-0142 est en retard de 12 jours.')
    expect(banner()).toHaveTextContent(
      "Une contestation est en cours : les relances sont suspendues jusqu'au 1 mai 2027, le temps de l'examiner."
    )
    expect(banner()).not.toHaveTextContent(/suspendu\./)
    expect(banner()).not.toHaveTextContent(/6 juin/)
    // Paying stays possible, as a secondary action.
    expect(payAction()).not.toHaveClass('bg-c-action')
  })

  it('treats a hold whose date has passed as over, never as a date to come', () => {
    view({ hold_until: '2027-04-01T00:00:00Z' })
    render(<InvoiceListScreen />)
    expect(banner()).not.toHaveTextContent(/contestation|jusqu'au/)
    expect(banner()).toHaveAttribute('role', 'alert')
    expect(payAction()).toHaveClass('bg-c-action')
  })
})

describe('the overdue sentence', () => {
  it('states how late the invoice is, with no empty suspension date, when the ladder dates none', () => {
    view({})
    render(<InvoiceListScreen />)
    expect(banner()).toHaveTextContent('La facture INV-2026-0142 est en retard de 12 jours.')
    expect(banner()).not.toHaveTextContent(/Sans règlement/)
  })

  it('never prints a day count the API did not send', () => {
    view({ days_overdue: null })
    render(<InvoiceListScreen />)
    expect(banner()).toHaveTextContent('La facture INV-2026-0142 est en retard de paiement.')
    expect(banner()).not.toHaveTextContent(/\d+ jours?/)
  })

  it('prints no day count for zero days, in the banner or the row', () => {
    view({ days_overdue: 0 })
    render(<InvoiceListScreen />)
    expect(banner()).toHaveTextContent('La facture INV-2026-0142 est en retard de paiement.')
    expect(screen.queryByText(/0 jours?/)).not.toBeInTheDocument()
  })

  it('does not threaten a suspension on a date already gone', () => {
    view({
      steps: [
        ...LADDER_WITHOUT_SUSPENSION,
        { state: 'suspended', due_at: '2027-04-10T00:00:00Z', done: false },
      ],
    })
    render(<InvoiceListScreen />)
    expect(banner()).not.toHaveTextContent(/Sans règlement|10 avril/)
  })

  it('keeps the suspension date when the ladder carries one still to come', () => {
    view({
      state: 'suspension_notice',
      steps: [
        ...LADDER_WITHOUT_SUSPENSION,
        { state: 'suspended', due_at: '2027-06-06T00:00:00Z', done: false },
      ],
    })
    render(<InvoiceListScreen />)
    expect(banner()).toHaveTextContent(
      /Sans règlement avant le 6 juin 2027, l'accès sera suspendu\./
    )
  })
})
