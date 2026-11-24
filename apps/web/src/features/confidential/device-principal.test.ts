// @vitest-environment node
// Public parser fixtures only; a parsed principal is never a network capability.
import { describe, expect, it } from 'vitest'
import fixtures from '../../../tests/unit/api/fixtures/confidential-device-http.responses.json'
import { DevicePrincipalError, parseDevicePrincipal } from './device-principal'

const selection = {
  issuer: fixtures.acceptedContext.issuer,
  subject: fixtures.acceptedContext.subject,
  organisationSlug: fixtures.acceptedContext.organisationSlug,
}
const healthy = () => structuredClone(fixtures.responses.me.body)
const parse = (me = healthy()) => parseDevicePrincipal(JSON.stringify(me), selection)
const expected = fixtures.acceptedContext

describe('bounded device principal projection', () => {
  it('derives the owner from Core person.id and retains no names or email', () => {
    const principal = parse()
    expect(principal).toEqual(expected)
    expect(principal.ownerId).not.toBe(principal.identityId)
    expect(Object.isFrozen(principal)).toBe(true)
    expect(Object.keys(principal).sort()).toEqual(Object.keys(expected).sort())
    expect(parseDevicePrincipal(JSON.stringify(healthy()), selection, principal)).toEqual(principal)
  })

  it('allows the shared-community identity realm to differ from organisation realm', () => {
    const me = healthy()
    me.identities[0]!.realm = 'community'
    me.organisations[0]!.organisation.realm = 'workspace'
    expect(parse(me)).toEqual(expected)
  })

  it('selects the target organisation identity when multiple shared-realm identities share issuer and subject', () => {
    const me = healthy()
    const communityIdentityId = '01970010-0000-7000-8000-000000000001'
    const secondPmeIdentityId = '01970010-0000-7000-8000-000000000002'
    me.identities.unshift({
      ...me.identities[0]!,
      id: communityIdentityId,
      realm: 'community',
    })
    me.identities.push({
      ...me.identities[1]!,
      id: secondPmeIdentityId,
      realm: 'community',
    })
    const baseMembership = me.organisations[0]!
    me.organisations.unshift({
      ...baseMembership,
      membership_id: '01970011-0000-7000-8000-000000000001',
      identity_id: communityIdentityId,
      organisation: {
        ...baseMembership.organisation,
        id: '01970012-0000-7000-8000-000000000001',
        slug: 'community',
        realm: 'community',
      },
    })
    me.organisations.push({
      ...baseMembership,
      membership_id: '01970011-0000-7000-8000-000000000002',
      identity_id: secondPmeIdentityId,
      organisation: {
        ...baseMembership.organisation,
        id: '01970012-0000-7000-8000-000000000002',
        slug: 'atelier-martin',
        realm: 'community',
      },
    })
    expect(parse(me)).toEqual(expected)
    const pmePrincipal = parseDevicePrincipal(JSON.stringify(me), {
      ...selection,
      organisationSlug: 'atelier-martin',
    })
    expect(pmePrincipal.identityId).toBe(secondPmeIdentityId)
    expect(pmePrincipal.organisationId).toBe('01970012-0000-7000-8000-000000000002')
    expect(pmePrincipal.membershipId).toBe('01970011-0000-7000-8000-000000000002')
  })

  it('refuses changed bindings on a later observation without choosing a new scope', () => {
    const principal = parse()
    for (const change of [
      (me: ReturnType<typeof healthy>) => { me.id = me.identities[0]!.id },
      (me: ReturnType<typeof healthy>) => { me.identities[0]!.id = me.id; me.organisations[0]!.identity_id = me.id },
      (me: ReturnType<typeof healthy>) => { me.organisations[0]!.organisation.id = me.id },
      (me: ReturnType<typeof healthy>) => { me.organisations[0]!.membership_id = me.id },
    ]) {
      const me = healthy(); change(me)
      // Each changed body is healthy for initial discovery; only the owned binding differs.
      expect(() => parse(me)).not.toThrow()
      expect(() => parseDevicePrincipal(JSON.stringify(me), selection, principal)).toThrow(DevicePrincipalError)
    }
  })

  it('requires exact SDK issuer and subject, customer staff state and active identity binding', () => {
    const changes = [
      (me: ReturnType<typeof healthy>) => { me.staff = true },
      (me: ReturnType<typeof healthy>) => { me.identities[0]!.issuer += '/other' },
      (me: ReturnType<typeof healthy>) => { me.identities[0]!.subject += '-other' },
      (me: ReturnType<typeof healthy>) => { me.organisations[0]!.state = 'suspended' },
      (me: ReturnType<typeof healthy>) => { me.organisations[0]!.identity_id = me.id },
      (me: ReturnType<typeof healthy>) => { Reflect.deleteProperty(me.organisations[0]!, 'identity_id') },
      (me: ReturnType<typeof healthy>) => { me.identities.push(structuredClone(me.identities[0]!)) },
      (me: ReturnType<typeof healthy>) => { me.organisations.push(structuredClone(me.organisations[0]!)) },
    ]
    for (const change of changes) {
      const me = healthy(); change(me)
      expect(() => parse(me)).toThrow(DevicePrincipalError)
    }
    expect(parse()).toEqual(expected)
  })

  it('checks the 64-entry boundaries independently of ambiguity or a missing selected row', () => {
    const me = healthy()
    for (let index = 1; index < 64; index++) {
      const suffix = index.toString(16).padStart(12, '0')
      me.identities.push({ ...me.identities[0]!, id: `01970001-0000-7000-8000-${suffix}`, subject: `other-${index}` })
      const base = me.organisations[0]!
      me.organisations.push({ ...base,
        membership_id: `01970002-0000-7000-8000-${suffix}`,
        identity_id: me.identities[index]!.id,
        organisation: { ...base.organisation, id: `01970003-0000-7000-8000-${suffix}`, slug: `other-${index}` },
      })
    }
    expect(parse(me)).toEqual(expected)
    const extraIdentity = { ...me.identities[1]!, id: '01970004-0000-7000-8000-000000000001', subject: 'extra' }
    me.identities.push(extraIdentity)
    expect(() => parse(me)).toThrow(DevicePrincipalError)
    me.identities.pop()
    const extra = structuredClone(me.organisations[1]!)
    extra.membership_id = '01970005-0000-7000-8000-000000000001'
    extra.organisation.id = '01970006-0000-7000-8000-000000000001'
    extra.organisation.slug = 'extra-org'
    me.organisations.push(extra)
    expect(() => parse(me)).toThrow(DevicePrincipalError)
  })

  it('rejects malformed required fields, unknown state/role and malformed UUIDs', () => {
    for (const change of [
      (me: ReturnType<typeof healthy>) => { me.id = '00000000-0000-0000-0000-000000000000' },
      (me: ReturnType<typeof healthy>) => { me.id = me.id.toUpperCase() },
      (me: ReturnType<typeof healthy>) => { me.organisations[0]!.state = 'unknown' },
      (me: ReturnType<typeof healthy>) => { me.organisations[0]!.role = 'unknown' },
      (me: ReturnType<typeof healthy>) => { me.identities[0]!.subject = 'é' },
      (me: ReturnType<typeof healthy>) => { me.identities[0]!.realm = 'x'.repeat(65) },
      (me: ReturnType<typeof healthy>) => { me.email = 'x'.repeat(321) },
      (me: ReturnType<typeof healthy>) => { me.display_name = 'é'.repeat(401) },
    ]) {
      const me = healthy(); change(me)
      expect(() => parse(me)).toThrow(DevicePrincipalError)
    }
    for (const body of ['null', '[]', '{', JSON.stringify({}), ' '.repeat(262145)])
      expect(() => parseDevicePrincipal(body, selection)).toThrow(DevicePrincipalError)
  })

  it('counts UTF-8 bytes, permits harmless unknown fields, and never returns them', () => {
    const me = healthy()
    const base = JSON.stringify(me)
    const prefix = base.slice(0, -1) + ',"unobserved":"'
    const body = prefix + 'x'.repeat(262144 - prefix.length - 2) + '"}'
    expect(new TextEncoder().encode(body).byteLength).toBe(262144)
    expect(parseDevicePrincipal(body, selection)).toEqual(expected)
    expect(() => parseDevicePrincipal(body.replace('x', 'é'), selection)).toThrow(DevicePrincipalError)
  })

  it('requires true EOF for every UUID and both selected slug values', () => {
    for (const suffix of ['\n', '\r\n']) {
      for (const field of ['owner', 'identity', 'organisation', 'membership']) {
        for (const nil of [false, true]) {
          const me = healthy()
          const original = field === 'owner' ? me.id : field === 'identity' ? me.identities[0]!.id
            : field === 'organisation' ? me.organisations[0]!.organisation.id : me.organisations[0]!.membership_id
          const value = (nil ? '00000000-0000-0000-0000-000000000000' : original) + suffix
          if (field === 'owner') me.id = value
          else if (field === 'identity') {
            me.identities[0]!.id = value
            me.organisations[0]!.identity_id = value
          } else if (field === 'organisation') me.organisations[0]!.organisation.id = value
          else me.organisations[0]!.membership_id = value
          expect(() => parse(me)).toThrow(expect.objectContaining({ code: 'invalid-response' }))
        }
      }
      const me = healthy()
      const selected = { ...selection, organisationSlug: selection.organisationSlug + suffix }
      me.organisations[0]!.organisation.slug = selected.organisationSlug
      // Match both sides deliberately: an unrelated missing-slug guard cannot mask EOF failure.
      expect(() => parseDevicePrincipal(JSON.stringify(me), selected)).toThrow(
        expect.objectContaining({ code: 'invalid-response' })
      )
    }
    expect(parse()).toEqual(expected)
  })
})
