// The discovery e-mail rule is the contract's, to the character.
//
// The rule is copied, not generated (`schema.d.ts` has no `pattern`), so a pin bump that
// changes it would leave the sign-in screen checking the previous contract's rule — and a
// person whose address the new rule refuses would get the generic message on a `422`
// instead of the specific one before submitting. Reading the pinned document here is what
// makes the copy fail loudly instead.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  DISCOVERY_EMAIL_MAX_LENGTH,
  DISCOVERY_EMAIL_PATTERN,
  isDiscoveryEmail,
} from './discoveryEmail'

const CONTRACT_PATH = join(import.meta.dirname, '..', '..', 'contracts', 'core-api.openapi.yaml')

interface EmailProperty {
  pattern?: unknown
  maxLength?: unknown
}

const contract = parse(readFileSync(CONTRACT_PATH, 'utf8')) as {
  components: { schemas: { RealmDiscoveryRequest: { properties: { email: EmailProperty } } } }
}
const declared = contract.components.schemas.RealmDiscoveryRequest.properties.email

describe('DISCOVERY_EMAIL_PATTERN', () => {
  it('is the pattern the pinned contract carries on RealmDiscoveryRequest.email', () => {
    expect(typeof declared.pattern).toBe('string')
    expect(DISCOVERY_EMAIL_PATTERN.source).toBe(declared.pattern)
  })

  it('carries no flag the contract does not', () => {
    expect(DISCOVERY_EMAIL_PATTERN.flags).toBe('')
  })

  it('has the length limit the pinned contract carries', () => {
    expect(DISCOVERY_EMAIL_MAX_LENGTH).toBe(declared.maxLength)
  })
})

describe('isDiscoveryEmail', () => {
  it.each([
    'marie.dupont@acme.fr',
    'marie+factures@acme-construction.fr',
    "o'brien@example.co.uk",
    'x@a1.fr',
    `${'a'.repeat(64)}@acme.fr`,
  ])('accepts %j', (value) => {
    expect(isDiscoveryEmail(value)).toBe(true)
  })

  it.each([
    ['an accented letter', 'élise@acme.fr'],
    ['an accented domain', 'marie@société.fr'],
    ['a space', 'marie dupont@acme.fr'],
    ['two dots in a row', 'marie..dupont@acme.fr'],
    ['a dot at the start', '.marie@acme.fr'],
    ['a dot before the @', 'marie.@acme.fr'],
    ['two @', 'marie@dupont@acme.fr'],
    ['a domain with one label', 'marie@acme'],
    ['a label starting with a hyphen', 'marie@-acme.fr'],
    ['a label ending with a hyphen', 'marie@acme-.fr'],
    ['an underscore in the domain', 'marie@acme_sa.fr'],
    ['a trailing newline', 'marie@acme.fr\n'],
    ['65 characters before the @', `${'a'.repeat(65)}@acme.fr`],
    ['a label of 64 characters', `marie@${'a'.repeat(64)}.fr`],
  ])('refuses %s', (_, value) => {
    expect(isDiscoveryEmail(value)).toBe(false)
  })

  it('refuses an address longer than 254 characters the pattern alone would accept', () => {
    const label = 'a'.repeat(63)
    const long = `marie@${[label, label, label, label].join('.')}.fr`
    expect(long.length).toBeGreaterThan(DISCOVERY_EMAIL_MAX_LENGTH)
    expect(DISCOVERY_EMAIL_PATTERN.test(long)).toBe(true)
    expect(isDiscoveryEmail(long)).toBe(false)
  })
})
