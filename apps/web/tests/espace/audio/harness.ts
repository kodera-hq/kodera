/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// The page two-browsers.spec.ts drives: Espace's real call controller (src/features/espace/audio/
// call.ts, imported, not copied) in a bare page, with what a test needs to see of it. Tokens come
// in through `page.evaluate`, never a URL.
//
// What the member hears is read from WebRTC's own statistics: every RTCPeerConnection the page
// makes is kept, LiveKit's among them, so the controller runs with its own room and nothing of
// it is replaced.

import type { CallController, CallSnapshot } from '@/features/espace/audio/call'
import type { AudioDeviceChoice, AudioDevices } from '@/features/espace/audio/devices'
import { createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createEspaceStore, type EspaceStore } from '@/features/espace/matrix/store'
import type { Workspace } from '@/features/workspace/workspace'

/** A snapshot, and when the controller published it (`Date.now()`, the Node side's clock). */
export interface Transition extends CallSnapshot {
  at: number
}

export interface RemoteAudio {
  /** The remote track's id, as the receiving `<audio>` element's stream names it. */
  trackId: string
  bytesReceived: number
  /** Grows while sound arrives, and stays flat through silence. */
  totalAudioEnergy: number
  /** WebRTC's received audio level, 0 to 1. Zero when the sender is silent. */
  audioLevel: number
  /** A playing, unmuted `<audio>` element has this track. */
  playing: boolean
}

export interface AudioStats {
  /** Bytes sent by the local microphone track. */
  bytesSent: number
  remote: RemoteAudio[]
}

export interface Harness {
  start(options: { homeserver: string; accessToken: string }): void
  /** The room the page's button joins: a join starts from a click, as from the sidebar. */
  arm(roomId: string): void
  /** After the click: resolves once the join is through, with the click's `Date.now()`. */
  joined(): Promise<number>
  leave(): Promise<void>
  mute(muted: boolean): Promise<void>
  snapshot(): CallSnapshot
  /** Every snapshot since `start`, in order. */
  history(): Transition[]
  stats(): Promise<AudioStats>
  /** The state of the microphone track the page sends: `ended` once stopped, as when muted. */
  microphone(): 'live' | 'ended' | 'none'
  /** The member's own microphone level as the dock's meter reads it (`micLevel`). */
  micLevel(): number
  /** The microphones and outputs the browser lists, as the audio settings show them. */
  devices(): Promise<AudioDevices>
  /** Writes a choice into this browser's storage, as an earlier visit would have left it. */
  remember(choice: AudioDeviceChoice): void
  /** The choice in this browser's storage now. */
  remembered(): unknown
  /** A new controller, as a page opened again makes: it reads the choice remembered. */
  restart(): void
  chooseInput(input: string | null): Promise<void>
  /** The device the microphone track the page sends captures from. */
  inputDevice(): string | null
  /** Mount the product live view over this member's real Matrix store and call. */
  showView(channelId: string): Promise<void>
  hideView(): void
}

declare global {
  interface Window {
    espaceHarness: Harness
  }
}

// Kept before LiveKit is loaded, so that every connection it makes is one of these.
const connections: RTCPeerConnection[] = []
const NativePeerConnection = window.RTCPeerConnection
window.RTCPeerConnection = class extends NativePeerConnection {
  constructor(configuration?: RTCConfiguration) {
    super(configuration)
    connections.push(this)
  }
}

const { createCallController } = await import('@/features/espace/audio/call')
const { listAudioDevices, AUDIO_DEVICES_STORAGE_KEY } =
  await import('@/features/espace/audio/devices')
const { RefreshRefused } = await import('@/auth/matrix')

// Load the real TSX view through Vite. This harness is also checked by the
// Node TS project, whose JSX mode is intentionally off. No copy or fake of
// the face/ring, controller or Matrix store is drawn here.
const source = '/src/features/espace/EspaceLiveView.tsx'
const { EspaceLiveView } = (await import(/* @vite-ignore */ source)) as {
  EspaceLiveView: ComponentType<{
    org: string
    organisationName: string
    workspace: Workspace
    channelId: undefined
    store: EspaceStore
    call: CallController
  }>
}
// The catalogue is split by namespace, and only the entry namespaces travel with the application:
// a screen's words arrive with its route (`ROUTE_UNITS` in `src/app/routeTree.ts`). This page has
// no route, so it asks for what the workspace route would have brought before it draws the view;
// without them the view refuses to draw a bare key and the proof never sees a face.
const { ensureNamespaces } = await import('@/i18n')
const { ORGANISATION_NAMESPACES } = await import('@/i18n/namespaces')
await ensureNamespaces([...ORGANISATION_NAMESPACES, 'docs'])
await import('@/index.css')

let controller: CallController | null = null
let started: { homeserver: string; accessToken: string } | null = null
let armed: string | null = null
let joining: { at: number; done: Promise<void> } | null = null
const transitions: Transition[] = []
let view: { root: Root; store: EspaceStore; element: HTMLElement } | null = null

function current(): CallController {
  if (controller === null) throw new Error('espaceHarness.start was not called')
  return controller
}

document.querySelector('#join')?.addEventListener('click', () => {
  if (armed === null) return
  joining = { at: Date.now(), done: current().join(armed) }
  armed = null
})

function playing(trackId: string): boolean {
  return [...document.querySelectorAll('audio')].some(
    (element) =>
      element.srcObject instanceof MediaStream &&
      element.srcObject.getAudioTracks().some((track) => track.id === trackId) &&
      !element.paused &&
      !element.muted &&
      element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
  )
}

window.espaceHarness = {
  start({ homeserver, accessToken }) {
    started = { homeserver, accessToken }
    controller = createCallController({
      homeserver,
      // The local stack's server name (tests/espace/stack/synapse/homeserver.yaml.tmpl); its
      // LiveKit is a ws: URL to this machine, which development allows.
      serverName: 'kodera.test',
      tokens: {
        current: () => accessToken,
        // A password sign-in's token outlives the test, so a refusal is a real one: the session
        // is over, as the Console's refresh would find it (a member taken out of the
        // organisation has lost their refresh token too).
        renew: () => Promise.reject(new RefreshRefused('the harness does not refresh')),
      },
    })
    controller.subscribe(() => {
      transitions.push({ ...current().getSnapshot(), at: Date.now() })
    })
  },
  arm(roomId) {
    armed = roomId
  },
  async joined() {
    if (joining === null) throw new Error('the join button was not clicked')
    const { at, done } = joining
    joining = null
    await done
    return at
  },
  leave: () => current().leave(),
  mute: (muted) => current().setMuted(muted),
  snapshot: () => current().getSnapshot(),
  history: () => [...transitions],
  async stats() {
    let bytesSent = 0
    const remote: RemoteAudio[] = []
    for (const connection of connections) {
      if (connection.connectionState === 'closed') continue
      const report = await connection.getStats()
      report.forEach((entry: Record<string, unknown>) => {
        if (entry['kind'] !== 'audio') return
        if (entry['type'] === 'outbound-rtp') bytesSent += Number(entry['bytesSent'] ?? 0)
        if (entry['type'] === 'inbound-rtp') {
          const trackId = String(entry['trackIdentifier'])
          remote.push({
            trackId,
            bytesReceived: Number(entry['bytesReceived'] ?? 0),
            totalAudioEnergy: Number(entry['totalAudioEnergy'] ?? 0),
            audioLevel: Number(entry['audioLevel'] ?? 0),
            playing: playing(trackId),
          })
        }
      })
    }
    return { bytesSent, remote }
  },
  micLevel() {
    return current().micLevel()
  },
  devices: () => listAudioDevices(),
  remember(choice) {
    window.localStorage.setItem(AUDIO_DEVICES_STORAGE_KEY, JSON.stringify(choice))
  },
  remembered() {
    const stored = window.localStorage.getItem(AUDIO_DEVICES_STORAGE_KEY)
    return stored === null ? null : JSON.parse(stored)
  },
  restart() {
    if (started === null) throw new Error('espaceHarness.start was not called')
    window.espaceHarness.start(started)
  },
  chooseInput: (input) => current().chooseInput(input),
  inputDevice() {
    for (const connection of connections) {
      if (connection.connectionState === 'closed') continue
      for (const sender of connection.getSenders()) {
        if (sender.track?.kind === 'audio' && sender.track.readyState === 'live')
          return sender.track.getSettings().deviceId ?? null
      }
    }
    return null
  },
  microphone() {
    for (const connection of connections) {
      if (connection.connectionState === 'closed') continue
      for (const sender of connection.getSenders()) {
        if (sender.track?.kind === 'audio') return sender.track.readyState
      }
    }
    return 'none'
  },
  async showView(channelId) {
    window.espaceHarness.hideView()
    if (started === null) throw new Error('espaceHarness.start was not called')
    const { homeserver, accessToken } = started
    const response = await fetch(`${homeserver}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) throw new Error(`audio view identity: ${response.status}`)
    const identity = (await response.json()) as { user_id: string; device_id: string }
    const store = createEspaceStore({
      baseUrl: homeserver,
      userId: identity.user_id,
      deviceId: identity.device_id,
      accessToken,
    })
    const workspace: Workspace = {
      organisation_id: '11111111-1111-4111-8111-111111111111',
      state: 'initialised',
      setup: { state: 'ready', reason: null },
      can_initialise: false,
      id: '22222222-2222-4222-8222-222222222222',
      categories: [],
      uncategorised_channels: [
        {
          id: channelId,
          kind: 'audio',
          name: 'Salon audio',
          template_key: null,
          topic: '',
          lifecycle: 'active',
          room_state: 'ready',
        },
      ],
    }
    const element = document.createElement('div')
    element.className = 'flex h-screen'
    document.body.append(element)
    const root = createRoot(element)
    view = { root, store, element }
    await store.start()
    root.render(
      createElement(EspaceLiveView, {
        org: 'acme',
        organisationName: 'Audio proof',
        workspace,
        channelId: undefined,
        store,
        call: current(),
      })
    )
  },
  hideView() {
    if (view === null) return
    view.root.unmount()
    view.store.stop()
    view.element.remove()
    view = null
  },
}
