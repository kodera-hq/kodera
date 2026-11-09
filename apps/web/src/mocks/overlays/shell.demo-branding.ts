// The demo organisation that has a mark: Groupe Vercelli, FICTIONAL, invented
// by the design handoff to show where a customer's own branding sits beside
// the maker's.
//
// Why an overlay at all: the base seed's organisation is `acme-sa` / "ACME SAS"
// (`src/mocks/generated/examples.ts`, from the contract's own example), and
// nothing in this repository knew the name Vercelli before this change — only
// the mark file did. Attaching a mark labelled "Groupe Vercelli" to an
// organisation named "ACME SAS" would put two different customers on one
// sidebar, so the demo that shows the mark seeds the organisation it belongs
// to, and every other scenario keeps ACME and shows no mark at all. That
// second case is the one every real deployment is in: the Core contract has no
// branding field (`src/app/demoBranding.ts`).
//
// `slug` is what `src/app/demoBranding.ts` keys on, so it must stay
// `vercelli` — `src/mocks/demo/branding.ts` exports the same constant and
// `tests/unit/mocks/demo-branding.test.ts` holds the two together.

import { http, HttpResponse } from 'msw'
import type { components } from '@/api/schema'
import { bindCurrentUserToMockRequest } from '../currentUserIdentity'
import { EXAMPLES } from '../generated/examples'

const BASE = '*/api/v1'

const ORGANISATIONS: components['schemas']['Me']['organisations'] = [
  {
    organisation: {
      id: '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f',
      slug: 'vercelli',
      name: 'Groupe Vercelli',
      realm: 'vercelli',
    },
    membership_id: '7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c',
    role: 'org_admin',
    state: 'active',
    identity_id: '3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d',
    joined_at: '2026-11-04T14:02:00Z',
  },
]

export const handlers = [
  http.get(`${BASE}/me`, ({ request }) => {
    const example = EXAMPLES.getMe
    const body = bindCurrentUserToMockRequest(
      {
        ...(example.body as components['schemas']['Me']),
        organisations: ORGANISATIONS,
      },
      request
    )
    return HttpResponse.json(body, { status: example.status, headers: { ...example.headers } })
  }),
]
