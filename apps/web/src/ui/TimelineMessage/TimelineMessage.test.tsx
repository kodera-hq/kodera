import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TimelineMessage } from './TimelineMessage'
import type { TimelineMessageProps } from './TimelineMessage'

function setup(props: Partial<TimelineMessageProps> = {}) {
  return render(
    <TimelineMessage
      author="Claire Dubois"
      dateTime="2026-10-22T09:31:00+02:00"
      timeLabel="09:31"
      {...props}
    >
      {props.children ?? <p>Mise en ligne jeudi à 7 h.</p>}
    </TimelineMessage>
  )
}

describe('TimelineMessage', () => {
  it('is an article named by its author and time', () => {
    setup()
    const article = screen.getByRole('article', { name: 'Claire Dubois 09:31' })
    expect(within(article).getByText('Mise en ligne jeudi à 7 h.')).toBeInTheDocument()
  })

  it('draws a 40 px avatar and the time in tabular figures in a <time>', () => {
    setup()
    const article = screen.getByRole('article')
    expect(article.querySelector('.rounded-full')).toHaveClass('h-10', 'w-10')
    const time = within(article).getByText('09:31')
    expect(time.tagName).toBe('TIME')
    expect(time).toHaveAttribute('dateTime', '2026-10-22T09:31:00+02:00')
    expect(time).toHaveClass('tabular-nums')
  })

  it('shows the edited marker only when given', () => {
    const { rerender } = setup({ edited: '(modifié)' })
    expect(screen.getByText('(modifié)')).toBeInTheDocument()
    rerender(
      <TimelineMessage author="Claire Dubois" dateTime="2026-10-22T09:31" timeLabel="09:31">
        <p>x</p>
      </TimelineMessage>
    )
    expect(screen.queryByText('(modifié)')).toBeNull()
  })

  it('quotes the message it answers, the label read before it', () => {
    setup({ reply: { label: 'En réponse à', author: 'Paul Ferrand', excerpt: 'Jeudi 7 h ?' } })
    const article = screen.getByRole('article')
    expect(within(article).getByText('En réponse à')).toHaveClass('sr-only')
    expect(within(article).getByText('Paul Ferrand')).toBeInTheDocument()
    expect(within(article).getByText('Jeudi 7 h ?')).toBeInTheDocument()
  })

  it('makes each reaction a toggle named in words, which calls back', async () => {
    const user = userEvent.setup()
    const onLike = vi.fn()
    const onThanks = vi.fn()
    setup({
      reactions: [
        {
          key: '👍',
          emoji: '👍',
          count: 3,
          mine: true,
          label: '👍 3, vous avez réagi',
          onToggle: onLike,
        },
        { key: '🙏', emoji: '🙏', count: 1, mine: false, label: '🙏 1', onToggle: onThanks },
      ],
    })
    const mine = screen.getByRole('button', { name: '👍 3, vous avez réagi' })
    expect(mine).toHaveAttribute('aria-pressed', 'true')
    expect(mine).toHaveClass('border-c-accent-ink', 'bg-c-accent-soft')
    const other = screen.getByRole('button', { name: '🙏 1' })
    expect(other).toHaveAttribute('aria-pressed', 'false')
    expect(other).toHaveClass('border-c-border')
    await user.click(mine)
    other.focus()
    await user.keyboard('{Enter}')
    expect(onLike).toHaveBeenCalledTimes(1)
    expect(onThanks).toHaveBeenCalledTimes(1)
  })

  it('opens its thread from an ink button that says how many replies', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    setup({ thread: { label: '6 réponses', onOpen, expanded: false } })
    const button = screen.getByRole('button', { name: '6 réponses' })
    expect(button).toHaveClass('text-c-ink', 'hover:underline', 'focus-visible:ring')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    await user.click(button)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('marks a mention of the viewer with a bar and words in the name, and no tint', () => {
    setup({ mention: 'vous mentionne' })
    const article = screen.getByRole('article', { name: 'Claire Dubois 09:31 vous mentionne' })
    expect(article).not.toHaveClass('bg-c-accent-soft')
    expect(article.querySelector('[data-bar]')).toHaveClass('bg-c-accent-ink')
  })

  it('passes the exact thread button synchronously for pointer and keyboard activation', async () => {
    const user = userEvent.setup()
    const targets: HTMLButtonElement[] = []
    setup({
      thread: {
        label: '6 réponses',
        onOpen: (event) => targets.push(event.currentTarget),
      },
    })
    const button = screen.getByRole('button', { name: '6 réponses' })
    await user.click(button)
    button.focus()
    await user.keyboard('{Enter}')
    expect(targets).toEqual([button, button])
  })

  it('tints the focused message, whose thread is open, and draws the bar', () => {
    setup({ focused: true })
    const article = screen.getByRole('article', { name: 'Claire Dubois 09:31' })
    expect(article).toHaveClass('bg-c-accent-soft')
    expect(article).not.toHaveClass('hover:bg-c-muted')
    expect(article.querySelector('[data-bar]')).toHaveClass('bg-c-accent-ink')
  })

  it('treats an empty mention as none, in the look and the name alike', () => {
    setup({ mention: '' })
    const article = screen.getByRole('article', { name: 'Claire Dubois 09:31' })
    expect(article.querySelector('[data-bar]')).toBeNull()
  })

  it('draws no mention cue on an ordinary message', () => {
    setup()
    const article = screen.getByRole('article')
    expect(article).not.toHaveClass('bg-c-accent-soft')
    expect(article).toHaveClass('hover:bg-c-muted', 'focus-within:bg-c-muted')
    expect(article.querySelector('[data-bar]')).toBeNull()
  })

  it('drops the avatar and header in the compact run, keeping its name', () => {
    setup({ compact: true })
    const article = screen.getByRole('article', { name: 'Claire Dubois 09:31' })
    expect(article.querySelector('.rounded-full')).toBeNull()
    expect(within(article).getByText('Claire Dubois')).toHaveClass('sr-only')
    expect(article).toHaveClass('group')
    expect(within(article).getByText('09:31')).toHaveClass(
      'opacity-0',
      'group-hover:opacity-100',
      'group-focus-within:opacity-100'
    )
  })

  it('keeps its action disclosure in the message flow and in the tab order, shown on hover, focus, an open menu or a screen with no hover', async () => {
    const user = userEvent.setup()
    setup({ actions: <button type="button">Répondre</button> })
    const toolbar = screen.getByRole('article').querySelector('[data-message-actions]')
    expect(screen.getByRole('article')).toHaveClass('group')
    expect(toolbar).toHaveClass('shrink-0', 'self-start')
    // Faded, never removed: it keeps its space and stays in the tab order and the reading order.
    // Where it is drawn is measured in a browser (tests/espace/layout/actions.spec.ts).
    expect(toolbar).toHaveClass(
      'opacity-0',
      'group-hover:opacity-100',
      'group-focus-within:opacity-100',
      'has-[[data-state=open]]:opacity-100',
      'forced-colors:opacity-100',
      '[@media(hover:none)]:opacity-100'
    )
    expect(toolbar).not.toHaveClass('absolute')
    expect(toolbar).not.toHaveClass('hidden')
    await user.tab()
    expect(screen.getByRole('button', { name: 'Répondre' })).toHaveFocus()
  })

  it('gives reactions and the thread button the 44 px floor under narrow', () => {
    setup({
      reactions: [
        { key: 'a', emoji: '👍', count: 1, mine: false, label: '👍 1', onToggle: () => {} },
      ],
      thread: { label: '2 réponses', onOpen: () => {} },
    })
    for (const name of ['👍 1', '2 réponses'])
      expect(screen.getByRole('button', { name })).toHaveClass(
        'narrow:min-h-[44px]',
        'focus-visible:ring'
      )
  })

  it('replaces a deleted body with the caller’s words, with no reactions, marker or actions', () => {
    setup({
      deleted: 'Message supprimé',
      edited: '(modifié)',
      reactions: [
        { key: 'a', emoji: '👍', count: 1, mine: false, label: '👍 1', onToggle: () => {} },
      ],
      addReaction: <button type="button">Réagir</button>,
      actions: <button type="button">Répondre</button>,
    })
    const article = screen.getByRole('article')
    expect(within(article).getByText('Message supprimé')).toBeInTheDocument()
    expect(within(article).queryByText('Mise en ligne jeudi à 7 h.')).toBeNull()
    expect(within(article).queryByText('(modifié)')).toBeNull()
    expect(within(article).queryAllByRole('button')).toEqual([])
  })

  it('says a message is sending, in words read in its name', () => {
    setup({ delivery: { state: 'sending', label: 'Envoi en cours' } })
    const article = screen.getByRole('article', { name: 'Claire Dubois 09:31 Envoi en cours' })
    expect(within(article).getByText('Envoi en cours')).toHaveClass('text-c-ink-3')
    expect(within(article).queryByRole('button')).toBeNull()
  })

  it('says a message failed, and retries it from a named button', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    setup({
      delivery: { state: 'failed', label: 'Échec de l’envoi', retryLabel: 'Réessayer', onRetry },
    })
    const article = screen.getByRole('article', { name: 'Claire Dubois 09:31 Échec de l’envoi' })
    expect(within(article).getByText('Échec de l’envoi')).toHaveClass('text-c-bad-ink')
    const retry = within(article).getByRole('button', { name: 'Réessayer' })
    expect(retry).toHaveClass('text-c-ink', 'narrow:min-h-[44px]', 'focus-visible:ring')
    await user.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('renders the caller’s add-reaction button after the reactions, even with none yet', () => {
    setup({ addReaction: <button type="button">Ajouter une réaction</button> })
    expect(screen.getByRole('button', { name: 'Ajouter une réaction' })).toBeInTheDocument()
  })

  it('draws up to three faces and the last-reply time on the thread button', () => {
    setup({
      thread: {
        label: '6 réponses',
        onOpen: () => {},
        lastReply: 'dernière il y a 4 min',
        participants: [
          { id: 'a', name: 'Paul Ferrand' },
          { id: 'b', name: 'Nadia Chevalier' },
          { id: 'c', name: 'Inès Kaci' },
          { id: 'd', name: 'Hugo Lefèvre' },
        ],
      },
    })
    const button = screen.getByRole('button', { name: '6 réponses dernière il y a 4 min' })
    const faces = button.querySelector('[data-thread-faces]')
    expect(faces).toHaveAttribute('aria-hidden', 'true')
    expect(faces?.querySelectorAll('.h-5')).toHaveLength(3)
    expect(within(button).getByText('dernière il y a 4 min')).toHaveClass('text-c-ink-3')
  })

  it('names two messages on one page each by its own author and time', () => {
    render(
      <>
        <TimelineMessage author="Claire Dubois" dateTime="2026-10-22T09:31" timeLabel="09:31">
          <p>a</p>
        </TimelineMessage>
        <TimelineMessage author="Paul Ferrand" dateTime="2026-10-22T09:33" timeLabel="09:33">
          <p>b</p>
        </TimelineMessage>
      </>
    )
    const [first, second] = screen.getAllByRole('article')
    expect(first).toHaveAccessibleName('Claire Dubois 09:31')
    expect(second).toHaveAccessibleName('Paul Ferrand 09:33')
    expect(first?.getAttribute('aria-labelledby')).not.toBe(second?.getAttribute('aria-labelledby'))
  })
})
