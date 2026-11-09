import { afterEach, expect, it, vi } from 'vitest'
import { baseInvoice, INVOICE_ID, ORGANISATION_ID } from '../../mocks/fixtures/invoiceFixtures'
import {
  requireInvoiceDownloadLink,
  requireInvoiceResponse,
  requirePaymentLink,
} from './responseValidation'

afterEach(() => vi.restoreAllMocks())

function link(overrides: Record<string, unknown> = {}) {
  return {
    invoice_id: INVOICE_ID,
    state: 'active',
    url: 'https://payments.example.test/synthetic?signature=synthetic',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  }
}

it('accepts an active matching link without changing or inspecting its signed contents', () => {
  const value = Object.freeze(link())
  expect(() => requirePaymentLink(value, INVOICE_ID)).not.toThrow()
  expect(value.url).toBe('https://payments.example.test/synthetic?signature=synthetic')
})

it('refuses precisely at expiry and permits the immediately preceding instant', () => {
  const value = link({ expires_at: '2099-01-01T00:00:00Z' })
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(value.expires_at) - 1)
  expect(() => requirePaymentLink(value, INVOICE_ID)).not.toThrow()
  vi.mocked(Date.now).mockReturnValue(Date.parse(value.expires_at))
  expect(() => requirePaymentLink(value, INVOICE_ID)).toThrow(
    'Payment link response is unavailable.'
  )
})

it.each([
  'https://payments.example.test/with space',
  'https://payments.example.test/\npath',
  'https://synthetic%40name@payments.example.test/path',
  '//payments.example.test/path',
  'https://',
])('refuses unusable URL spelling %s without leaking it', (url) => {
  expect(() => requirePaymentLink(link({ url }), INVOICE_ID)).toThrow(
    'Payment link response is unavailable.'
  )
})

it.each(['expired', 'cancelled', 'used', null])(
  'refuses nonactive state %s even with a future expiry',
  (state) => {
    expect(() => requirePaymentLink(link({ state }), INVOICE_ID)).toThrow(
      'Payment link response is unavailable.'
    )
  }
)

it('accepts a declared PDF but refuses missing media type without opening a resource', () => {
  const value = { ...link(), content_type: 'application/pdf' }
  expect(() => requireInvoiceDownloadLink(value)).not.toThrow()
  expect(() => requireInvoiceDownloadLink(link())).toThrow('Invoice PDF response is unavailable.')
})

it('preserves zero and negative declared money without calculating invoice totals', () => {
  const invoice = baseInvoice({
    state: 'credited',
    total_excl_vat: { amount_minor: -100, currency: 'EUR' },
    vat_amount: { amount_minor: 0, currency: 'EUR' },
    total_incl_vat: { amount_minor: -100, currency: 'EUR' },
  })
  expect(() =>
    requireInvoiceResponse(invoice, { invoiceId: INVOICE_ID, organisationId: ORGANISATION_ID })
  ).not.toThrow()
})

it('preserves optional missing row amount for the existing unavailable-amount presentation', () => {
  const { total_incl_vat: omitted, ...row } = baseInvoice()
  expect(omitted).toBeDefined()
  expect(() => requireInvoiceResponse(row, { organisationId: ORGANISATION_ID })).not.toThrow()
  expect(() =>
    requireInvoiceResponse(row, { invoiceId: INVOICE_ID, organisationId: ORGANISATION_ID })
  ).toThrow('Invoice response is unavailable.')
})

it.each([
  { ...baseInvoice(), vat_regime: 'toString' },
  { ...baseInvoice(), pdf_available: 'true' },
  { ...baseInvoice(), number: {} },
  { ...baseInvoice(), lines: [{ ...baseInvoice().lines[0], vat_rate_bp: NaN }] },
  {
    ...baseInvoice(),
    total_incl_vat: { amount_minor: Number.MAX_SAFE_INTEGER + 1, currency: 'EUR' },
  },
])('refuses unusable fields consumed by the invoice detail', (value) => {
  expect(() =>
    requireInvoiceResponse(value, { invoiceId: INVOICE_ID, organisationId: ORGANISATION_ID })
  ).toThrow('Invoice response is unavailable.')
})

it('preserves the specified missing-currency row fallback while detail refuses it', () => {
  const row = { ...baseInvoice(), total_incl_vat: { amount_minor: 10 } }
  expect(() => requireInvoiceResponse(row, { organisationId: ORGANISATION_ID })).not.toThrow()
  expect(() =>
    requireInvoiceResponse(row, { invoiceId: INVOICE_ID, organisationId: ORGANISATION_ID })
  ).toThrow()
})
