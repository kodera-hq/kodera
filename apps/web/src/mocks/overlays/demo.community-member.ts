import { http, HttpResponse } from 'msw'
import { communityMe, isCommunityDemoRequest } from '../demo/community'

/** The interactive community demo with ordinary member authority for settings acceptance. */
export const handlers = [
  http.get('*/api/v1/me', ({ request }) => {
    if (!isCommunityDemoRequest(request)) return
    const me = communityMe(new Date())
    return HttpResponse.json({
      ...me,
      organisations: me.organisations.map((membership) => ({ ...membership, role: 'org_member' })),
    })
  }),
]
