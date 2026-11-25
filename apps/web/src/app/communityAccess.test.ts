import { describe, expect, it } from 'vitest'
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
