import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { authAdapter } from '../../auth/oidc'
import { ApiProblem } from '../../api/client'
import { baseInvoice } from '../../mocks/fixtures/invoiceFixtures'
import { InvoiceDetailScreen } from './InvoiceDetailScreen'
import { SubscriptionScreen } from './SubscriptionScreen'
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
const { pay, notify, refetch, query, params } = vi.hoisted(() => ({
  params: { org: 'acme-sa', invoiceId: 'invoice' },
  pay: vi.fn(),
  notify: vi.fn(),
  refetch: vi.fn(),
  query: vi.fn(),
}))
vi.mock('./payment', () => ({ payOnline: pay }))
vi.mock('../../ui/Toast/Toast', () => ({ useToast: () => notify }))
vi.mock('./BankDetailsDialog', () => ({ BankDetailsDialog: () => null }))
vi.mock('../../app/org-route', () => ({
  orgRoute: {
    useLoaderData: () => ({ membership: { role: 'org_owner', organisation: { id: 'org' } } }),
  },
}))
vi.mock('./routes', () => ({
  invoiceDetailRoute: {
    useParams: () => params,
    useSearch: () => ({}),
  },
  invoicesSubscriptionRoute: { useParams: () => ({ org: 'acme-sa' }) },
}))
vi.mock('./queries', () => ({
  useInvoiceQuery: () => ({ data: query(), isLoading: false, isError: false, refetch }),
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
  params.invoiceId = 'invoice'
  pay.mockReset()
  notify.mockReset()
  refetch.mockReset()
  query.mockReturnValue(baseInvoice())
  refetch.mockResolvedValue({ data: baseInvoice() })
})
it('does not announce payment from a generic conflict while Core still says issued', async () => {
  pay.mockRejectedValue(
    new ApiProblem({
      type: 'https://kodera.io/problems/conflict',
      status: 409,
      title: 'Conflict',
    })
  )
  render(<InvoiceDetailScreen />)
  await userEvent.click(screen.getByRole('button', { name: 'Payer en ligne' }))
  await waitFor(() => expect(refetch).toHaveBeenCalled())
  expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }))
})
it('does not open a late payment URL after the detail has unmounted', async () => {
  let finish!: (value: { url: string }) => void
  pay.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  const { unmount } = render(<InvoiceDetailScreen />)
  await userEvent.click(screen.getByRole('button', { name: 'Payer en ligne' }))
  unmount()
  finish({ url: 'https://payments.example.test/late' })
  await waitFor(() => expect(open).not.toHaveBeenCalled())
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(open).not.toHaveBeenCalled()
})
it('explains successful absence on the subscription screen', () => {
  render(<SubscriptionScreen />)
  expect(screen.getByText('Aucun abonnement actif pour cette organisation.')).toBeInTheDocument()
})

it('announces payment only after a successful invoice reread establishes paid state', async () => {
  pay.mockRejectedValue(
    new ApiProblem({
      type: 'https://kodera.io/problems/conflict',
      status: 409,
      title: 'Conflict',
    })
  )
  refetch.mockResolvedValue({ data: baseInvoice({ state: 'paid' }), isError: false })
  render(<InvoiceDetailScreen />)
  await userEvent.click(screen.getByRole('button', { name: 'Payer en ligne' }))
  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'success', title: 'Cette facture est réglée. Merci.' })
    )
  )
})

it('retires old action state when the invoice changes in the reused detail component', async () => {
  pay.mockReturnValue(new Promise(() => {}))
  const { rerender } = render(<InvoiceDetailScreen />)
  await userEvent.click(screen.getByRole('button', { name: 'Payer en ligne' }))
  expect(screen.getByRole('button', { name: 'Payer en ligne' })).toHaveAttribute('data-loading')
  params.invoiceId = 'invoice-new'
  query.mockReturnValue(baseInvoice({ id: 'invoice-new', number: 'NEW-INVOICE' }))
  rerender(<InvoiceDetailScreen />)
  expect(screen.getByRole('heading', { name: 'Facture NEW-INVOICE' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Payer en ligne' })).not.toHaveAttribute('data-loading')
})

it('keeps an explicit usable payment action after the automatic tab attempt', async () => {
  pay.mockResolvedValue({
    url: 'https://payments.example.test/ready',
    expires_at: new Date(Date.now() + 60000).toISOString(),
  })
  vi.spyOn(window, 'open').mockReturnValue(null)
  render(<InvoiceDetailScreen />)
  await userEvent.click(screen.getByRole('button', { name: 'Payer en ligne' }))
  expect(await screen.findByRole('link', { name: 'Ouvrir le paiement' })).toHaveAttribute(
    'href',
    'https://payments.example.test/ready'
  )
  expect(screen.queryByText('Paiement en cours ?')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Payer en ligne' })).toBeInTheDocument()
})
