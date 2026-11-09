import { describe, expect, it } from 'vitest'
import type { MessageView } from './matrix/timeline'
import { channelAfter, channelMove, newestEditable } from './shortcuts'

const key = (
  key: string,
  mods: Partial<Record<'alt' | 'ctrl' | 'meta' | 'shift', boolean>> = {}
) => ({
  key,
  altKey: mods.alt ?? false,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  shiftKey: mods.shift ?? false,
})

describe('channelMove', () => {
  it('reads Alt and an arrow, with Shift for unread channels only', () => {
    expect(channelMove(key('ArrowDown', { alt: true }))).toEqual({ step: 1, unread: false })
    expect(channelMove(key('ArrowUp', { alt: true }))).toEqual({ step: -1, unread: false })
    expect(channelMove(key('ArrowDown', { alt: true, shift: true }))).toEqual({
      step: 1,
      unread: true,
    })
  })

  it('reads nothing without Alt, with Ctrl or Meta, or another key', () => {
    expect(channelMove(key('ArrowDown'))).toBeNull()
    expect(channelMove(key('ArrowDown', { alt: true, ctrl: true }))).toBeNull()
    expect(channelMove(key('ArrowDown', { alt: true, meta: true }))).toBeNull()
    expect(channelMove(key('ArrowLeft', { alt: true }))).toBeNull()
  })
})

describe('channelAfter', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('steps to the neighbour, wrapping at either end', () => {
    expect(channelAfter(ids, 'b', 1)).toBe('c')
    expect(channelAfter(ids, 'b', -1)).toBe('a')
    expect(channelAfter(ids, 'd', 1)).toBe('a')
    expect(channelAfter(ids, 'a', -1)).toBe('d')
  })

  it('takes the nearest accepted one, never the current one', () => {
    const unread = (id: string) => id === 'a' || id === 'c'
    expect(channelAfter(ids, 'c', 1, unread)).toBe('a')
    expect(channelAfter(ids, 'b', -1, unread)).toBe('a')
    expect(channelAfter(ids, 'c', -1, unread)).toBe('a')
    expect(channelAfter(ids, 'a', 1, (id) => id === 'a')).toBeNull()
    expect(channelAfter(ids, 'a', 1, () => false)).toBeNull()
  })

  it('starts from an end with no current channel, and finds nothing in an empty list', () => {
    expect(channelAfter(ids, null, 1)).toBe('a')
    expect(channelAfter(ids, undefined, -1)).toBe('d')
    expect(channelAfter(ids, 'gone', 1)).toBe('a')
    expect(channelAfter([], 'a', 1)).toBeNull()
  })
})

describe('newestEditable', () => {
  const message = (eventId: string, sender: string, extra: Partial<MessageView> = {}) =>
    ({
      key: eventId,
      eventId,
      sender,
      body: eventId,
      ts: 0,
      edited: false,
      redacted: false,
      delivery: 'sent',
      replyTo: null,
      reactions: [],
      ...extra,
    }) satisfies MessageView

  it('is the newest own message that is sent and not deleted', () => {
    const timeline = [
      message('$1', '@me'),
      message('$2', '@me'),
      message('$3', '@other'),
      message('$4', '@me', { redacted: true }),
      message('$5', '@me', { delivery: 'failed' }),
      message('$6', '@me', { delivery: 'pending' }),
    ]
    expect(newestEditable(timeline, '@me')?.eventId).toBe('$2')
    expect(newestEditable(timeline, '@nobody')).toBeUndefined()
    expect(newestEditable(timeline, null)).toBeUndefined()
  })
})
