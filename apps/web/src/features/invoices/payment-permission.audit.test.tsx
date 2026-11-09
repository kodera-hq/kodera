import type { ReactNode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { authAdapter } from '../../auth/oidc'
import { baseInvoice, ORGANISATION_ID, INVOICE_ID } from '../../mocks/fixtures/invoiceFixtures'
import { InvoiceDetailScreen } from './InvoiceDetailScreen'
import { InvoiceListScreen } from './InvoiceListScreen'

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
const { state, pay, notify, profileRead } = vi.hoisted(() => ({
  state: { role: 'org_owner' },
  pay: vi.fn(),
  profileRead: vi.fn(() => ({ data: undefined, isLoading: false, isError: false })),
  notify: vi.fn(),
}))
vi.mock('./payment', () => ({ payOnline: pay }))
vi.mock('../../ui/Toast/Toast', () => ({ useToast: () => notify }))
vi.mock('../../app/org-route', () => ({
  orgRoute: {
    useLoaderData: () => ({
      membership: { role: state.role, organisation: { id: ORGANISATION_ID } },
    }),
    useParams: () => ({ org: 'acme-sa' }),
  },
}))
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<object>()),
  useNavigate: () => vi.fn(),
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a href="/synthetic-invoice" className={className}>
      {children}
    </a>
  ),
}))
vi.mock('./routes', () => ({
  invoiceDetailRoute: {
    useParams: () => ({ org: 'acme-sa', invoiceId: INVOICE_ID }),
    useSearch: () => ({}),
  },
}))
vi.mock('./queries', () => ({
  useBillingProfileQuery: profileRead,
  useInvoiceQuery: () => ({
    data: baseInvoice(),
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useInvoicesQuery: () => ({
    data: { pages: [{ data: [baseInvoice()], has_more: false }] },
    isLoading: false,
    isError: false,
    fetchNextPage: vi.fn(),
  }),
  useActiveSubscriptionQuery: () => ({ data: undefined, isLoading: false, isError: false }),
  useDunningQuery: () => ({ data: undefined, isLoading: false, isError: false }),
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
  pay.mockReset().mockResolvedValue({ url: 'https://payments.example.test/synthetic' })
  notify.mockReset()
  profileRead.mockClear()
  vi.spyOn(window, 'open').mockReturnValue(null)
})
for (const page of ['detail', 'list'] as const) {
  it.each(['org_owner', 'org_billing', 'org_admin', 'org_member'])(
    `${page} exposes payment only to owner/billing while preserving allowed read: %s`,
    async (role) => {
      state.role = role
      render(page === 'detail' ? <InvoiceDetailScreen /> : <InvoiceListScreen />)
      if (role === 'org_member') {
        expect(screen.queryByText('INV-2026-0142')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Payer en ligne' })).not.toBeInTheDocument()
        expect(screen.getByRole('status')).toHaveTextContent(/factures sont réservées/)
        expect(pay).not.toHaveBeenCalled()
        expect(profileRead).not.toHaveBeenCalled()
        return
      }
      expect(screen.getByRole('button', { name: /Télécharger le PDF/ })).toBeInTheDocument()
      if (page === 'list') expect(profileRead).toHaveBeenCalledWith(ORGANISATION_ID)
      if (page === 'list') {
        await userEvent.click(screen.getByRole('button', { name: /Actions pour la facture/ }))
      }
      const payment = screen.queryByRole(page === 'list' ? 'menuitem' : 'button', {
        name: 'Payer en ligne',
      })
      if (role === 'org_admin') {
        expect(payment).not.toBeInTheDocument()
        expect(pay).not.toHaveBeenCalled()
      } else {
        expect(payment).toBeInTheDocument()
        await userEvent.click(payment!)
        await waitFor(() => expect(pay).toHaveBeenCalledTimes(1))
        expect(pay.mock.calls[0]?.[0]).toBe(INVOICE_ID)
      }
    }
  )
}
