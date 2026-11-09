// docs/specs/00-shell-and-login.md §7: `/me` returns three entries in
// `organisations[]` — the organisation switcher's menu case
// (`src/app/OrgSwitcher.tsx`), as opposed to `shell.single-organisation`'s
// static text.
//
// "across two packs" (§7's own wording) has no field to carry it: `Me.
// organisations[].organisation` is `OrganisationSummary` (`id`, `slug`,
// `name`, `realm` — §6's own field list for `GET /me`, and the schema
// confirms it), and nothing else `/me` returns names a pack per membership.
// Reported as a gap; this overlay differs each entry by slug and name only,
// the fields the response actually carries.

import { http, HttpResponse } from 'msw'
import type { components } from '@/api/schema'
import { bindCurrentUserToMockRequest } from '../currentUserIdentity'
import { EXAMPLES } from '../generated/examples'

const BASE = '*/api/v1'

const ORGANISATIONS: components['schemas']['Me']['organisations'] = [
  {
    organisation: {
      id: '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f',
      slug: 'acme-sa',
      name: 'ACME Construction',
      realm: 'acme-sa',
    },
    membership_id: '7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c',
    role: 'org_admin',
    state: 'active',
    identity_id: '3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d',
    joined_at: '2026-11-04T14:02:00Z',
  },
  {
    organisation: {
      id: '7a2e3f4d-9b5c-4d6e-af70-1b2c3d4e5f6a',
      slug: 'acme-holding',
      name: 'ACME Holding',
      realm: 'acme-holding',
    },
    membership_id: '8d3c2b1a-4f5e-4a6b-9c0d-1e2f3a4b5c6d',
    role: 'org_owner',
    state: 'active',
    identity_id: '3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d',
    joined_at: '2026-06-01T09:00:00Z',
  },
  {
    organisation: {
      id: '9e4d3c2b-1a5f-4b6c-8d0e-2f3a4b5c6d7e',
      slug: 'acme-nord',
      name: 'ACME Nord',
      realm: 'acme-nord',
    },
    membership_id: '0f5e4d3c-2b1a-4c6d-9e0f-3a4b5c6d7e8f',
    role: 'org_member',
    state: 'active',
    identity_id: '3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d',
    joined_at: '2027-01-15T09:00:00Z',
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
