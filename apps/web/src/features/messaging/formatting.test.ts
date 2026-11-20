import { describe, expect, it } from 'vitest'
import { formatSelection, insertLink, safeLinkHref } from './formatting'

describe('the formatting toolbar', () => {
  it('wraps the selection, and unwraps it when pressed again instead of writing ****', () => {
    const once = formatSelection('hello', 0, 5, 'bold')
    expect(once).toEqual({ text: '**hello**', start: 2, end: 7 })
    expect(formatSelection(once.text, once.start, once.end, 'bold')).toEqual({
      text: 'hello',
      start: 0,
      end: 5,
    })
    const empty = formatSelection('', 0, 0, 'bold')
    expect(empty.text).toBe('****')
    expect(formatSelection(empty.text, empty.start, empty.end, 'bold').text).toBe('')
  })

  it('unwraps a selection that holds its own markers', () => {
    expect(formatSelection('a **b** c', 2, 7, 'bold')).toEqual({ text: 'a b c', start: 2, end: 3 })
    expect(formatSelection('~~x~~', 0, 5, 'strike').text).toBe('x')
  })

  it('does not take a bold’s inner star for an italic', () => {
    expect(formatSelection('**hi**', 2, 4, 'italic').text).toBe('***hi***')
    expect(formatSelection('***hi***', 3, 5, 'italic').text).toBe('**hi**')
  })

  it('prefixes lines with a bullet or a quote, and takes it off again', () => {
    const listed = formatSelection('un\ndeux', 0, 7, 'bullet')
    expect(listed.text).toBe('- un\n- deux')
    expect(formatSelection(listed.text, listed.start, listed.end, 'bullet').text).toBe('un\ndeux')
    expect(formatSelection('a\nb', 2, 2, 'quote').text).toBe('a\n> b')
  })

  it('writes a link over the selection, with only web addresses admitted', () => {
    expect(insertLink('voir ici', 5, 8, '', 'https://kodera.io/')).toEqual({
      text: 'voir [ici](https://kodera.io/)',
      start: 30,
      end: 30,
    })
    expect(insertLink('', 0, 0, 'a [b]', 'https://x.test/').text).toBe(
      '[a \\[b\\]](https://x.test/)'
    )
    expect(insertLink('', 0, 0, 'foo\\', 'https://kodera.io').text).toBe(
      '[foo\\\\](https://kodera.io)'
    )
    expect(insertLink('', 0, 0, 'a\\[b]\\', 'https://kodera.io').text).toBe(
      '[a\\\\\\[b\\]\\\\](https://kodera.io)'
    )
    expect(safeLinkHref('kodera.io')).toBe('https://kodera.io/')
    expect(safeLinkHref('javascript:alert(1)')).toBeNull()
    expect(safeLinkHref('  ')).toBeNull()
  })
})
