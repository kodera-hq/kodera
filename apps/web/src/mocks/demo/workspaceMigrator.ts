// The demo's answers to workspace import dry-run/execution and live coexistence bridges
// (Core API 0.52.0), aligned with the Groupe Vercelli seed so no base-handler ACME fixture leaks.

import { http, HttpResponse, type HttpHandler } from 'msw/http'
import type { components } from '@/api/schema'
import * as seed from './seed'

type DryRunReport = components['schemas']['WorkspaceImportDryRunReport']
type ImportExecuteResponse = components['schemas']['WorkspaceImportResponse']
type BridgeRecord = components['schemas']['CoexistenceBridge']
type BridgeListResponse = components['schemas']['CoexistenceBridgeListResponse']
type ImportSource = components['schemas']['WorkspaceImportSource']
type BridgeSource = components['schemas']['CoexistenceBridgeSource']

export const WORKSPACE_MIGRATOR_DEMO_ROUTES: readonly string[] = [
  'POST /organisations/:organisation_id/workspace/imports/preview',
  'POST /organisations/:organisation_id/workspace/imports/execute',
  'GET /organisations/:organisation_id/workspace/coexistence/bridges',
  'POST /organisations/:organisation_id/workspace/coexistence/bridges',
  'DELETE /organisations/:organisation_id/workspace/coexistence/bridges/:bridge_id',
]

const DEMO_ARCHIVE_SHA256 = 'a4f1098c53e2b7714d809c66a1e35f92b407d18c6e2f9034a5b7c8d9e0f12345'
const DEMO_WORKSPACE_ID = '01950000-0000-7000-8000-000000000901'
const DEMO_CHANNEL_ID = '01950000-0000-7000-8000-000000000902'
const DEMO_BRIDGE_ID = '01950000-0000-7000-8000-000000000903'
const DEMO_BATCH_ID = '01950000-0000-7000-8000-000000000904'

function parseImportSource(value: unknown): ImportSource {
  return value === 'discord' || value === 'notion' ? value : 'slack'
}

function parseBridgeSource(value: unknown): BridgeSource {
  return value === 'discord' ? 'discord' : 'slack'
}

export function workspaceMigratorDemoHandlers(
  base: string,
  headers: () => Record<string, string>
): HttpHandler[] {
  const workspace = `${base}/organisations/:organisation_id/workspace`

  return [
    http.post(`${workspace}/imports/preview`, async ({ request }) => {
      const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const source = parseImportSource(raw['source'])
      const owner = seed.memberships(new Date())[0]
      const body = {
        source,
        archive_sha256: DEMO_ARCHIVE_SHA256,
        dry_run: true,
        counts: {
          channels_total: source === 'notion' ? 0 : 3,
          channels_existing: 1,
          channels_to_create: source === 'notion' ? 0 : 2,
          messages_total: source === 'notion' ? 0 : 24,
          thread_replies_total: source === 'notion' ? 0 : 6,
          docs_pages_total: source === 'notion' ? 8 : 0,
          collections_total: source === 'notion' ? 1 : 0,
          collection_rows_total: source === 'notion' ? 5 : 0,
          members_matched: 1,
          members_unmatched: 1,
          already_imported_reused: 0,
          omitted_assets: 0,
        },
        member_mappings: [
          {
            external_id: 'U01VERCELLI',
            display_name: owner?.display_name ?? 'Marco Vercelli',
            matched_membership_id: owner?.id ?? null,
            local_role_preserved: true,
          },
        ],
        warnings: ['external_admin_privilege_ignored'],
      } satisfies DryRunReport
      return HttpResponse.json(body, { status: 200, headers: headers() })
    }),

    http.post(`${workspace}/imports/execute`, async ({ request }) => {
      const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const source = parseImportSource(raw['source'])
      const owner = seed.memberships(new Date())[0]
      const hasChannelMap =
        typeof raw['channelMap'] === 'object' &&
        raw['channelMap'] !== null &&
        Object.keys(raw['channelMap'] as Record<string, unknown>).length > 0
      const body = {
        batch_id: DEMO_BATCH_ID,
        source,
        state: hasChannelMap ? 'partial' : 'complete',
        dry_run: false,
        archive_sha256: DEMO_ARCHIVE_SHA256,
        complete: !hasChannelMap,
        imported: source === 'notion' ? 8 : 0,
        reused: 0,
        remaining: 0,
        omitted_assets: 0,
        queued_messages: hasChannelMap ? 24 : 0,
        replayed_messages: 0,
        reused_messages: 0,
        member_mappings: [
          {
            external_id: 'U01VERCELLI',
            display_name: owner?.display_name ?? 'Marco Vercelli',
            matched_membership_id: owner?.id ?? null,
            local_role_preserved: true,
          },
        ],
        warnings: ['external_admin_privilege_ignored'],
      } satisfies ImportExecuteResponse
      return HttpResponse.json(body, { status: 200, headers: headers() })
    }),

    http.get(`${workspace}/coexistence/bridges`, () => {
      const body = { bridges: [] } satisfies BridgeListResponse
      return HttpResponse.json(body, { status: 200, headers: headers() })
    }),

    http.post(`${workspace}/coexistence/bridges`, async ({ request }) => {
      const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const stamp = new Date().toISOString()
      const owner = seed.memberships(new Date())[0]
      const created = {
        id: DEMO_BRIDGE_ID,
        workspaceId: DEMO_WORKSPACE_ID,
        channelId: typeof raw['channelId'] === 'string' ? raw['channelId'] : DEMO_CHANNEL_ID,
        creatorMembershipId: owner?.id ?? DEMO_WORKSPACE_ID,
        source: parseBridgeSource(raw['source']),
        externalWorkspaceId:
          typeof raw['externalWorkspaceId'] === 'string'
            ? raw['externalWorkspaceId']
            : 'T01VERCELLI',
        externalChannelId:
          typeof raw['externalChannelId'] === 'string' ? raw['externalChannelId'] : 'C01DIRECTION',
        outboundEndpoint:
          typeof raw['outboundEndpoint'] === 'string'
            ? raw['outboundEndpoint']
            : 'https://hooks.vercelli.example/coexistence',
        active: true,
        revokedAt: null,
        createdAt: stamp,
        updatedAt: stamp,
      } satisfies BridgeRecord
      return HttpResponse.json(created, { status: 201, headers: headers() })
    }),

    http.delete(`${workspace}/coexistence/bridges/:bridge_id`, () =>
      new HttpResponse(null, { status: 204, headers: headers() })
    ),
  ]
}
