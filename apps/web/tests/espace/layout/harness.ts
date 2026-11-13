/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// The page log.spec.ts drives: Espace's real live view (src/features/espace/EspaceLiveView.tsx,
// imported, not copied) with the console's own styles, over a store that holds one channel and
// as many messages as a test asks for. jsdom lays nothing out; this page is where the log's
// place on the screen can be measured.

import { createElement, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { ensureNamespaces } from '@/i18n'
import { ORGANISATION_NAMESPACES } from '@/i18n/namespaces'
import '@/index.css'
import { EspaceLiveView, type EspaceStoreLike } from '@/features/espace/EspaceLiveView'
import type { EspaceSnapshot, RoomSummary } from '@/features/espace/matrix/store'
import type { MessageView } from '@/features/espace/matrix/timeline'
import type { Workspace } from '@/features/workspace/workspace'

export interface LayoutHarness {
  /** Draws #général with `count` messages, oldest first. */
  show(count: number): void
  /**
   * Draws #général and #annonces, whose address takes `delay` ms to follow a channel asked for,
   * as the router's does (shortcuts.spec.ts).
   */
  navigating(delay: number): void
  /**
   * Draws #général with `count` messages over a store that publishes, as a sync does, for
   * scale.spec.ts: `append` then adds one message and returns how long, in milliseconds, the view
   * took to draw it — React's render, the log's measuring and the layout it forces.
   */
  live(count: number): void
  append(): number
}

declare global {
  interface Window {
    layoutHarness: LayoutHarness
  }
}

const CHANNEL = 'a1111111-1111-4111-8111-000000000001'
const ROOM = '!general:matrix.acme.kodera.io'

const WORKSPACE: Workspace = {
  organisation_id: '11111111-1111-4111-8111-111111111111',
  state: 'initialised',
  setup: { state: 'ready', reason: null },
  can_initialise: false,
  id: '22222222-2222-4222-8222-222222222222',
  categories: [],
  uncategorised_channels: [
    {
      id: CHANNEL,
      kind: 'text',
      name: 'general',
      template_key: 'general',
      topic: '',
      lifecycle: 'active',
      room_state: 'ready',
    },
  ],
}

const GENERAL: RoomSummary = {
  roomId: ROOM,
  name: 'general',
  alias: `#kodera-ch-${CHANNEL}:matrix.acme.kodera.io`,
  kind: 'text',
  unread: 0,
  mentions: 0,
  occupancy: null,
}

const SNAPSHOT: EspaceSnapshot = {
  status: 'live',
  rooms: [GENERAL],
  invites: [],
  channels: new Map([[CHANNEL, { state: 'resolved', roomId: ROOM }]]),
}

function message(index: number): MessageView {
  return {
    key: `$m${index}`,
    eventId: `$m${index}`,
    // Two authors in turn, so every message draws its own name and face.
    sender:
      index % 2 === 0
        ? '@henri.duflot:matrix.acme.kodera.io'
        : '@bruno.petit:matrix.acme.kodera.io',
    body: `Message ${index}`,
    ts: Date.UTC(2026, 10, 2, 9, index),
    edited: false,
    redacted: false,
    delivery: 'sent',
    replyTo: null,
    reactions: [],
  }
}

const idle = async () => undefined

/** The live store `live` draws, and the way to publish one more message to it. */
let publishOne: (() => void) | null = null

function storeWith(messages: readonly MessageView[]): EspaceStoreLike {
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => SNAPSHOT,
    getUserId: () => '@me:matrix.acme.kodera.io',
    getTimeline: (roomId) => (roomId === ROOM ? messages : []),
    getThread: () => [],
    // The room's creation is reached: nothing older is asked for.
    getHistory: () => 'start',
    send: idle,
    edit: idle,
    remove: idle,
    toggleReaction: idle,
    resolveChannels: () => undefined,
  }
}

const ANNONCES = 'a1111111-1111-4111-8111-000000000002'
const ANNONCES_ROOM = '!annonces:matrix.acme.kodera.io'

const TWO_CHANNELS: Workspace = {
  ...WORKSPACE,
  uncategorised_channels: [
    ...WORKSPACE.uncategorised_channels,
    { ...WORKSPACE.uncategorised_channels[0]!, id: ANNONCES, name: 'annonces', template_key: null },
  ],
}

const TWO_ROOMS: EspaceSnapshot = {
  ...SNAPSHOT,
  rooms: [GENERAL, { ...GENERAL, roomId: ANNONCES_ROOM, name: 'annonces' }],
  channels: new Map([
    [CHANNEL, { state: 'resolved', roomId: ROOM }],
    [ANNONCES, { state: 'resolved', roomId: ANNONCES_ROOM }],
  ]),
}

function Navigating({ delay }: { delay: number }) {
  const [channelId, setChannelId] = useState(CHANNEL)
  return createElement(EspaceLiveView, {
    org: 'acme',
    organisationName: 'Acme SA',
    workspace: TWO_CHANNELS,
    channelId,
    store: { ...storeWith([]), getSnapshot: () => TWO_ROOMS },
    onNavigateChannel: (next: string) =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          setChannelId(next)
          resolve()
        }, delay)
      ),
  })
}

// The catalogue is split by namespace, and only the entry namespaces travel with the application:
// a screen's words arrive with its route (`ROUTE_UNITS` in `src/app/routeTree.ts`). This page has
// no route, so it asks for what the workspace route would have brought before it offers to draw.
await ensureNamespaces([...ORGANISATION_NAMESPACES, 'docs'])

const element = document.getElementById('root')
if (element === null) throw Error('harness.html has no #root')
const root = createRoot(element)

function liveStore(initial: number): EspaceStoreLike {
  let messages: readonly MessageView[] = Array.from({ length: initial }, (_, index) =>
    message(index)
  )
  let snapshot = SNAPSHOT
  const listeners = new Set<() => void>()
  publishOne = () => {
    messages = [...messages, message(messages.length)]
    snapshot = { ...snapshot }
    for (const listener of [...listeners]) listener()
  }
  return {
    ...storeWith(messages),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    getTimeline: (roomId) => (roomId === ROOM ? messages : []),
  }
}

window.layoutHarness = {
  show(count) {
    const messages = Array.from({ length: count }, (_, index) => message(index))
    // A fresh view per call: the log opens on its newest message, as when a channel is opened.
    root.render(
      createElement(
        'div',
        { key: count, className: 'flex h-screen' },
        createElement(EspaceLiveView, {
          org: 'acme',
          organisationName: 'Acme SA',
          workspace: WORKSPACE,
          channelId: CHANNEL,
          store: storeWith(messages),
        })
      )
    )
  },
  live(count) {
    root.render(
      createElement(
        'div',
        { key: `live-${count}`, className: 'flex h-screen' },
        createElement(EspaceLiveView, {
          org: 'acme',
          organisationName: 'Acme SA',
          workspace: WORKSPACE,
          channelId: CHANNEL,
          store: liveStore(count),
        })
      )
    )
  },
  append() {
    const publish = publishOne
    if (publish === null) throw Error('append() before live()')
    const started = performance.now()
    flushSync(publish)
    return performance.now() - started
  },
  navigating(delay) {
    root.render(
      createElement(
        'div',
        { key: `navigating-${delay}`, className: 'flex h-screen' },
        createElement(Navigating, { delay })
      )
    )
  },
}
