// §7: "Six invoices in `state: paid` over two cursor pages." The list
// screen's own pager only ever asks for `next`, never `previous`
// (`src/features/invoices/InvoiceListScreen.tsx`), so the mock only needs to
// answer the two cursors that pager can actually produce: none, and
// `"page-2"`.

import { http, HttpResponse } from 'msw/http'
import { baseInvoice, ORGANISATION_ID } from '../fixtures/invoiceFixtures'

const BASE = '*/api/v1'

function paidInvoice(index: number) {
  return baseInvoice({
    id: `11111111-1111-4111-8111-11111111111${index}`,
    number: `INV-2026-010${index}`,
    state: 'paid',
    paid_at: '2026-11-15T10:00:00Z',
    amount_due: { amount_minor: 0, currency: 'EUR' },
  })
}

const PAGE_ONE = [paidInvoice(1), paidInvoice(2), paidInvoice(3)]
const PAGE_TWO = [paidInvoice(4), paidInvoice(5), paidInvoice(6)]

export const handlers = [
  http.get(`${BASE}/organisations/${ORGANISATION_ID}/invoices`, ({ request }) => {
    const cursor = new URL(request.url).searchParams.get('cursor')
    const page = cursor === 'page-2' ? PAGE_TWO : PAGE_ONE
    const hasMore = cursor !== 'page-2'
    return HttpResponse.json(
      { data: page, next_cursor: hasMore ? 'page-2' : null, has_more: hasMore },
      { status: 200, headers: { 'X-Request-Id': crypto.randomUUID() } }
    )
  }),
]
