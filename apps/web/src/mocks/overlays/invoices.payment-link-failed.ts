// §7: "`POST /invoices/{id}/payment-link` returns `502`
// `upstream-unavailable`." `./payment.ts` tries a `GET` before that `POST`
// (an invoice that already has an active link never needs a new one), so the
// `GET` here answers `404 not-found` — no link exists yet — to reach the
// `POST` this overlay is actually about.

import { http, HttpResponse } from 'msw'
import { problem } from '../problem'
import { baseInvoice, INVOICE_ID, invoicesPage, ORGANISATION_ID } from '../fixtures/invoiceFixtures'

const BASE = '*/api/v1'
const PAYABLE_INVOICE = baseInvoice()

export const handlers = [
  http.get(`${BASE}/organisations/${ORGANISATION_ID}/invoices`, () =>
    HttpResponse.json(invoicesPage([PAYABLE_INVOICE]), {
      status: 200,
      headers: { 'X-Request-Id': crypto.randomUUID() },
    })
  ),
  http.get(`${BASE}/invoices/${INVOICE_ID}`, () =>
    HttpResponse.json(PAYABLE_INVOICE, {
      status: 200,
      headers: { 'X-Request-Id': crypto.randomUUID() },
    })
  ),
  http.get(`${BASE}/invoices/${INVOICE_ID}/payment-link`, () =>
    problem('https://kodera.io/problems/not-found')
  ),
  http.post(`${BASE}/invoices/${INVOICE_ID}/payment-link`, () =>
    problem('https://kodera.io/problems/upstream-unavailable')
  ),
]
