import { describe, expect, it } from 'vitest'
import type { components } from '../api/schema'
import type { AuthIdentity } from '../auth/AuthAdapter'
import { isCurrentIdentityMfaEnrolled, resolveCurrentIdentity } from './currentIdentity'

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
        mfa_enrolled: true,
      },
    ],
    organisations: [
      {
        organisation: { id: organisationId, slug: 'acme-sa', name: 'Acme', realm: 'acme-sa' },
        membership_id: membershipId,
        state: 'active',
        role: 'org_owner',
        identity_id: identityId,
      },
    ],
  }
}

describe('current identity authority', () => {
  it('selects the one exact issuer/subject identity and matching relationship', () => {
    const resolved = resolveCurrentIdentity(currentMe(), active, 'acme-sa')
    expect(resolved?.identity.id).toBe(identityId)
    expect(resolved?.membership.identity_id).toBe(identityId)
    expect(resolved?.identity.mfa_enrolled).toBe(true)
  })

  it.each([
    ['missing SDK identity', (me: components['schemas']['Me']) => ({ me, auth: undefined })],
    [
      'false MFA',
      (me: components['schemas']['Me']) => {
        me.identities[0]!.mfa_enrolled = false
        return { me, auth: active }
      },
    ],
    [
      'omitted MFA',
      (me: components['schemas']['Me']) => {
        delete me.identities[0]!.mfa_enrolled
        return { me, auth: active }
      },
    ],
    [
      'duplicate issuer and subject',
      (me: components['schemas']['Me']) => {
        me.identities.push({ ...me.identities[0]!, id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })
        return { me, auth: active }
      },
    ],
    [
      'duplicate identity ID',
      (me: components['schemas']['Me']) => {
        me.identities.push({ ...me.identities[0]!, issuer: 'https://other.example.test' })
        return { me, auth: active }
      },
    ],
    [
      'mismatched membership identity',
      (me: components['schemas']['Me']) => {
        me.organisations[0]!.identity_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
        return { me, auth: active }
      },
    ],
    [
      'missing membership identity',
      (me: components['schemas']['Me']) => {
        delete me.organisations[0]!.identity_id
        return { me, auth: active }
      },
    ],
    [
      'duplicate organisation relationship',
      (me: components['schemas']['Me']) => {
        me.organisations.push({ ...me.organisations[0]! })
        return { me, auth: active }
      },
    ],
    [
      'malformed identity ID',
      (me: components['schemas']['Me']) => {
        me.identities[0]!.id = 'identity'
        me.organisations[0]!.identity_id = 'identity'
        return { me, auth: active }
      },
    ],
    [
      'malformed membership ID',
      (me: components['schemas']['Me']) => {
        me.organisations[0]!.membership_id = 'membership'
        return { me, auth: active }
      },
    ],
    [
      'malformed organisation ID',
      (me: components['schemas']['Me']) => {
        me.organisations[0]!.organisation.id = 'organisation'
        return { me, auth: active }
      },
    ],
    [
      'duplicate membership ID',
      (me: components['schemas']['Me']) => {
        me.organisations.push({
          ...me.organisations[0]!,
          organisation: {
            ...me.organisations[0]!.organisation,
            id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            slug: 'other-org',
          },
        })
        return { me, auth: active }
      },
    ],
    [
      'suspended relationship',
      (me: components['schemas']['Me']) => {
        me.organisations[0]!.state = 'suspended'
        return { me, auth: active }
      },
    ],
    [
      'invited relationship',
      (me: components['schemas']['Me']) => {
        me.organisations[0]!.state = 'invited'
        return { me, auth: active }
      },
    ],
    [
      'removed relationship',
      (me: components['schemas']['Me']) => {
        me.organisations[0]!.state = 'removed'
        return { me, auth: active }
      },
    ],
    [
      'wrong subject',
      (me: components['schemas']['Me']) => ({
        me,
        auth: { ...active, subject: 'another-subject' },
      }),
    ],
  ])('fails closed for %s', (_case, arrange) => {
    const { me, auth } = arrange(currentMe())
    expect(isCurrentIdentityMfaEnrolled(me, auth, 'acme-sa')).toBe(false)
  })
})
