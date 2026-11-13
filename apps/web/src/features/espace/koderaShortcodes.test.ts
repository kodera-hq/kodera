import { describe, expect, it } from 'vitest'
import { KODERA_EMOJI, koderaSegments } from './koderaShortcodes'
import { GLYPHS } from './KoderaEmojiGlyphs'

describe("Kodera's own emoji codes", () => {
  it('cuts the known codes out of the text in order, nothing lost or added', () => {
    const text = 'Bravo :kodera_heart: et :kodera_spark::kodera_check: !'
    const segments = koderaSegments(text)
    expect(segments).toEqual([
      { text: 'Bravo ' },
      { emoji: 'kodera_heart' },
      { text: ' et ' },
      { emoji: 'kodera_spark' },
      { emoji: 'kodera_check' },
      { text: ' !' },
    ])
  })

  it('leaves an unknown code, another case and a Unicode code as text', () => {
    for (const text of [
      ':kodera_nope:',
      ':KODERA_HEART:',
      ':wave:',
      'kodera_heart',
      ': kodera_heart :',
    ]) {
      expect(koderaSegments(text)).toEqual([{ text }])
    }
  })

  it('has a glyph for every code, and no glyph without a code', () => {
    expect(Object.keys(GLYPHS).sort()).toEqual([...KODERA_EMOJI].sort())
  })
})
