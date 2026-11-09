import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthSessionSnapshot } from '../../auth/AuthAdapter'
import type { components } from '../../api/schema'
import {
  INVITATION_RECOVERY_KEY,
  resolveInvitationOwner,
  canSaveInvitation,
  saveInvitation,
  readInvitation,
  consumeInvitation,
  clearInvitation,
} from './invitationRecovery'

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
  return { session, me, meGeneration: 4, organisationId, membershipId, credential: true }
}
const draft = {
  text: 'anne@example.test\nunfinished@',
  role: 'org_admin' as const,
  open: true as const,
}
function owner() {
  return resolveInvitationOwner(fixture())!
}
afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
})

describe('invitation recovery ownership', () => {
  it('uses only the processed SDK and unique active Core owner at its captured generation', () => {
    expect(owner()).toEqual({
      issuer,
      subject: 'Opaque-Subject',
      organisationId,
      membershipId,
      identityId,
      generation: 4,
      role: 'org_owner',
    })
    expect(Object.isFrozen(owner())).toBe(true)
  })
  it.each([
    'stale',
    'pending',
    'credential',
    'identity',
    'issuer',
    'subject',
    'duplicate identity',
    'duplicate membership',
    'inactive',
    'membership identity',
    'role',
  ])('refuses %s from an otherwise valid context', (failure) => {
    const input = fixture()
    expect(resolveInvitationOwner(input)).toBeDefined()
    switch (failure) {
      case 'stale':
        input.meGeneration--
        break
      case 'pending':
        input.session = { ...input.session, status: 'pending' }
        break
      case 'credential':
        input.credential = false
        break
      case 'identity':
        input.session = { ...input.session, user: { realm: 'acme-sa' } }
        break
      case 'issuer':
        input.me.identities[0]!.issuer += '/other'
        break
      case 'subject':
        input.me.identities[0]!.subject = 'another'
        break
      case 'duplicate identity':
        input.me.identities.push({ ...input.me.identities[0]! })
        break
      case 'duplicate membership':
        input.me.organisations.push({ ...input.me.organisations[0]! })
        break
      case 'inactive':
        input.me.organisations[0]!.state = 'suspended'
        break
      case 'membership identity':
        input.me.organisations[0]!.identity_id = membershipId
        break
      case 'role':
        input.me.organisations[0]!.role = 'org_member'
        break
    }
    expect(resolveInvitationOwner(input)).toBeUndefined()
  })
  it('allows saving an expired committed owner but never a replacement session', () => {
    const input = fixture()
    expect(canSaveInvitation(owner(), input.session)).toBe(true)
    expect(canSaveInvitation(owner(), { ...input.session, generation: 5 })).toBe(false)
    expect(canSaveInvitation(owner(), { ...input.session, status: 'unauthenticated' })).toBe(false)
    expect(
      canSaveInvitation(owner(), {
        ...input.session,
        user: { ...input.session.user!, identity: { issuer, subject: 'another' } },
      })
    ).toBe(false)
  })
})

describe('strict tab-scoped invitation envelope', () => {
  it('restores raw fields for the same owner after a new generation, without consuming during read', () => {
    saveInvitation(owner(), draft, 1000)
    const raw = sessionStorage.getItem(INVITATION_RECOVERY_KEY)
    const snapshot = readInvitation({ ...owner(), generation: 9 }, 1001)!
    expect(snapshot.draft).toEqual(draft)
    expect(sessionStorage.getItem(INVITATION_RECOVERY_KEY)).toBe(raw)
    expect(raw).not.toContain('credential')
    expect(raw).not.toContain('generation')
    consumeInvitation(snapshot)
    expect(sessionStorage.getItem(INVITATION_RECOVERY_KEY)).toBeNull()
  })
  it('does not read private fields before owner verification', () => {
    saveInvitation(owner(), draft, 1000)
    const get = vi.spyOn(Storage.prototype, 'getItem')
    expect(readInvitation(undefined, 1001)).toBeUndefined()
    expect(get).not.toHaveBeenCalled()
  })
  it.each(['issuer', 'subject', 'organisationId', 'membershipId', 'identityId', 'role'] as const)(
    'discards changed %s rather than binding old fields to it',
    (key) => {
      saveInvitation(owner(), { ...draft, role: 'org_billing' }, 1000)
      const changed = { ...owner() }
      if (key === 'role') changed.role = 'org_admin'
      else if (key === 'issuer' || key === 'subject') changed[key] += '-changed'
      else changed[key] = '00000000-0000-4000-8000-000000000009'
      expect(readInvitation(changed, 1001)).toBeUndefined()
      expect(sessionStorage.getItem(INVITATION_RECOVERY_KEY)).toBeNull()
    }
  )
  it('accepts just before ten minutes, rejects the exact boundary and future saves', () => {
    saveInvitation(owner(), draft, 1000)
    expect(readInvitation(owner(), 600999)).toBeDefined()
    expect(readInvitation(owner(), 601000)).toBeUndefined()
    saveInvitation(owner(), draft, 1001)
    expect(readInvitation(owner(), 1000)).toBeUndefined()
  })
  it.each([
    'version',
    'purpose',
    'extra',
    'extra owner',
    'extra draft',
    'array',
    'timestamp',
    'invalid owner',
    'invalid role',
    'closed',
    'corrupt',
  ])('rejects %s after establishing valid authority', (failure) => {
    saveInvitation(owner(), draft, 1000)
    const envelope = JSON.parse(sessionStorage.getItem(INVITATION_RECOVERY_KEY)!)
    switch (failure) {
      case 'version':
        envelope.version = 2
        break
      case 'purpose':
        envelope.purpose = 'other'
        break
      case 'extra':
        envelope.extra = true
        break
      case 'extra owner':
        envelope.owner.token = 'private'
        break
      case 'extra draft':
        envelope.draft.password = 'private'
        break
      case 'array':
        envelope.draft = []
        break
      case 'timestamp':
        envelope.savedAt = 1.5
        break
      case 'invalid owner':
        envelope.owner.identityId = 'slug'
        break
      case 'invalid role':
        envelope.draft.role = 'org_owner'
        break
      case 'closed':
        envelope.draft.open = false
        break
    }
    sessionStorage.setItem(
      INVITATION_RECOVERY_KEY,
      failure === 'corrupt' ? '{' : JSON.stringify(envelope)
    )
    expect(readInvitation(owner(), 1001)).toBeUndefined()
    expect(sessionStorage.getItem(INVITATION_RECOVERY_KEY)).toBeNull()
  })
  it.each(['ascii', 'multibyte', 'escaped'])(
    'accepts precisely 65536 UTF-8 bytes of %s and refuses 65537',
    (kind) => {
      const text =
        kind === 'multibyte'
          ? 'é'.repeat(32768)
          : (kind === 'escaped' ? '\u0000' : 'a').repeat(65536)
      saveInvitation(owner(), { ...draft, text }, 1000)
      expect(readInvitation(owner(), 1001)?.draft.text).toBe(text)
      saveInvitation(owner(), { ...draft, text: text + 'a' }, 1000)
      expect(readInvitation(owner(), 1001)).toBeUndefined()
    }
  )
  it('never removes an intervening newer draft on old committed consumption', () => {
    saveInvitation(owner(), draft, 1000)
    const snapshot = readInvitation(owner(), 1001)!
    saveInvitation(owner(), { ...draft, text: 'newer@' }, 1002)
    consumeInvitation(snapshot)
    expect(readInvitation(owner(), 1003)?.draft.text).toBe('newer@')
    clearInvitation()
    expect(sessionStorage.getItem(INVITATION_RECOVERY_KEY)).toBeNull()
  })
  it.each(['getItem', 'setItem', 'removeItem'] as const)(
    'isolates denied feature %s without another store or thrown error',
    (method) => {
      saveInvitation(owner(), draft, 1000)
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError')
      })
      expect(() => saveInvitation(owner(), draft, 1001)).not.toThrow()
      expect(() => readInvitation(owner(), 1002)).not.toThrow()
      expect(() => clearInvitation()).not.toThrow()
    }
  )
})

it('refuses oversized stored text independently of the save-time cap', () => {
  saveInvitation(owner(), draft, 1000)
  const envelope = JSON.parse(sessionStorage.getItem(INVITATION_RECOVERY_KEY)!)
  envelope.draft.text = 'é'.repeat(32768) + 'a'
  sessionStorage.setItem(INVITATION_RECOVERY_KEY, JSON.stringify(envelope))
  expect(readInvitation(owner(), 1001)).toBeUndefined()
  expect(sessionStorage.getItem(INVITATION_RECOVERY_KEY)).toBeNull()
})
it('refuses an overlarge serialized slot before JSON parsing', () => {
  sessionStorage.setItem(INVITATION_RECOVERY_KEY, ' '.repeat(500_000))
  const parse = vi.spyOn(JSON, 'parse')
  expect(readInvitation(owner(), 1001)).toBeUndefined()
  expect(parse).not.toHaveBeenCalled()
  expect(sessionStorage.getItem(INVITATION_RECOVERY_KEY)).toBeNull()
})

it('invalidates the same slot when removal is denied and never rereads its committed snapshot', () => {
  saveInvitation(owner(), draft, 1000)
  const snapshot = readInvitation(owner(), 1001)!
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new DOMException('denied')
  })
  consumeInvitation(snapshot)
  expect(readInvitation(owner(), 1002)).toBeUndefined()
  expect(sessionStorage.getItem(INVITATION_RECOVERY_KEY)).toBe('null')
})
it('reports failed durable invalidation when both writes are denied, without throwing', () => {
  saveInvitation(owner(), draft, 1000)
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new DOMException('denied')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('denied')
  })
  expect(clearInvitation()).toBe(false)
})
it('suppresses a committed snapshot in this document under both-write denial but allows a newer successful save', () => {
  saveInvitation(owner(), draft, 1000)
  const snapshot = readInvitation(owner(), 1001)!
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new DOMException('denied')
  })
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('denied')
  })
  consumeInvitation(snapshot)
  expect(readInvitation(owner(), 1002)).toBeUndefined()
  remove.mockRestore()
  set.mockRestore()
  // A successful identical serialization must reset only the in-document marker.
  saveInvitation(owner(), draft, 1000)
  expect(readInvitation(owner(), 1002)?.raw).toBe(snapshot.raw)
  saveInvitation(owner(), { ...draft, text: 'newer@' }, 1003)
  expect(readInvitation(owner(), 1004)?.draft.text).toBe('newer@')
})
