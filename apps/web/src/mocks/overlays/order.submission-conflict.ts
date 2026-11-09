// 01-order.md §7: "The first `orders` call times out; the retry with the
// same key replays the original `OrderResult` with `Idempotency-Replayed:
// true`." The base generated handler already replays a repeated
// `Idempotency-Key` (`src/mocks/generated/handlers.ts`'s `answerIdempotent`)
// — what this overlay adds is the FIRST attempt failing at the network
// layer, the shape a genuine timeout takes, so the retry is the interesting
// part under test rather than a second ordinary success.

import { http, HttpResponse } from 'msw'
import { EXAMPLES } from '../generated/examples'

const BASE = '*/api/v1'

const seenKeys = new Set<string>()

export const handlers = [
  http.post(`${BASE}/organisations/:organisation_id/orders`, ({ request }) => {
    const key = request.headers.get('Idempotency-Key')
    if (key !== null && !seenKeys.has(key)) {
      seenKeys.add(key)
      // A network-level failure — the shape `mutate()` turns into
      // `NetworkError`, the same as a request that never got an answer.
      return HttpResponse.error()
    }
    const example = EXAMPLES.placeOrder
    return HttpResponse.json(example.body, {
      status: example.status,
      headers: {
        ...example.headers,
        'X-Request-Id': crypto.randomUUID(),
        'Idempotency-Replayed': 'true',
      },
    })
  }),
]
