// Shared builders for the invoices area's MSW overlays
// (`src/mocks/overlays/invoices.*.ts`). Deliberately outside `overlays/`:
// that directory is globbed by file name and every file in it is expected to
// export `handlers` (`src/mocks/overlays/index-glob.ts`) — a helper module
// living there would be mistaken for a scenario of its own.

import type { components } from '../../api/schema'

export const ORGANISATION_ID = '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f'
export const SUBSCRIPTION_ID = '4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d'
export const INVOICE_ID = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70'
export const INVOICE_NUMBER = 'INV-2026-0142'

type Invoice = components['schemas']['Invoice']

export function baseInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: INVOICE_ID,
    organisation_id: ORGANISATION_ID,
    subscription_id: SUBSCRIPTION_ID,
    order_id: 'a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f',
    number: INVOICE_NUMBER,
    state: 'issued',
    currency: 'EUR',
    vat_regime: 'fr_standard',
    lines: [
      {
        description: 'Essentiel, pack Visio + Docs, capacity M, 12 months',
        quantity: 1,
        unit_amount_excl_vat: { amount_minor: 448800, currency: 'EUR' },
        total_excl_vat: { amount_minor: 448800, currency: 'EUR' },
        vat_rate_bp: 2000,
        period_start: '2026-12-01T00:00:00Z',
        period_end: '2027-12-01T00:00:00Z',
      },
    ],
    total_excl_vat: { amount_minor: 448800, currency: 'EUR' },
    vat_amount: { amount_minor: 89760, currency: 'EUR' },
    total_incl_vat: { amount_minor: 538560, currency: 'EUR' },
    amount_due: { amount_minor: 538560, currency: 'EUR' },
    issued_at: '2026-12-01T09:42:00Z',
    due_at: '2026-12-31T23:59:59Z',
    paid_at: null,
    pdf_available: true,
    external_ref: 'qonto_inv_9RJ2K',
    created_at: '2026-12-01T09:41:07Z',
    updated_at: '2026-12-01T09:42:00Z',
    ...overrides,
  }
}

export function invoicesPage(invoices: Invoice[]) {
  return { data: invoices, next_cursor: null, has_more: false }
}
