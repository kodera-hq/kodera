// §7: "An active subscription with `next_invoice_at` set, `invoices` returns
// an empty page." The subscription stays the base example (it already
// carries `next_invoice_at`); the invoice list is overridden, and so is
// dunning — the base `getDunning` example happens to describe an overdue
// invoice (`docs/specs/05-invoices.md`'s own reconciled numbers), which
// would otherwise leak an overdue banner onto a screen with no invoice to
// name in it.

import { http, HttpResponse } from 'msw'

const BASE = '*/api/v1'
const ORG = '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f'

export const handlers = [
  http.get(`${BASE}/organisations/${ORG}/invoices`, () =>
    HttpResponse.json(
      { data: [], next_cursor: null, has_more: false },
      { status: 200, headers: { 'X-Request-Id': crypto.randomUUID() } }
    )
  ),
  http.get(`${BASE}/organisations/${ORG}/dunning`, () =>
    HttpResponse.json(
      { state: 'current', oldest_overdue_invoice_id: null, amount_due: null, steps: [] },
      { status: 200, headers: { 'X-Request-Id': crypto.randomUUID() } }
    )
  ),
]
