// A permanent fixture, not a real scenario: its only job is to prove
// composition order in tests/unit/mocks/scenario.test.ts. It answers a path no
// real feature reads, so it can never be picked up by accident.
//
// Paired with test-fixture.second.ts: both answer the same path with a
// different body, so a test naming both scenarios can assert which one wins.

import { http, HttpResponse } from 'msw'

export const handlers = [
  http.get('*/api/v1/__scenario-composition-fixture', () =>
    HttpResponse.json({ overlay: 'first' })
  ),
]
