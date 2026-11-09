// docs/specs/03-people.md §7 `people.enrolment-qr-failed`: creation succeeds
// but `qr_svg` is absent; `fingerprint` and `enrolment_url` are present.
// The contract marks `qr_svg` required, so this is deliberately a response
// the console must survive rather than one the API promises to send.

import { http, HttpResponse } from 'msw'

export const handlers = [
  http.post('*/api/v1/organisations/:organisation_id/enrolment-tokens', async ({ request }) => {
    const body = (await request.json()) as { max_uses?: number; expires_at?: string }
    const secret = 'enr_7K4P92MB0000'
    return HttpResponse.json(
      {
        id: 'e1e1e1e1-0000-4000-8000-0000000000ff',
        organisation_id: '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f',
        role: 'org_member',
        state: 'active',
        max_uses: body.max_uses ?? 1,
        uses: 0,
        fingerprint: '4a1b2c3d4e5f6071',
        expires_at: body.expires_at ?? '2027-03-05T09:12:00Z',
        created_at: '2027-03-04T09:12:00Z',
        secret,
        enrolment_url: `https://app.kodera.io/enrol#${secret}`,
      },
      { status: 201 }
    )
  }),
]
