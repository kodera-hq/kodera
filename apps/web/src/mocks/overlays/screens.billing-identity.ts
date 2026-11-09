// Explicit synthetic cross-screen billing identity. Keep the production owner
// resolver intact while exercising the distinct role refusal at Order entry.
import { http, HttpResponse } from 'msw'
import { ownedOrderMe } from '../orderIdentity'

export const handlers = [
  http.get('*/api/v1/me', () => {
    const me = ownedOrderMe()
    return HttpResponse.json({
      ...me,
      organisations: me.organisations.map((entry) => ({ ...entry, role: 'org_billing' })),
    })
  }),
]
