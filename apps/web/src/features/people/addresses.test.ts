import { describe, expect, it } from 'vitest'
import { MAX_ADDRESSES, parseAddresses } from './addresses'

describe('parseAddresses (03-people.md §8)', () => {
  it('splits a spreadsheet paste on commas, semicolons, tabs, spaces and newlines', () => {
    const parsed = parseAddresses(
      'julie.leroy@acme.fr, marc.petit@acme.fr\nsamir.benali@acme.fr;\tcamille@acme.fr anne@acme.fr'
    )
    expect(parsed.valid).toEqual([
      'julie.leroy@acme.fr',
      'marc.petit@acme.fr',
      'samir.benali@acme.fr',
      'camille@acme.fr',
      'anne@acme.fr',
    ])
    expect(parsed.invalid).toEqual([])
    expect(parsed.duplicates).toBe(0)
  })

  it('reduces "Nom <a@b.fr>" to the address', () => {
    expect(parseAddresses('Marc Petit <marc.petit@acme.fr>, Julie <julie@acme.fr>').valid).toEqual([
      'marc.petit@acme.fr',
      'julie@acme.fr',
    ])
  })

  it('collapses duplicates case-insensitively and counts them', () => {
    const parsed = parseAddresses('marc@acme.fr\nMarc@Acme.fr\nmarc@acme.fr\njulie@acme.fr')
    expect(parsed.valid).toEqual(['marc@acme.fr', 'julie@acme.fr'])
    expect(parsed.duplicates).toBe(2)
  })

  it('keeps invalid addresses apart, in input order', () => {
    const parsed = parseAddresses('pierre@, jean.martin@acme..fr, ok@acme.fr, sans-arobase')
    expect(parsed.valid).toEqual(['ok@acme.fr'])
    expect(parsed.invalid).toEqual(['pierre@', 'jean.martin@acme..fr', 'sans-arobase'])
  })

  it('returns nothing for blank input', () => {
    expect(parseAddresses('  \n ,; ')).toEqual({ valid: [], invalid: [], duplicates: 0 })
  })

  it('caps a submission at 200 addresses', () => {
    expect(MAX_ADDRESSES).toBe(200)
  })
})
