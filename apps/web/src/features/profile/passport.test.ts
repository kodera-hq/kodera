import { describe, expect, it } from 'vitest'
import { EMPTY_PASSPORT, isPlaceholderName, passportOf } from './passport'

describe('the Kodera Passport', () => {
  it('reads only what is as written: a known accent, a clean bio, at most four tags', () => {
    expect(passportOf(null)).toEqual(EMPTY_PASSPORT)
    expect(
      passportOf({
        accent: 't3',
        bio: '  Chef de chantier‮  ',
        tags: ['BTP', 'BTP', '', 7, 'Lyon', 'a', 'b', 'c'],
        onboarded: true,
      })
    ).toEqual({
      accent: 't3',
      bio: 'Chef de chantier',
      tags: ['BTP', 'Lyon', 'a', 'b'],
      onboarded: true,
    })
    expect(passportOf({ accent: 'crimson' }).accent).toBe('cobalt')
    expect(passportOf({ bio: 'x'.repeat(400) }).bio).toHaveLength(160)
  })

  it('offers itself to a member whose name is no chosen name', () => {
    const id = '@32dc5a1e-0000-7000-8000-000000000000:acme.kodera.test'
    expect(isPlaceholderName(undefined, id)).toBe(true)
    expect(isPlaceholderName('32dc', id)).toBe(true)
    expect(isPlaceholderName('qa+lane3', id)).toBe(true)
    expect(isPlaceholderName('jane.doe@acme.fr', id)).toBe(true)
    expect(isPlaceholderName('miguel', '@miguel:acme.kodera.test')).toBe(true)
    expect(isPlaceholderName('Miguel Victoria', id)).toBe(false)
    expect(isPlaceholderName('Élodie', id)).toBe(false)
  })
})
