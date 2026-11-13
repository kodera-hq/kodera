// The dock's camera, screen, video stage, reconnect banner, push-to-talk and pre-join presence,
// against a call the test drives (docs/specs/espace-video-and-screenshare.md).
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import type { CallSnapshot } from './audio/call'
import { callPreferences } from './audio/callPreferences'
import type { AudioCallLike, EspaceStoreLike } from './liveViewModel'
import type { EspaceSnapshot } from './matrix/store'
import { VoiceCallDock } from './VoiceCallDock'

const ME = '@me:example.test'
const BOB = '@bob:example.test'
const ROOM = '!standup:example.test'

beforeAll(async () => {
  await i18n.changeLanguage('fr')
})

afterEach(() => {
  callPreferences.update({ inputMode: 'voice', noiseSuppression: true })
  window.localStorage.clear()
})

const IDLE: CallSnapshot = {
  status: 'idle',
  roomId: null,
  muted: false,
  deafened: false,
  listenOnly: false,
  speakers: [],
  participants: [],
  playbackBlocked: false,
  videos: [],
  camera: 'off',
  screen: 'off',
}

function fakeCall(options: { video?: boolean } = {}) {
  let snapshot = IDLE
  const listeners = new Set<() => void>()
  const set = (patch: Partial<CallSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const call = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    join: vi.fn(async (roomId: string) => set({ status: 'connecting', roomId })),
    leave: vi.fn(async () => set(IDLE)),
    setMuted: vi.fn(async (muted: boolean) => set({ muted })),
    setDeafened: vi.fn(async () => undefined),
    startAudio: vi.fn(async () => undefined),
    ...(options.video === false
      ? {}
      : {
          setCameraEnabled: vi.fn(async (on: boolean) => set({ camera: on ? 'on' : 'off' })),
          setScreenShareEnabled: vi.fn(async (on: boolean) => set({ screen: on ? 'on' : 'off' })),
          attachVideo: vi.fn(() => () => undefined),
        }),
  } satisfies AudioCallLike
  return { call, set: (patch: Partial<CallSnapshot>) => act(() => set(patch)) }
}

function fakeStore(occupants: readonly string[] = []): EspaceStoreLike {
  const snapshot = {
    status: 'live',
    channels: new Map(),
    rooms: [
      {
        roomId: ROOM,
        name: 'Point quotidien',
        alias: '#standup:example.test',
        kind: 'audio',
        unread: 0,
        mentions: 0,
        occupancy: { participants: [...occupants], screenShare: [] },
        names: { [BOB]: 'Bob Martin' },
      },
    ],
    invites: [],
  } as unknown as EspaceSnapshot
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
  } as unknown as EspaceStoreLike
}

function renderDock(call: AudioCallLike, store = fakeStore()) {
  return render(
    <VoiceCallDock
      call={call}
      channel={{
        channelId: 'standup',
        roomId: ROOM,
        roomName: 'Point quotidien',
        categoryName: 'Équipe',
      }}
      store={store}
      viewerId={ME}
      deviceSettings={null}
      meterRef={{ current: null }}
      panelMeterRef={{ current: null }}
    />
  )
}

describe('the camera and the screen in the dock', () => {
  it('turns the camera on and off from the dock, and says the browser refused it', async () => {
    const user = userEvent.setup()
    const { call, set } = fakeCall()
    renderDock(call)
    set({ status: 'connected', roomId: ROOM, participants: [ME] })
    await user.click(screen.getByRole('button', { name: 'Activer la caméra' }))
    expect(call.setCameraEnabled).toHaveBeenCalledWith(true)
    const off = screen.getByRole('button', { name: 'Couper la caméra' })
    expect(off).toHaveAttribute('aria-pressed', 'true')
    await user.click(off)
    expect(call.setCameraEnabled).toHaveBeenLastCalledWith(false)

    set({ videoProblem: 'camera-denied' })
    expect(
      screen.getByText(
        'Le navigateur refuse la caméra à Kodera. Autorisez-la dans les réglages du site, puis réessayez.'
      )
    ).toBeInTheDocument()
  })

  it('draws the video stage, loaded on demand, once someone shows video, and docks it', async () => {
    const user = userEvent.setup()
    const { call, set } = fakeCall()
    renderDock(call)
    set({ status: 'connected', roomId: ROOM, participants: [ME, BOB] })
    expect(screen.queryByRole('region', { name: 'Vidéo de l’appel' })).toBeNull()
    set({ videos: [{ key: 'TR_bob', userId: BOB, source: 'camera', local: false }] })
    const stage = await screen.findByRole('region', { name: 'Vidéo de l’appel' })
    expect(within(stage).getByRole('figure', { name: 'Caméra de Bob Martin' })).toBeInTheDocument()
    expect(call.attachVideo).toHaveBeenCalledWith('TR_bob', expect.any(HTMLVideoElement))
    await user.click(screen.getByRole('button', { name: 'Réduire la vidéo en vignette' }))
    expect(screen.getByRole('region', { name: 'Vidéo de l’appel' })).toHaveClass('fixed')
  })

  it('offers no camera in a listen-only room, while connecting, or on a call that makes no video', () => {
    const listenOnly = fakeCall()
    const first = renderDock(listenOnly.call)
    listenOnly.set({ status: 'connected', roomId: ROOM, listenOnly: true, muted: true })
    expect(screen.queryByRole('button', { name: 'Activer la caméra' })).toBeNull()
    first.unmount()

    const connecting = fakeCall()
    const second = renderDock(connecting.call)
    connecting.set({ status: 'connecting', roomId: ROOM })
    expect(screen.queryByRole('button', { name: 'Activer la caméra' })).toBeNull()
    second.unmount()

    const audioOnly = fakeCall({ video: false })
    renderDock(audioOnly.call)
    audioOnly.set({ status: 'connected', roomId: ROOM })
    expect(screen.queryByRole('button', { name: 'Activer la caméra' })).toBeNull()
  })
})

describe('before the call is through', () => {
  it('lists who is already in the room, from its occupancy, the member left out', () => {
    const { call, set } = fakeCall()
    renderDock(call, fakeStore([BOB, ME]))
    set({ status: 'connecting', roomId: ROOM })
    const already = screen.getByRole('region', { name: 'Déjà dans le salon' })
    expect(within(already).getByText('Bob Martin')).toBeInTheDocument()
    expect(within(already).queryAllByRole('listitem')).toHaveLength(1)
  })
})

describe('reconnecting', () => {
  it('says the connection is being resumed while LiveKit resumes it', () => {
    const { call, set } = fakeCall()
    renderDock(call)
    set({ status: 'connected', roomId: ROOM })
    set({ status: 'reconnecting' })
    expect(screen.getByText('Connexion instable : reprise en cours…')).toBeInTheDocument()
  })
})

describe('push-to-talk', () => {
  it('mutes once the call is through, speaks while the key is held, and says the mode', async () => {
    callPreferences.update({ inputMode: 'push-to-talk' })
    const { call, set } = fakeCall()
    renderDock(call)
    set({ status: 'connected', roomId: ROOM })
    expect(call.setMuted).toHaveBeenLastCalledWith(true)
    expect(screen.getByText('Connecté · Appuyer pour parler')).toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backquote', cancelable: true }))
    })
    expect(call.setMuted).toHaveBeenLastCalledWith(false)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Backquote' }))
    })
    expect(call.setMuted).toHaveBeenLastCalledWith(true)
  })

  it('leaves the microphone as it is when the member goes back to an open microphone', () => {
    callPreferences.update({ inputMode: 'push-to-talk' })
    const { call, set } = fakeCall()
    renderDock(call)
    set({ status: 'connected', roomId: ROOM })
    act(() => callPreferences.update({ inputMode: 'voice' }))
    expect(call.setMuted).not.toHaveBeenCalledWith(false)
    // The key does nothing once the mode is off.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backquote' }))
    })
    expect(call.setMuted).not.toHaveBeenCalledWith(false)
  })
})
