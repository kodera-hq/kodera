import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest'
import { setupServer } from 'msw/node'
import '../../i18n'
import { handlers } from '../overlays/demo.groupe-vercelli'
import {
  registerInteractiveDemos,
  registerInteractiveDemo,
  createDemoWorkspaceStore,
  isDemoActive,
  demoLandingFor,
} from '../../app/interactiveDemo'
import { createLocalWorkspaceStore } from './workspaceStore'
import { readyWorkspace } from '../fixtures/workspaceFixtures'
import {
  COMMUNITY_CHANNEL_NAMES,
  COMMUNITY_ORGANISATION_ID,
  COMMUNITY_TENANT_ID,
  communityDemo,
  communityWorkspace,
} from './community'

const server = setupServer(...handlers)
beforeAll(() => {
  vi.stubEnv('VITE_KEYCLOAK_URL', 'https://id.example.test')
  server.listen({ onUnhandledFrame: 'error' })
})
afterAll(() => {
  server.close()
  vi.unstubAllEnvs()
})
afterEach(() => registerInteractiveDemo(undefined))
const base = 'https://core.test/api/v1'
const get = async (path: string, headers = {}) => (await fetch(base + path, { headers })).json()

it('discovers community without replacing the existing vercelli identity', async () => {
  for (const slug of ['community', 'vercelli']) {
    const response = await fetch(base + '/auth/discover', {
      method: 'POST',
      body: JSON.stringify({ slug }),
    })
    expect(await response.json()).toMatchObject({ realm: slug, organisation: { slug } })
  }
  const ordinary = await get('/me')
  expect(ordinary.organisations[0].organisation.slug).toBe('vercelli')
  const token = `test.${btoa(JSON.stringify({ sub: 'mock-user-community' }))}.mock`
  const me = await get('/me', { Authorization: `Bearer ${token}` })
  expect(me.organisations[0].organisation).toMatchObject({
    id: COMMUNITY_ORGANISATION_ID,
    slug: 'community',
    name: 'Kodera Community',
  })
  expect(me.identities[0]).toMatchObject({ realm: 'community', subject: 'mock-user-community' })
  expect((await get('/me')).organisations[0].organisation.slug).toBe('vercelli')
})
it('serves the matching organisation, tenant and three exact categories and twelve ready community channels', async () => {
  expect(await get(`/organisations/${COMMUNITY_ORGANISATION_ID}`)).toMatchObject({
    slug: 'community',
  })
  const tenants = await get(`/organisations/${COMMUNITY_ORGANISATION_ID}/tenants`)
  expect(tenants.data[0]).toMatchObject({
    id: COMMUNITY_TENANT_ID,
    slug: 'community',
    organisation_id: COMMUNITY_ORGANISATION_ID,
  })
  const workspace = await get(`/organisations/${COMMUNITY_ORGANISATION_ID}/workspace`)
  expect(
    workspace.categories
      .flatMap((category: { channels: { name: string }[] }) => category.channels)
      .map((channel: { name: string }) => channel.name)
  ).toEqual(COMMUNITY_CHANNEL_NAMES)
  expect(workspace.categories.map((category: { name: string }) => category.name)).toEqual([
    'Community',
    'Core Kodera',
    'Design Partners',
  ])
  expect(
    workspace.categories.map((category: { channels: { name: string; kind: string }[] }) =>
      category.channels.map((channel) => [channel.name, channel.kind])
    )
  ).toEqual([
    [
      ['announcements', 'text'],
      ['developers-community', 'text'],
      ['support', 'text'],
      ['extensions', 'text'],
      ['self-hosting', 'text'],
      ['show-and-tell', 'text'],
      ['office-hours', 'audio'],
    ],
    [
      ['dev', 'text'],
      ['strategy', 'text'],
      ['ops-oncall', 'text'],
    ],
    [
      ['partner-onboarding', 'text'],
      ['partner-feedback', 'text'],
    ],
  ])
  expect(workspace.organisation_id).toBe(COMMUNITY_ORGANISATION_ID)
  expect(await get(`/organisations/${COMMUNITY_ORGANISATION_ID}/status-summary`)).toMatchObject({
    overall: 'operational',
    capacity: null,
  })
})
it('registers both local stores, preserving per-organisation isolation and normal landing', async () => {
  expect(createDemoWorkspaceStore('community', communityWorkspace())).toBeUndefined()
  registerInteractiveDemos([
    { slug: 'vercelli', createStore: createLocalWorkspaceStore },
    communityDemo,
  ])
  expect(isDemoActive('community')).toBe(true)
  expect(isDemoActive('vercelli')).toBe(true)
  expect(demoLandingFor('community')).toBe('/$org/workspace')
  expect(demoLandingFor('vercelli')).toBeUndefined()
  const community = createDemoWorkspaceStore('community', communityWorkspace())!
  const vercelli = createDemoWorkspaceStore('vercelli', readyWorkspace())!
  for (const room of community.getSnapshot().rooms.filter((room) => room.kind === 'text')) {
    expect(community.getTimeline(room.roomId)[0]?.body).toMatch(
      ['announcements', 'support'].includes(room.name) ? /simul/i : /Bienvenue/
    )
    expect(community.getTimeline(room.roomId)).toHaveLength(room.name === 'announcements' ? 3 : 2)
    if (room.name === 'partner-onboarding' || room.name === 'partner-feedback') {
      expect(community.getTimeline(room.roomId)[1]?.body).toMatch(/Element.*Matrix|Matrix.*Element/)
    }
  }
  const room = community.getSnapshot().rooms[0]!.roomId
  await community.send(room, 'Community message')
  expect(community.getTimeline(room).at(-1)?.body).toBe('Community message')
  expect(
    vercelli
      .getSnapshot()
      .rooms.every((room) =>
        vercelli.getTimeline(room.roomId).every((message) => message.body !== 'Community message')
      )
  ).toBe(true)
  expect(createDemoWorkspaceStore('other', communityWorkspace())).toBeUndefined()
})

it.each(['community', 'vercelli'] as const)(
  'keeps local Matrix invitations scoped to one room in %s',
  async (profile) => {
    const workspace = profile === 'community' ? communityWorkspace() : readyWorkspace()
    const store = createLocalWorkspaceStore(workspace, profile)
    const [room, other] = store.getSnapshot().rooms
    const listener = vi.fn()
    store.subscribe(listener)
    const previousMembers = store.getMembers!(other!.roomId)
    const previousTimeline = store.getTimeline(other!.roomId)
    const invitee = '@marie:example.org'
    for (const invalid of [
      'marie:example.org',
      '@marie',
      '@marie:',
      '@:example.org',
      '@marie:bad/path',
    ]) {
      await expect(store.inviteToRoom!(room!.roomId, invalid)).rejects.toThrow()
    }
    expect(listener).not.toHaveBeenCalled()
    await expect(store.inviteToRoom!('!unknown:demo.invalid', invitee)).rejects.toThrow()
    await store.inviteToRoom!(room!.roomId, invitee)
    await store.inviteToRoom!(room!.roomId, invitee)
    expect(
      store.getMembers!(room!.roomId).filter((member) => member.userId === invitee)
    ).toHaveLength(1)
    expect(store.getRoster!(room!.roomId)).toContainEqual({ userId: invitee })
    expect(store.getTimeline(room!.roomId).at(-1)?.body).toBe(
      `Invitation Matrix envoyée à ${invitee}`
    )
    expect(store.getMembers!(other!.roomId)).toBe(previousMembers)
    expect(store.getTimeline(other!.roomId)).toBe(previousTimeline)
    expect(listener).toHaveBeenCalled()
  }
)
