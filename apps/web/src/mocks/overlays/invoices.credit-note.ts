// §7: "One invoice `state: credited` and a line with a negative
// `amount_minor`."

import { http, HttpResponse } from 'msw/http'
import { baseInvoice, INVOICE_ID, invoicesPage, ORGANISATION_ID } from '../fixtures/invoiceFixtures'

const BASE = '*/api/v1'

const CREDIT_NOTE = baseInvoice({
  number: 'A-2026-0003',
  state: 'credited',
  paid_at: null,
  lines: [
    {
      description: 'Avoir sur facture INV-2026-0142',
      quantity: 1,
      unit_amount_excl_vat: { amount_minor: -49500, currency: 'EUR' },
      total_excl_vat: { amount_minor: -49500, currency: 'EUR' },
      vat_rate_bp: 2000,
    },
  ],
  total_excl_vat: { amount_minor: -49500, currency: 'EUR' },
  vat_amount: { amount_minor: -9900, currency: 'EUR' },
  total_incl_vat: { amount_minor: -59400, currency: 'EUR' },
  amount_due: { amount_minor: 0, currency: 'EUR' },
})

export const handlers = [
  http.get(`${BASE}/organisations/${ORGANISATION_ID}/invoices`, () =>
    HttpResponse.json(invoicesPage([CREDIT_NOTE]), {
      status: 200,
      headers: { 'X-Request-Id': crypto.randomUUID() },
    })
  ),
  http.get(`${BASE}/invoices/${INVOICE_ID}`, () =>
    HttpResponse.json(CREDIT_NOTE, {
      status: 200,
      headers: { 'X-Request-Id': crypto.randomUUID() },
    })
  ),
  // The base `getDunning` example happens to name this same invoice id as
  // overdue (docs/specs/05-invoices.md's reconciled numbers) — without this
  // override the list would show a dunning banner pointed at a row that is
  // actually a credit note.
  http.get(`${BASE}/organisations/${ORGANISATION_ID}/dunning`, () =>
    HttpResponse.json(
      { state: 'current', oldest_overdue_invoice_id: null, amount_due: null, steps: [] },
      { status: 200, headers: { 'X-Request-Id': crypto.randomUUID() } }
    )
  ),
]
