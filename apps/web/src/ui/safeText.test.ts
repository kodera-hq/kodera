import { describe, expect, it } from 'vitest'
import { cleanText } from './safeText'

describe('cleanText', () => {
  it('strips bidi overrides, ALM, soft hyphens, CGJ, invisible operators, deprecated formatters and Unicode tags', () => {
    const poisoned = [
      '\u00AD', // soft hyphen
      '\u034F', // combining grapheme joiner
      '\u061C', // Arabic letter mark
      '\u200B\u200E\u200F', // ZWSP, LRM, RLM
      '\u202A\u202E\u202C', // LRE, RLO, PDF
      '\u2060\u2061\u2062\u2063\u2064', // word joiner + invisible math operators
      '\u2066\u2067\u2068\u2069', // LRI, RLI, FSI, PDI
      '\u206A\u206B\u206C\u206D\u206E\u206F', // deprecated shaping/numeric formatters
      '\uFEFF', // BOM / ZWNBSP
      '\u{E0001}\u{E0041}\u{E007F}', // Unicode tag block
    ].join('')
    expect(cleanText(`Alice${poisoned} Martin`, 80)).toBe('Alice Martin')
  })

  it('collapses whitespace, trims, truncates by code point and ignores non-strings', () => {
    expect(cleanText(null, 80)).toBe('')
    expect(cleanText(42, 80)).toBe('')
    expect(cleanText('  Bonjour   tout\n\tle  monde  ', 80)).toBe('Bonjour tout le monde')
    expect(cleanText('abcdefghij', 5)).toBe('abcd\u2026')
  })
})
