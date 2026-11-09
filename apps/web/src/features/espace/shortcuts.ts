// The live view's keyboard shortcuts (workspace audit item 11), as Discord has them: `Alt` and
// the arrows to the channel above or below, with `Shift` to the next unread one; `ArrowUp` in an
// empty composer to edit the newest own message. Pure functions: the keys are wired in
// `EspaceLiveView.tsx`.

import type { MessageView } from './matrix/timeline'

/** A channel move the key asks for: up or down, and whether only unread channels count. */
export interface ChannelMove {
  step: -1 | 1
  unread: boolean
}

/** `Alt` + `ArrowUp` / `ArrowDown`, with or without `Shift`, and no other modifier. */
export function channelMove(event: {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): ChannelMove | null {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return null
  return { step: event.key === 'ArrowUp' ? -1 : 1, unread: event.shiftKey }
}

/**
 * The channel a move lands on: the nearest one in that direction that `accept` takes, wrapping
 * at either end, the current one never. From no current channel, the first (or last) accepted.
 * Null when no other channel is accepted.
 */
export function channelAfter(
  ids: readonly string[],
  current: string | null | undefined,
  step: -1 | 1,
  accept: (id: string) => boolean = () => true
): string | null {
  const at = current === null || current === undefined ? -1 : ids.indexOf(current)
  const start = at === -1 ? (step === 1 ? -1 : ids.length) : at
  for (let n = 1; n <= ids.length; n++) {
    const index = (((start + step * n) % ids.length) + ids.length) % ids.length
    const id = ids[index]!
    if (index === at) return null
    if (accept(id)) return id
  }
  return null
}

/** The viewer's newest message that « Modifier » can edit: sent, not deleted. */
export function newestEditable(
  timeline: readonly MessageView[],
  viewerId: string | null
): MessageView | undefined {
  if (viewerId === null) return undefined
  return timeline.findLast(
    (message) => message.sender === viewerId && !message.redacted && message.delivery === 'sent'
  )
}
