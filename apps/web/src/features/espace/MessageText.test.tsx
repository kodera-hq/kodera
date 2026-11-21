import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { MessageRow } from './MessageRow'
import { MessageText, linkSegments, mentionSegments, permalinkUser } from './MessageText'
import type { MessageView } from './matrix/timeline'

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

const MIGUEL = { userId: '@miguel:kodera.test', name: 'Miguel Victoria' }
const MIG = { userId: '@mig:kodera.test', name: 'Miguel' }

describe('the mentions in a message', () => {
  it('cut out multi-word names, the longest first, full ids and the whole room, nothing lost', () => {
    const text = 'Salut @Miguel Victoria et @Miguel, @salon: voir @ana:kodera.test. mail@x.fr'
    const segments = mentionSegments(text, [MIG, MIGUEL])
    expect(segments).toEqual([
      { text: 'Salut ' },
      { text: '@Miguel Victoria', userId: MIGUEL.userId },
      { text: ' et ' },
      { text: '@Miguel', userId: MIG.userId },
      { text: ', ' },
      { text: '@salon', room: true },
      { text: ': voir ' },
      { text: '@ana:kodera.test', userId: '@ana:kodera.test' },
      { text: '. mail@x.fr' },
    ])
    expect(segments.map((segment) => segment.text).join('')).toBe(text)
  })

  it('leave an unknown name, a partial name and an address alone', () => {
    expect(mentionSegments('@Inconnu et @Migueline', [MIG])).toEqual([
      { text: '@Inconnu et @Migueline' },
    ])
  })

  it('read a member from a matrix.to permalink, and nothing else', () => {
    expect(permalinkUser('https://matrix.to/#/@miguel:kodera.test')).toBe('@miguel:kodera.test')
    expect(permalinkUser('https://matrix.to/#/%40miguel%3Akodera.test')).toBe('@miguel:kodera.test')
    expect(permalinkUser('https://matrix.to/#/!room:kodera.test')).toBeNull()
    expect(permalinkUser('https://evil.test/#/@miguel:kodera.test')).toBeNull()
  })

  it('draws members as pills that open their profile, and the room as a plain pill', async () => {
    const user = userEvent.setup()
    const open = vi.fn()
    render(
      <p>
        <MessageText
          body="@Miguel Victoria regarde, @salon aussi"
          members={[MIGUEL]}
          onMentionClick={open}
        />
      </p>
    )
    const pill = screen.getByRole('button', { name: '@Miguel Victoria' })
    await user.click(pill)
    expect(open).toHaveBeenCalledWith(MIGUEL.userId, pill)
    expect(screen.queryByRole('button', { name: '@salon' })).toBeNull()
    expect(screen.getByText('@salon')).toHaveAttribute('data-mention', 'room')
  })

  it('draws a pill as highlighted text when nothing opens a profile', () => {
    render(
      <p>
        <MessageText body="Voir https://matrix.to/#/@miguel:kodera.test" members={[MIGUEL]} />
      </p>
    )
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('@Miguel Victoria')).toHaveAttribute('data-mention', MIGUEL.userId)
  })
})

describe('markdown formatting and mention anti-spoofing', () => {
  it('renders safe markdown links, strikethrough, lists, quotes, bold mentions, and preserves inline code precedence', () => {
    const open = vi.fn()
    const { container } = render(
      <MessageText
        body={[
          'Voir [Portail Kodera](https://kodera.io/docs) et [Piège](javascript:alert(1)) et ~~ancien~~',
          'littéral `https://kodera.io` et `@Miguel Victoria` mais **@Miguel Victoria**',
          '- premier point',
          '- second point',
          '> note citée',
        ].join('\n')}
        members={[MIGUEL]}
        onMentionClick={open}
      />
    )
    const link = screen.getByRole('link', { name: 'Portail Kodera' })
    expect(link).toHaveAttribute('href', 'https://kodera.io/docs')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.queryByRole('link', { name: 'Piège' })).toBeNull()
    expect(container.textContent).toContain('[Piège](javascript:alert(1))')
    expect(container.querySelector('del')?.textContent).toBe('ancien')
    expect(Array.from(container.querySelectorAll('code')).map((el) => el.textContent)).toEqual([
      'https://kodera.io',
      '@Miguel Victoria',
    ])
    expect(screen.queryByRole('link', { name: 'https://kodera.io' })).toBeNull()
    const pills = screen.getAllByRole('button', { name: '@Miguel Victoria' })
    expect(pills).toHaveLength(1)
    expect(pills[0]!.closest('strong')).not.toBeNull()
    expect(Array.from(container.querySelectorAll('ul > li')).map((el) => el.textContent)).toEqual([
      'premier point',
      'second point',
    ])
    expect(container.querySelector('blockquote')?.textContent).toBe('note citée')
  })

  it('prevents formatted_body mention pills from impersonating room members or forging popover names', async () => {
    const user = userEvent.setup()
    const MARINA = { userId: '@marina:kodera.test', name: 'Marina Loiseau' }
    const ATTACKER = '@mallory:evil.test'
    const message: MessageView = {
      key: '$spoof',
      eventId: '$spoof',
      sender: '@sender:kodera.test',
      senderName: 'Expéditeur',
      body: 'Salut @Marina Loiseau, @Directrice et @bob:kodera.test',
      mentionPills: [
        { userId: ATTACKER, label: 'Marina Loiseau' },
        { userId: ATTACKER, label: 'Directrice' },
      ],
      ts: 1_700_000_000_000,
      delivery: 'sent',
      edited: false,
      redacted: false,
      replyTo: null,
      reactions: [],
    }
    render(
      <MessageRow
        profileRole="member"
        onMention={vi.fn()}
        message={message}
        placement="timeline"
        viewerId="@viewer:kodera.test"
        archived={false}
        expanded={false}
        repliedMessage={undefined}
        threadReplies={[]}
        menuContextKey="ctx"
        mentionMembers={[MARINA]}
        resolveMember={(userId) =>
          userId === MARINA.userId
            ? { userId: MARINA.userId, name: MARINA.name, presence: 'online', role: 'admin' }
            : { userId, name: userId, presence: 'offline', role: 'member' }
        }
        onRetry={vi.fn()}
        onReaction={vi.fn()}
        onReply={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onOpenThread={vi.fn()}
      />
    )

    // Authoritative Marina cannot be hijacked to @mallory:evil.test.
    await user.click(screen.getByRole('button', { name: '@Marina Loiseau' }))
    const marinaDialog = await screen.findByRole('dialog', { name: 'Marina Loiseau' })
    expect(marinaDialog).toHaveTextContent('@marina:kodera.test')
    expect(marinaDialog).not.toHaveTextContent(ATTACKER)
    await user.keyboard('{Escape}')

    // Unknown userId with forged label "Directrice" never shows "Directrice" as authoritative identity.
    await user.click(screen.getByRole('button', { name: '@Directrice' }))
    const attackerDialog = await screen.findByRole('dialog', { name: ATTACKER })
    expect(attackerDialog).toHaveTextContent(ATTACKER)
    expect(screen.queryByRole('heading', { name: 'Directrice' })).toBeNull()
    await user.keyboard('{Escape}')

    // Plain-text MXID without formatted_body is also clickable.
    await user.click(screen.getByRole('button', { name: '@bob:kodera.test' }))
    expect(await screen.findByRole('dialog', { name: '@bob:kodera.test' })).toBeInTheDocument()
  })

  it('does not split @bob:two.test, @bob-smith, @bob_admin, or @room-notes into local bob or @room pills', () => {
    const BOB = { userId: '@bob-uuid:one.test', name: 'bob' }
    const text = 'Salut @bob ! Voir @bob:two.test, @bob-smith, @bob_admin et @room-notes.'
    const segments = mentionSegments(text, [BOB])
    expect(segments).toEqual([
      { text: 'Salut ' },
      { text: '@bob', userId: BOB.userId },
      { text: ' ! Voir ' },
      { text: '@bob:two.test', userId: '@bob:two.test' },
      { text: ', @bob-smith, @bob_admin et @room-notes.' },
    ])

    const { container } = render(
      <MessageText body={text} members={[BOB]} onMentionClick={vi.fn()} />
    )
    const mentionNodes = Array.from(container.querySelectorAll('[data-mention]')).map((el) => ({
      text: el.textContent,
      target: el.getAttribute('data-mention'),
    }))
    expect(mentionNodes).toEqual([
      { text: '@bob', target: BOB.userId },
      { text: '@bob:two.test', target: '@bob:two.test' },
    ])
  })

  it('rejects @room123 and @salon_x as room mentions and pins @alice:server.org to its explicit MXID', () => {
    const ALICE_LOCAL = { userId: '@alice:kodera.test', name: 'alice' }
    const ALICE_REMOTE_NAMED = { userId: '@alice:server.org', name: 'Alice Martin' }
    const text =
      'Test @room123, @salon_x, @salon_ vs @room et @salon; voir @alice:server.org, @alice et @Alice Martin.'
    const segments = mentionSegments(text, [ALICE_LOCAL, ALICE_REMOTE_NAMED])
    expect(segments).toEqual([
      { text: 'Test @room123, @salon_x, @salon_ vs ' },
      { text: '@room', room: true },
      { text: ' et ' },
      { text: '@salon', room: true },
      { text: '; voir ' },
      { text: '@alice:server.org', userId: '@alice:server.org' },
      { text: ', ' },
      { text: '@alice', userId: ALICE_LOCAL.userId },
      { text: ' et ' },
      { text: '@Alice Martin', userId: ALICE_REMOTE_NAMED.userId },
      { text: '.' },
    ])

    const { container } = render(
      <MessageText
        body={text}
        members={[ALICE_LOCAL, ALICE_REMOTE_NAMED]}
        onMentionClick={vi.fn()}
      />
    )
    const mentionNodes = Array.from(container.querySelectorAll('[data-mention]')).map((el) => ({
      text: el.textContent,
      target: el.getAttribute('data-mention'),
    }))
    expect(mentionNodes).toEqual([
      { text: '@room', target: 'room' },
      { text: '@salon', target: 'room' },
      { text: '@alice:server.org', target: '@alice:server.org' },
      { text: '@alice', target: '@alice:kodera.test' },
      { text: '@Alice Martin', target: '@alice:server.org' },
    ])
  })

  it('renders 64 KiB adversarial unclosed bracket runs in linear time', () => {
    const adversarial = '['.repeat(65_536)
    const started = performance.now()
    const { container } = render(<MessageText body={adversarial} />)
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(50)
    expect(container.textContent).toHaveLength(65_536)
  })
})
