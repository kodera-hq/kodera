import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import type { Workspace } from '../workspace/workspace'
import { CallsSurfaceView } from './CallsSurfaceView'
import type { EspaceStoreLike } from './liveViewModel'
import type { EspaceSnapshot } from './matrix/store'

const closeMeter = vi.fn()
vi.mock('./audio/meter', () => ({
  webAudioMeter: vi.fn(() => ({
    level: () => 0.42,
    close: closeMeter,
  })),
}))

const WORKSPACE: Workspace = {
  organisation_id: 'org-1',
  state: 'initialised',
  setup: { state: 'ready', reason: null },
  can_initialise: false,
  id: 'ws-1',
  categories: [],
  uncategorised_channels: [
    {
      id: 'ch-voice',
      kind: 'audio',
      name: 'office-hours',
      template_key: null,
      topic: '',
      lifecycle: 'active',
      room_state: 'ready',
    },
  ],
}

function fakeStore(): EspaceStoreLike {
  const snapshot = {
    status: 'live',
    channels: new Map([['ch-voice', { state: 'resolved', roomId: '!voice:acme.test' }]]),
    rooms: [
      {
        roomId: '!voice:acme.test',
        name: 'office-hours',
        alias: '#office-hours:acme.test',
        kind: 'audio',
        unread: 0,
        mentions: 0,
        occupancy: { participants: [], screenShare: [] },
        names: {},
      },
    ],
    invites: [],
  } as unknown as EspaceSnapshot
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
  } as unknown as EspaceStoreLike
}

function createFakeStream() {
  let live = true
  const track = {
    stop: vi.fn(() => {
      live = false
    }),
    isLive: () => live,
  }
  const stream = {
    getAudioTracks: () => [track as unknown as MediaStreamTrack],
    getTracks: () => [track as unknown as MediaStreamTrack],
  } as unknown as MediaStream
  return { stream, track }
}

beforeAll(async () => {
  await i18n.changeLanguage('fr')
})

afterEach(() => {
  closeMeter.mockClear()
  vi.unstubAllGlobals()
})

describe('CallsSurfaceView pre-join microphone lifecycle', () => {
  it('stops resolved MediaStream tracks immediately when unmounted before getUserMedia settles', async () => {
    const user = userEvent.setup()
    let resolveStream!: (stream: MediaStream) => void
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveStream = resolve
        })
    )
    vi.stubGlobal(
      'navigator',
      Object.assign(Object.create(navigator), {
        mediaDevices: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
      })
    )

    const view = render(
      <CallsSurfaceView
        workspace={WORKSPACE}
        store={fakeStore()}
        call={null}
        callChannel={null}
        deviceSettings={null}
        onJoinRoom={vi.fn()}
        onOpenStage={vi.fn()}
      />
    )

    const testBtn = screen.getByRole('button', { name: 'Tester le micro' })
    await user.click(testBtn)
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(testBtn).toBeDisabled()

    // Unmount while getUserMedia permission prompt is still pending
    view.unmount()

    const { stream, track } = createFakeStream()
    await act(async () => {
      resolveStream(stream)
      await Promise.resolve()
    })

    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(track.isLive()).toBe(false)
  })

  it('serializes rapid double-clicks on Tester le micro and leaves zero live tracks after Stop', async () => {
    const user = userEvent.setup()
    const streams: ReturnType<typeof createFakeStream>[] = []
    let resolveFirst!: (stream: MediaStream) => void
    const getUserMedia = vi.fn(() => {
      const created = createFakeStream()
      streams.push(created)
      if (streams.length === 1) {
        return new Promise<MediaStream>((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve(created.stream)
    })
    vi.stubGlobal(
      'navigator',
      Object.assign(Object.create(navigator), {
        mediaDevices: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
      })
    )

    render(
      <CallsSurfaceView
        workspace={WORKSPACE}
        store={fakeStore()}
        call={null}
        callChannel={null}
        deviceSettings={null}
        onJoinRoom={vi.fn()}
        onOpenStage={vi.fn()}
      />
    )

    const testBtn = screen.getByRole('button', { name: 'Tester le micro' })
    // Rapid synchronous double-click in the same tick before state flush
    fireEvent.click(testBtn)
    fireEvent.click(testBtn)
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(testBtn).toBeDisabled()

    await act(async () => {
      resolveFirst(streams[0]!.stream)
      await Promise.resolve()
    })

    const stopBtn = screen.getByRole('button', { name: /Arrêter/ })
    expect(stopBtn).toBeEnabled()
    await user.click(stopBtn)

    expect(streams).toHaveLength(1)
    expect(streams[0]!.track.stop).toHaveBeenCalledTimes(1)
    expect(streams[0]!.track.isLive()).toBe(false)
    expect(closeMeter).toHaveBeenCalledTimes(1)
  })
})
