// What the live view draws again, and what it does not. The view is cut into parts that each read
// their own slice (`MessageTimeline` and its `MessageRow`s, `MessageComposer`, `ChannelSidebar`,
// `VoiceCallDock`), so that writing a message draws the field being written in and nothing else.
// This file counts draws, never time: a channel of two hundred messages is mounted, the member
// types, and no `MessageRow` may be drawn again. The log is virtual (`timelineWindow.ts`): of the
// two hundred, it draws the rows its window holds, and those are the rows counted.
//
// How a draw is counted, with no seam in the product code: three modules are observed through
// `vi.mock`, each wrapped by a plain function around the real, memoised component.
//   - `MessageRow` renders exactly one `TimelineMessage`, and nothing else does in a channel's log:
//     a call of the observed `TimelineMessage` is one draw of one `MessageRow`.
//   - `MessageTimeline` hands each drawn message to the observed `MessageRow`: a call of it for the
//     newest message at mount, which the log's window always holds, is one draw of the log.
//   - the view hands the log to the observed `MessageTimeline`: a call of it is one draw of the view.
//
// A proof nobody has watched fail proves nothing (docs/dev/TESTING.md §« Writing a test that can
// actually fail »), so the same wrappers carry the mutants, one per guard, each owned by the exact
// message that must refuse it (`MUTANTS`). The refusal tests below run every one of them. To watch
// the acceptance test itself go red, arm one from the shell:
//
//   VITE_ESPACE_RENDER_MUTANT=unstable-row-prop npx vitest run \
//     src/features/espace/EspaceLiveView.renders.test.tsx -t "re-renders no MessageRow"

import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'
import type * as TimelineMessageModule from '../../ui/TimelineMessage/TimelineMessage'
import type { Workspace } from '../workspace/workspace'
import type * as DraftProviderModule from './EspaceDraftProvider'
import type * as MessageComposerModule from './MessageComposer'
import type * as MessageRowModule from './MessageRow'
import type * as MessageTimelineModule from './MessageTimeline'
import { EMPTY_DRAFT, type ChannelDraft, type DraftLease } from './EspaceDraftProvider'
import { EspaceLiveView } from './EspaceLiveView'
import type { EspaceStoreLike } from './EspaceLiveView'
import type { ChannelRoom, EspaceSnapshot, MemberView } from './matrix/store'
import type { MessageView } from './matrix/timeline'
import { MAX_DRAWN_ROWS } from './timelineWindow'

/**
 * Each mutant breaks one guard, and nothing else, through the observed modules:
 *   - `unstable-row-prop`: every `MessageRow` is handed a new `onReaction` function at each draw
 *     of the log, so its memoisation never holds;
 *   - `lifted-composer-state`: the composer's text is handed up to the view, which keeps it in its
 *     own state, as it did before the view was cut into parts;
 *   - `unmemoised`: both, and the log is handed a new `inserts` array at each draw of the view: no
 *     layer holds, which is the view as it was.
 * The value is the message the typing proof must refuse it with.
 */
const MUTANTS = {
  'unstable-row-prop': 'MessageRow was drawn again while the member typed',
  'lifted-composer-state': 'the view was drawn again for a keystroke',
  unmemoised: 'MessageRow was drawn again while the member typed',
} as const
type Mutant = keyof typeof MUTANTS

const probe = vi.hoisted(() => ({
  mutant: null as string | null,
  /** The provider's draft memory, when a test mounts the view as the product does. */
  memory: null as unknown,
  viewDraws: 0,
  timelineDraws: 0,
  /** The message whose draws count the log's: the newest at mount, which the window always holds. */
  logMarker: '$m0',
  /** One entry per draw of a `MessageRow`: its author and its time. */
  rowDraws: [] as string[],
}))

vi.mock('../../ui/TimelineMessage/TimelineMessage', async (original) => {
  const actual = await original<typeof TimelineMessageModule>()
  type Props = Parameters<typeof actual.TimelineMessage>[0]
  function ObservedTimelineMessage(props: Props) {
    probe.rowDraws.push(`${props.author} ${props.dateTime}`)
    return <actual.TimelineMessage {...props} />
  }
  return { ...actual, TimelineMessage: ObservedTimelineMessage }
})

vi.mock('./MessageRow', async (original) => {
  const actual = await original<typeof MessageRowModule>()
  function ObservedMessageRow(props: MessageRowModule.MessageRowProps) {
    if (props.placement === 'timeline' && props.message.key === probe.logMarker)
      probe.timelineDraws += 1
    if (probe.mutant === 'unstable-row-prop' || probe.mutant === 'unmemoised') {
      return (
        <actual.MessageRow
          {...props}
          onReaction={(eventId, reaction) => props.onReaction(eventId, reaction)}
        />
      )
    }
    return <actual.MessageRow {...props} />
  }
  return { ...actual, MessageRow: ObservedMessageRow }
})

vi.mock('./MessageTimeline', async (original) => {
  const actual = await original<typeof MessageTimelineModule>()
  function ObservedMessageTimeline(props: MessageTimelineModule.MessageTimelineProps) {
    probe.viewDraws += 1
    if (probe.mutant === 'unmemoised') {
      return <actual.MessageTimeline {...props} inserts={[...props.inserts]} />
    }
    return <actual.MessageTimeline {...props} />
  }
  return { ...actual, MessageTimeline: ObservedMessageTimeline }
})

vi.mock('./MessageComposer', async (original) => {
  const actual = await original<typeof MessageComposerModule>()
  const { useEffect } = await import('react')
  const { useDraftSlice } = await import('./draftChannel')
  type Props = MessageComposerModule.MessageComposerProps
  const textOf = (draft: ChannelDraft) => draft.text
  /** The mutant: each keystroke is told to the view, which keeps what it is told in its state. */
  function LiftedText({ draft, onAnnounce }: Pick<Props, 'draft' | 'onAnnounce'>) {
    const text = useDraftSlice(draft, textOf)
    useEffect(() => {
      onAnnounce(text)
    }, [text, onAnnounce])
    return null
  }
  function ObservedMessageComposer(props: Props) {
    const lifted = probe.mutant === 'lifted-composer-state' || probe.mutant === 'unmemoised'
    return (
      <>
        {lifted ? <LiftedText draft={props.draft} onAnnounce={props.onAnnounce} /> : null}
        <actual.MessageComposer {...props} />
      </>
    )
  }
  return { ...actual, MessageComposer: ObservedMessageComposer }
})

vi.mock('./EspaceDraftProvider', async (original) => {
  const actual = await original<typeof DraftProviderModule>()
  return { ...actual, useEspaceDraftMemory: () => probe.memory }
})

const GENERAL = 'a1111111-1111-4111-8111-000000000001'
const ROOM = '!general:matrix.acme.kodera.io'
const ME = '@me:matrix.acme.kodera.io'
const ALICE = '@marina.loiseau:matrix.acme.kodera.io'
const BOB = '@bob.dupont:matrix.acme.kodera.io'
const ELODIE = '@elodie.roux:matrix.acme.kodera.io'
/** A busy channel's loaded history: enough for a draw of every message to be felt. */
const MESSAGES = 200
const SENTENCE = 'Bonjour à toute l’équipe !'

const WORKSPACE: Workspace = {
  organisation_id: '11111111-1111-4111-8111-111111111111',
  state: 'initialised',
  setup: { state: 'ready', reason: null },
  can_initialise: false,
  id: '22222222-2222-4222-8222-222222222222',
  categories: [
    {
      id: 'cat-general',
      name: 'General',
      template_key: 'general',
      channels: [
        {
          id: GENERAL,
          kind: 'text',
          name: 'general',
          template_key: 'general',
          topic: 'Discussions de toute l’équipe',
          lifecycle: 'active',
          room_state: 'ready',
        },
      ],
    },
  ],
  uncategorised_channels: [],
}

const FIRST = Date.UTC(2026, 10, 2, 8, 0)

/** Three days of a channel: three authors, answers, reactions, a mention, an edit, a removal. */
function history(count: number): MessageView[] {
  const senders = [ALICE, BOB, ME, ELODIE]
  return Array.from({ length: count }, (_, index): MessageView => {
    const eventId = `$m${index}`
    return {
      key: eventId,
      eventId,
      sender: senders[index % senders.length]!,
      body: `Message ${index} : le point du chantier`,
      // Twenty minutes apart: about seventy messages a day.
      ts: FIRST + index * 20 * 60_000,
      edited: index % 17 === 3,
      redacted: index % 53 === 7,
      delivery: 'sent',
      replyTo: index % 9 === 4 ? `$m${index - 1}` : null,
      reactions: index % 6 === 1 ? [{ key: '👍', count: 2, mine: index % 12 === 1 }] : [],
      ...(index % 31 === 5 ? { mentionsMe: true } : {}),
    }
  })
}

function reply(eventId: string, sender: string, at: number): MessageView {
  return {
    key: eventId,
    eventId,
    sender,
    body: 'Je réponds dans le fil.',
    ts: at,
    edited: false,
    redacted: false,
    delivery: 'sent',
    replyTo: null,
    reactions: [],
  }
}

/**
 * A store that publishes as a sync does. The homeserver echoes the member's own typing notice in
 * the next sync, so the snapshot changes when they start to write: the log reads the store again,
 * and finds nothing a message draws has changed. `getThread` builds a new array at each read, as a
 * store that rebuilds its thread views would.
 */
function makeStore(count: number) {
  const listeners = new Set<() => void>()
  let publications = 0
  let typing: readonly MemberView[] = []
  let writing = false
  let timeline: readonly MessageView[] = history(count)
  const online = new Set<string>([ALICE])
  // A recent message, in the log's window: its thread's opener is drawn.
  const root = timeline[Math.max(0, count - 3)]!
  const threadOf = root.eventId
  const threadReplies = [
    reply('$t1', BOB, root.ts + 1),
    reply('$t2', ELODIE, root.ts + 2),
  ]
  const members: readonly MemberView[] = [
    { userId: ALICE, name: 'Marina Loiseau' },
    { userId: BOB, name: 'Bob Dupont' },
    { userId: ELODIE, name: 'Élodie Roux' },
  ]
  let snapshot: EspaceSnapshot = {
    status: 'live',
    channels: new Map<string, ChannelRoom>([[GENERAL, { state: 'resolved', roomId: ROOM }]]),
    rooms: [
      {
        roomId: ROOM,
        name: 'general',
        alias: null,
        kind: 'text',
        unread: 0,
        mentions: 0,
        occupancy: null,
      },
    ],
    invites: [],
  }
  const publish = () => {
    publications += 1
    snapshot = { ...snapshot }
    for (const listener of [...listeners]) listener()
  }
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    getUserId: () => ME,
    getTimeline: (roomId: string) => (roomId === ROOM ? timeline : []),
    getThread: (roomId: string, rootEventId: string) =>
      roomId === ROOM && rootEventId === threadOf ? [...threadReplies] : [],
    getMembers: (roomId: string) => (roomId === ROOM ? members : []),
    getTyping: (roomId: string) => (roomId === ROOM ? typing : []),
    isOnline: (userId: string) => online.has(userId),
    setTyping: (_roomId: string, next: boolean) => {
      if (next === writing) return
      writing = next
      publish()
    },
    send: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => undefined),
  } satisfies EspaceStoreLike
  return {
    store,
    publications: () => publications,
    /** A sync: something changed in the room, as told by `change`. */
    sync(change: () => void) {
      act(() => {
        change()
        publish()
      })
    },
    typing(next: readonly MemberView[]) {
      typing = next
    },
    comesOnline(userId: string) {
      online.add(userId)
    },
    receives(message: MessageView) {
      timeline = [...timeline, message]
    },
    /** The drawn messages `sender` wrote: a virtual log draws only its window's rows. */
    messagesOf: (sender: string) =>
      timeline.filter((message) => message.sender === sender && drawnKeys().has(message.key))
        .length,
  }
}

/**
 * The provider's draft memory, as the view reads it (`EspaceDraftProvider`'s `DraftMemory`): one
 * draft per room, behind a lease, and one publication to every reader at each change. The outer
 * view follows every publication; the proof is that the mounted one does not.
 */
function makeMemory() {
  const listeners = new Set<() => void>()
  const drafts = new Map<string, ChannelDraft>()
  let revision = 0
  const publish = () => {
    revision += 1
    for (const listener of [...listeners]) listener()
  }
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => revision,
    getViewEpoch: () => 0,
    canPresent: () => true,
    canKeepView: () => true,
    observeView: () => undefined,
    attachView: (_store: EspaceStoreLike, _workspace: unknown, roomId: string): DraftLease => ({
      read: () => drafts.get(roomId) ?? EMPTY_DRAFT,
      update: (patch) => {
        const previous = drafts.get(roomId) ?? EMPTY_DRAFT
        drafts.set(roomId, {
          ...previous,
          ...(typeof patch === 'function' ? patch(previous) : patch),
        })
        publish()
        return true
      },
      command: (effect, patch) => {
        if (patch !== undefined)
          drafts.set(roomId, { ...(drafts.get(roomId) ?? EMPTY_DRAFT), ...patch })
        try {
          effect()
        } finally {
          if (patch !== undefined) publish()
        }
        return true
      },
      release: () => undefined,
    }),
    publications: () => revision,
  }
}

function resetCounts() {
  probe.viewDraws = 0
  probe.timelineDraws = 0
  probe.rowDraws = []
}

/** The keys of the rows the log has in the page now. */
function drawnKeys(): Set<string> {
  return new Set(
    [...document.querySelectorAll('[data-timeline-row]')].map(
      (row) => row.getAttribute('data-timeline-row') ?? ''
    )
  )
}

/** How many messages the log has in the page now. */
function drawnMessages(): number {
  return document.querySelectorAll('[role="log"] [data-timeline-row] article').length
}

function mount(count = MESSAGES) {
  const room = makeStore(count)
  probe.logMarker = `$m${count - 1}`
  resetCounts()
  render(
    <EspaceLiveView
      org="acme"
      organisationName="Acme SA"
      workspace={WORKSPACE}
      channelId={GENERAL}
      store={room.store}
    />
  )
  // The probe is alive: every message in the log's window was drawn, and, with no mutant at work,
  // drawn once, by the one draw of the log and of the view. The window is a part of a long log.
  const drawn = drawnMessages()
  expect(drawn).toBeGreaterThan(0)
  expect(drawn).toBeLessThanOrEqual(Math.min(count, MAX_DRAWN_ROWS))
  expect(new Set(probe.rowDraws).size).toBe(drawn)
  if (probe.mutant === null) {
    expect(probe.rowDraws).toHaveLength(drawn)
    expect(probe.timelineDraws).toBe(1)
    // Under the provider the view is drawn once more, when its lease on the room is attached:
    // that draw reaches neither the log nor a message.
    expect(probe.viewDraws).toBe(probe.memory === null ? 1 : 2)
  }
  return room
}

interface TypingMeasure {
  keystrokes: number
  /** How many times the store published while the member typed (the echo of their notice). */
  publications: number
  viewDraws: number
  timelineDraws: number
  rowDraws: readonly string[]
  /** How many messages the log had in the page. */
  drawn: number
}

/** Mounts the channel, then types `text` in its composer, and reports what was drawn again. */
async function typeInComposer(
  text: string,
  options: { memory?: boolean; mutant?: Mutant | null; messages?: number } = {}
): Promise<TypingMeasure> {
  probe.mutant = options.mutant === undefined ? ARMED : options.mutant
  probe.memory = options.memory ? makeMemory() : null
  const user = userEvent.setup()
  const room = mount(options.messages)
  const composer = screen.getByRole('textbox', { name: 'Message dans #général' })
  await user.click(composer)
  resetCounts()
  const before = room.publications()
  await user.type(composer, text)
  expect(composer).toHaveValue(text)
  return {
    keystrokes: text.length,
    publications: room.publications() - before,
    viewDraws: probe.viewDraws,
    timelineDraws: probe.timelineDraws,
    rowDraws: [...probe.rowDraws],
    drawn: drawnMessages(),
  }
}

/**
 * The proof. A sync may draw the log again, never a keystroke; and nothing draws a message whose
 * own slice did not change. Each refusal has its own words, which `MUTANTS` names.
 */
function assertTypingDrawsNoRow(measure: TypingMeasure) {
  const counts =
    `${measure.keystrokes} keystrokes, ${measure.publications} sync publication(s), ` +
    `${measure.viewDraws} draw(s) of the view, ${measure.timelineDraws} of the log, ` +
    `${measure.rowDraws.length} of a MessageRow`
  if (measure.rowDraws.length > 0)
    throw new Error(
      `MessageRow was drawn again while the member typed (${counts}; first: ${measure.rowDraws[0]})`
    )
  if (measure.timelineDraws > measure.publications)
    throw new Error(`the message log was drawn again for a keystroke (${counts})`)
  if (measure.viewDraws > measure.publications)
    throw new Error(`the view was drawn again for a keystroke (${counts})`)
}

/** The mutant armed from the shell for the acceptance tests; none in an ordinary run. */
const ARMED: Mutant | null = (() => {
  const named: unknown = import.meta.env['VITE_ESPACE_RENDER_MUTANT']
  if (named === undefined || named === '') return null
  if (typeof named === 'string' && named in MUTANTS) return named as Mutant
  throw new Error(`VITE_ESPACE_RENDER_MUTANT names no mutant: ${String(named)}`)
})()

beforeEach(() => {
  probe.mutant = ARMED
  probe.memory = null
})
afterEach(() => {
  probe.mutant = null
  probe.memory = null
})

const SLOW = { timeout: 60_000 }

describe('what typing draws', () => {
  it('typing in the composer re-renders no MessageRow', SLOW, async () => {
    const measure = await typeInComposer(SENTENCE)
    assertTypingDrawsNoRow(measure)
    expect(measure.rowDraws).toEqual([])
    // Not vacuous: the echo of the typing notice did publish, and the log did read the store
    // again. It found every message as it was.
    expect(measure.publications).toBe(1)
    expect(measure.timelineDraws).toBe(1)
    expect(measure.viewDraws).toBeLessThanOrEqual(1)
  })

  it('typing in the composer re-renders no MessageRow under the draft provider', SLOW, async () => {
    const measure = await typeInComposer(SENTENCE, { memory: true })
    // The memory published at every keystroke, to the outer view among others.
    const memory = probe.memory as ReturnType<typeof makeMemory>
    assertTypingDrawsNoRow(measure)
    expect(measure.rowDraws).toEqual([])
    expect(memory.publications()).toBeGreaterThanOrEqual(SENTENCE.length)
    expect(measure.publications).toBe(1)
    expect(measure.viewDraws).toBeLessThanOrEqual(1)
  })

  it('typing in an open thread re-renders no MessageRow', SLOW, async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByRole('button', { name: '2 réponses' }))
    const field = screen.getByLabelText('Répondre au fil')
    await user.click(field)
    resetCounts()
    await user.type(field, SENTENCE)
    expect(field).toHaveValue(SENTENCE)
    expect(probe.rowDraws).toEqual([])
    expect(probe.timelineDraws).toBe(0)
    expect(probe.viewDraws).toBe(0)
  })
})

describe('what a sync draws', () => {
  it('re-renders no MessageRow when nothing a message draws has changed', SLOW, () => {
    const room = mount()
    resetCounts()
    room.sync(() => room.typing([{ userId: ALICE, name: 'Marina Loiseau' }]))
    expect(screen.getByText('Marina Loiseau écrit…')).toBeInTheDocument()
    // The log read the store again, threads included, whose arrays are new ones.
    expect(probe.timelineDraws).toBe(1)
    expect(probe.rowDraws).toEqual([])
  })

  it('re-renders only the messages of the member whose presence changed', SLOW, () => {
    const room = mount()
    resetCounts()
    room.sync(() => room.comesOnline(BOB))
    expect(probe.rowDraws).toHaveLength(room.messagesOf(BOB))
    expect(probe.rowDraws.every((draw) => draw.startsWith('Bob Dupont '))).toBe(true)
  })

  it('draws the one message that arrived, and no other again', SLOW, () => {
    const room = mount()
    resetCounts()
    const arrived: MessageView = {
      key: '$new',
      eventId: '$new',
      sender: ALICE,
      body: 'Un message de plus.',
      ts: FIRST + MESSAGES * 20 * 60_000,
      edited: false,
      redacted: false,
      delivery: 'sent',
      replyTo: null,
      reactions: [],
    }
    room.sync(() => room.receives(arrived))
    expect(screen.getByText('Un message de plus.')).toBeInTheDocument()
    expect(probe.rowDraws).toEqual([`Marina Loiseau ${new Date(arrived.ts).toISOString()}`])
  })
})

// The refusals: each mutant breaks one guard, and the proof above must refuse it in its own words.
// The control runs the same measure with no mutant, so a refusal is the mutant's doing.
describe('the typing proof refuses each mutant', () => {
  const WORD = 'Bonjour'

  it('control: with no mutant, the same measure passes', SLOW, async () => {
    const measure = await typeInComposer(WORD, { mutant: null, messages: 60 })
    expect(() => assertTypingDrawsNoRow(measure)).not.toThrow()
  })

  it.each(Object.entries(MUTANTS) as [Mutant, string][])(
    'mutant %s is refused: %s',
    SLOW,
    async (mutant, refusal) => {
      const measure = await typeInComposer(WORD, { mutant, messages: 60 })
      expect(() => assertTypingDrawsNoRow(measure)).toThrow(refusal)
    }
  )

  it(
    'mutant unstable-row-prop draws every message again at the echo of the notice',
    SLOW,
    async () => {
      const measure = await typeInComposer(WORD, { mutant: 'unstable-row-prop', messages: 60 })
      expect(measure.rowDraws).toHaveLength(measure.drawn)
    }
  )

  it('mutant lifted-composer-state draws the view again at every keystroke', SLOW, async () => {
    const measure = await typeInComposer(WORD, { mutant: 'lifted-composer-state', messages: 60 })
    expect(measure.viewDraws).toBeGreaterThanOrEqual(WORD.length)
    // The log's own memoisation still held: the second layer, which `unmemoised` takes away too.
    expect(measure.rowDraws).toEqual([])
  })

  it('mutant unmemoised draws every message again at every keystroke', SLOW, async () => {
    const measure = await typeInComposer(WORD, { mutant: 'unmemoised', messages: 60 })
    expect(measure.rowDraws.length).toBeGreaterThanOrEqual(WORD.length * measure.drawn)
  })
})
