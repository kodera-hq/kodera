import { beforeEach, expect, it, vi } from 'vitest'
import { clearLocalSessionStorage } from '../../auth/localSession'
import { clearStashedContacts, readStashedContacts, stashContacts } from './contactStash'
import { EDITABLE_RETENTION_MS, ownerTuple } from './editableStorage'
import type { OrderOwner } from './owner'

const owner: OrderOwner = {
  issuer: 'https://identity.example.test/realms/a',
  subject: 'person-a',
  organisationId: 'org-a',
  membershipId: 'membership-a',
  identityId: 'identity-a',
  generation: 1,
}
const contacts = {
  legalName: 'Partial synthetic buyer',
  slug: '',
  registrationNumber: '',
  vatNumber: '',
  addressLine1: '',
  postalCode: '',
  city: '',
  country: 'FR',
  billingReference: '',
  adminEmail: '',
  billingEmail: '',
  securityEmail: '',
}
const storageKey = (scope = owner, id = 'draft-a') =>
  `kodera.web.order.contactStash:${JSON.stringify([...ownerTuple(scope), id])}`

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

it('reads repeatedly without consuming and accepts a renewed generation for the same owner', () => {
  stashContacts(owner, 'draft-a', contacts)
  const saved = sessionStorage.getItem(storageKey())
  expect(readStashedContacts(owner, 'draft-a')).toEqual({ contacts, raw: saved })
  expect(readStashedContacts({ ...owner, generation: 2 }, 'draft-a')).toEqual({
    contacts,
    raw: saved,
  })
  expect(sessionStorage.getItem(storageKey())).toBe(saved)
})

it.each(['issuer', 'subject', 'organisationId'] as const)(
  'refuses fields under another %s, including a copied envelope in its storage key',
  (field) => {
    stashContacts(owner, 'draft-a', contacts)
    const saved = sessionStorage.getItem(storageKey())!
    const other = { ...owner, [field]: 'other', generation: 2 }
    expect(readStashedContacts(other, 'draft-a')).toBeUndefined()
    sessionStorage.setItem(storageKey(other), saved)
    expect(readStashedContacts(other, 'draft-a')).toBeUndefined()
    expect(sessionStorage.getItem(storageKey())).toBe(saved)
  }
)

it('refuses another draft even if its key carries a copied valid envelope', () => {
  stashContacts(owner, 'draft-a', contacts)
  sessionStorage.setItem(storageKey(owner, 'draft-b'), sessionStorage.getItem(storageKey())!)
  expect(readStashedContacts(owner, 'draft-b')).toBeUndefined()
})

it.each([
  'invalid-json',
  'purpose',
  'version',
  'future',
  'expired',
  'oversized',
  'purchase',
  'unknown-contact',
])('refuses %s recovery without consuming or mutating the record', (failure) => {
  stashContacts(owner, 'draft-a', contacts)
  const saved = JSON.parse(sessionStorage.getItem(storageKey())!)
  if (failure === 'purpose') saved.purpose = 'purchase'
  if (failure === 'version') saved.version = 2
  if (failure === 'future') saved.editedAt = new Date(Date.now() + 60_000).toISOString()
  if (failure === 'expired')
    saved.editedAt = new Date(Date.now() - EDITABLE_RETENTION_MS).toISOString()
  if (failure === 'oversized') saved.contacts.legalName = 'x'.repeat(1025)
  if (failure === 'purchase') saved.orderId = 'unresolved-order'
  if (failure === 'unknown-contact') saved.contacts.submitIdempotencyKey = 'unresolved-key'
  const raw = failure === 'invalid-json' ? '{' : JSON.stringify(saved)
  sessionStorage.setItem(storageKey(), raw)
  expect(readStashedContacts(owner, 'draft-a')).toBeUndefined()
  expect(sessionStorage.getItem(storageKey())).toBe(raw)
})

it('does not clear a newer snapshot when the committed recovery names an older one', () => {
  stashContacts(owner, 'draft-a', contacts)
  const first = readStashedContacts(owner, 'draft-a')!
  stashContacts(owner, 'draft-a', { ...contacts, legalName: 'Newer fields' })
  clearStashedContacts(owner, 'draft-a', first.raw)
  expect(readStashedContacts(owner, 'draft-a')?.contacts.legalName).toBe('Newer fields')
  clearStashedContacts(owner, 'draft-a', readStashedContacts(owner, 'draft-a')!.raw)
  expect(readStashedContacts(owner, 'draft-a')).toBeUndefined()
})

it('does not let storage denial throw or log form values', () => {
  const warn = vi.spyOn(console, 'warn')
  const error = vi.spyOn(console, 'error')
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('denied')
  })
  expect(() => stashContacts(owner, 'draft-a', contacts)).not.toThrow()
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('denied')
  })
  expect(readStashedContacts(owner, 'draft-a')).toBeUndefined()
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new Error('denied')
  })
  expect(() => clearStashedContacts(owner, 'draft-a')).not.toThrow()
  expect(warn).not.toHaveBeenCalled()
  expect(error).not.toHaveBeenCalled()
})

it('clears recovery through the existing explicit-logout cleanup, retaining unrelated state', () => {
  stashContacts(owner, 'draft-a', contacts)
  sessionStorage.setItem('unrelated', 'keep')
  clearLocalSessionStorage()
  expect(readStashedContacts(owner, 'draft-a')).toBeUndefined()
  expect(sessionStorage.getItem('unrelated')).toBe('keep')
})
