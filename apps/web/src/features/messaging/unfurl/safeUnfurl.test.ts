import { describe, expect, it } from 'vitest'
import { cleanText, safeHref, safeUnfurl } from './safeUnfurl'

const SENT = 'https://exemple.fr/article?id=4'

function result(overrides: Record<string, unknown> = {}) {
  return {
    url: SENT,
    canonicalUrl: 'https://exemple.fr/article',
    title: 'Un article',
    description: 'Ce qu’il dit, en bref.',
    siteName: 'Exemple',
    ...overrides,
  }
}

describe('a link preview', () => {
  it('keeps a plain https card, leading to its canonical address on the same site', () => {
    expect(safeUnfurl(result(), SENT)).toEqual({
      href: 'https://exemple.fr/article',
      host: 'exemple.fr',
      title: 'Un article',
      description: 'Ce qu’il dit, en bref.',
      siteName: 'Exemple',
    })
  })

  it('refuses every address that is not http or https, as the card or as its canonical address', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java\tscript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://exemple.fr/uuid',
      'https://user:pass@exemple.fr/',
    ]) {
      expect(safeHref(bad)).toBeNull()
      expect(safeUnfurl(result({ url: bad }), SENT)).toBeNull()
      expect(safeUnfurl(result({ canonicalUrl: bad }), SENT)).toBeNull()
      expect(safeUnfurl(result({ url: bad }), bad)).toBeNull()
    }
  })

  it('refuses a card for another address than the one in the message', () => {
    expect(safeUnfurl(result({ url: 'https://autre.fr/' }), SENT)).toBeNull()
  })

  it('matches the address Core fetched, which escapes `|` and drops the fragment', () => {
    // Core's canonical form (apps/server/apps/media/outbound.py): quote() and no fragment.
    const sent = 'https://exemple.fr/doc|v2/[a]^b?x=1#section'
    const card = safeUnfurl(result({ url: 'https://exemple.fr/doc%7Cv2/%5Ba%5D%5Eb?x=1', canonicalUrl: undefined }), sent)
    expect(card?.title).toBe('Un article')
    expect(card?.href).toBe(new URL(sent).href)
  })

  it('still refuses a card whose path differs only by an escaped slash or query mark', () => {
    expect(safeUnfurl(result({ url: 'https://exemple.fr/article%3Fid=4' }), SENT)).toBeNull()
    expect(safeUnfurl(result({ url: 'https://exemple.fr/a%2Fb' }), 'https://exemple.fr/a/b')).toBeNull()
  })

  it('does not follow a canonical address on another site', () => {
    expect(safeUnfurl(result({ canonicalUrl: 'https://piege.example/' }), SENT)?.href).toBe(SENT)
  })

  it('refuses a card with nothing to say, and anything that is not an object', () => {
    expect(safeUnfurl(result({ title: '', description: '  ' }), SENT)).toBeNull()
    expect(safeUnfurl(null, SENT)).toBeNull()
    expect(safeUnfurl('<html>', SENT)).toBeNull()
  })

  it('shows markup as text, and drops control and direction characters', () => {
    const card = safeUnfurl(
      result({ title: '<img src=x onerror=alert(1)>\u202Egnp.exe', description: 'a\u0000b\n\nc' }),
      SENT
    )!
    expect(card.title).toBe('<img src=x onerror=alert(1)>gnp.exe')
    expect(card.description).toBe('ab c')
  })

  it('cuts long text on a character, never inside one', () => {
    expect([...cleanText('😀'.repeat(200), 120)]).toHaveLength(120)
    expect(cleanText('😀'.repeat(200), 120).endsWith('…')).toBe(true)
    expect(cleanText(42, 10)).toBe('')
  })
})
