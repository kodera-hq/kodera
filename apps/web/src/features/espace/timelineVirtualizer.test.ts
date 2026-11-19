import { describe, expect, it } from 'vitest'
import { stableKeys } from './timelineVirtualizer'

describe('the log rows’ keys (stableKeys)', () => {
  it('keeps one array while the keys stay the same, and takes the new one when they change', () => {
    const intern = stableKeys()
    const first = intern(['$a', '$b'])
    // The parent draws again with an equal array: the layout sees the same rows.
    expect(intern(['$a', '$b'])).toBe(first)
    const appended = ['$a', '$b', '$c']
    expect(intern(appended)).toBe(appended)
    const reordered = ['$b', '$a', '$c']
    expect(intern(reordered)).toBe(reordered)
    expect(intern(['$b', '$a', '$c'])).toBe(reordered)
  })
})
