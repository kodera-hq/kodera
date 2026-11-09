import { describe, expect, it } from 'vitest'
import { isDiscoveryEmail } from '../../api/discoveryEmail'
import {
  DISCOVERY_WAIT_CAP_S,
  MAX_COUNTABLE_WAIT_S,
  emailDomain,
  emailRefusal,
  isEmailFormatValid,
  isSlugFormatValid,
  normalizeEmail,
  normalizeSlug,
  rateLimitWaitSeconds,
  unavailableWaitSeconds,
} from './discovery'

describe('normalizeEmail', () => {
  it('trims and lower-cases', () => {
    expect(normalizeEmail('  Marie.Dupont@ACME.fr  ')).toBe('marie.dupont@acme.fr')
  })
})

describe('normalizeSlug', () => {
  it('trims and lower-cases a plain slug', () => {
    expect(normalizeSlug('  ACME-SA  ')).toBe('acme-sa')
  })

  it('reduces a pasted URL to its first host label (spec §8)', () => {
    expect(normalizeSlug('https://acme-sa.kodera.io')).toBe('acme-sa')
  })

  it('reduces a pasted bare host to its first label', () => {
    expect(normalizeSlug('acme-sa.kodera.io')).toBe('acme-sa')
  })

  it('strips a path after the host', () => {
    expect(normalizeSlug('https://acme-sa.kodera.io/login')).toBe('acme-sa')
  })
})

describe('isEmailFormatValid', () => {
  it('accepts an address with an @ and a dot-bearing domain', () => {
    expect(isEmailFormatValid('marie.dupont@acme.fr')).toBe(true)
  })

  it('refuses an address with no @', () => {
    expect(isEmailFormatValid('marie.dupont-acme.fr')).toBe(false)
  })

  it('refuses an address whose domain has no dot', () => {
    expect(isEmailFormatValid('marie@acme')).toBe(false)
  })

  it('refuses an address with nothing before the @', () => {
    expect(isEmailFormatValid('@acme.fr')).toBe(false)
  })
})

describe('isSlugFormatValid', () => {
  it.each([
    ['a'.repeat(4), false],
    ['a'.repeat(5), true],
    ['a'.repeat(20), true],
    ['a'.repeat(21), false],
    ['acme', false],
    ['acme-sa', true],
    ['-acme-sa', false],
    ['acme-sa-', false],
    ['acme-sa\n', false],
  ])('checks the persisted organisation boundary for %j', (value, accepted) => {
    expect(isSlugFormatValid(value)).toBe(accepted)
  })

  it('accepts lower-case letters, digits and hyphens, 5 to 20 characters', () => {
    expect(isSlugFormatValid('acme-construction-42')).toBe(true)
  })

  it('refuses a single character', () => {
    expect(isSlugFormatValid('a')).toBe(false)
  })

  it('refuses a space or an uppercase letter', () => {
    expect(isSlugFormatValid('ACME co')).toBe(false)
  })
})

describe('emailDomain', () => {
  it('returns the part after the @', () => {
    expect(emailDomain('marie.dupont@acme.fr')).toBe('acme.fr')
  })
})

// The address checked is the address sent: `onSubmitEmail` sends `normalizeEmail(raw)`, so the
// checks run on that, not on what was typed. Lower-casing can turn a character outside ASCII into
// an ASCII one — U+212A KELVIN SIGN lower-cases to `k` — so the two orders disagree.
describe('emailRefusal', () => {
  it.each([
    ['', 'required'],
    ['   ', 'required'],
    ['marie@acme', 'incomplete'],
    ['élise.martin@acme.fr', 'refused'],
    ['marie..dupont@acme.fr', 'refused'],
    ['marie@dupont@acme.fr', 'refused'],
    ['  Marie.Dupont@ACME.fr  ', undefined],
    ['\u212Aodera@acme.fr', undefined],
  ] as const)('%j is %s', (raw, refusal) => {
    expect(emailRefusal(raw)).toBe(refusal)
  })

  it('judges the normalised address, never the raw one', () => {
    for (const raw of ['\u212Aodera@acme.fr', '  Marie@ACME.fr ', '\u0130lse@acme.fr', 'a@b.fr']) {
      expect(emailRefusal(raw) === undefined).toBe(isDiscoveryEmail(normalizeEmail(raw)))
    }
  })
})

// Realm discovery's waits (docs/specs/00-shell-and-login.md §9). `retry_after_s` arrives from the
// network: `JSON.parse('1e999')` is `Infinity`, and nothing stops a server from sending a year.
describe('rateLimitWaitSeconds', () => {
  it.each([
    ['missing', undefined, 60],
    ['zero', 0, 0],
    ['less than zero', -5, 0],
    ['a part of a second', 1.5, 2],
    ['thirty seconds', 30, 30],
    ['an hour, honoured as the spec says', 3600, 3600],
    ['a year, honoured: a countable wait is held to the end', 31_536_000, 31_536_000],
    ['the longest countable wait', MAX_COUNTABLE_WAIT_S, MAX_COUNTABLE_WAIT_S],
    ['one second past the longest countable wait', MAX_COUNTABLE_WAIT_S + 1, 60],
    ['1e306, whose deadline would be Infinity', 1e306, 60],
    ['Infinity', Infinity, 60],
    ['NaN', NaN, 60],
    ['minus Infinity', -Infinity, 0],
  ])('waits the right time when retry_after_s is %s', (_, given, wait) => {
    expect(rateLimitWaitSeconds(given)).toBe(wait)
  })
})

describe('unavailableWaitSeconds', () => {
  it.each([
    ['missing', undefined, 5],
    ['shorter than five seconds', 1, 5],
    ['a part of a second over five', 5.2, 6],
    ['twelve seconds', 12, 12],
    ['exactly the cap', DISCOVERY_WAIT_CAP_S, DISCOVERY_WAIT_CAP_S],
    ['a year', 31_536_000, DISCOVERY_WAIT_CAP_S],
    ['1e306', 1e306, DISCOVERY_WAIT_CAP_S],
    ['Infinity', Infinity, DISCOVERY_WAIT_CAP_S],
    ['NaN', NaN, 5],
    ['minus Infinity', -Infinity, 5],
  ])('waits the right time when retry_after_s is %s', (_, given, wait) => {
    expect(unavailableWaitSeconds(given)).toBe(wait)
  })

  it('caps the wait at about a minute', () => {
    expect(DISCOVERY_WAIT_CAP_S).toBe(60)
  })
})
