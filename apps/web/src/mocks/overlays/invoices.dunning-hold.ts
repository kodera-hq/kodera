// §7: "`dunning.hold_until` set while a billing dispute is open."

import { http, HttpResponse } from 'msw/http'
import { baseInvoice, INVOICE_ID, invoicesPage, ORGANISATION_ID } from '../fixtures/invoiceFixtures'

const BASE = '*/api/v1'

const OVERDUE_INVOICE = baseInvoice({
  state: 'overdue',
  due_at: '2027-03-31T23:59:59Z',
})

const DUNNING = {
  state: 'notice',
  ladder: 'invoice',
  oldest_overdue_invoice_id: INVOICE_ID,
  days_overdue: 12,
  amount_due: { amount_minor: 538560, currency: 'EUR' },
  hold_until: '2027-05-01T00:00:00Z',
  steps: [
    { state: 'past_due', due_at: '2027-03-31T23:59:59Z', done: true },
    { state: 'notice', due_at: '2027-04-07T00:00:00Z', done: true },
  ],
}

export const handlers = [
  http.get(`${BASE}/organisations/${ORGANISATION_ID}/invoices`, () =>
    HttpResponse.json(invoicesPage([OVERDUE_INVOICE]), {
      status: 200,
      headers: { 'X-Request-Id': crypto.randomUUID() },
    })
  ),
  http.get(`${BASE}/invoices/${INVOICE_ID}`, () =>
    HttpResponse.json(OVERDUE_INVOICE, {
      status: 200,
      headers: { 'X-Request-Id': crypto.randomUUID() },
    })
  ),
  http.get(`${BASE}/organisations/${ORGANISATION_ID}/dunning`, () =>
    HttpResponse.json(DUNNING, { status: 200, headers: { 'X-Request-Id': crypto.randomUUID() } })
  ),
]
