// The demo's answers to workspace governance (Core API 0.50.0): the server profile, roles,
// sub-teams and tags, member role assignments, channel overrides, bans and the workspace audit
// log. A demo stores nothing: every list is empty, the profile is blank, and every write is
// refused (`forbidden`, a status the contract declares), so the administration screens show their
// refusal, never a fiction.

import { http, HttpResponse, type HttpHandler } from 'msw/http'
import type { components } from '@/api/schema'
import { problem } from '../problem'

export const GOVERNANCE_DEMO_ROUTES: readonly string[] = [
  'GET /organisations/:organisation_id/workspace/profile',
  'PATCH /organisations/:organisation_id/workspace/profile',
  'GET /organisations/:organisation_id/workspace/roles',
  'POST /organisations/:organisation_id/workspace/roles',
  'PATCH /organisations/:organisation_id/workspace/roles/:role_id',
  'DELETE /organisations/:organisation_id/workspace/roles/:role_id',
  'PUT /organisations/:organisation_id/workspace/members/:membership_id/roles',
  'GET /organisations/:organisation_id/workspace/channels/:channel_id/overrides',
  'PUT /organisations/:organisation_id/workspace/channels/:channel_id/overrides',
  'GET /organisations/:organisation_id/workspace/bans',
  'GET /organisations/:organisation_id/workspace/audit-logs',
  'GET /organisations/:organisation_id/workspace/channel-governance',
  'POST /organisations/:organisation_id/workspace/partner-agreements',
  'POST /organisations/:organisation_id/workspace/partner-agreements/:agreement_id/actions/transition',
  'POST /organisations/:organisation_id/workspace/guest-grants',
  'POST /organisations/:organisation_id/workspace/guest-grants/:grant_id/actions/revoke',
]

const BLANK_PROFILE = {
  description: '',
  banner_preset: '',
  icon_mxc: '',
  traits: [],
  arrivals_channel_id: null,
  rules_channel_id: null,
  moderator_updates_channel_id: null,
  security_alerts_channel_id: null,
  invites_paused: false,
}

export function governanceDemoHandlers(
  base: string,
  headers: () => Record<string, string>
): HttpHandler[] {
  const tagged = () => ({ ...headers(), ETag: '"demo-governance"' })
  const page = () =>
    HttpResponse.json({ data: [], next_cursor: null, has_more: false }, { headers: headers() })
  const refused = () => problem('https://kodera.io/problems/forbidden')
  const workspace = `${base}/organisations/:organisation_id/workspace`
  return [
    http.get(`${workspace}/profile`, () => HttpResponse.json(BLANK_PROFILE, { headers: tagged() })),
    http.patch(`${workspace}/profile`, refused),
    http.get(`${workspace}/roles`, () =>
      HttpResponse.json({ data: [], assignments: [] }, { headers: tagged() })
    ),
    http.post(`${workspace}/roles`, refused),
    http.patch(`${workspace}/roles/:role_id`, refused),
    http.delete(`${workspace}/roles/:role_id`, refused),
    http.put(`${workspace}/members/:membership_id/roles`, refused),
    http.get(`${workspace}/channels/:channel_id/overrides`, () =>
      HttpResponse.json({ data: [] }, { headers: headers() })
    ),
    http.put(`${workspace}/channels/:channel_id/overrides`, refused),
    http.get(`${workspace}/bans`, page),
    http.get(`${workspace}/audit-logs`, page),
    http.get(`${workspace}/channel-governance`, () =>
      HttpResponse.json(
        {
          enforcementReady: false,
          agreements: [],
          guests: [],
        } satisfies components['schemas']['ChannelGovernance'],
        { headers: headers() }
      )
    ),
    http.post(`${workspace}/partner-agreements`, refused),
    http.post(`${workspace}/partner-agreements/:agreement_id/actions/transition`, refused),
    http.post(`${workspace}/guest-grants`, refused),
    http.post(`${workspace}/guest-grants/:grant_id/actions/revoke`, refused),
  ]
}
