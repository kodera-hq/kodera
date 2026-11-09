// §7: "`vat_regime: eu_reverse_charge`, `vat_amount.amount_minor: 0`." Total
// incl. tax equals total excl. tax, per AT3.

import { http, HttpResponse } from 'msw'
import { baseInvoice, INVOICE_ID, invoicesPage, ORGANISATION_ID } from '../fixtures/invoiceFixtures'

const BASE = '*/api/v1'

const REVERSE_CHARGE_INVOICE = baseInvoice({
  vat_regime: 'eu_reverse_charge',
  lines: [
    {
      description: 'Essentiel, pack Visio + Docs, capacity M, 12 months',
      quantity: 1,
      unit_amount_excl_vat: { amount_minor: 448800, currency: 'EUR' },
      total_excl_vat: { amount_minor: 448800, currency: 'EUR' },
      vat_rate_bp: 0,
      period_start: '2026-12-01T00:00:00Z',
      period_end: '2027-12-01T00:00:00Z',
    },
  ],
  total_excl_vat: { amount_minor: 448800, currency: 'EUR' },
  vat_amount: { amount_minor: 0, currency: 'EUR' },
  total_incl_vat: { amount_minor: 448800, currency: 'EUR' },
  amount_due: { amount_minor: 448800, currency: 'EUR' },
})

export const handlers = [
  http.get(`${BASE}/organisations/${ORGANISATION_ID}/invoices`, () =>
    HttpResponse.json(invoicesPage([REVERSE_CHARGE_INVOICE]), {
      status: 200,
      headers: { 'X-Request-Id': crypto.randomUUID() },
    })
  ),
  http.get(`${BASE}/invoices/${INVOICE_ID}`, () =>
    HttpResponse.json(REVERSE_CHARGE_INVOICE, {
      status: 200,
      headers: { 'X-Request-Id': crypto.randomUUID() },
    })
  ),
]
