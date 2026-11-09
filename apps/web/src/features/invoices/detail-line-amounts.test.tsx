// SI-02: each line of the detail table is `total_excl_vat`, and its column
// header said « Montant TTC » — the list's header, reused. The demo read
// « 448 € » under « MONTANT TTC » two rows above « Total TTC 537,60 € ».
import { render, screen, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { authAdapter } from '../../auth/oidc'
import { baseInvoice } from '../../mocks/fixtures/invoiceFixtures'
import { InvoiceDetailScreen } from './InvoiceDetailScreen'
import type { ReactNode } from 'react'

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

vi.mock('./payment', () => ({ payOnline: vi.fn() }))
vi.mock('../../ui/Toast/Toast', () => ({ useToast: () => vi.fn() }))
vi.mock('./BankDetailsDialog', () => ({ BankDetailsDialog: () => null }))
vi.mock('../../app/org-route', () => ({
  orgRoute: {
    useLoaderData: () => ({ membership: { role: 'org_owner', organisation: { id: 'org' } } }),
  },
}))
vi.mock('./routes', () => ({
  invoiceDetailRoute: {
    useParams: () => ({ org: 'acme-sa', invoiceId: 'invoice' }),
    useSearch: () => ({}),
  },
}))
vi.mock('./queries', () => ({
  useInvoiceQuery: () => ({
    data: baseInvoice(),
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useActiveSubscriptionQuery: () => ({ data: null, isLoading: false, isError: false }),
  fetchInvoiceDownloadLink: vi.fn(),
}))

beforeEach(() => {
  vi.spyOn(authAdapter, 'getSnapshot').mockReturnValue({
    status: 'ready',
    generation: 1,
    credentialGeneration: 1,
    user: { realm: 'acme-sa' },
  })
  vi.spyOn(authAdapter, 'getAccessToken').mockReturnValue('synthetic')
})

it('labels the pre-tax line amounts as pre-tax, and keeps TTC for the total only', () => {
  render(<InvoiceDetailScreen />)
  const table = screen.getByRole('table', { name: /Détail de la facture/ })
  const headers = within(table)
    .getAllByRole('columnheader')
    .map((cell) => cell.textContent)
  expect(headers).toContain('Montant HT')
  expect(within(table).queryByText(/TTC/)).not.toBeInTheDocument()
  // The line's own figure, 4 488 € excluding VAT, sits under that header.
  expect(within(table).getByText(/^4\s488\s€$/)).toBeInTheDocument()
  expect(screen.getByText('Total TTC')).toBeInTheDocument()
})
