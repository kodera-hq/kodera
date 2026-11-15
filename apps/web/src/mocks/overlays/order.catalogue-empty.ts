// A successful empty collection is distinct from a failed catalogue read.
import { http, HttpResponse } from 'msw/http'

export const handlers = [
  http.get('*/api/v1/catalog/capacity-tiers', () =>
    HttpResponse.json(
      { data: [], next_cursor: null, has_more: false },
      { headers: { 'X-Request-Id': crypto.randomUUID() } }
    )
  ),
]
