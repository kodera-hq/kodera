import { fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import '@/i18n'
import { authAdapter } from '../../auth/oidc'
import { baseInvoice } from '../../mocks/fixtures/invoiceFixtures'
import { InvoiceListScreen } from './InvoiceListScreen'
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}))
vi.mock('../../app/org-route', () => ({
  orgRoute: {
    useParams: () => ({ org: 'acme-sa' }),
    useLoaderData: () => ({ membership: { role: 'org_owner', organisation: { id: 'org' } } }),
  },
}))
vi.mock('../../ui/Toast/Toast', () => ({ useToast: () => vi.fn() }))
const { state, refetch, pay } = vi.hoisted(() => ({
  state: { dunning: false, failed: false, discoveryFailed: false },
  refetch: vi.fn(),
  pay: vi.fn(),
}))
vi.mock('./payment', () => ({ payOnline: pay }))
beforeEach(() => {
  vi.spyOn(authAdapter, 'getSnapshot').mockReturnValue({
    status: 'ready',
    generation: 1,
    credentialGeneration: 1,
    user: { realm: 'acme-sa' },
  })
  vi.spyOn(authAdapter, 'getAccessToken').mockReturnValue('synthetic')
  pay.mockReset().mockReturnValue(new Promise(() => {}))
  state.discoveryFailed = false
  state.dunning = false
  state.failed = false
  refetch.mockReset()
})
vi.mock('./queries', () => ({
  useBillingProfileQuery: () => ({ data: undefined, isLoading: false, isError: false }),
  useInvoicesQuery: () => ({
    data: { pages: [{ data: [], has_more: true, next_cursor: 'next' }] },
    isLoading: false,
    isError: false,
    hasNextPage: true,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  }),
  useActiveSubscriptionQuery: () => ({ data: null, isLoading: false, isError: false }),
  useDunningQuery: () => ({
    data: state.dunning
      ? {
          state: 'notice',
          oldest_overdue_invoice_id: baseInvoice().id,
          days_overdue: 12,
          steps: [],
        }
      : undefined,
    isLoading: false,
    isError: state.discoveryFailed,
    refetch,
  }),
  useInvoiceQuery: () => ({
    data: state.failed ? undefined : baseInvoice({ state: 'overdue' }),
    isError: state.failed,
    refetch,
  }),
  fetchInvoiceDownloadLink: vi.fn(),
}))
it('keeps valid continuation accessible when the first page contains only filtered drafts', () => {
  render(<InvoiceListScreen />)
  expect(screen.getByRole('button', { name: 'Afficher 25 de plus' })).toBeInTheDocument()
})

it('keeps overdue context visible when its invoice is outside the current filtered page', () => {
  state.dunning = true
  render(<InvoiceListScreen />)
  expect(screen.getByText(/La facture INV-2026-0142/)).toBeInTheDocument()
})

it('shows a retry when the off-page overdue invoice cannot be read', () => {
  state.dunning = true
  state.failed = true
  render(<InvoiceListScreen />)
  expect(
    screen.getByText(
      'La facture en retard n’a pas pu être chargée. Réessayez pour consulter ses détails.'
    )
  ).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
  expect(refetch).toHaveBeenCalledTimes(1)
})

it('pays the already resolved off-page invoice from its dunning drawer', async () => {
  state.dunning = true
  render(<InvoiceListScreen />)
  fireEvent.click(screen.getByRole('button', { name: 'Échéances de règlement' }))
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Payer maintenant' })
  )
  await waitFor(() => expect(pay).toHaveBeenCalledTimes(1))
  expect(pay.mock.calls[0]?.[0]).toBe(baseInvoice().id)
})

it('does not conceal an initial dunning discovery error behind a closed drawer', () => {
  state.discoveryFailed = true
  render(<InvoiceListScreen />)
  expect(
    screen.getByText(
      'La facture en retard n’a pas pu être chargée. Réessayez pour consulter ses détails.'
    )
  ).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
  expect(refetch).toHaveBeenCalledTimes(1)
})
