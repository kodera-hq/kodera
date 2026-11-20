import { describe, expect, it } from 'vitest'
import { markdownToHtml, userPermalink } from './markdownHtml'

describe('the outgoing formatted_body', () => {
  it('is null for plain text, so only body is sent', () => {
    expect(markdownToHtml('Bonjour à tous')).toBeNull()
    expect(markdownToHtml('2 * 3 = 6')).toBeNull()
  })

  it('compiles bold, italic, strike, inline code and links', () => {
    expect(markdownToHtml('**gras** *ital* ~~barré~~ `x<y`')).toBe(
      '<strong>gras</strong> <em>ital</em> <del>barré</del> <code>x&lt;y</code>'
    )
    expect(markdownToHtml('[le site](https://kodera.io/a?b=1&c=2)')).toBe(
      '<a href="https://kodera.io/a?b=1&amp;c=2">le site</a>'
    )
  })

  it('escapes every character the member typed and refuses script links', () => {
    expect(markdownToHtml('**<img src=x onerror=alert(1)>**')).toBe(
      '<strong>&lt;img src=x onerror=alert(1)&gt;</strong>'
    )
    expect(markdownToHtml('[x](javascript:alert(1)) **a**')).toBe(
      '[x](javascript:alert(1)) <strong>a</strong>'
    )
  })

  it('draws lists, quotes, code blocks and line breaks', () => {
    expect(markdownToHtml('Liste :\n- un\n- **deux**')).toBe(
      'Liste :<ul><li>un</li><li><strong>deux</strong></li></ul>'
    )
    expect(markdownToHtml('> cité\n> encore')).toBe('<blockquote>cité<br>encore</blockquote>')
    expect(markdownToHtml('```ts\nconst a = <b>\n```')).toBe(
      '<pre><code class="language-ts">const a = &lt;b&gt;</code></pre>'
    )
    expect(markdownToHtml('**a**\nb')).toBe('<strong>a</strong><br>b')
  })

  it('links mentions to the member’s matrix.to permalink, multi-word names included', () => {
    const miguel = { userId: '@miguel:kodera.test', label: 'Miguel Victoria' }
    expect(markdownToHtml('Merci @Miguel Victoria !', [miguel])).toBe(
      `Merci <a href="${userPermalink(miguel.userId)}">@Miguel Victoria</a> !`
    )
    expect(userPermalink('@miguel:kodera.test')).toBe('https://matrix.to/#/@miguel:kodera.test')
  })
})
