// docs/specs/03-people.md §7 `people.invite-all-rejected`: every
// `results[].outcome` is `invalid_email`.

import { http, HttpResponse } from 'msw'
import type { components } from '@/api/schema'

type InvitationBatchResult = components['schemas']['InvitationBatchResult']

export const handlers = [
  http.post('*/api/v1/organisations/:organisation_id/invitations', async ({ request }) => {
    const body = (await request.json()) as { invitations?: { email: string }[] }
    const result: InvitationBatchResult = {
      created: 0,
      skipped: 0,
      failed: (body.invitations ?? []).length,
      results: (body.invitations ?? []).map((row) => ({
        email: row.email,
        outcome: 'invalid_email',
        invitation: null,
      })),
    }
    return HttpResponse.json(result, { status: 201 })
  }),
]
