import { http, HttpResponse } from 'msw/http'
import { communityMe } from '../demo/community'

/** The interactive community demo with ordinary member authority for settings acceptance. */
export const handlers = [
  http.get('*/api/v1/me', () => {
    const me = communityMe(new Date())
    return HttpResponse.json({
      ...me,
      organisations: me.organisations.map((membership) => ({ ...membership, role: 'org_member' })),
    })
  }),
]
