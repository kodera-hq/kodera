import { describe, expect, it, vi } from 'vitest'
import { MessageCueTracker } from '../../../src/features/espace/messageCues'
import { workspaceFilesOf } from '../../../src/features/espace/workspaceFiles'
import type { EspaceStoreLike } from '../../../src/features/espace/liveViewModel'
import type { EspaceSnapshot, RoomSummary } from '../../../src/features/espace/matrix/store'
import type { MessageView } from '../../../src/features/espace/matrix/timeline'
import { CURATED_COMMUNITY_PRESETS } from '../../../src/features/appearance/ThemeStudioModal'
import { hasReadableTheme } from '../../../src/features/appearance/themeContrast'
import { applyCustomTokensToDocument } from '../../../src/features/appearance/themeOverrides'

const message = (key: string, extra = {}): MessageView =>
  ({
    key,
    eventId: key,
    sender: '@peer:example.org',
    body: 'hello',
    ts: 100,
    redacted: false,
    ...extra,
  }) as MessageView
const room = (roomId: string): RoomSummary => ({
  roomId,
  name: roomId,
  alias: null,
  kind: 'text',
  unread: 0,
  mentions: 0,
  occupancy: null,
})
function fixture() {
  const timelines = new Map<string, MessageView[]>([
    ['!general:example.org', [message('$history')]],
    ['!dm:example.org', [message('$dmhistory')]],
  ])
  let history = 'start'
  const store = {
    getTimeline: (id: string) => timelines.get(id) ?? [],
    getUserId: () => '@me:example.org',
    getDirects: () => [
      { roomId: '!dm:example.org', name: 'Peer', userIds: ['@peer:example.org'], unread: 0 },
    ],
    getHistory: () => history,
  } as unknown as EspaceStoreLike
  const snapshot: EspaceSnapshot = {
    status: 'live',
    rooms: [...timelines.keys()].map(room),
    channels: new Map([['general', { state: 'resolved', roomId: '!general:example.org' }]]),
    invites: [],
  }
  return {
    store,
    snapshot,
    timelines,
    setHistory: (next: string) => {
      history = next
    },
  }
}

describe('live arrivals across joined conversations', () => {
  it('primes history, then emits unread, mention and DM cues without selecting those rooms', () => {
    const { store, snapshot, timelines } = fixture()
    const tracker = new MessageCueTracker()
    const play = vi.fn()
    tracker.update(store, snapshot, play)
    expect(play).not.toHaveBeenCalled()
    timelines
      .get('!general:example.org')!
      .push(message('$new'), message('$mention', { mentionsMe: true }))
    timelines.get('!dm:example.org')!.push(message('$dm'))
    tracker.update(store, snapshot, play)
    expect(play.mock.calls.map(([cue]) => cue)).toEqual([
      'msg_channel_unread',
      'msg_mention',
      'msg_dm',
    ])
    expect(play).toHaveBeenLastCalledWith(
      'msg_dm',
      expect.objectContaining({ roomId: '!dm:example.org', currentUserId: '@me:example.org' })
    )
    tracker.update(store, snapshot, play)
    expect(play).toHaveBeenCalledTimes(3)
  })

  it('suppresses the actual selected room, consumes its messages, and follows a DM selection', () => {
    const { store, snapshot, timelines } = fixture()
    const tracker = new MessageCueTracker()
    const play = vi.fn()
    tracker.update(store, snapshot, play, '!general:example.org')
    timelines.get('!general:example.org')!.push(message('$reading', { mentionsMe: true }))
    timelines.get('!dm:example.org')!.push(message('$incoming-dm'))
    tracker.update(store, snapshot, play, '!general:example.org')
    expect(play).toHaveBeenCalledExactlyOnceWith(
      'msg_dm',
      expect.objectContaining({ roomId: '!dm:example.org' })
    )
    play.mockClear()
    tracker.update(store, snapshot, play, '!dm:example.org')
    expect(play).not.toHaveBeenCalled()
    timelines.get('!dm:example.org')!.push(message('$dm-reading'))
    timelines.get('!general:example.org')!.push(message('$background'))
    tracker.update(store, snapshot, play, '!dm:example.org')
    expect(play).toHaveBeenCalledExactlyOnceWith(
      'msg_channel_unread',
      expect.objectContaining({ channelId: 'general', roomId: '!general:example.org' })
    )
  })

  it('does not sound for self, redacted, backfilled, newly joined or reconnected history', () => {
    const { store, snapshot, timelines, setHistory } = fixture()
    const tracker = new MessageCueTracker()
    const play = vi.fn()
    tracker.update(store, snapshot, play)
    timelines.get('!general:example.org')!.unshift(message('$old', { ts: 1 }))
    timelines
      .get('!dm:example.org')!
      .push(
        message('$self', { sender: '@me:example.org' }),
        message('$redacted', { redacted: true })
      )
    tracker.update(store, snapshot, play)
    setHistory('loading')
    timelines.get('!dm:example.org')!.unshift(message('$backfill', { ts: 1 }))
    tracker.update(store, snapshot, play)
    setHistory('start')
    tracker.update(store, { ...snapshot, status: 'reconnecting' }, play)
    timelines.get('!dm:example.org')!.push(message('$reconnected'))
    tracker.update(store, snapshot, play)
    timelines.set('!joined:example.org', [message('$joined')])
    tracker.update(
      store,
      { ...snapshot, rooms: [...snapshot.rooms, room('!joined:example.org')] },
      play
    )
    expect(play).not.toHaveBeenCalled()
  })
})

describe('shared palettes', () => {
  it('keeps body text and primary labels at AA for every curated preset', () => {
    for (const preset of CURATED_COMMUNITY_PRESETS)
      expect(hasReadableTheme(preset.tokens, preset.baseMode), preset.id).toBe(true)
  })
  it('refuses dark-on-dark text and pale primary fills before touching the document', () => {
    const tokens = CURATED_COMMUNITY_PRESETS[0]!.tokens
    const before = document.documentElement.style.cssText
    for (const bad of [
      { ...tokens, '--c-ink': tokens['--c-page'] },
      { ...tokens, '--c-action': 'rgb(255, 255, 255)' },
    ]) {
      expect(hasReadableTheme(bad, 'black')).toBe(false)
      applyCustomTokensToDocument(bad, 'black')
      expect(document.documentElement.style.cssText).toBe(before)
    }
  })
})

it('includes direct attachments once, strips spoofing controls, and omits redacted files', () => {
  const { store, snapshot, timelines } = fixture()
  const ref = {
    id: 'attachment',
    filename: '\u202eevil.png',
    contentType: 'image/png',
    sizeBytes: 42,
  }
  timelines
    .get('!dm:example.org')!
    .push(
      message('$file', { attachments: [ref] }),
      message('$removed', { attachments: [ref], redacted: true })
    )
  const files = workspaceFilesOf(
    store,
    snapshot,
    [{ id: 'general', label: 'general', kind: 'text' }],
    []
  )
  expect(files).toHaveLength(1)
  expect(files[0]).toMatchObject({
    name: 'evil.png',
    directRoomId: '!dm:example.org',
    sizeBytes: 42,
  })
})
