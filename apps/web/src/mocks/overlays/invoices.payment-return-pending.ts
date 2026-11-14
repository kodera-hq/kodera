// §7: "After the return the invoice is still `issued` and `amount_due` is
// unchanged." Explicit rather than relying on the base example staying
// `issued` by coincidence — AT5 needs this shape to hold regardless of what
// a future contract regeneration's example carries.

import { http, HttpResponse } from 'msw/http'
import { baseInvoice, INVOICE_ID, invoicesPage, ORGANISATION_ID } from '../fixtures/invoiceFixtures'

const BASE = '*/api/v1'

const STILL_UNPAID = baseInvoice({ state: 'issued', paid_at: null })

export const handlers = [
  http.get(`${BASE}/organisations/${ORGANISATION_ID}/invoices`, () =>
    HttpResponse.json(invoicesPage([STILL_UNPAID]), {
      status: 200,
      headers: { 'X-Request-Id': crypto.randomUUID() },
    })
  ),
  http.get(`${BASE}/invoices/${INVOICE_ID}`, () =>
    HttpResponse.json(STILL_UNPAID, {
      status: 200,
      headers: { 'X-Request-Id': crypto.randomUUID() },
    })
  ),
]
