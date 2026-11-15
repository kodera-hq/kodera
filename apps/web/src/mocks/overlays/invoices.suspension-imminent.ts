// §7: "`dunning.state: suspension_notice`, the next `steps[]` entry due in
// seven days." Dates are computed from "now" so "seven days" stays true
// whenever the suite runs, rather than a date that quietly goes stale.

import { http, HttpResponse } from 'msw/http'
import { baseInvoice, INVOICE_ID, invoicesPage, ORGANISATION_ID } from '../fixtures/invoiceFixtures'

const BASE = '*/api/v1'

const now = Date.now()
const daysFromNow = (days: number) => new Date(now + days * 86_400_000).toISOString()
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString()

const OVERDUE_INVOICE = baseInvoice({
  state: 'overdue',
  due_at: daysAgo(35),
  amount_due: { amount_minor: 580608, currency: 'EUR' },
  total_incl_vat: { amount_minor: 580608, currency: 'EUR' },
})

const DUNNING = {
  state: 'suspension_notice',
  ladder: 'invoice',
  oldest_overdue_invoice_id: INVOICE_ID,
  days_overdue: 35,
  amount_due: { amount_minor: 580608, currency: 'EUR' },
  hold_until: null,
  steps: [
    { state: 'past_due', due_at: daysAgo(35), done: true },
    { state: 'notice', due_at: daysAgo(28), done: true },
    { state: 'notice', due_at: daysAgo(14), done: true },
    { state: 'formal_notice', due_at: daysAgo(5), done: true },
    { state: 'suspension_notice', due_at: daysFromNow(7), done: false },
    { state: 'suspended', due_at: daysFromNow(14), done: false },
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
