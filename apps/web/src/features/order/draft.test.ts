import { describe, expect, it } from 'vitest'
import { emptyDraft, furthestStep, parseDraft, serializeDraft } from './draft'

// 01-order.md §5 "Resume rule": a draft order is created on the first change
// on `plan`. There is no server-side draft (§6) — the wizard's own state
// lives in the browser until the last button, keyed by a client-generated
// `orderId` that only ever appears in the URL and in `localStorage`, never
// sent to the Core API. These are the pure functions that logic runs on, kept
// apart from the `localStorage` binding so they can be tested without a DOM.

describe('serializeDraft / parseDraft', () => {
  it('round-trips a draft through JSON', () => {
    const draft = { ...emptyDraft(), headcount: 120, packCode: 'visio-docs' }
    expect(parseDraft(serializeDraft(draft))).toEqual(draft)
  })

  it('returns undefined for anything that is not a valid draft', () => {
    expect(parseDraft(undefined)).toBeUndefined()
    expect(parseDraft('not json')).toBeUndefined()
    expect(parseDraft('null')).toBeUndefined()
    expect(parseDraft('42')).toBeUndefined()
    expect(parseDraft('{}')).toBeUndefined()
  })
})

describe('furthestStep', () => {
  it('starts at plan for an empty draft', () => {
    expect(furthestStep(emptyDraft())).toBe('plan')
  })

  it('advances to contacts once a plan is chosen', () => {
    const draft = { ...emptyDraft(), packCode: 'visio', capacityTierCode: 'M' }
    expect(furthestStep(draft)).toBe('contacts')
  })

  it('advances to agreements once the contact details are filled in', () => {
    const draft = {
      ...emptyDraft(),
      packCode: 'visio',
      capacityTierCode: 'M',
      contacts: {
        legalName: 'ACME',
        slug: 'acme',
        registrationNumber: '830485108',
        vatNumber: '',
        addressLine1: '12 rue des Lilas',
        postalCode: '75011',
        city: 'Paris',
        country: 'FR',
        billingReference: '',
        adminEmail: 'a@acme.fr',
        billingEmail: 'b@acme.fr',
        securityEmail: 'c@acme.fr',
      },
    }
    expect(furthestStep(draft)).toBe('agreements')
  })

  it('advances to confirmation once the order is placed', () => {
    const draft = {
      ...emptyDraft(),
      packCode: 'visio',
      capacityTierCode: 'M',
      contacts: {
        legalName: 'ACME',
        slug: 'acme',
        registrationNumber: '830485108',
        vatNumber: '',
        addressLine1: '12 rue des Lilas',
        postalCode: '75011',
        city: 'Paris',
        country: 'FR',
        billingReference: '',
        adminEmail: 'a@acme.fr',
        billingEmail: 'b@acme.fr',
        securityEmail: 'c@acme.fr',
      },
      orderId: 'a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f',
    }
    expect(furthestStep(draft)).toBe('confirmation')
  })
})
