import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { authAdapter } from '../../auth/oidc'
import { baseInvoice, INVOICE_ID, ORGANISATION_ID } from '../../mocks/fixtures/invoiceFixtures'
import { BillingProfileCard } from './BillingProfileCard'
import type { BillingProfile } from './billingProfile'
import type * as FacturxApiModule from './facturxApi'
import type { BillingVatStatus, CreditNote } from './facturxApi'
import { InvoiceDetailScreen } from './InvoiceDetailScreen'

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

const mocks = vi.hoisted(() => ({
  profileFixture: {
    data: {
      name: 'Groupe Vercelli SAS',
      address: {
        line1: '18 cours Charlemagne',
        line2: null,
        postal_code: '69002',
        city: 'Lyon',
        country: 'FR',
      },
    } as BillingProfile | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  invoiceData: undefined as ReturnType<typeof baseInvoice> | undefined,
  downloadInvoicePdf: vi.fn(),
  downloadInvoiceArtifact: vi.fn(),
  downloadCreditNoteArtifact: vi.fn(),
  validateVat: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('./payment', () => ({ payOnline: vi.fn() }))
vi.mock('../../ui/Toast/Toast', () => ({ useToast: () => mocks.notify }))
vi.mock('../../app/org-route', () => ({
  orgRoute: {
    useLoaderData: () => ({
      membership: { role: 'org_owner', organisation: { id: ORGANISATION_ID } },
    }),
  },
}))
vi.mock('./routes', () => ({
  invoiceDetailRoute: {
    useParams: () => ({ org: 'vercelli', invoiceId: INVOICE_ID }),
    useSearch: () => ({}),
  },
}))
vi.mock('./queries', () => ({
  useBillingProfileQuery: () => mocks.profileFixture,
  useInvoiceQuery: () => ({
    data: mocks.invoiceData,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useActiveSubscriptionQuery: () => ({ data: null, isLoading: false, isError: false }),
  fetchInvoiceDownloadLink: mocks.downloadInvoicePdf,
}))
vi.mock('./facturxApi', async (importOriginal) => {
  const actual = await importOriginal<typeof FacturxApiModule>()
  return {
    ...actual,
    fetchInvoiceArtifactDownloadLink: mocks.downloadInvoiceArtifact,
    fetchCreditNoteDownloadLink: mocks.downloadCreditNoteArtifact,
    validateBillingVat: mocks.validateVat,
  }
})

const SAMPLE_SHA256 = 'a'.repeat(64)
const CREDIT_SHA256 = 'b'.repeat(64)

beforeEach(async () => {
  await i18n.changeLanguage('fr')
  vi.spyOn(authAdapter, 'getSnapshot').mockReturnValue({
    status: 'ready',
    generation: 1,
    credentialGeneration: 1,
    user: { realm: 'vercelli' },
  })
  vi.spyOn(authAdapter, 'getAccessToken').mockReturnValue('synthetic')
  vi.spyOn(window, 'open').mockReturnValue(null)
  mocks.invoiceData = baseInvoice()
  mocks.downloadInvoicePdf.mockReset()
  mocks.downloadInvoiceArtifact.mockReset()
  mocks.downloadCreditNoteArtifact.mockReset()
  mocks.validateVat.mockReset()
  mocks.notify.mockReset()
})

afterEach(async () => {
  await i18n.changeLanguage('fr')
  vi.restoreAllMocks()
})

describe('BillingProfileCard VIES statuses and tax regimes', () => {
  it('displays fr_standard, verified eu_reverse_charge, and VIES unavailable hold notice without silent 0% fallback', async () => {
    const verifiedVat: BillingVatStatus = {
      country_code: 'DE',
      vat_number: 'DE123456789',
      status: 'valid',
      checked_at: '2026-11-13T10:00:00Z',
      next_check_at: '2026-12-13T10:00:00Z',
      evidence_id: '019467a3-0f9b-7cc3-98c2-1fa48f28f562',
    }

    const { container, rerender } = render(
      <BillingProfileCard
        organisationId={ORGANISATION_ID}
        taxRegime="eu_reverse_charge"
        vatStatus={verifiedVat}
      />
    )

    expect(screen.getByText(/Autoliquidation UE/)).toBeVisible()
    expect(screen.getByText('VIES vérifié')).toBeVisible()
    expect(screen.getByText('DE · DE123456789')).toBeVisible()
    expect(screen.getByText('019467a3-0f9b-7cc3-98c2-1fa48f28f562')).toBeVisible()

    const heldVat: BillingVatStatus = {
      country_code: 'BE',
      vat_number: 'BE0123456789',
      status: 'unavailable',
      checked_at: '2026-11-13T10:05:00Z',
      next_check_at: '2026-11-13T12:05:00Z',
      evidence_id: null,
    }

    rerender(
      <BillingProfileCard
        organisationId={ORGANISATION_ID}
        taxRegime="fr_standard"
        vatStatus={heldVat}
      />
    )

    expect(screen.getByText('TVA française standard')).toBeVisible()
    expect(screen.getByText('En attente VIES (revue opérateur)')).toBeVisible()
    expect(
      screen.getByText(/Aucune autoliquidation à 0\s% de TVA n’est accordée automatiquement/)
    ).toBeVisible()
    expect(container.querySelectorAll('[style]')).toHaveLength(0)

    await i18n.changeLanguage('en')
    rerender(
      <BillingProfileCard
        organisationId={ORGANISATION_ID}
        taxRegime="fr_standard"
        vatStatus={heldVat}
      />
    )

    expect(screen.getByText('French standard VAT')).toBeVisible()
    expect(screen.getByText('VIES pending hold (operator review)')).toBeVisible()
    expect(
      screen.getByText(/Reverse-charge 0% VAT is never silently granted/)
    ).toBeVisible()
  })

  it('submits normalized intra-EU VAT numbers when interactive validation is enabled', async () => {
    const user = userEvent.setup()
    mocks.validateVat.mockResolvedValueOnce({
      country_code: 'NL',
      vat_number: 'NL123456789B01',
      status: 'valid',
      checked_at: '2026-11-13T11:00:00Z',
      next_check_at: null,
      evidence_id: '019467a3-0f9b-7cc3-98c2-1fa48f28f999',
    })

    render(
      <BillingProfileCard
        organisationId={ORGANISATION_ID}
        canValidateVat
        vatStatus={{
          country_code: null,
          vat_number: null,
          status: 'not_checked',
          checked_at: null,
          next_check_at: null,
          evidence_id: null,
        }}
      />
    )

    await user.type(screen.getByLabelText('Pays UE (ISO-2)'), 'nl')
    await user.type(screen.getByLabelText('Numéro de TVA'), 'nl 123456789 b01')
    await user.click(screen.getByRole('button', { name: 'Vérifier le numéro de TVA' }))

    await waitFor(() =>
      expect(mocks.validateVat).toHaveBeenCalledWith(ORGANISATION_ID, {
        country_code: 'NL',
        vat_number: 'NL123456789B01',
      })
    )
    expect(await screen.findByText('VIES vérifié')).toBeVisible()
  })
})

describe('Factur-X 1.0 (380 invoice & 381 AV- credit-note) downloads and digests', () => {
  it('renders Factur-X 380 & 381 metadata, SHA-256 digests, and opens PDF/XML pre-signed downloads', async () => {
    const user = userEvent.setup()
    const expiresAt = new Date(Date.now() + 300_000).toISOString()

    mocks.invoiceData = baseInvoice({
      state: 'credited',
      credit_note_id: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      facturx_type_code: '380',
      xml_available: true,
      snapshot_sha256: SAMPLE_SHA256,
      artifacts: {
        pdf: {
          content_type: 'application/pdf',
          filename: 'INV-2026-0142.pdf',
          sha256: SAMPLE_SHA256,
          size_bytes: 51_200,
        },
        xml: {
          content_type: 'application/xml',
          filename: 'factur-x.xml',
          sha256: SAMPLE_SHA256,
          size_bytes: 8_192,
        },
      },
    })

    const creditNote: CreditNote = {
      id: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      organisation_id: ORGANISATION_ID,
      invoice_id: INVOICE_ID,
      invoice_number: 'INV-2026-0142',
      number: 'AV-INV-2026-00007',
      issued_at: '2026-12-03T10:12:44Z',
      reason: 'customer_cancellation',
      currency: 'EUR',
      vat_regime: 'fr_standard',
      lines: [
        {
          description: 'Essentiel, pack Workspace, capacity M, 12 months',
          quantity: 1,
          unit_amount_excl_vat: { amount_minor: 448800, currency: 'EUR' },
          total_excl_vat: { amount_minor: 448800, currency: 'EUR' },
          vat_rate_bp: 2000,
        },
      ],
      total_excl_vat: { amount_minor: 448800, currency: 'EUR' },
      vat_amount: { amount_minor: 89760, currency: 'EUR' },
      total_incl_vat: { amount_minor: 538560, currency: 'EUR' },
      facturx_type_code: '381',
      xml_available: true,
      snapshot_sha256: CREDIT_SHA256,
      artifacts: {
        pdf: {
          content_type: 'application/pdf',
          filename: 'AV-INV-2026-00007.pdf',
          sha256: CREDIT_SHA256,
          size_bytes: 49_100,
        },
      },
    }

    mocks.downloadInvoicePdf.mockResolvedValueOnce({
      url: 'https://storage.example.test/invoices/inv.pdf',
      expires_at: expiresAt,
      content_type: 'application/pdf',
    })
    mocks.downloadInvoiceArtifact.mockResolvedValueOnce({
      url: 'https://storage.example.test/invoices/factur-x.xml',
      expires_at: expiresAt,
      content_type: 'application/xml',
    })
    mocks.downloadCreditNoteArtifact
      .mockResolvedValueOnce({
        url: 'https://storage.example.test/credit-notes/av.pdf',
        expires_at: expiresAt,
        content_type: 'application/pdf',
      })
      .mockResolvedValueOnce({
        url: 'https://storage.example.test/credit-notes/av.xml',
        expires_at: expiresAt,
        content_type: 'application/xml',
      })

    const { container } = render(<InvoiceDetailScreen initialCreditNote={creditNote} />)

    expect(screen.getByText('Factur-X 1.0 · Facture (380)')).toBeVisible()
    expect(screen.getByText(SAMPLE_SHA256)).toBeVisible()
    expect(screen.getByText('INV-2026-0142.pdf')).toBeVisible()

    expect(screen.getByRole('heading', { name: 'Avoir AV-INV-2026-00007' })).toBeVisible()
    expect(screen.getByText('Factur-X 1.0 · Avoir (381)')).toBeVisible()
    expect(screen.getByText('Annulation à la demande du client')).toBeVisible()
    expect(screen.getByText(CREDIT_SHA256)).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Télécharger le PDF' }))
    expect(mocks.downloadInvoicePdf).toHaveBeenCalledWith(INVOICE_ID)

    await user.click(screen.getByRole('button', { name: 'Télécharger le XML Factur-X (380)' }))
    expect(mocks.downloadInvoiceArtifact).toHaveBeenCalledWith(INVOICE_ID, 'xml')

    await user.click(screen.getByRole('button', { name: 'Télécharger l’avoir PDF/A-3 (381)' }))
    expect(mocks.downloadCreditNoteArtifact).toHaveBeenCalledWith(creditNote.id, 'pdf')

    await user.click(screen.getByRole('button', { name: 'Télécharger le XML de l’avoir (381)' }))
    expect(mocks.downloadCreditNoteArtifact).toHaveBeenCalledWith(creditNote.id, 'xml')

    expect(window.open).toHaveBeenCalledTimes(4)
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })
})
