import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../api/schema'
import type { AuthIdentity } from '../auth/AuthAdapter'
import { resolveCurrentIdentity } from './currentIdentity'
import {
  isKnownSharedRealmSlug,
  isPublicCommunityMember,
  isSharedRealmFreemiumMember,
  rememberSharedRealmSlug,
  sessionCoversOrganisation,
} from './communityAccess'

const identityId = '3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d'
const membershipId = '7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c'
const organisationId = '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f'
const active: AuthIdentity = {
  issuer: 'https://id.example.test/realms/acme-sa',
  subject: 'Opaque:Subject/1',
}

function currentMe(): components['schemas']['Me'] {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    email: 'owner@example.test',
    locale: 'fr',
    staff: false,
    identities: [
      {
        id: identityId,
        issuer: active.issuer,
        realm: 'acme-sa',
        subject: active.subject,
        email: 'owner@example.test',
        mfa_enrolled: false,
      },
    ],
    organisations: [
      {
        organisation: {
          id: organisationId,
          slug: 'community',
          name: 'Community',
          realm: 'community',
        },
        membership_id: membershipId,
        state: 'active',
        role: 'org_member',
        identity_id: identityId,
      },
    ],
  }
}

describe('canonical community access', () => {
  it('allows an exact active public membership without fabricating MFA enrollment', () => {
    const me = currentMe()
    expect(isPublicCommunityMember(me, active, 'community')).toBe(true)
    expect(me.identities[0]!.mfa_enrolled).toBe(false)
  })
  it.each(['org_owner', 'org_admin', 'org_billing'] as const)(
    'preserves the MFA gate for %s',
    (role) => {
      const me = currentMe()
      me.organisations[0]!.role = role
      expect(isPublicCommunityMember(me, active, 'community')).toBe(false)
    }
  )
  it('preserves staff and tenant MFA, and rejects unbound identities', () => {
    const me = currentMe()
    expect(isPublicCommunityMember(me, active, 'acme-sa')).toBe(false)
    expect(isPublicCommunityMember(me, undefined, 'community')).toBe(false)
    expect(isPublicCommunityMember(me, { ...active, subject: 'another' }, 'community')).toBe(false)
    me.staff = true
    expect(isPublicCommunityMember(me, active, 'community')).toBe(false)
    me.staff = false
    me.organisations[0]!.state = 'suspended'
    expect(isPublicCommunityMember(me, active, 'community')).toBe(false)
  })
  it('allows only the shared community and shared-realm PME exceptions to tenant realm matching', () => {
    expect(sessionCoversOrganisation('acme-sa', 'community')).toBe(true)
    expect(sessionCoversOrganisation('acme-sa', 'community', false)).toBe(false)
    expect(sessionCoversOrganisation('community', 'community', false)).toBe(true)
    expect(sessionCoversOrganisation('kodera-staff', 'community')).toBe(true)
    expect(sessionCoversOrganisation(undefined, 'community')).toBe(false)
    expect(sessionCoversOrganisation('acme-sa', 'bravo')).toBe(false)
    expect(sessionCoversOrganisation('acme-sa', 'acme-sa')).toBe(true)
    expect(sessionCoversOrganisation('community', 'atelier-alpha', true, false)).toBe(false)
    expect(sessionCoversOrganisation('community', 'atelier-alpha', true, true)).toBe(true)
    expect(sessionCoversOrganisation('acme-sa', 'atelier-alpha', true, true)).toBe(false)
    expect(sessionCoversOrganisation('atelier-alpha', 'atelier-alpha', true, true)).toBe(false)
  })

  it('resolves exact per-organisation shared-realm identities and exempts freemium_pme from forced MFA', () => {
    const pmeIdentityId = '4b8d0f2c-3e50-4b7c-9d1e-2f304b5c6d7e'
    const pmeMembershipId = '8d3c2b1a-4f5e-406b-9c7d-0e1f203b4c5d'
    const pmeOrgId = '702e3f4d-9b5c-4d6e-8f70-1b2c3d4e5f60'
    const sharedActive: AuthIdentity = {
      issuer: 'https://auth.kodera.test/realms/community',
      subject: 'shared-founder-subject',
    }
    const me: components['schemas']['Me'] = {
      id: '11111111-2222-4333-8444-555555555555',
      email: 'founder@example.test',
      locale: 'fr',
      staff: false,
      identities: [
        {
          id: identityId,
          issuer: sharedActive.issuer,
          realm: 'community',
          subject: sharedActive.subject,
          email: 'founder@example.test',
          mfa_enrolled: false,
        },
        {
          id: pmeIdentityId,
          issuer: sharedActive.issuer,
          realm: 'community',
          subject: sharedActive.subject,
          email: 'founder@example.test',
          mfa_enrolled: false,
        },
      ],
      organisations: [
        {
          organisation: {
            id: organisationId,
            slug: 'community',
            name: 'Community',
            realm: 'community',
          },
          membership_id: membershipId,
          state: 'active',
          role: 'org_member',
          identity_id: identityId,
          shared_realm: false,
          plan_tier: 'community',
        },
        {
          organisation: {
            id: pmeOrgId,
            slug: 'atelier-alpha',
            name: 'Atelier Alpha',
            realm: 'community',
          },
          membership_id: pmeMembershipId,
          state: 'active',
          role: 'org_owner',
          identity_id: pmeIdentityId,
          shared_realm: true,
          plan_tier: 'freemium_pme',
        },
      ],
    }

    const resolvedComm = resolveCurrentIdentity(me, sharedActive, 'community')
    const resolvedPme = resolveCurrentIdentity(me, sharedActive, 'atelier-alpha')
    expect(resolvedComm?.identity.id).toBe(identityId)
    expect(resolvedPme?.identity.id).toBe(pmeIdentityId)
    expect(isSharedRealmFreemiumMember(me, sharedActive, 'atelier-alpha')).toBe(true)
    expect(isSharedRealmFreemiumMember(me, sharedActive, 'community')).toBe(false)

    // Upgrading plan_tier to sovereign or cloud_collaborative re-enables strict MFA enforcement.
    me.organisations[1]!.plan_tier = 'sovereign'
    expect(isSharedRealmFreemiumMember(me, sharedActive, 'atelier-alpha')).toBe(false)

    rememberSharedRealmSlug('atelier-alpha')
    expect(isKnownSharedRealmSlug('atelier-alpha')).toBe(true)
    expect(isKnownSharedRealmSlug('community')).toBe(false)
  })
})

describe('shared-realm hints across reloads', () => {
  const key = 'kodera.web.auth.sharedRealmSlugs'
  beforeEach(() => sessionStorage.clear())
  afterEach(() => {
    vi.restoreAllMocks()
    sessionStorage.clear()
  })
  async function freshHints() {
    vi.resetModules()
    return import('./communityAccess')
  }

  it('persists validated slugs and lazily hydrates them in a fresh module', async () => {
    const hints = await freshHints()
    hints.rememberSharedRealmSlug('testing')
    for (const invalid of ['', 'BAD-ORG', 'abcd', 'invalid.org', 'testing\n', 'a'.repeat(21)]) {
      hints.rememberSharedRealmSlug(invalid)
      expect(hints.isKnownSharedRealmSlug(invalid)).toBe(false)
    }
    hints.rememberSharedRealmSlug('community')
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(['testing'])
    expect((await freshHints()).isKnownSharedRealmSlug('testing')).toBe(true)
  })

  it.each(['broken json', '{}', 'null', '42'])('ignores malformed storage: %s', async (stored) => {
    sessionStorage.setItem(key, stored)
    const hints = await freshHints()
    expect(hints.isKnownSharedRealmSlug('testing')).toBe(false)
    hints.rememberSharedRealmSlug('testing')
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(['testing'])
  })

  it('filters stored entries, deduplicates them, and bounds both storage and memory to 64 slugs', async () => {
    sessionStorage.setItem(
      key,
      JSON.stringify([null, 123, {}, 'BAD-ORG', 'community', 'testing', 'testing'])
    )
    const hints = await freshHints()
    expect(hints.isKnownSharedRealmSlug('testing')).toBe(true)
    for (let index = 0; index < 70; index++) hints.rememberSharedRealmSlug(`space-${index}`)
    const stored: string[] = JSON.parse(sessionStorage.getItem(key)!)
    expect(stored).toHaveLength(64)
    expect(new Set(stored).size).toBe(64)
    expect(stored).toContain('space-69')
    expect(hints.isKnownSharedRealmSlug('testing')).toBe(false)
    expect(hints.isKnownSharedRealmSlug('space-0')).toBe(false)
    const reloaded = await freshHints()
    expect(reloaded.isKnownSharedRealmSlug('testing')).toBe(false)
    expect(reloaded.isKnownSharedRealmSlug('space-69')).toBe(true)
  })

  it('caps oversized stored arrays to 64 valid entries', async () => {
    sessionStorage.setItem(
      key,
      JSON.stringify(Array.from({ length: 80 }, (_, index) => `space-${index}`))
    )
    const hints = await freshHints()
    expect(hints.isKnownSharedRealmSlug('space-79')).toBe(true)
    expect(hints.isKnownSharedRealmSlug('space-0')).toBe(false)
    hints.rememberSharedRealmSlug('testing')
    expect(JSON.parse(sessionStorage.getItem(key)!)).toHaveLength(64)
  })

  it('keeps memory usable when browser storage throws, including during cleanup', async () => {
    const hints = await freshHints()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage blocked')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('Storage blocked')
    })
    expect(() => hints.rememberSharedRealmSlug('testing')).not.toThrow()
    expect(hints.isKnownSharedRealmSlug('testing')).toBe(true)
    hints.clearKnownSharedRealmSlugs()
    expect(hints.isKnownSharedRealmSlug('testing')).toBe(false)
  })

  it('clears persisted hints and memory during local session cleanup', async () => {
    const hints = await freshHints()
    hints.rememberSharedRealmSlug('testing')
    const { clearLocalSessionStorage } = await import('../auth/localSession')
    clearLocalSessionStorage()
    expect(sessionStorage.getItem(key)).toBeNull()
    expect(hints.isKnownSharedRealmSlug('testing')).toBe(false)
  })

  it('does not rehydrate old hints when storage removal fails during sign-out', async () => {
    const hints = await freshHints()
    hints.rememberSharedRealmSlug('testing')
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => {
      throw new Error('Storage blocked')
    })
    hints.clearKnownSharedRealmSlugs()
    expect(sessionStorage.getItem(key)).toBe('[]')
    expect(hints.isKnownSharedRealmSlug('testing')).toBe(false)
    expect((await freshHints()).isKnownSharedRealmSlug('testing')).toBe(false)
  })

  it('forgets a hydrated slug and persists the remaining hints across reloads', async () => {
    sessionStorage.setItem(key, '["testing","acme-sa"]')
    const hints = await freshHints()
    hints.forgetSharedRealmSlug('testing')
    expect(hints.isKnownSharedRealmSlug('testing')).toBe(false)
    expect(sessionStorage.getItem(key)).toBe('["acme-sa"]')
    const reloaded = await freshHints()
    expect(reloaded.isKnownSharedRealmSlug('testing')).toBe(false)
    expect(reloaded.isKnownSharedRealmSlug('acme-sa')).toBe(true)
  })
})
