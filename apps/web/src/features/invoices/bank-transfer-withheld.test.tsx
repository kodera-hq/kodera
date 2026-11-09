// SI-12: « Coordonnées bancaires » opened a dialog with no IBAN, no BIC and
// no holder in it, and it was the primary way to pay once the payment link
// failed — under an error that said « avec les coordonnées ci-dessous ».
// Owner ruling 2026-09-24: until contract 0.12.0 carries the issuer's bank
// details, the console offers no bank-transfer dialog and points to the
// invoice PDF, which carries them, and to support (05-invoices.md §4.3).
import type { ReactNode } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { SUPPORT_EMAIL } from '../../app/supportContact'
import { authAdapter } from '../../auth/oidc'
import { baseInvoice, INVOICE_ID, ORGANISATION_ID } from '../../mocks/fixtures/invoiceFixtures'
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

const f = vi.hoisted(() => ({ pay: vi.fn(), notify: vi.fn(), pdfAvailable: true }))
vi.mock('./payment', () => ({ payOnline: f.pay }))
vi.mock('../../ui/Toast/Toast', () => ({ useToast: () => f.notify }))
vi.mock('../../app/org-route', () => ({
  orgRoute: {
    useLoaderData: () => ({
      membership: { role: 'org_owner', organisation: { id: ORGANISATION_ID } },
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
  useBillingProfileQuery: () => ({ data: undefined, isLoading: false, isError: false }),
  useInvoiceQuery: () => ({
    data: baseInvoice({ pdf_available: f.pdfAvailable }),
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
  f.pay.mockReset().mockRejectedValue(new Error('upstream-unavailable'))
  f.pdfAvailable = true
})

const SUPPORT = '/acme-sa/help?invoiceNumber=INV-2026-0142'

function toPayCard() {
  return screen.getByRole('heading', { name: 'À régler' }).parentElement!.parentElement!
}

describe('the invoice detail', () => {
  it('offers no bank-details dialog, and says the transfer details are on the PDF', () => {
    render(<InvoiceDetailScreen />)
    expect(screen.queryByRole('button', { name: /coordonnées bancaires/i })).toBeNull()
    expect(
      screen.getByText(
        'Vous pouvez aussi régler par virement : les coordonnées figurent sur la facture PDF.'
      )
    ).toBeInTheDocument()
  })

  it('falls back to the PDF and support when the payment link fails', async () => {
    render(<InvoiceDetailScreen />)
    await userEvent.click(screen.getByRole('button', { name: 'Payer en ligne' }))
    await waitFor(() => expect(f.pay).toHaveBeenCalled())
    const card = within(toPayCard())
    expect(
      await card.findByText(
        'Le paiement en ligne est momentanément indisponible. Réessayez dans quelques instants, ou réglez par virement avec les coordonnées indiquées sur la facture PDF.'
      )
    ).toBeInTheDocument()
    // One PDF action on the page, the card's, and it comes first: the
    // primary action leads the reading order, then support, then the retry.
    expect(screen.getAllByRole('button', { name: 'Télécharger le PDF' })).toHaveLength(1)
    const actions = [...toPayCard().querySelectorAll('button, a')].map(
      (element) => element.textContent
    )
    expect(actions).toEqual(['Télécharger le PDF', 'Nous écrire', 'Réessayer'])
    expect(card.getByRole('button', { name: 'Télécharger le PDF' })).toBeInTheDocument()
    expect(card.getByRole('link', { name: 'Nous écrire' })).toHaveAttribute('href', SUPPORT)
    expect(screen.queryByRole('button', { name: /coordonnées bancaires/i })).toBeNull()
    expect(screen.queryByText(/ci-dessous/)).toBeNull()
  })

  it('falls back to support alone when there is no PDF either', async () => {
    f.pdfAvailable = false
    render(<InvoiceDetailScreen />)
    await userEvent.click(screen.getByRole('button', { name: 'Payer en ligne' }))
    const card = within(toPayCard())
    expect(
      await card.findByText(
        `Le paiement en ligne est momentanément indisponible. Réessayez dans quelques instants, ou écrivez-nous à ${SUPPORT_EMAIL} en indiquant le numéro de facture.`
      )
    ).toBeInTheDocument()
    expect(card.queryByRole('button', { name: 'Télécharger le PDF' })).toBeNull()
    expect(card.getByRole('link', { name: 'Nous écrire' })).toHaveAttribute('href', SUPPORT)
    expect(
      screen.queryByText(
        'Vous pouvez aussi régler par virement : les coordonnées figurent sur la facture PDF.'
      )
    ).toBeNull()
  })

  it('names the missing PDF and support, not a retry beside a disabled button', () => {
    f.pdfAvailable = false
    render(<InvoiceDetailScreen />)
    expect(
      screen.getByText(
        `Le PDF de cette facture n'est pas disponible pour le moment. Écrivez-nous à ${SUPPORT_EMAIL} en indiquant son numéro.`
      )
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Un problème avec cette facture ?' })).toHaveAttribute(
      'href',
      SUPPORT
    )
  })
})

describe('the invoice list', () => {
  it("offers no « Coordonnées bancaires » in a row's menu", async () => {
    render(<InvoiceListScreen />)
    await userEvent.click(screen.getByRole('button', { name: /Actions pour la facture/ }))
    expect(await screen.findByRole('menuitem', { name: 'Voir le détail' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /coordonnées bancaires/i })).toBeNull()
  })
})

// A download that fails is transient, and retrying works there; the missing-
// PDF sentence (no retry beside a disabled button) must not be reused for it.
describe('a PDF download that fails', () => {
  it('keeps « Réessayez » in its toast, on the detail', async () => {
    const { fetchInvoiceDownloadLink } = await import('./queries')
    vi.mocked(fetchInvoiceDownloadLink).mockRejectedValue(new Error('upstream-unavailable'))
    render(<InvoiceDetailScreen />)
    await userEvent.click(screen.getByRole('button', { name: 'Télécharger le PDF' }))
    await waitFor(() =>
      expect(f.notify).toHaveBeenCalledWith({
        kind: 'error',
        title: `Le PDF n'est pas disponible pour le moment. Réessayez ; si cela persiste, écrivez-nous à ${SUPPORT_EMAIL} en indiquant le numéro de facture.`,
      })
    )
  })

  it('keeps « Réessayez » in its toast, on the list', async () => {
    const { fetchInvoiceDownloadLink } = await import('./queries')
    vi.mocked(fetchInvoiceDownloadLink).mockRejectedValue(new Error('upstream-unavailable'))
    render(<InvoiceListScreen />)
    await userEvent.click(screen.getByRole('button', { name: /Télécharger le PDF/ }))
    await waitFor(() =>
      expect(f.notify).toHaveBeenCalledWith({
        kind: 'error',
        title: `Le PDF n'est pas disponible pour le moment. Réessayez ; si cela persiste, écrivez-nous à ${SUPPORT_EMAIL} en indiquant le numéro de facture.`,
      })
    )
  })
})
