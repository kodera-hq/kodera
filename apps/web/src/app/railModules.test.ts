import { describe, expect, it } from 'vitest'
import { moduleGlyphName } from './railModules'

describe('moduleGlyphName', () => {
  it.each(['visio', 'docs', 'drive', 'messaging', 'grist'] as const)(
    'draws %s with its own glyph',
    (code) => {
      expect(moduleGlyphName(code)).toBe(code)
    }
  )

  it('falls back to a neutral glyph for a code the contract does not name', () => {
    expect(moduleGlyphName('quantum-fax')).toBe('unknown')
  })

  it('never borrows another application mark for an unknown code', () => {
    // The failure this guards is the quiet one: a fallback that happened to
    // resolve to `visio` would put a camera on a module that is not a call.
    expect(moduleGlyphName('')).not.toBe('visio')
    expect(moduleGlyphName('visio-legacy')).toBe('unknown')
  })

  it('does not treat an inherited Object property as an application code', () => {
    expect(moduleGlyphName('toString')).toBe('unknown')
    expect(moduleGlyphName('constructor')).toBe('unknown')
  })
})
