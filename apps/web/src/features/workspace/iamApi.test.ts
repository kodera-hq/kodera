import { http, HttpResponse } from 'msw/http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { ORG_ID, signInSynthetic } from '../people/test-support'
import {
  createInvite,
  createWorkspaceRole,
  getChannelOverrides,
  getWorkspaceProfile,
  heldCapabilities,
  IamUnsupported,
  listInvites,
  listWorkspaceAuditLogs,
  listWorkspaceBans,
  listWorkspaceRoles,
  overrideState,
  roleSlug,
  setChannelOverrides,
  setMemberRoles,
  updateWorkspaceProfile,
  updateWorkspaceRole,
  withOverride,
  type WorkspaceRoles,
} from './iamApi'
import { ROLE_SWATCHES } from './admin/WorkspaceProfilePanel'

const SWATCH = ROLE_SWATCHES[1] ?? ''

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
beforeEach(signInSynthetic)

const BASE = '*/api/v1/organisations/:org/workspace'
const ROLE = {
  id: '00000000-0000-7000-8000-000000000011',
  workspace_id: '00000000-0000-7000-8000-000000000012',
  organisation_id: ORG_ID,
  name: 'Builders',
  slug: 'builders',
  kind: 'role',
  color: SWATCH,
  icon: 'wrench',
  position: 10,
  is_hoisted: true,
  is_mentionable: true,
  permissions: ['channel.view', 'message.post', 'not.a.capability'],
  member_count: 1,
  etag: '"e1"',
  created_at: '2026-01-02T12:00:00Z',
  updated_at: '2026-01-02T12:00:00Z',
}

describe('workspace roles', () => {
  it('reads roles ranked by position and their assignments', async () => {
    server.use(
      http.get(`${BASE}/roles`, () =>
        HttpResponse.json({
          data: [{ ...ROLE, id: 'low', position: 1, name: 'Low' }, ROLE],
          assignments: [{ membership_id: 'm1', role_ids: [ROLE.id] }],
        })
      )
    )
    const roles = await listWorkspaceRoles(ORG_ID)
    expect(roles.roles.map((role) => role.name)).toEqual(['Builders', 'Low'])
    // An unknown capability from a newer server is dropped, never shown as a raw key.
    expect(roles.roles[0]?.permissions).toEqual(['channel.view', 'message.post'])
    expect(roles.assignments).toEqual([{ membership_id: 'm1', role_ids: [ROLE.id] }])
  })

  it('creates with an idempotency key and updates under the role’s own tag', async () => {
    const seen: { key: string | null; ifMatch: string | null; body: unknown }[] = []
    server.use(
      http.post(`${BASE}/roles`, async ({ request }) => {
        seen.push({
          key: request.headers.get('Idempotency-Key'),
          ifMatch: null,
          body: await request.json(),
        })
        return HttpResponse.json(ROLE, { status: 201 })
      }),
      http.patch(`${BASE}/roles/:role`, async ({ request, params }) => {
        expect(params['role']).toBe(ROLE.id)
        seen.push({
          key: null,
          ifMatch: request.headers.get('If-Match'),
          body: await request.json(),
        })
        return HttpResponse.json({ ...ROLE, position: 12 })
      })
    )
    await createWorkspaceRole(ORG_ID, {
      name: 'Builders',
      slug: 'builders',
      kind: 'subteam',
      color: SWATCH,
      icon: '',
      position: 3,
      is_hoisted: false,
      is_mentionable: true,
      permissions: ['channel.view'],
    })
    const updated = await updateWorkspaceRole(
      ORG_ID,
      { id: ROLE.id, etag: '"e1"' },
      { position: 12 }
    )
    expect(updated.position).toBe(12)
    expect(seen[0]?.key).toMatch(/^[0-9a-f-]{36}$/u)
    expect(seen[0]?.body).toMatchObject({ kind: 'subteam', slug: 'builders' })
    expect(seen[1]).toEqual({ key: null, ifMatch: '"e1"', body: { position: 12 } })
  })

  it('replaces a member’s roles with a deduplicated set', async () => {
    let body: unknown
    server.use(
      http.put(`${BASE}/members/:membership/roles`, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ membership_id: 'm1', role_ids: ['a', 'b'] })
      })
    )
    await expect(setMemberRoles(ORG_ID, 'm1', ['a', 'b', 'a'])).resolves.toEqual({
      membership_id: 'm1',
      role_ids: ['a', 'b'],
    })
    expect(body).toEqual({ role_ids: ['a', 'b'] })
  })

  it('reports an older server as unsupported rather than as an error', async () => {
    server.use(http.get(`${BASE}/roles`, () => new HttpResponse('Not Found', { status: 404 })))
    await expect(listWorkspaceRoles(ORG_ID)).rejects.toBeInstanceOf(IamUnsupported)
  })

  it('derives a contract-safe slug from a French name', () => {
    expect(roleSlug('Équipe Réseau & Sécurité')).toBe('equipe-reseau-securite')
    expect(roleSlug('42 Builders')).toBe('builders')
    expect(roleSlug('Ops', ['ops', 'ops-2'])).toBe('ops-3')
    expect(roleSlug('!!!')).toBe('role')
  })

  it('computes a delegate’s capabilities and ceiling from their assigned roles', () => {
    const roles: WorkspaceRoles = {
      roles: [
        { ...ROLE, kind: 'role', permissions: ['manage_roles'], position: 7 } as never,
        {
          ...ROLE,
          id: 'other',
          kind: 'tag',
          permissions: ['view_audit_log'],
          position: 20,
        } as never,
      ],
      assignments: [{ membership_id: 'me', role_ids: [ROLE.id] }],
    }
    const held = heldCapabilities(roles, 'me')
    expect([...held.capabilities]).toEqual(['manage_roles'])
    expect(held.ceiling).toBe(7)
    expect(heldCapabilities(roles, 'nobody').ceiling).toBe(-1)
  })
})

describe('workspace profile', () => {
  it('reads with its tag and saves under If-Match', async () => {
    let ifMatch: string | null = null
    const profile = {
      display_name: '',
      logo_url: '',
      default_ui_mode: 'pro',
      default_channel_id: null,
      allow_member_channel_creation: false,
      allow_member_invites: true,
      allow_link_previews: true,
      description: 'Product',
      banner_preset: 'cobalt',
      icon_mxc: '',
      traits: [{ icon: '💻', label: 'Tech' }],
      arrivals_channel_id: null,
      rules_channel_id: null,
      moderator_updates_channel_id: null,
      security_alerts_channel_id: null,
      invites_paused: false,
    }
    server.use(
      http.get(`${BASE}/profile`, () => HttpResponse.json(profile, { headers: { ETag: '"p1"' } })),
      http.patch(`${BASE}/profile`, async ({ request }) => {
        ifMatch = request.headers.get('If-Match')
        return HttpResponse.json(
          { ...profile, ...((await request.json()) as object) },
          { headers: { ETag: '"p2"' } }
        )
      })
    )
    const read = await getWorkspaceProfile(ORG_ID)
    expect(read).toEqual({ value: profile, etag: '"p1"' })
    const saved = await updateWorkspaceProfile(ORG_ID, { invites_paused: true }, read.etag)
    expect(ifMatch).toBe('"p1"')
    expect(saved).toEqual({ value: { ...profile, invites_paused: true }, etag: '"p2"' })
  })
})

describe('channel overrides', () => {
  it('keeps allow and deny disjoint and drops empty rows', () => {
    let rows = withOverride([], 'r1', 'message.post', 'deny')
    expect(overrideState(rows, 'r1', 'message.post')).toBe('deny')
    rows = withOverride(rows, 'r1', 'message.post', 'allow')
    expect(rows).toEqual([{ role_id: 'r1', allow: ['message.post'], deny: [] }])
    rows = withOverride(rows, 'r1', 'message.post', 'inherit')
    expect(rows).toEqual([])
    expect(overrideState(rows, 'r1', 'message.post')).toBe('inherit')
  })

  it('reads and replaces a channel’s overrides', async () => {
    let body: unknown
    server.use(
      http.get(`${BASE}/channels/:channel/overrides`, () =>
        HttpResponse.json({ data: [{ role_id: 'r1', allow: ['channel.view'], deny: [] }] })
      ),
      http.put(`${BASE}/channels/:channel/overrides`, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ data: [] })
      })
    )
    await expect(getChannelOverrides(ORG_ID, 'c1')).resolves.toEqual([
      { role_id: 'r1', allow: ['channel.view'], deny: [] },
    ])
    await setChannelOverrides(ORG_ID, 'c1', [])
    expect(body).toEqual({ overrides: [] })
  })
})

describe('bans, audit and invites', () => {
  it('passes the ban search and the audit filters as query parameters', async () => {
    const urls: URL[] = []
    server.use(
      http.get(`${BASE}/bans`, ({ request }) => {
        urls.push(new URL(request.url))
        return HttpResponse.json({ data: [], has_more: false, next_cursor: null })
      }),
      http.get(`${BASE}/audit-logs`, ({ request }) => {
        urls.push(new URL(request.url))
        return HttpResponse.json({
          data: [
            {
              id: 'e1',
              occurred_at: '2026-01-02T12:00:00Z',
              actor_id: null,
              actor_type: 'system',
              action: 'workspace.role.created',
              target_urn: 'urn:kodera:workspace_role:x',
              request_id: null,
            },
          ],
          has_more: true,
          next_cursor: 'next',
        })
      })
    )
    await listWorkspaceBans(ORG_ID, { q: '  camille ' })
    const audit = await listWorkspaceAuditLogs(ORG_ID, { action: 'Not Valid!', actorId: 'a1' })
    expect(urls[0]?.searchParams.get('q')).toBe('camille')
    expect(urls[1]?.searchParams.get('actor_id')).toBe('a1')
    // An action outside the contract's pattern is never sent.
    expect(urls[1]?.searchParams.has('action')).toBe(false)
    expect(audit).toMatchObject({ hasMore: true, nextCursor: 'next' })
  })

  it('reads the host and auto-roles of each link and sends auto-roles only when chosen', async () => {
    const bodies: unknown[] = []
    server.use(
      http.get(`${BASE}/invite-links`, () =>
        HttpResponse.json({
          data: [
            {
              id: 'l1',
              expiresAt: '2026-01-09T12:00:00Z',
              maxUses: 10,
              usesCount: 3,
              revokedAt: null,
              channelId: 'c1',
              role: 'org_member',
              createdBy: { membershipId: 'm1', displayName: 'Camille' },
              auto_role_ids: ['r1'],
            },
          ],
          has_more: false,
          next_cursor: null,
        })
      ),
      http.post(`${BASE}/invite-links`, async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json({ link: {}, code: 'secret' }, { status: 201 })
      })
    )
    await expect(listInvites(ORG_ID)).resolves.toEqual([
      expect.objectContaining({ host: 'Camille', autoRoleIds: ['r1'], usesCount: 3 }),
    ])
    await createInvite(ORG_ID, { expiresAt: 'x', maxUses: 5, role: 'org_member', autoRoleIds: [] })
    await createInvite(ORG_ID, {
      expiresAt: 'x',
      maxUses: 5,
      role: 'org_member',
      channelId: 'c1',
      autoRoleIds: ['r1'],
    })
    expect(bodies[0]).not.toHaveProperty('auto_role_ids')
    expect(bodies[1]).toMatchObject({ channelId: 'c1', auto_role_ids: ['r1'] })
  })
})
