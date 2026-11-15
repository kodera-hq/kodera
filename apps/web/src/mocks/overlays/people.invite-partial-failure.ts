// docs/specs/03-people.md §7 `people.invite-partial-failure`: the first batch
// answers `created: 2`, `skipped: 1`, `failed: 1` — one `invalid_email`, one
// `already_member`, in submission order. Later batches (the retry) are
// answered by the stateful store underneath.

import { http, HttpResponse } from 'msw/http'
import type { components } from '@/api/schema'

type InvitationBatchResult = components['schemas']['InvitationBatchResult']

let answered = false

export const handlers = [
  http.post('*/api/v1/organisations/:organisation_id/invitations', async ({ request }) => {
    if (answered) return undefined
    answered = true
    const body = (await request.json()) as { invitations?: { email: string }[] }
    const outcomes = ['created', 'invalid_email', 'created', 'already_member'] as const
    const result: InvitationBatchResult = {
      created: 2,
      skipped: 1,
      failed: 1,
      results: (body.invitations ?? []).map((row, i) => ({
        email: row.email,
        outcome: outcomes[i] ?? 'created',
        invitation: null,
      })),
    }
    return HttpResponse.json(result, { status: 201 })
  }),
]
