import type { Workspace } from '../../../src/features/workspace/workspace'
import { useEffect, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AnyRouter } from '@tanstack/react-router'
import { ensureNamespaces } from '../../../src/i18n'
import '../../../src/index.css'
import { startTelemetry } from '../../../src/analytics/telemetry/bootstrap'
import {
  hasTelemetryConsent,
  setTelemetryConsent,
  setTelemetryScope,
  subscribeTelemetryConsent,
} from '../../../src/analytics/telemetry/consent'
import { track } from '../../../src/analytics/track'
import {
  EspaceLiveView,
  type AudioCallLike,
  type EspaceStoreLike,
} from '../../../src/features/espace/EspaceLiveView'
import type { CallSnapshot } from '../../../src/features/espace/audio/call'
import type { EspaceSnapshot } from '../../../src/features/espace/matrix/store'
import { EXAMPLES } from '../../../src/mocks/generated/examples'

const workspace = structuredClone(EXAMPLES.getWorkspace.body) as Workspace
const general = workspace.categories[0]!.channels[1]!
const audio = {
  ...general,
  id: 'protected-audio',
  name: 'Protected audio',
  template_key: null,
  kind: 'audio' as const,
  is_confidential: true,
}
workspace.categories[0]!.channels.push(audio)
const generalRoom = '!general:example.test'
const callRoom = '!call:example.test'
const snapshot: EspaceSnapshot = {
  status: 'live',
  channels: new Map([
    [general.id, { state: 'resolved', roomId: generalRoom }],
    [audio.id, { state: 'resolved', roomId: callRoom }],
  ]),
  rooms: [
    {
      roomId: callRoom,
      name: 'Protected audio',
      alias: null,
      kind: 'audio',
      unread: 0,
      mentions: 0,
      occupancy: null,
    },
    {
      roomId: generalRoom,
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
const empty = Object.freeze([])
const store: EspaceStoreLike = {
  subscribe: () => () => {},
  getSnapshot: () => snapshot,
  getUserId: () => '@member:example.test',
  getTimeline: () => empty,
  getThread: () => empty,
  send: async () => {},
  edit: async () => {},
  remove: async () => {},
  toggleReaction: async () => {},
  getDirects: () => [
    {
      roomId: '!pending:example.test',
      userIds: ['@alice:example.test'],
      name: 'Pending DM',
      unread: 0,
    },
  ],
  getRoomBoundary: (roomId) =>
    roomId === generalRoom
      ? 'ordinary'
      : roomId === callRoom
        ? 'confidential-unavailable'
        : 'unknown',
}
let callSnapshot: CallSnapshot = {
  status: 'idle',
  roomId: null,
  muted: false,
  deafened: false,
  listenOnly: false,
  speakers: [],
  participants: [],
  playbackBlocked: false,
}
const listeners = new Set<() => void>()
const changeCall = (active: boolean) => {
  callSnapshot = {
    ...callSnapshot,
    status: active ? 'connected' : 'idle',
    roomId: active ? callRoom : null,
  }
  for (const listener of listeners) listener()
}
const call: AudioCallLike = {
  subscribe: (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  getSnapshot: () => callSnapshot,
  canJoinProtectedRoom: () => true,
  join: async () => changeCall(true),
  leave: async () => changeCall(false),
  setMuted: async () => {},
  setDeafened: async () => {},
  startAudio: async () => {},
}
const router = { subscribe: () => () => {} } as unknown as AnyRouter
function Fixture() {
  const allowed = useSyncExternalStore(subscribeTelemetryConsent, hasTelemetryConsent)
  useEffect(() => {
    const clear = setTelemetryScope({
      person: 'fixture-member',
      workspace: 'fixture-workspace',
      slug: 'fixture',
    })
    setTelemetryConsent(true)
    const started = startTelemetry(
      router,
      import.meta.env.VITE_POSTHOG_KEY,
      import.meta.env.VITE_POSTHOG_HOST
    )
    return () => {
      clear()
      void started.then((stop) => stop())
    }
  }, [])
  return (
    <QueryClientProvider client={client}>
      <output data-testid="telemetry-state">{allowed ? 'active' : 'held'}</output>
      <button onClick={() => changeCall(true)}>Start protected call</button>
      <button onClick={() => changeCall(false)}>End protected call</button>
      <button
        onClick={() =>
          track('client_error', { source: 'boundary', kind: 'unknown', area: 'workspace' })
        }
      >
        Telemetry probe
      </button>
      <EspaceLiveView
        org="fixture"
        organisationName="Fixture"
        workspace={workspace}
        channelId={general.id}
        store={store}
        call={call}
      />
    </QueryClientProvider>
  )
}
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
void ensureNamespaces(['workspace', 'messaging', 'docs']).then(() => {
  createRoot(document.getElementById('root')!).render(<Fixture />)
})
