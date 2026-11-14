// §7: "One invoice `overdue`, `dunning.days_overdue: 12`, `dunning.state:
// notice`." The list banner (AT1) reads the suspension step's own `due_at`
// for "sans règlement avant le {date}" — the `formal_notice`/
// `suspension_notice`/`suspended` steps below give it one to read.

import { http, HttpResponse } from 'msw/http'
import { baseInvoice, INVOICE_ID, invoicesPage, ORGANISATION_ID } from '../fixtures/invoiceFixtures'

const BASE = '*/api/v1'

const OVERDUE_INVOICE = baseInvoice({
  state: 'overdue',
  due_at: '2027-03-31T23:59:59Z',
  amount_due: { amount_minor: 580608, currency: 'EUR' },
  total_incl_vat: { amount_minor: 580608, currency: 'EUR' },
})

const DUNNING = {
  state: 'notice',
  ladder: 'invoice',
  oldest_overdue_invoice_id: INVOICE_ID,
  days_overdue: 12,
  amount_due: { amount_minor: 580608, currency: 'EUR' },
  hold_until: null,
  steps: [
    { state: 'past_due', due_at: '2027-03-31T23:59:59Z', done: true },
    { state: 'notice', due_at: '2027-04-07T00:00:00Z', done: true },
    { state: 'notice', due_at: '2027-04-21T00:00:00Z', done: false },
    { state: 'formal_notice', due_at: '2027-05-05T00:00:00Z', done: false },
    { state: 'suspension_notice', due_at: '2027-05-30T00:00:00Z', done: false },
    { state: 'suspended', due_at: '2027-06-06T00:00:00Z', done: false },
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
