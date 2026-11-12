import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '../../i18n'
import { MessageText, linkSegments } from './MessageText'

describe('the web addresses in a message', () => {
  it('are cut out of the text in order, nothing lost or added', () => {
    const text = 'Le compte rendu : https://docs.acme.fr/cr?id=4#fin et http://exemple.fr ensuite'
    const segments = linkSegments(text)
    expect(segments).toEqual([
      { text: 'Le compte rendu : ' },
      { text: 'https://docs.acme.fr/cr?id=4#fin', href: 'https://docs.acme.fr/cr?id=4#fin' },
      { text: ' et ' },
      { text: 'http://exemple.fr', href: 'http://exemple.fr/' },
      { text: ' ensuite' },
    ])
    expect(segments.map((segment) => segment.text).join('')).toBe(text)
  })

  it("leave the sentence's punctuation and an unopened parenthesis out of the address", () => {
    expect(linkSegments('Voir https://acme.fr/a.')).toEqual([
      { text: 'Voir ' },
      { text: 'https://acme.fr/a', href: 'https://acme.fr/a' },
      { text: '.' },
    ])
    expect(linkSegments('(voir https://acme.fr/a), puis…')).toEqual([
      { text: '(voir ' },
      { text: 'https://acme.fr/a', href: 'https://acme.fr/a' },
      { text: '), puis…' },
    ])
    expect(linkSegments('(voir https://acme.fr/a(b))')).toEqual([
      { text: '(voir ' },
      { text: 'https://acme.fr/a(b)', href: 'https://acme.fr/a(b)' },
      { text: ')' },
    ])
    expect(linkSegments('https://fr.wikipedia.org/wiki/Paris_(France)')).toEqual([
      {
        text: 'https://fr.wikipedia.org/wiki/Paris_(France)',
        href: 'https://fr.wikipedia.org/wiki/Paris_(France)',
      },
    ])
  })

  it('are http and https only, starting a word', () => {
    for (const text of [
      'javascript:alert(1)',
      'ftp://acme.fr/f',
      'data:text/html,<b>x</b>',
      'xhttps://acme.fr',
      'https://',
      'http://[x',
      'acme.fr',
    ]) {
      expect(linkSegments(text)).toEqual([{ text }])
    }
    expect(linkSegments('')).toEqual([])
  })

  it('stay quick on a message ending in a long run of closing parentheses', () => {
    // A Matrix event holds up to 64 KiB: re-counting the brackets for each one dropped would
    // take tens of seconds here, in every reader's tab.
    const tail = ')'.repeat(60_000)
    const started = performance.now()
    const segments = linkSegments(`https://a.example/${tail}`)
    expect(performance.now() - started).toBeLessThan(500)
    expect(segments).toEqual([
      { text: 'https://a.example/', href: 'https://a.example/' },
      { text: tail },
    ])
  })
})

describe('a message with a web address', () => {
  it('links it in a new tab with no opener and no referrer, and says so to assistive technology', () => {
    render(
      <p>
        <MessageText body="Lisez https://docs.acme.fr/cr puis <b>répondez</b>" />
      </p>
    )
    const link = screen.getByRole('link', { name: 'https://docs.acme.fr/cr' })
    expect(link).toHaveAttribute('href', 'https://docs.acme.fr/cr')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).toHaveAccessibleDescription('Ouvre un nouvel onglet')
    // The rest stays text: markup in a message is never markup on the page.
    expect(screen.getByText(/puis <b>répondez<\/b>/)).toBeInTheDocument()
    expect(document.querySelector('b')).toBeNull()
  })

  it('draws a message without one as plain text, with nothing added', () => {
    const { container } = render(
      <p>
        <MessageText body="Rien à ouvrir ici." />
      </p>
    )
    expect(container.textContent).toBe('Rien à ouvrir ici.')
    expect(screen.queryByRole('link')).toBeNull()
  })
})

describe("Kodera's own emoji in a message", () => {
  it('draws a known code as its glyph, named by its code, and leaves the rest as sent', async () => {
    render(<MessageText body="Merci :kodera_heart: et :kodera_nope: **fort** :wave:" />)
    const glyph = await screen.findByRole('img', { name: ':kodera_heart:' })
    await waitFor(() => expect(glyph.querySelector('svg')).not.toBeNull())
    // No colour of its own: the glyph takes the text's.
    expect(glyph.innerHTML).not.toMatch(/#[0-9a-f]{3,8}|rgb\(/iu)
    expect(screen.getByText(/:kodera_nope:/u)).toBeInTheDocument()
    expect(screen.getByText(/:wave:/u)).toBeInTheDocument()
    expect(screen.getByText('fort').tagName).toBe('STRONG')
  })

  it('never draws a code inside inline code, and keeps emphasis around a glyph', async () => {
    const { container } = render(
      <MessageText body={'`:kodera_heart:` puis **bravo :kodera_spark:** et \\:kodera_sun:'} />
    )
    await screen.findByRole('img', { name: ':kodera_spark:' })
    expect(container.querySelector('code')?.textContent).toBe(':kodera_heart:')
    expect(screen.queryByRole('img', { name: ':kodera_heart:' })).toBeNull()
    expect(screen.queryByRole('img', { name: ':kodera_sun:' })).toBeNull()
    const strong = container.querySelector('strong')!
    expect(strong.textContent).toContain('bravo')
    expect(strong.querySelector('[data-kodera-emoji="kodera_spark"]')).not.toBeNull()
  })
})
