import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formatSecret,
  generateRecoveryCodes,
  RECOVERY_CODE_ALPHABET,
  isTotpFormatValid,
  normalizeTotpCode,
  otpauthUri,
  verifyTotpCode,
  WRONG_CODE_SENTINEL,
} from './totp'

describe('formatSecret', () => {
  it('groups the secret into 4-character blocks', () => {
    expect(formatSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP')
  })
})

describe('otpauthUri', () => {
  it('encodes the issuer, account and secret as an otpauth URI', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'julie@acme.fr', 'Kodera')
    expect(uri).toMatch(/^otpauth:\/\/totp\//)
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP')
    expect(uri).toContain('issuer=Kodera')
  })
})

describe('normalizeTotpCode', () => {
  it('strips every space, including a mid-code one', () => {
    expect(normalizeTotpCode('123 456')).toBe('123456')
    expect(normalizeTotpCode(' 1 2 3 4 5 6 ')).toBe('123456')
  })
})

describe('isTotpFormatValid', () => {
  it('accepts exactly six digits', () => {
    expect(isTotpFormatValid('123456')).toBe(true)
  })

  it('refuses fewer or more than six digits', () => {
    expect(isTotpFormatValid('12345')).toBe(false)
    expect(isTotpFormatValid('1234567')).toBe(false)
  })

  it('refuses a non-digit character', () => {
    expect(isTotpFormatValid('12345a')).toBe(false)
  })
})

describe('verifyTotpCode', () => {
  it('accepts a well-formatted code that is not the reserved sentinel', () => {
    expect(verifyTotpCode('123456')).toBe(true)
  })

  it('refuses the reserved sentinel, for the wrong-code acceptance path', () => {
    expect(verifyTotpCode(WRONG_CODE_SENTINEL)).toBe(false)
  })
})

/** The shape the recovery step displays, unchanged: two groups of four drawn
 * from the digits and the uppercase Latin letters. The generator's alphabet is
 * this same set, so nothing here was widened or narrowed to make a fix pass. */
const RECOVERY_CODE_SHAPE = /^[0-9A-Z]{4}-[0-9A-Z]{4}$/

/** Replaces the global randomness source with a fixed byte sequence, cycled for
 * as many bytes as the generator asks for. Returns the spy so a test can assert
 * how many separate draws were needed — which is how the rejection path is
 * observed from outside. `restoreMocks` plus the `afterEach` below put the real
 * `crypto` back before any other test runs. */
function stubRandomBytes(source: readonly number[]) {
  let cursor = 0
  return vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
    if (array instanceof Uint8Array) {
      for (let index = 0; index < array.length; index += 1) {
        array[index] = source[cursor % source.length] ?? 0
        cursor += 1
      }
    }
    return array
  })
}

describe('generateRecoveryCodes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('generates the requested number of unique codes', () => {
    const codes = generateRecoveryCodes(8)
    expect(codes).toHaveLength(8)
    expect(new Set(codes).size).toBe(8)
  })

  it('formats each code as two four-character groups', () => {
    const [code] = generateRecoveryCodes(1)
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
  })

  it('uses eight as the default count, all distinct', () => {
    const codes = generateRecoveryCodes()
    expect(codes).toHaveLength(8)
    expect(new Set(codes).size).toBe(8)
  })

  // The assertion above draws a single code, so a generator that emits a short
  // code a few percent of the time passes it most runs and turns a real defect
  // into an intermittent one. A large sample removes the luck: at the rate the
  // previous generator failed, a run of 1600 codes came out clean about twice
  // in 10^16.
  it('formats every code across a large sample, not just a lucky first one', () => {
    const sample: string[] = []
    for (let batch = 0; batch < 200; batch += 1) sample.push(...generateRecoveryCodes(8))
    expect(sample).toHaveLength(1600)
    expect(sample.filter((code) => !RECOVERY_CODE_SHAPE.test(code))).toEqual([])
  })

  // Bytes below 36 are exactly what the previous generator mis-rendered: it
  // mapped each byte through `toString(36)`, one character below 36 and two
  // above, so an all-low draw produced a five-character run that `slice(0, 8)`
  // could trim but never pad — `0123-4` instead of `0123-4567`.
  it('emits eight symbols even when every random byte is below the alphabet size', () => {
    stubRandomBytes([0, 1, 2, 3, 4, 5, 6, 7])
    expect(generateRecoveryCodes(1)).toEqual(['0123-4567'])
  })

  // 255 sits above the 252 ceiling. Folded with a plain modulo it would become
  // 255 % 36 = 3 and the code would read `3777-7777` from a single draw; the
  // rejection path discards it and asks for one more byte instead.
  it('rejects a byte above the unbiased ceiling and redraws rather than folding it', () => {
    const random = stubRandomBytes([255, 7, 7, 7, 7, 7, 7, 7, 7])
    expect(generateRecoveryCodes(1)).toEqual(['7777-7777'])
    expect(random).toHaveBeenCalledTimes(2)
  })

  it('draws from a duplicate-free alphabet that the displayed shape accepts', () => {
    expect(RECOVERY_CODE_ALPHABET).toMatch(/^[0-9A-Z]+$/)
    expect(RECOVERY_CODE_ALPHABET).toHaveLength(36)
    expect(new Set(RECOVERY_CODE_ALPHABET).size).toBe(RECOVERY_CODE_ALPHABET.length)
  })

  // Both redraw loops are bounded. A source stuck on one value can never fill
  // the set, and a source that only returns rejected bytes can never fill a
  // code; neither may spin, and both say what they saw.
  it('fails loudly instead of spinning when the source cannot produce distinct codes', () => {
    stubRandomBytes([9])
    expect(() => generateRecoveryCodes(2)).toThrow(
      'recovery codes: 16 draws yielded 1 unique of 2 requested'
    )
  })

  it('fails loudly instead of spinning when every byte is rejected', () => {
    stubRandomBytes([255])
    expect(() => generateRecoveryCodes(1)).toThrow(
      'recovery code: 256 random bytes yielded only 0 of 8 symbols'
    )
  })
})
