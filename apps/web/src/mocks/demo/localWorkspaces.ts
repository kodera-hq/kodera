// Local workspaces remain in this browser session and never allocate infrastructure.
import type { components } from '../../api/schema'
import type { ClaimedWorkspace } from '../../features/onboarding/instantClaimClient'
import { registerInteractiveDemos } from '../../app/interactiveDemo'
import { readyWorkspace } from '../fixtures/workspaceFixtures'
import { communityDemo, communityOrganisation, communityTenant, communityMe } from './community'
import { createLocalWorkspaceStore } from './workspaceStore'
import * as seed from './seed'
import { keycloakUrl } from '../../config'
import { isOrganisationSlug } from '../../api/organisationSlug'
import { RESERVED_DOCS_TENANT_LABELS } from '../../features/docs/url'
import { TEMPLATE_CHANNELS, localClaim } from '../../features/onboarding/instantClaimClient'

type Organisation = components['schemas']['Organisation']
const STORAGE_KEY = 'kodera.demo.local-workspaces'
const claims = new Map<string, ClaimedWorkspace>()
interface LocalFixtureIds {
  organisation: string
  tenant: string
  workspace: string
  membership: string
  identity: string
  category: string
  channels: Record<string, string>
}
const fixtureIds = new Map<string, LocalFixtureIds>()
function newFixtureIds(claim: ClaimedWorkspace): LocalFixtureIds {
  return {
    organisation: crypto.randomUUID(),
    tenant: crypto.randomUUID(),
    workspace: crypto.randomUUID(),
    membership: crypto.randomUUID(),
    identity: crypto.randomUUID(),
    category: crypto.randomUUID(),
    channels: Object.fromEntries(
      claim.channels.map((channel) => [channel.id, crypto.randomUUID()])
    ),
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
function validFixtureIds(value: unknown, claim: ClaimedWorkspace): value is LocalFixtureIds {
  if (!value || typeof value !== 'object') return false
  const ids = value as LocalFixtureIds
  if (!ids.channels || typeof ids.channels !== 'object') return false
  const values = [
    ids.organisation,
    ids.tenant,
    ids.workspace,
    ids.membership,
    ids.identity,
    ids.category,
    ...claim.channels.map((channel) => ids.channels[channel.id]),
  ]
  return (
    values.every((value) => typeof value === 'string' && UUID.test(value)) &&
    new Set(values).size === values.length
  )
}
export function localFixtureIds(claim: ClaimedWorkspace): LocalFixtureIds {
  let ids = fixtureIds.get(claim.payload.slug)
  if (!ids) {
    ids = newFixtureIds(claim)
    fixtureIds.set(claim.payload.slug, ids)
  }
  return ids
}
function saveClaims() {
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        localWorkspaceClaims().map((claim) => ({ ...claim, fixtureIds: localFixtureIds(claim) }))
      )
    )
  } catch {
    /* Storage may be unavailable. */
  }
}

export function localWorkspaceClaims() {
  return [...claims.values()]
}
export function resetLocalWorkspaces() {
  claims.clear()
  fixtureIds.clear()
}
export function registerLocalWorkspace(claim: ClaimedWorkspace) {
  if (!validLocalClaim(claim)) throw new Error('invalid-workspace')
  if (claims.has(claim.payload.slug)) throw new Error('workspace-already-exists')
  claims.set(claim.payload.slug, claim)
  localFixtureIds(claim)
  saveClaims()
  activateLocalWorkspaces()
}
export function activateLocalWorkspaces() {
  registerInteractiveDemos([
    {
      slug: seed.DEMO_SLUG,
      createStore: (workspace: components['schemas']['Workspace']) =>
        createLocalWorkspaceStore(workspace, 'vercelli', true),
    },
    communityDemo,
    ...localWorkspaceClaims().map((claim) => ({
      slug: claim.payload.slug,
      landing: '/$org/workspace' as const,
      createStore: (workspace: components['schemas']['Workspace']) =>
        createLocalWorkspaceStore(workspace, 'community', true),
    })),
  ])
}
function validLocalClaim(value: unknown): value is ClaimedWorkspace {
  if (!value || typeof value !== 'object') return false
  const claim = value as ClaimedWorkspace
  return (
    claim.mode === 'local' &&
    typeof claim.workspaceId === 'string' &&
    !!claim.payload &&
    typeof claim.payload.slug === 'string' &&
    isOrganisationSlug(claim.payload.slug) &&
    !RESERVED_DOCS_TENANT_LABELS.has(claim.payload.slug) &&
    !claim.payload.slug.startsWith('synth-') &&
    !['community', seed.DEMO_SLUG].includes(claim.payload.slug) &&
    typeof claim.payload.organizationName === 'string' &&
    claim.payload.organizationName.trim().length > 0 &&
    Object.hasOwn(TEMPLATE_CHANNELS, claim.payload.templateId) &&
    Array.isArray(claim.channels) &&
    claim.channels.every(
      (channel) =>
        channel &&
        typeof channel.id === 'string' &&
        typeof channel.name === 'string' &&
        (channel.kind === 'text' || channel.kind === 'audio')
    )
  )
}
export function restoreLocalWorkspaces() {
  claims.clear()
  fixtureIds.clear()
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]')
    if (Array.isArray(saved))
      for (const value of saved) {
        if (validLocalClaim(value)) {
          const claim = localClaim(value.payload)
          claims.set(claim.payload.slug, claim)
          const storedIds = (value as ClaimedWorkspace & { fixtureIds?: unknown }).fixtureIds
          fixtureIds.set(
            claim.payload.slug,
            validFixtureIds(storedIds, claim) ? storedIds : newFixtureIds(claim)
          )
        }
      }
  } catch {
    /* Invalid session data must not block sign-in. */
  }
  saveClaims()
  activateLocalWorkspaces()
}
export function findLocalWorkspace(id: unknown) {
  return localWorkspaceClaims().find(
    (claim) =>
      claim.workspaceId === id ||
      claim.payload.slug === id ||
      Object.values(localFixtureIds(claim)).includes(String(id))
  )
}
export function localOrganisation(claim: ClaimedWorkspace, now: Date): Organisation {
  return {
    ...communityOrganisation(now),
    id: localFixtureIds(claim).organisation,
    name: claim.payload.organizationName,
    legal_name: claim.payload.organizationName,
    slug: claim.payload.slug,
    realm: claim.payload.slug,
  }
}
export function localTenant(claim: ClaimedWorkspace, now: Date) {
  return {
    ...communityTenant(now),
    id: localFixtureIds(claim).tenant,
    organisation_id: localFixtureIds(claim).organisation,
    name: claim.payload.organizationName,
    slug: claim.payload.slug,
    realm: claim.payload.slug,
    default_urls: {},
  }
}
export function localWorkspace(claim: ClaimedWorkspace): components['schemas']['Workspace'] {
  const base = readyWorkspace()
  const channel = base.categories[0]!.channels[0]!
  return {
    ...base,
    id: localFixtureIds(claim).workspace,
    organisation_id: localFixtureIds(claim).organisation,
    categories: [
      {
        id: localFixtureIds(claim).category,
        name: claim.payload.organizationName,
        template_key: null,
        channels: claim.channels.map((item) => ({
          ...channel,
          ...item,
          id: localFixtureIds(claim).channels[item.id]!,
          template_key: null,
          room_state: 'ready',
          topic: '',
        })),
      },
    ],
    uncategorised_channels: [],
  }
}
export function withLocalMemberships(me: components['schemas']['Me'], now: Date) {
  const base = communityMe(now).organisations[0]!
  return {
    ...me,
    organisations: [
      ...me.organisations,
      ...localWorkspaceClaims().map((claim) => ({
        ...base,
        membership_id: localFixtureIds(claim).membership,
        identity_id: localFixtureIds(claim).identity,
        organisation: {
          id: localFixtureIds(claim).organisation,
          name: claim.payload.organizationName,
          slug: claim.payload.slug,
          realm: claim.payload.slug,
        },
      })),
    ],
  }
}

export function localRequestWorkspace(request: Request) {
  try {
    const token = request.headers.get('Authorization')?.split(' ')[1]
    const sub: unknown = JSON.parse(
      atob(token!.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))
    ).sub
    return typeof sub === 'string' ? findLocalWorkspace(sub.replace(/^mock-user-/, '')) : undefined
  } catch {
    return undefined
  }
}
export function localMe(claim: ClaimedWorkspace, now: Date) {
  const me = communityMe(now)
  return {
    ...me,
    identities: [
      ...me.identities,
      {
        ...me.identities[0]!,
        id: localFixtureIds(claim).identity,
        realm: claim.payload.slug,
        subject: `mock-user-${claim.payload.slug}`,
        issuer: `${keycloakUrl()}/realms/${claim.payload.slug}`,
      },
    ],
  }
}
export function localDiscovery(claim: ClaimedWorkspace) {
  const organisation = localOrganisation(claim, new Date())
  return {
    realm: claim.payload.slug,
    issuer: `${keycloakUrl()}/realms/${claim.payload.slug}`,
    openid_configuration_url: `${keycloakUrl()}/realms/${claim.payload.slug}/.well-known/openid-configuration`,
    organisation,
    candidates: [],
  }
}

export function localMemberships(
  claim: ClaimedWorkspace,
  now: Date
): components['schemas']['Membership'][] {
  const base = seed.memberships(now)[0]!
  return [
    {
      ...base,
      id: localFixtureIds(claim).membership,
      organisation_id: localFixtureIds(claim).organisation,
      identity_id: localFixtureIds(claim).identity,
      person_id: communityMe(now).id,
      display_name: 'Community Member',
      email: 'member@community.kodera.io',
    },
  ]
}
