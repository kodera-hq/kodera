import { describe, expect, it } from 'vitest'
import { agreementsSchema, contactsSchema, headcountSchema, quoteSchema } from './schemas'

// 01-order.md §8: every message is a catalogue key, never a sentence — the
// schemas below never construct English or French text, only the dotted key
// a screen looks up through `t()`.

describe('headcountSchema', () => {
  it('accepts an integer between 1 and 100000', () => {
    expect(headcountSchema.safeParse(120).success).toBe(true)
    expect(headcountSchema.safeParse(1).success).toBe(true)
    expect(headcountSchema.safeParse(100_000).success).toBe(true)
  })

  it('rejects zero, a fraction, and anything above 100000', () => {
    expect(headcountSchema.safeParse(0).success).toBe(false)
    expect(headcountSchema.safeParse(3.5).success).toBe(false)
    expect(headcountSchema.safeParse(100_001).success).toBe(false)
  })

  it('carries the catalogue key, not a sentence', () => {
    const result = headcountSchema.safeParse(0)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('console.order.plan.error-headcount-range')
    }
  })
})

const validContacts = {
  legalName: 'ACME Construction',
  slug: 'acme',
  country: 'FR',
  registrationNumber: '830485108',
  vatNumber: '',
  addressLine1: '12 rue des Lilas',
  postalCode: '75011',
  city: 'Paris',
  billingReference: '',
  adminEmail: 'marie.dupont@acme.fr',
  billingEmail: 'compta@acme.fr',
  securityEmail: 'dpo@acme.fr',
}

describe('contactsSchema', () => {
  it('accepts a fully filled-in form', () => {
    expect(contactsSchema.safeParse(validContacts).success).toBe(true)
  })

  it('requires a legal name of 2 to 120 characters', () => {
    expect(contactsSchema.safeParse({ ...validContacts, legalName: 'A' }).success).toBe(false)
    expect(contactsSchema.safeParse({ ...validContacts, legalName: '' }).success).toBe(false)
  })

  it('requires the tenant slug shape the contract carries: 3-32 chars, a DNS label', () => {
    expect(contactsSchema.safeParse({ ...validContacts, slug: 'ac' }).success).toBe(false)
    expect(contactsSchema.safeParse({ ...validContacts, slug: 'abc' }).success).toBe(true)
    expect(contactsSchema.safeParse({ ...validContacts, slug: 'a'.repeat(32) }).success).toBe(true)
    expect(contactsSchema.safeParse({ ...validContacts, slug: 'a'.repeat(33) }).success).toBe(false)
    expect(contactsSchema.safeParse({ ...validContacts, slug: '-acme' }).success).toBe(false)
    expect(contactsSchema.safeParse({ ...validContacts, slug: 'acme-' }).success).toBe(false)
    expect(contactsSchema.safeParse({ ...validContacts, slug: 'ACME' }).success).toBe(false)
    expect(contactsSchema.safeParse({ ...validContacts, slug: 'acme fr' }).success).toBe(false)
    expect(contactsSchema.safeParse({ ...validContacts, slug: 'acme-construction' }).success).toBe(
      true
    )
    // A DNS label admits consecutive hyphens and the contract's pattern does too. The form
    // used to refuse this; a screen stricter than the API turns a name the API would take
    // into a format error the buyer cannot act on.
    expect(contactsSchema.safeParse({ ...validContacts, slug: 'acme--fr' }).success).toBe(true)
  })

  it('names the slug key for a wrong length and for a wrong shape alike', () => {
    for (const slug of ['ab', 'a'.repeat(33), 'ACME']) {
      const result = contactsSchema.safeParse({ ...validContacts, slug })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.message)).toContain(
          'console.order.contacts.error-slug-format'
        )
      }
    }
  })

  it('requires a 9-digit registration number when the country is France', () => {
    expect(contactsSchema.safeParse({ ...validContacts, registrationNumber: '123' }).success).toBe(
      false
    )
    expect(
      contactsSchema.safeParse({ ...validContacts, country: 'BE', registrationNumber: '123' })
        .success
    ).toBe(true)
  })

  it('leaves the VAT number optional but format-checked when present', () => {
    expect(contactsSchema.safeParse({ ...validContacts, vatNumber: '' }).success).toBe(true)
    expect(contactsSchema.safeParse({ ...validContacts, vatNumber: 'FR12830485108' }).success).toBe(
      true
    )
    expect(contactsSchema.safeParse({ ...validContacts, vatNumber: 'not-a-vat' }).success).toBe(
      false
    )
  })

  it('requires every address field', () => {
    expect(contactsSchema.safeParse({ ...validContacts, addressLine1: '' }).success).toBe(false)
    expect(contactsSchema.safeParse({ ...validContacts, postalCode: '' }).success).toBe(false)
    expect(contactsSchema.safeParse({ ...validContacts, city: '' }).success).toBe(false)
    expect(contactsSchema.safeParse({ ...validContacts, country: '' }).success).toBe(false)
  })

  it('caps the billing reference at 60 characters and leaves it optional', () => {
    expect(contactsSchema.safeParse({ ...validContacts, billingReference: '' }).success).toBe(true)
    expect(
      contactsSchema.safeParse({ ...validContacts, billingReference: 'x'.repeat(60) }).success
    ).toBe(true)
    expect(
      contactsSchema.safeParse({ ...validContacts, billingReference: 'x'.repeat(61) }).success
    ).toBe(false)
  })

  it('requires the three contact emails to be valid addresses', () => {
    expect(contactsSchema.safeParse({ ...validContacts, adminEmail: 'not-an-email' }).success).toBe(
      false
    )
    expect(
      contactsSchema.safeParse({ ...validContacts, billingEmail: 'not-an-email' }).success
    ).toBe(false)
    expect(
      contactsSchema.safeParse({ ...validContacts, securityEmail: 'not-an-email' }).success
    ).toBe(false)
  })
})

describe('agreementsSchema', () => {
  it('refuses submission until the checkbox is ticked', () => {
    expect(agreementsSchema.safeParse({ accepted: false }).success).toBe(false)
    expect(agreementsSchema.safeParse({ accepted: true }).success).toBe(true)
  })
})

describe('quoteSchema', () => {
  it('accepts a filled-in form', () => {
    expect(
      quoteSchema.safeParse({
        headcount: 500,
        country: 'FR',
        needs: 'Nous cherchons une solution pour 500 personnes.',
        contactEmail: 'julie@acme.fr',
      }).success
    ).toBe(true)
  })

  it('requires every field', () => {
    expect(
      quoteSchema.safeParse({ headcount: 0, country: '', needs: '', contactEmail: '' }).success
    ).toBe(false)
  })
})
