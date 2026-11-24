// The demo's answers to workspace governance (Core API 0.50.0): the server profile, roles,
// sub-teams and tags, member role assignments, channel overrides, bans and the workspace audit
// log. A demo stores nothing: every list is empty, the profile is blank, and every write is
// refused (`forbidden`, a status the contract declares), so the administration screens show their
// refusal, never a fiction.

import { http, HttpResponse, type HttpHandler } from 'msw/http'
import type { components } from '@/api/schema'
import { ORGANISATION_ID } from './seed'
import { problem } from '../problem'

type WorkspaceSecurityPosture = components['schemas']['WorkspaceSecurityPosture']

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEMO_WORKSPACE_ID = '5eed0000-0000-4000-8000-000000000099'

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
  'GET /organisations/:organisation_id/workspace/security-posture',
  'POST /organisations/:organisation_id/workspace/security-posture/actions/remediate',
]

function demoSecurityPosture(rawOrganisationId: unknown): WorkspaceSecurityPosture {
  const organisationId =
    typeof rawOrganisationId === 'string' && UUID_PATTERN.test(rawOrganisationId)
      ? rawOrganisationId
      : ORGANISATION_ID
  return {
    organisation_id: organisationId,
    workspace_id: DEMO_WORKSPACE_ID,
    score: 70,
    max_score: 100,
    grade: 'C',
    passing_checks: 4,
    total_checks: 6,
    fixable_checks: 2,
    checks: [
      {
        id: 'invite_hygiene',
        status: 'pass',
        earned_points: 20,
        max_points: 20,
        remediation_action: 'cap_unbounded_invites',
        fix_available: false,
        affected_count: 0,
      },
      {
        id: 'sovereign_ai_boundary',
        status: 'pass',
        earned_points: 20,
        max_points: 20,
        remediation_action: 'enforce_eu_sovereign_ai',
        fix_available: false,
        affected_count: 0,
      },
      {
        id: 'security_alert_routing',
        status: 'warn',
        earned_points: 0,
        max_points: 15,
        remediation_action: 'provision_security_alerts_channel',
        fix_available: true,
        affected_count: 1,
      },
      {
        id: 'extension_secret_rotation',
        status: 'pass',
        earned_points: 15,
        max_points: 15,
        remediation_action: 'rotate_stale_extension_keys',
        fix_available: false,
        affected_count: 0,
      },
      {
        id: 'least_privilege_roles',
        status: 'pass',
        earned_points: 15,
        max_points: 15,
        remediation_action: 'strip_excess_role_permissions',
        fix_available: false,
        affected_count: 0,
      },
      {
        id: 'confidential_room_readiness',
        status: 'warn',
        earned_points: 0,
        max_points: 15,
        remediation_action: 'provision_confidential_channel',
        fix_available: true,
        affected_count: 1,
      },
    ],
  }
}

const BLANK_PROFILE = {
  display_name: '',
  logo_url: '',
  default_ui_mode: 'pro',
  default_channel_id: null,
  allow_member_channel_creation: false,
  allow_member_invites: true,
  allow_link_previews: true,
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
    http.get(`${workspace}/security-posture`, ({ params }) =>
      HttpResponse.json(demoSecurityPosture(params.organisation_id), { headers: headers() })
    ),
    http.post(`${workspace}/security-posture/actions/remediate`, refused),
  ]
}
