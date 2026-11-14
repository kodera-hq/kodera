// 01-order.md §7: "`orders` succeeds with `invoice: null`, `payment_link:
// null` and `billing_pending: true`." The confirmation screen reads this
// back through `GET /orders/{order_id}`, so this overlay carries the same
// deferral there: `invoice_id` absent is what `billing_pending` becomes once
// an order already exists (`ConfirmationStep.tsx`).

import { http, HttpResponse } from 'msw/http'
import { EXAMPLES } from '../generated/examples'

const BASE = '*/api/v1'

export const handlers = [
  http.post(`${BASE}/organisations/:organisation_id/orders`, () => {
    const example = EXAMPLES.placeOrder
    const body = example.body as { order: Record<string, unknown> } & Record<string, unknown>
    return HttpResponse.json(
      {
        ...body,
        order: { ...body.order, invoice_id: null },
        invoice: null,
        payment_link: null,
        billing_pending: true,
      },
      {
        status: example.status,
        headers: { ...example.headers, 'X-Request-Id': crypto.randomUUID() },
      }
    )
  }),
  http.get(`${BASE}/orders/:order_id`, () => {
    const example = EXAMPLES.getOrder
    const body = example.body as Record<string, unknown>
    return HttpResponse.json(
      { ...body, invoice_id: null },
      { headers: { ...example.headers, 'X-Request-Id': crypto.randomUUID() } }
    )
  }),
]
