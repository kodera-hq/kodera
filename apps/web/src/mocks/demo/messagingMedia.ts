// The demo's answers to attachments, link previews, notifications, Web Push, invite links and
// moderation (Core API 0.43.0). A demo stores nothing and contacts no one: lists are empty, and
// every call that would store a file, fetch a page, subscribe a device, issue a code or moderate a
// person is refused (`forbidden`, a status the contract declares), so the screens show their
// refusal, never a fiction.

import { http, HttpResponse, type HttpHandler } from 'msw'
import { problem } from '../problem'

export const MESSAGING_DEMO_ROUTES: readonly string[] = [
  'POST /organisations/:organisation_id/workspace/attachments/uploads',
  'POST /organisations/:organisation_id/workspace/attachments/:attachment_id/complete',
  'GET /organisations/:organisation_id/workspace/attachments/:attachment_id',
  'POST /organisations/:organisation_id/workspace/unfurl',
  'GET /notifications',
  'POST /notifications/read',
  'GET /push/public-key',
  'DELETE /push/subscriptions/:device_id',
  'GET /organisations/:organisation_id/workspace/invite-links',
  'POST /organisations/:organisation_id/workspace/invite-links',
  'DELETE /organisations/:organisation_id/workspace/invite-links/:invite_link_id',
  'GET /organisations/:organisation_id/workspace/reports',
  'PATCH /organisations/:organisation_id/workspace/reports/:report_id',
  'POST /organisations/:organisation_id/workspace/moderation',
  'POST /workspace-invites/preview',
  'POST /workspace-invites/redeem',
]

export function messagingDemoHandlers(
  base: string,
  headers: () => Record<string, string>
): HttpHandler[] {
  const empty = () =>
    HttpResponse.json({ data: [], next_cursor: null, has_more: false }, { headers: headers() })
  const refused = () => problem('https://kodera.io/problems/forbidden')
  const missing = () => problem('https://kodera.io/problems/not-found')
  const done = () => new HttpResponse(null, { status: 204, headers: headers() })
  return [
    http.post(`${base}/organisations/:organisation_id/workspace/attachments/uploads`, refused),
    http.post(
      `${base}/organisations/:organisation_id/workspace/attachments/:attachment_id/complete`,
      refused
    ),
    http.get(
      `${base}/organisations/:organisation_id/workspace/attachments/:attachment_id`,
      missing
    ),
    http.post(`${base}/organisations/:organisation_id/workspace/unfurl`, missing),
    http.get(`${base}/notifications`, empty),
    http.post(`${base}/notifications/read`, done),
    http.get(`${base}/push/public-key`, refused),
    http.delete(`${base}/push/subscriptions/:device_id`, done),
    http.get(`${base}/organisations/:organisation_id/workspace/invite-links`, empty),
    http.post(`${base}/organisations/:organisation_id/workspace/invite-links`, refused),
    http.delete(
      `${base}/organisations/:organisation_id/workspace/invite-links/:invite_link_id`,
      missing
    ),
    http.get(`${base}/organisations/:organisation_id/workspace/reports`, empty),
    http.patch(`${base}/organisations/:organisation_id/workspace/reports/:report_id`, missing),
    http.post(`${base}/organisations/:organisation_id/workspace/moderation`, refused),
    http.post(`${base}/workspace-invites/preview`, missing),
    http.post(`${base}/workspace-invites/redeem`, missing),
  ]
}
