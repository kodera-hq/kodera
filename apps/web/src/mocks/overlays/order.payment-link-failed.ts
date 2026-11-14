// 01-order.md §7: "`invoices/{invoice_id}/payment-link` returns `502`
// `upstream-unavailable`." The invoice itself exists and downloads fine —
// only the payment provider is unreachable, so the confirmation screen falls
// back to bank transfer and offers a retry (`ConfirmationStep.tsx`).

import { http } from 'msw/http'
import { problem } from '../problem'

const BASE = '*/api/v1'

export const handlers = [
  http.post(`${BASE}/invoices/:invoice_id/payment-link`, () =>
    problem('https://kodera.io/problems/upstream-unavailable', { retryAfterS: 30 })
  ),
]
