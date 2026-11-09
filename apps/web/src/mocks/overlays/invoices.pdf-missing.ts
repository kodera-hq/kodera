// §7: "`pdf_available: false`; `download` returns `404`."

import { http, HttpResponse } from 'msw'
import { problem } from '../problem'
import { baseInvoice, INVOICE_ID, invoicesPage, ORGANISATION_ID } from '../fixtures/invoiceFixtures'

const BASE = '*/api/v1'

const NO_PDF_INVOICE = baseInvoice({ pdf_available: false })

export const handlers = [
  http.get(`${BASE}/organisations/${ORGANISATION_ID}/invoices`, () =>
    HttpResponse.json(invoicesPage([NO_PDF_INVOICE]), {
      status: 200,
      headers: { 'X-Request-Id': crypto.randomUUID() },
    })
  ),
  http.get(`${BASE}/invoices/${INVOICE_ID}`, () =>
    HttpResponse.json(NO_PDF_INVOICE, {
      status: 200,
      headers: { 'X-Request-Id': crypto.randomUUID() },
    })
  ),
  http.get(`${BASE}/invoices/${INVOICE_ID}/download`, () =>
    problem('https://kodera.io/problems/not-found')
  ),
]
