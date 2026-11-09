import type { ReactNode } from 'react'
import { cx } from '../cx'

/**
 * A labelled rule across a conversation's log, as the reference's feed draws `.day` (p02):
 * the label centred between two hairlines.
 *
 * - `day`: the calendar day the following messages were written on (« Aujourd'hui »,
 *   « Hier », « Mardi 4 novembre »), in the quiet ink, between `c-border-soft` rules.
 * - `new`: « Nouveaux messages », above the first message the member has not read, in the
 *   accent ink, rules included, so it reads from across the screen.
 *
 * Plain text, not `role="separator"`: a separator's content is presentational and a screen
 * reader would skip the very label that says what changes here. Inside the log it is read in
 * order, as the messages are. The rules are decoration only.
 */
export function TimelineDivider({
  tone = 'day',
  children,
}: {
  tone?: 'day' | 'new'
  children: ReactNode
}) {
  const rule = cx('h-px flex-1', tone === 'new' ? 'bg-c-accent-ink' : 'bg-c-border-soft')
  return (
    <div
      data-divider={tone}
      className={cx(
        'flex items-center gap-3 py-1 text-xs font-semibold',
        tone === 'new' ? 'text-c-accent-ink' : 'text-c-ink-3'
      )}
    >
      <span aria-hidden="true" className={rule} />
      <span>{children}</span>
      <span aria-hidden="true" className={rule} />
    </div>
  )
}
