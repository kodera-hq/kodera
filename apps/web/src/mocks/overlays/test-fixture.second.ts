// See test-fixture.first.ts — the pair exists only to prove overlay
// composition order in tests/unit/mocks/scenario.test.ts.

import { http, HttpResponse } from 'msw/http'

export const handlers = [
  http.get('*/api/v1/__scenario-composition-fixture', () =>
    HttpResponse.json({ overlay: 'second' })
  ),
]
