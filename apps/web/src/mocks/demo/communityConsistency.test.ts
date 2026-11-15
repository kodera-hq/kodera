import { resolveCurrentIdentity, isCurrentIdentityMfaEnrolled } from '../../app/currentIdentity'
import { createLocalWorkspaceStore } from './workspaceStore'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { setupServer } from 'msw/node'
import '../../i18n'
import { handlers } from '../overlays/demo.groupe-vercelli'
import { COMMUNITY_ORGANISATION_ID, COMMUNITY_TENANT_ID, communityWorkspace } from './community'
import { localClaim } from '../../features/onboarding/instantClaimClient'
import {
  localFixtureIds,
  localMe,
  withLocalMemberships,
  registerLocalWorkspace,
  resetLocalWorkspaces,
  restoreLocalWorkspaces,
} from './localWorkspaces'
import { isDemoActive, registerInteractiveDemo } from '../../app/interactiveDemo'

const server = setupServer(...handlers)
const base = 'https://core.test/api/v1'
const token = (slug: string) => ({
  Authorization: `Bearer test.${btoa(JSON.stringify({ sub: `mock-user-${slug}` }))}.mock`,
})
const get = async (path: string, slug = 'community') =>
  (await fetch(base + path, { headers: token(slug) })).json()
beforeAll(() => {
  vi.stubEnv('VITE_KEYCLOAK_URL', 'https://id.example.test')
  server.listen({ onUnhandledFrame: 'error' })
})
afterAll(() => {
  server.close()
  vi.unstubAllEnvs()
})
afterEach(() => {
  resetLocalWorkspaces()
  sessionStorage.clear()
  registerInteractiveDemo(undefined)
})

it('keeps every community console identity, member count, domain and status consistent', async () => {
  const org = `/organisations/${COMMUNITY_ORGANISATION_ID}`
  const roster = await get(`${org}/memberships`)
  expect(roster.data).toHaveLength(6)
  expect(await get(`${org}/memberships/count`)).toMatchObject({ count: roster.data.length })
  const responses = await Promise.all([
    get(org),
    get(`${org}/bootstrap`),
    get(`${org}/status-summary`),
    get(`${org}/tenants`),
    get(`/tenants/${COMMUNITY_TENANT_ID}/status`),
    get(`/tenants/${COMMUNITY_TENANT_ID}/domains`),
    get('/status/components'),
    get('/status/incidents'),
    get('/support/help-context'),
  ])
  expect(JSON.stringify(responses)).not.toMatch(/Vercelli|vercelli|Inès|groupe-vercelli/)
  expect(await get(`/tenants/${COMMUNITY_TENANT_ID}/domains`)).toMatchObject({
    data: [{ fqdn: 'community.kodera.io' }],
  })
  expect((await get(`${org}/entitlements`)).data).toContainEqual(
    expect.objectContaining({ code: 'federation', enabled: true })
  )
  expect(await get(`${org}/subscriptions`)).toMatchObject({ data: [] })
  expect(await get(`${org}/invoices`)).toMatchObject({ data: [] })
})

it('scopes enrolment and import responses to community', async () => {
  const org = `/organisations/${COMMUNITY_ORGANISATION_ID}`
  for (const endpoint of ['enrolment-tokens', 'member-imports']) {
    const response = await fetch(base + `${org}/${endpoint}`, {
      method: 'POST',
      headers: { ...token('community'), 'Idempotency-Key': 'community-test' },
      body: '{}',
    })
    const body = await response.json()
    expect(body.organisation_id).toBe(COMMUNITY_ORGANISATION_ID)
    expect(JSON.stringify(body)).not.toMatch(/VERCELLI|Vercelli|vercelli|Lucia|Ferraro/)
  }
})

it('registers, restores and resolves newly created workspaces without crossing data', async () => {
  const claim = localClaim({
    organizationName: 'Review Team',
    slug: 'review-team',
    hostingMode: 'self-host',
    templateId: 'tech-studio',
    themeId: 'ardoise',
    soundPackId: 'silence',
    enabledConnectors: [],
  })
  registerLocalWorkspace(claim)
  expect(isDemoActive('review-team')).toBe(true)
  resetLocalWorkspaces()
  restoreLocalWorkspaces()
  expect(isDemoActive('review-team')).toBe(true)
  const me = await get('/me', 'review-team')
  const membership = me.organisations.find(
    (entry: { organisation: { slug: string } }) => entry.organisation.slug === 'review-team'
  )
  expect(membership.organisation.name).toBe('Review Team')
  const identity = me.identities.find((entry: { realm: string }) => entry.realm === 'review-team')
  expect(identity.id).toBe(membership.identity_id)
  const ids = localFixtureIds(claim)
  const org = `/organisations/${ids.organisation}`
  expect(await get(`${org}/memberships/count`, 'review-team')).toMatchObject({ count: 1 })
  expect(await get(`${org}/bootstrap`, 'review-team')).toMatchObject({
    organisation_id: ids.organisation,
    slug: 'review-team',
  })
  const status = await get(`${org}/status-summary`, 'review-team')
  expect(status).toMatchObject({
    organisation_id: ids.organisation,
    tenant_id: ids.tenant,
  })
  const tenant = await get(`/tenants/${ids.tenant}/status`, 'review-team')
  expect(tenant).toMatchObject({ tenant_id: ids.tenant, domains: [] })
  expect(JSON.stringify([status, tenant])).not.toMatch(/Vercelli|vercelli|groupe-vercelli/)
})

it('refuses invalid, reserved and duplicate local workspaces without replacing existing data', () => {
  const claim = localClaim({
    organizationName: 'Review Team',
    slug: 'review-team',
    hostingMode: 'self-host',
    templateId: 'tech-studio',
    themeId: 'ardoise',
    soundPackId: 'silence',
    enabledConnectors: [],
  })
  for (const slug of [
    '',
    'ab',
    'community',
    'vercelli',
    'admin',
    'master',
    'synth-test',
    'this-workspace-name-is-too-long',
  ]) {
    expect(() => registerLocalWorkspace({ ...claim, payload: { ...claim.payload, slug } })).toThrow(
      'invalid-workspace'
    )
  }
  registerLocalWorkspace(claim)
  expect(() =>
    registerLocalWorkspace({
      ...claim,
      payload: { ...claim.payload, organizationName: 'Replacement' },
    })
  ).toThrow('workspace-already-exists')
})

it('retains local messages, reactions, threads, invites and created channels through a full page restart', async () => {
  const workspace = communityWorkspace()
  const store = createLocalWorkspaceStore(workspace, 'community', true)
  const channel = {
    ...workspace.categories[0]!.channels[0]!,
    id: 'custom-room',
    name: 'review-room',
  }
  store.addChannel(channel)
  const room = store.getSnapshot().channels.get(channel.id)!
  if (room.state !== 'resolved') throw new Error('Room not resolved')
  await store.send(room.roomId, 'Retained message')
  const message = store.getTimeline(room.roomId)[0]!
  await store.toggleReaction!(room.roomId, message.eventId!, '✅')
  await store.send(room.roomId, 'Retained thread', { threadRootId: message.eventId! })
  await store.inviteToRoom!(room.roomId, '@visitor:example.test')
  const restored = createLocalWorkspaceStore(workspace, 'community', true)
  expect(restored.getSnapshot().channels.get(channel.id)).toEqual(room)
  expect(restored.getTimeline(room.roomId)[0]).toMatchObject({
    body: 'Retained message',
    reactions: [{ key: '✅', mine: true }],
  })
  expect(restored.getThread!(room.roomId, message.eventId!)[0]?.body).toBe('Retained thread')
  expect(restored.getMembers!(room.roomId)).toContainEqual({ userId: '@visitor:example.test' })
  const fresh = createLocalWorkspaceStore(workspace, 'community')
  expect(fresh.getSnapshot().channels.has(channel.id)).toBe(false)
})

it('persists community membership mutations and protects the signed-in owner', async () => {
  const org = `/organisations/${COMMUNITY_ORGANISATION_ID}`
  const rows = (await get(`${org}/memberships`)).data
  const change = async (id: string, method: 'PATCH' | 'DELETE', body?: unknown, etag?: string) =>
    fetch(base + `${org}/memberships/${id}`, {
      method,
      headers: { ...token('community'), ...(etag ? { 'If-Match': etag } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const detail = await fetch(base + `${org}/memberships/${rows[1].id}`, {
    headers: token('community'),
  })
  const updated = await change(
    rows[1].id,
    'PATCH',
    { role: 'org_admin', state: 'suspended' },
    detail.headers.get('ETag')!
  )
  expect(updated.status).toBe(200)
  expect((await get(`${org}/memberships`)).data[1]).toMatchObject({
    role: 'org_admin',
    state: 'suspended',
  })
  expect(
    (await change(rows[1].id, 'PATCH', { role: 'org_member' }, detail.headers.get('ETag')!)).status
  ).toBe(412)
  expect((await change(rows[0].id, 'PATCH', { role: 'org_member' })).status).toBe(403)
  expect((await change(rows[0].id, 'DELETE')).status).toBe(403)
  expect((await change(rows[2].id, 'DELETE')).status).toBe(200)
  expect(await get(`${org}/memberships/count`)).toMatchObject({ count: 5 })
  expect(
    (await get(`${org}/memberships`)).data.some((item: { id: string }) => item.id === rows[2].id)
  ).toBe(false)
  expect((await get('/organisations/vercelli/memberships', 'vercelli')).data).toHaveLength(138)
})

it('persists invitations, deduplicates requests and scopes resend/revoke to the active workspace', async () => {
  const org = `/organisations/${COMMUNITY_ORGANISATION_ID}`
  const body = { invitations: [{ email: 'visitor@example.test', role: 'org_member' }] }
  const invite = async () =>
    fetch(base + `${org}/invitations`, {
      method: 'POST',
      headers: { ...token('community'), 'Idempotency-Key': 'invite-1' },
      body: JSON.stringify(body),
    })
  const created = await (await invite()).json()
  expect(created.created).toBe(1)
  const invitation = created.results[0].invitation
  expect(invitation.organisation_id).toBe(COMMUNITY_ORGANISATION_ID)
  expect((await get(`${org}/invitations`)).data).toHaveLength(1)
  expect((await (await invite()).json()).created).toBe(1)
  expect((await get(`${org}/invitations`)).data).toHaveLength(1)
  const claim = localClaim({
    organizationName: 'Review Team',
    slug: 'review-team',
    hostingMode: 'self-host',
    templateId: 'tech-studio',
    themeId: 'ardoise',
    soundPackId: 'silence',
    enabledConnectors: [],
  })
  registerLocalWorkspace(claim)
  expect(
    (await get(`/organisations/${claim.workspaceId}/invitations`, 'review-team')).data
  ).toEqual([])
  const resend = await fetch(base + `/invitations/${invitation.id}/actions/resend`, {
    method: 'POST',
    headers: { ...token('community'), 'Idempotency-Key': 'resend-1' },
  })
  expect((await resend.json()).sent_count).toBe(2)
  expect(
    (
      await fetch(base + `/invitations/${invitation.id}`, {
        method: 'DELETE',
        headers: token('review-team'),
      })
    ).status
  ).toBe(404)
  expect(
    (
      await fetch(base + `/invitations/${invitation.id}`, {
        method: 'DELETE',
        headers: token('community'),
      })
    ).status
  ).toBe(204)
  expect((await get(`${org}/invitations`)).data).toEqual([])
})

it('keeps UUID fixture identifiers across reload and satisfies the real current-identity MFA guard', async () => {
  const claim = localClaim({
    organizationName: 'Identity Team',
    slug: 'identity-team',
    hostingMode: 'self-host',
    templateId: 'tech-studio',
    themeId: 'ardoise',
    soundPackId: 'silence',
    enabledConnectors: [],
  })
  registerLocalWorkspace(claim)
  const before = localFixtureIds(claim)
  const me = withLocalMemberships(localMe(claim, new Date()), new Date())
  const active = {
    issuer: 'https://id.example.test/realms/identity-team',
    subject: 'mock-user-identity-team',
  }
  expect(resolveCurrentIdentity(me, active, 'identity-team')).toMatchObject({
    identity: { id: before.identity },
    membership: { membership_id: before.membership, organisation: { id: before.organisation } },
  })
  expect(isCurrentIdentityMfaEnrolled(me, active, 'identity-team')).toBe(true)
  resetLocalWorkspaces()
  restoreLocalWorkspaces()
  expect(localFixtureIds(claim)).toEqual(before)
  const refreshed = await get('/me', 'identity-team')
  expect(isCurrentIdentityMfaEnrolled(refreshed, active, 'identity-team')).toBe(true)
  const tenant = await get(`/organisations/${before.organisation}/tenants`, 'identity-team')
  expect(tenant.data[0]).toMatchObject({ id: before.tenant, organisation_id: before.organisation })
  const workspace = await get(`/organisations/${before.organisation}/workspace`, 'identity-team')
  expect(workspace).toMatchObject({ id: before.workspace, organisation_id: before.organisation })
})
