import { describe, expect, it } from 'vitest'
import { isTenantSlug } from '../../api/tenantSlug'
import { deriveSlug } from './slug'

describe('deriveSlug', () => {
  it('lowercases, drops accents and joins words with one hyphen', () => {
    expect(deriveSlug('Équipe Kodera')).toBe('equipe-kodera')
    expect(deriveSlug('  A/B  ')).toBe('a-b')
    expect(deriveSlug('Ça & Là — 2026')).toBe('ca-la-2026')
  })

  it('spells out the Latin letters that have no accent to drop', () => {
    expect(deriveSlug('Cœur de France')).toBe('coeur-de-france')
    expect(deriveSlug('Æther Straße')).toBe('aether-strasse')
    expect(deriveSlug('Ørsted Łódź Đakovo')).toBe('orsted-lodz-dakovo')
  })

  it('cuts at 32 characters and never ends on a hyphen', () => {
    expect(deriveSlug('x'.repeat(40))).toBe('x'.repeat(32))
    expect(deriveSlug(`${'a'.repeat(31)} b`)).toBe('a'.repeat(31))
    expect(isTenantSlug(deriveSlug(`Acme ${'Lab '.repeat(20)}`))).toBe(true)
  })

  it('may give a name too short for an address, which the form then opens', () => {
    expect(deriveSlug('Ça')).toBe('ca')
    expect(isTenantSlug(deriveSlug('Ça'))).toBe(false)
    expect(deriveSlug('--')).toBe('')
    expect(deriveSlug('日本')).toBe('')
  })
})
