import { describe, expect, it } from 'vitest'
import type { AuthSessionSnapshot } from '../../auth/AuthAdapter'
import type { components } from '../../api/schema'
import { resolveOrderOwner } from './owner'

const issuer = 'https://id.example.test/realms/acme-sa'
const organisationId = '00000000-0000-4000-8000-000000000001'
const membershipId = '00000000-0000-4000-8000-000000000002'
const identityId = '00000000-0000-4000-8000-000000000003'
function fixture() {
  const session: AuthSessionSnapshot = {
    status: 'ready',
    generation: 4,
    credentialGeneration: 1,
    user: {
      realm: 'acme-sa',
      identity: { issuer, subject: 'Opaque-Subject' },
    },
  }
  const me: components['schemas']['Me'] = {
    id: '00000000-0000-4000-8000-000000000004',
    email: 'shared@example.test',
    locale: 'fr',
    staff: false,
    identities: [
      {
        id: identityId,
        issuer,
        subject: 'Opaque-Subject',
        realm: 'acme-sa',
        email: 'shared@example.test',
      },
    ],
    organisations: [
      {
        organisation: { id: organisationId, slug: 'acme-sa', name: 'Acme' },
        membership_id: membershipId,
        identity_id: identityId,
        state: 'active',
        role: 'org_owner',
      },
    ],
  }
  return { session, me, meGeneration: 4, organisationId, membershipId }
}
describe('fresh order owner mapping', () => {
  it('returns only frozen exact owner metadata after active membership and identity match', () => {
    const owner = resolveOrderOwner(fixture())
    expect(owner).toEqual({
      issuer,
      subject: 'Opaque-Subject',
      organisationId,
      membershipId,
      identityId,
      generation: 4,
    })
    expect(Object.isFrozen(owner)).toBe(true)
  })
  it.each([
    'stale me',
    'pending',
    'no identity',
    'other issuer',
    'other subject',
    'case changed subject',
    'missing membership identity',
    'other membership identity',
    'suspended',
    'wrong organisation',
    'wrong membership',
    'duplicate identity pair',
    'duplicate identity ID',
    'duplicate membership',
    'duplicate membership ID',
    'slug as organisation',
  ])('refuses %s rather than using person, email or slug', (failure) => {
    const input = fixture()
    const identity = input.me.identities[0]!
    const membership = input.me.organisations[0]!
    switch (failure) {
      case 'stale me':
        input.meGeneration--
        break
      case 'pending':
        input.session = { ...input.session, status: 'pending' }
        break
      case 'no identity':
        input.session = { ...input.session, user: { realm: 'acme-sa' } }
        break
      case 'other issuer':
        identity.issuer = 'https://another.example.test/realms/acme-sa'
        break
      case 'other subject':
        identity.subject = 'Someone-Else'
        break
      case 'case changed subject':
        identity.subject = 'opaque-subject'
        break
      case 'missing membership identity':
        delete membership.identity_id
        break
      case 'other membership identity':
        membership.identity_id = '00000000-0000-4000-8000-000000000009'
        break
      case 'suspended':
        membership.state = 'suspended'
        break
      case 'wrong organisation':
        input.organisationId = '00000000-0000-4000-8000-000000000009'
        break
      case 'wrong membership':
        input.membershipId = '00000000-0000-4000-8000-000000000009'
        break
      case 'duplicate identity pair':
        input.me.identities.push({ ...identity, id: '00000000-0000-4000-8000-000000000009' })
        break
      case 'duplicate identity ID':
        input.me.identities.push({ ...identity, subject: 'another' })
        break
      case 'duplicate membership':
        input.me.organisations.push({ ...membership })
        break
      case 'duplicate membership ID':
        input.me.organisations.push({
          ...membership,
          organisation: { ...membership.organisation, id: '00000000-0000-4000-8000-000000000009' },
        })
        break
      case 'slug as organisation':
        input.organisationId = 'acme-sa'
        membership.organisation.id = 'acme-sa'
        break
    }
    expect(resolveOrderOwner(input)).toBeUndefined()
  })
})
