import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { MessageRow, type MessageRowProps } from './MessageRow'
import type { MessageView } from './matrix/timeline'

const message: MessageView = {
  key: '$m',
  eventId: '$m',
  sender: '@bob:kodera.test',
  senderName: 'Bob',
  body: 'Mise en ligne jeudi.',
  ts: 1_700_000_000_000,
  delivery: 'sent',
  edited: false,
  redacted: false,
  replyTo: null,
  reactions: [
    { key: '👍', count: 3, mine: true },
    { key: '🙏', count: 1, mine: false },
  ],
}

function row(props: Partial<MessageRowProps> = {}) {
  const onReaction = vi.fn()
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
      onRetry={vi.fn()}
      onReaction={onReaction}
      onReply={vi.fn()}
      onEdit={vi.fn()}
      onRemove={vi.fn()}
      onOpenThread={vi.fn()}
      {...props}
    />
  )
  return { onReaction }
}

describe("a message's reactions", () => {
  it('toggles a reaction where the member may react', async () => {
    await i18n.changeLanguage('en')
    const { onReaction } = row()
    await userEvent.setup().click(screen.getByRole('button', { name: '👍 3, you reacted' }))
    expect(onReaction).toHaveBeenCalledExactlyOnceWith('$m', '👍')
  })

  it('shows the counts but offers nothing to press where the member may not react', async () => {
    await i18n.changeLanguage('en')
    const { onReaction } = row({ canReact: false })
    expect(screen.queryByRole('button', { name: /👍|🙏/u })).toBeNull()
    const mine = screen.getByRole('img', { name: '👍 3, you reacted' })
    const other = screen.getByRole('img', { name: '🙏 1' })
    for (const chip of [mine, other]) {
      expect(chip.className).not.toMatch(/hover:|focus-visible:|cursor-/u)
      expect(chip).not.toHaveAttribute('tabindex')
    }
    await userEvent.setup().click(mine)
    expect(onReaction).not.toHaveBeenCalled()
  })

  it('offers nothing to press in an archived channel either', async () => {
    await i18n.changeLanguage('en')
    row({ archived: true })
    expect(screen.queryByRole('button', { name: /👍|🙏/u })).toBeNull()
    expect(screen.getByRole('img', { name: '🙏 1' })).toBeInTheDocument()
  })
})
