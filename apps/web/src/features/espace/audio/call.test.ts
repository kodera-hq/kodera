import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionState, DisconnectReason, Room, RoomEvent, Track } from 'livekit-client'
import {
  createCallController,
  matrixUserOf,
  ROOM_OPTIONS,
  type CallRoom,
  type CallSoundPort,
} from './call'
import { CROWD_ATTENUATED_GAIN, SoundEngine, type SoundDecision } from '../../sounds'
import type { MicMeter } from './meter'
import { NO_CHOICE, type AudioDeviceChoice } from './devices'

/** LiveKit's enable as the controller makes it without a chosen microphone: the default, by name. */
const MIC_ON = [true, { deviceId: { ideal: 'default' } }] as const

const HS = 'https://matrix.acme-sa.kodera.test'
const STANDUP = '!standup:matrix.acme-sa.kodera.test'
const RETRO = '!retro:matrix.acme-sa.kodera.test'
const ME = '@me:matrix.acme-sa.kodera.test'
const BOB = '@bob:matrix.acme-sa.kodera.test'
const LIVEKIT_TOKEN = 'lk.jwt.secret'

type Handler = (...args: never[]) => void

class FakeTrack {
  readonly kind: 'audio' | 'video'
  readonly elements: HTMLAudioElement[] = []
  constructor(kind: 'audio' | 'video' = 'audio') {
    this.kind = kind
  }
  attach = vi.fn(() => {
    const element = document.createElement('audio')
    this.elements.push(element)
    return element
  })
  detach = vi.fn(() => this.elements.splice(0))
}

class FakePublication {
  enabled = true
  track: FakeTrack | undefined
  constructor(track?: FakeTrack) {
    this.track = track
  }
  setEnabled = vi.fn((enabled: boolean) => {
    this.enabled = enabled
  })
}

class FakeRemote {
  readonly audioTrackPublications = new Map<string, FakePublication>()
  constructor(readonly identity: string) {}
}

/** The browser's capture under the microphone: `stop` ends it, unless a test says otherwise. */
class FakeCapture {
  readyState: 'live' | 'ended' = 'live'
  stop = vi.fn(() => {
    this.readyState = 'ended'
  })
}

/** The member's own microphone track, as LiveKit publishes it. */
class FakeMicrophone {
  readonly mediaStreamTrack = new FakeCapture()
  muted = false
  get isMuted(): boolean {
    return this.muted
  }
  /** Whether the capture has ended: what the browser says, not what was asked of it. */
  get stopped(): boolean {
    return this.mediaStreamTrack.readyState === 'ended'
  }
  set stopped(stopped: boolean) {
    this.mediaStreamTrack.readyState = stopped ? 'ended' : 'live'
  }
  mute = vi.fn(async () => {
    this.muted = true
    return this
  })
  stop = vi.fn(() => {
    this.mediaStreamTrack.stop()
  })
}

class FakeRoom {
  readonly handlers = new Map<string, Set<Handler>>()
  readonly remoteParticipants = new Map<string, FakeRemote>()
  state: ConnectionState = ConnectionState.Disconnected
  canPlaybackAudio = true
  /** Published at the first `setMicrophoneEnabled(true)`; LiveKit keeps it published while muted. */
  microphone: { source: Track.Source; track: FakeMicrophone } | undefined
  /** What LiveKit last made of the microphone: the call that settled last, not the last made. */
  microphoneOn = false
  readonly localParticipant = {
    identity: `${ME}|DEVICE1`,
    permissions: { canPublish: true } as { canPublish: boolean } | undefined,
    setMicrophoneEnabled: vi.fn(async (enabled: boolean) => {
      this.applyMicrophone(enabled)
      return undefined as unknown
    }),
    getTrackPublication: vi.fn((source: Track.Source) =>
      source === Track.Source.Microphone ? this.microphone : undefined
    ),
    unpublishTrack: vi.fn(async (track: FakeMicrophone, _stopOnUnpublish?: boolean) => {
      if (this.microphone?.track === track) this.microphone = undefined
      return undefined as unknown
    }),
  }
  connect = vi.fn(async (_url: string, _token: string) => {
    this.state = ConnectionState.Connected
  })
  /** As LiveKit's: a no-op once disconnected, and `Disconnected` emitted otherwise. */
  disconnect = vi.fn(async () => {
    if (this.state === ConnectionState.Disconnected) return
    this.state = ConnectionState.Disconnected
    this.remoteParticipants.clear()
    // LiveKit unpublishes and stops the member's tracks with the connection.
    this.microphone?.track.stop()
    this.microphone = undefined
    this.microphoneOn = false
    this.emit(RoomEvent.Disconnected, DisconnectReason.CLIENT_INITIATED)
  })
  startAudio = vi.fn(async () => undefined)
  /** LiveKit's device switch: it succeeds unless a test says otherwise. */
  switchActiveDevice = vi.fn(async (_kind: MediaDeviceKind, _id: string, _exact?: boolean) => true)
  on(event: string, handler: Handler) {
    let set = this.handlers.get(event)
    if (set === undefined) this.handlers.set(event, (set = new Set()))
    set.add(handler)
    return this
  }
  off(event: string, handler: Handler) {
    this.handlers.get(event)?.delete(handler)
    return this
  }
  emit(event: string, ...args: unknown[]) {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      ;(handler as (...values: unknown[]) => void)(...args)
    }
  }
  /** What a settled `setMicrophoneEnabled` does to the microphone. */
  applyMicrophone(enabled: boolean, announce = true): void {
    const track = this.microphone?.track
    if (enabled) {
      if (track === undefined) this.publishMicrophone(announce)
      // LiveKit's unmute restarts a muted microphone (its restart clears `manuallyStopped`), and
      // returns early on one not muted: a track stopped without being muted stays dead.
      else if (track.muted) track.muted = track.stopped = false
    } else if (track !== undefined) {
      // `stopMicTrackOnMute`: muting stops the track.
      track.muted = track.stopped = true
    }
    this.microphoneOn = enabled
  }
  /** LiveKit publishing the member's microphone, and saying so unless `announce` is false. */
  publishMicrophone(announce = true): FakeMicrophone {
    const track = new FakeMicrophone()
    this.microphone = { source: Track.Source.Microphone, track }
    if (announce) this.emit(RoomEvent.LocalTrackPublished, this.microphone, this.localParticipant)
    return track
  }
  /** A microphone track published and still capturing: what the room can hear. */
  liveMicrophone(): boolean {
    return this.microphone?.track.mediaStreamTrack.readyState === 'live'
  }
  listening(): number {
    return [...this.handlers.values()].reduce((count, set) => count + set.size, 0)
  }
  /** A remote member publishing audio, subscribed. */
  publish(identity: string): { track: FakeTrack; publication: FakePublication } {
    const remote = this.remoteParticipants.get(identity) ?? new FakeRemote(identity)
    this.remoteParticipants.set(identity, remote)
    const track = new FakeTrack()
    const publication = new FakePublication(track)
    remote.audioTrackPublications.set(`TR_${remote.audioTrackPublications.size}`, publication)
    this.emit(RoomEvent.ParticipantConnected, remote)
    this.emit(RoomEvent.TrackSubscribed, track, publication, remote)
    return { track, publication }
  }
}

function grant(listenOnly = false, token = LIVEKIT_TOKEN) {
  return new Response(
    JSON.stringify({
      url: 'wss://rtc.acme-sa.kodera.test',
      token,
      listen_only: listenOnly,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

function setup(
  options: {
    answers?: (() => Response | Promise<Response>)[]
    deadline?: number
    createMeter?: () => MicMeter
    deviceChoice?: { read: () => AudioDeviceChoice; save: (choice: AudioDeviceChoice) => boolean }
    sounds?: CallSoundPort
  } = {}
) {
  const rooms: FakeRoom[] = []
  const answers = options.answers ?? []
  const fetchImpl = vi.fn(async () =>
    (answers.shift() ?? (() => grant()))()
  ) as unknown as typeof fetch
  const mount = document.createElement('div')
  document.body.append(mount)
  const call = createCallController({
    homeserver: HS,
    serverName: 'acme-sa.kodera.test',
    tokens: { current: () => 'syt_member', renew: vi.fn(async () => 'syt_next') },
    fetch: fetchImpl,
    mount: () => mount,
    ...(options.deadline === undefined ? {} : { microphoneDeadlineMs: options.deadline }),
    ...(options.createMeter === undefined ? {} : { createMeter: options.createMeter }),
    ...(options.sounds === undefined ? {} : { sounds: options.sounds }),
    // Never this browser's storage: a test's choice must not reach the next test.
    deviceChoice: options.deviceChoice ?? { read: () => NO_CHOICE, save: () => true },
    createRoom: () => {
      const room = new FakeRoom()
      rooms.push(room)
      return room as unknown as CallRoom
    },
  })
  const room = (index = 0) => {
    const found = rooms[index]
    if (found === undefined) throw new Error(`No room ${index} was created`)
    return found
  }
  return { call, rooms, room, fetchImpl, mount }
}

// The deployment's matrix domain, under which the room-access call's LiveKit URL must sit.
beforeEach(() => {
  vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
})

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('matrixUserOf', () => {
  it("reads the Matrix user id out of the room-access service's identity", () => {
    expect(matrixUserOf(`${ME}|DEVICE1`)).toBe(ME)
    expect(matrixUserOf(ME)).toBe(ME)
    expect(matrixUserOf('DEVICE1')).toBeNull()
    expect(matrixUserOf('|DEVICE1')).toBeNull()
    expect(matrixUserOf('@:x|D')).toBeNull()
  })
})

describe('CallController', () => {
  it('joins: a token for the room, the connection, then the microphone', async () => {
    const { call, room, fetchImpl } = setup()
    const joining = call.join(STANDUP)
    // From the click itself, before anything is awaited.
    expect(room().startAudio).toHaveBeenCalledTimes(1)
    expect(call.getSnapshot()).toMatchObject({ status: 'connecting', roomId: STANDUP })
    await joining

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${HS}/_kodera/rooms/token`)
    expect(JSON.parse(init.body as string)).toEqual({ room_id: STANDUP })
    expect(room().connect).toHaveBeenCalledWith('wss://rtc.acme-sa.kodera.test', LIVEKIT_TOKEN)
    expect(room().localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(...MIC_ON)
    expect(call.getSnapshot()).toEqual({
      status: 'connected',
      roomId: STANDUP,
      muted: false,
      muting: false,
      deafened: false,
      deafening: false,
      listenOnly: false,
      speakers: [],
      participants: [ME],
      // Whose ring the member's own microphone draws.
      self: ME,
      playbackBlocked: false,
    })
  })

  it('stays silent with a listen-only token: no microphone, and unmuting does nothing', async () => {
    const { call, room } = setup({ answers: [() => grant(true)] })
    await call.join(STANDUP)
    expect(room().localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled()
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', listenOnly: true, muted: true })
    await call.setMuted(false)
    expect(room().localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled()
    expect(call.getSnapshot().muted).toBe(true)
  })

  it('mutes and unmutes the microphone', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    const mic = room().localParticipant.setMicrophoneEnabled
    mic.mockClear()
    await call.setMuted(true)
    expect(mic).toHaveBeenLastCalledWith(false)
    expect(call.getSnapshot().muted).toBe(true)
    await call.setMuted(false)
    expect(mic).toHaveBeenLastCalledWith(...MIC_ON)
    expect(call.getSnapshot().muted).toBe(false)
  })

  it('plays remote audio through hidden elements, and removes them when the track goes', async () => {
    const { call, room, mount } = setup()
    await call.join(STANDUP)
    const { track, publication } = room().publish(`${BOB}|PHONE`)
    const [element] = track.elements
    expect(element).toBeDefined()
    expect(mount.contains(element!)).toBe(true)
    expect(element!.closest('[hidden]')).not.toBeNull()
    expect(element!.muted).toBe(false)
    expect(call.getSnapshot().participants).toEqual([ME, BOB])

    room().emit(RoomEvent.TrackUnsubscribed, track, publication, {})
    expect(mount.contains(element!)).toBe(false)
  })

  it('ignores video tracks: audio rooms play sound only', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    const video = new FakeTrack('video')
    room().emit(RoomEvent.TrackSubscribed, video, new FakePublication(video), {})
    expect(video.attach).not.toHaveBeenCalled()
  })

  it('deafens: silences what plays, what arrives later, and the microphone; undeafening restores', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    const bob = room().publish(`${BOB}|PHONE`)
    const mic = room().localParticipant.setMicrophoneEnabled
    mic.mockClear()
    const track = room().microphone!.track

    // LiveKit's own disable never settles: the microphone is shut down without it.
    hold(room())
    void call.setDeafened(true)
    expect(track.stop).toHaveBeenCalled()
    expect(track.mute).toHaveBeenCalled()
    expect(call.getSnapshot()).toMatchObject({ deafened: false, deafening: true, muted: false })
    await vi.waitFor(() =>
      expect(call.getSnapshot()).toMatchObject({ deafened: true, deafening: false, muted: true })
    )
    expect(track.mediaStreamTrack.readyState).toBe('ended')
    expect(bob.track.elements[0]!.muted).toBe(true)
    expect(bob.publication.setEnabled).toHaveBeenLastCalledWith(false)
    expect(mic).toHaveBeenLastCalledWith(false)

    const carol = room().publish('@carol:matrix.acme-sa.kodera.test|LAPTOP')
    expect(carol.track.elements[0]!.muted).toBe(true)
    expect(carol.publication.setEnabled).toHaveBeenLastCalledWith(false)

    await call.setDeafened(false)
    expect(call.getSnapshot()).toMatchObject({ deafened: false, muted: false })
    expect(bob.track.elements[0]!.muted).toBe(false)
    expect(carol.track.elements[0]!.muted).toBe(false)
    expect(bob.publication.setEnabled).toHaveBeenLastCalledWith(true)
    expect(carol.publication.setEnabled).toHaveBeenLastCalledWith(true)
    expect(mic).toHaveBeenLastCalledWith(...MIC_ON)
  })

  it('keeps the microphone off after undeafening when it was off before', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    await call.setMuted(true)
    await call.setDeafened(true)
    const mic = room().localParticipant.setMicrophoneEnabled
    mic.mockClear()
    await call.setDeafened(false)
    expect(call.getSnapshot()).toMatchObject({ deafened: false, muted: true })
    expect(mic).not.toHaveBeenCalled()
  })

  it('undeafens when the member unmutes', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    const bob = room().publish(`${BOB}|PHONE`)
    await call.setDeafened(true)
    await call.setMuted(false)
    expect(call.getSnapshot()).toMatchObject({ deafened: false, muted: false })
    expect(bob.track.elements[0]!.muted).toBe(false)
  })

  it('leaves: disconnects, and takes every element and listener with it', async () => {
    const { call, room, mount } = setup()
    await call.join(STANDUP)
    const bob = room().publish(`${BOB}|PHONE`)
    await call.leave()
    expect(room().disconnect).toHaveBeenCalledTimes(1)
    expect(bob.track.detach).toHaveBeenCalled()
    expect(mount.children).toHaveLength(0)
    expect(room().listening()).toBe(0)
    expect(call.getSnapshot()).toMatchObject({ status: 'idle', roomId: null })
  })

  it('leaves the current room before joining another, on the same LiveKit room', async () => {
    const { call, room, rooms } = setup()
    await call.join(STANDUP)
    const listening = room().listening()
    const bob = room().publish(`${BOB}|PHONE`)
    await call.join(RETRO)
    expect(rooms).toHaveLength(1)
    expect(room().disconnect).toHaveBeenCalledTimes(1)
    expect(room().connect).toHaveBeenCalledTimes(2)
    // The first call's elements and listeners went with it; the room's own Disconnected, emitted
    // while the next call connects, did not end that one.
    expect(bob.track.detach).toHaveBeenCalled()
    expect(room().listening()).toBe(listening)
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', roomId: RETRO })
    expect(call.getSnapshot()).not.toHaveProperty('problem')
  })

  it('makes one LiveKit room for every join, those that never connected included', async () => {
    // A room unlocks playback with an AudioContext it closes only when a connection ends: one
    // room per join leaked one for each join refused before connecting.
    const { call, rooms } = setup({
      answers: [
        () => new Response('{}', { status: 503 }),
        () => new Response('{}', { status: 403 }),
      ],
    })
    await call.join(STANDUP)
    await call.join(STANDUP)
    await call.leave()
    await call.join(RETRO)
    expect(rooms).toHaveLength(1)
    expect(rooms[0]!.startAudio).toHaveBeenCalledTimes(3)
    expect(rooms[0]!.connect).toHaveBeenCalledTimes(1)
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', roomId: RETRO })
  })

  it('does nothing when asked to join the room it is already in', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    await call.join(STANDUP)
    expect(room().connect).toHaveBeenCalledTimes(1)
    expect(room().disconnect).not.toHaveBeenCalled()
  })

  it('joins the second room when the first one’s token arrives after it', async () => {
    let releaseFirst: (response: Response) => void = () => undefined
    const { call, room } = setup({
      answers: [
        () => new Promise<Response>((resolve) => (releaseFirst = resolve)),
        () => grant(false, 'lk.jwt.retro'),
      ],
    })
    const first = call.join(STANDUP)
    await call.join(RETRO)
    releaseFirst(grant(false, 'lk.jwt.standup'))
    await first
    expect(room().connect).toHaveBeenCalledTimes(1)
    expect(room().connect).toHaveBeenCalledWith('wss://rtc.acme-sa.kodera.test', 'lk.jwt.retro')
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', roomId: RETRO })
  })

  it('fails when the connection closes while it is being set up', async () => {
    const { call, rooms } = setup()
    const joining = call.join(STANDUP)
    let connected: () => void = () => undefined
    rooms[0]!.connect.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (connected = () => resolve(undefined)))
    )
    await vi.waitFor(() => expect(rooms[0]!.connect).toHaveBeenCalled())
    // LiveKit says the room is gone before `connect` has returned, then returns all the same.
    rooms[0]!.emit(RoomEvent.Disconnected, DisconnectReason.SIGNAL_CLOSE)
    expect(call.getSnapshot()).toMatchObject({ status: 'connecting', roomId: STANDUP })
    connected()
    await joining
    expect(rooms[0]!.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled()
    expect(call.getSnapshot()).toMatchObject({
      status: 'failed',
      roomId: STANDUP,
      problem: 'unavailable',
    })
    expect(rooms[0]!.listening()).toBe(0)
  })

  it('fails when the connection closes while it is being set up, and connect says so', async () => {
    const { call, rooms } = setup()
    const joining = call.join(STANDUP)
    let refuse: (error: Error) => void = () => undefined
    rooms[0]!.connect.mockImplementationOnce(
      () => new Promise<undefined>((_resolve, reject) => (refuse = reject))
    )
    await vi.waitFor(() => expect(rooms[0]!.connect).toHaveBeenCalled())
    rooms[0]!.emit(RoomEvent.Disconnected, DisconnectReason.SIGNAL_CLOSE)
    refuse(new Error('could not establish signal connection'))
    await joining
    expect(call.getSnapshot()).toMatchObject({ status: 'failed', problem: 'unavailable' })
  })

  it('says when the browser holds the sound back, and lets the member start it', async () => {
    const { call, rooms } = setup()
    const joining = call.join(STANDUP)
    rooms[0]!.canPlaybackAudio = false
    await joining
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', playbackBlocked: true })

    // A click that the browser still refuses keeps it so.
    rooms[0]!.startAudio.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'))
    await call.startAudio()
    expect(call.getSnapshot().playbackBlocked).toBe(true)

    rooms[0]!.startAudio.mockImplementationOnce(async () => {
      rooms[0]!.canPlaybackAudio = true
    })
    await call.startAudio()
    expect(call.getSnapshot().playbackBlocked).toBe(false)

    // LiveKit says so itself, both ways (a page coming back on iOS, for one).
    rooms[0]!.canPlaybackAudio = false
    rooms[0]!.emit(RoomEvent.AudioPlaybackStatusChanged, false)
    expect(call.getSnapshot().playbackBlocked).toBe(true)
    rooms[0]!.canPlaybackAudio = true
    rooms[0]!.emit(RoomEvent.AudioPlaybackStatusChanged, true)
    expect(call.getSnapshot().playbackBlocked).toBe(false)
  })

  it('stops the microphone track itself when muted, so the recording indicator goes off', () => {
    expect(ROOM_OPTIONS.publishDefaults?.stopMicTrackOnMute).toBe(true)
    // LiveKit reads it from there for the microphone it publishes.
    expect(new Room({ ...ROOM_OPTIONS }).options.publishDefaults?.stopMicTrackOnMute).toBe(true)
  })

  it('never connects when the member left while the token was on its way', async () => {
    let release: (response: Response) => void = () => undefined
    const { call, room } = setup({
      answers: [() => new Promise<Response>((resolve) => (release = resolve))],
    })
    const joining = call.join(STANDUP)
    await call.leave()
    release(grant())
    await joining
    expect(room().connect).not.toHaveBeenCalled()
    expect(call.getSnapshot().status).toBe('idle')
  })

  it.each([
    [DisconnectReason.PARTICIPANT_REMOVED, 'removed'],
    [DisconnectReason.ROOM_DELETED, 'room-closed'],
    [DisconnectReason.ROOM_CLOSED, 'room-closed'],
    [DisconnectReason.DUPLICATE_IDENTITY, 'elsewhere'],
    [DisconnectReason.SIGNAL_CLOSE, 'connection-lost'],
    [undefined, 'connection-lost'],
  ])('ends the call when the server disconnects it (reason %s)', async (reason, problem) => {
    const { call, room, mount } = setup()
    await call.join(STANDUP)
    room().publish(`${BOB}|PHONE`)
    room().emit(RoomEvent.Disconnected, reason)
    expect(call.getSnapshot()).toMatchObject({ status: 'ended', roomId: STANDUP, problem })
    expect(mount.children).toHaveLength(0)
    expect(room().listening()).toBe(0)
    await call.leave()
    expect(call.getSnapshot().status).toBe('idle')
  })

  it('says it is reconnecting, then connected again', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    room().emit(RoomEvent.Reconnecting)
    expect(call.getSnapshot().status).toBe('reconnecting')
    room().emit(RoomEvent.Reconnected)
    expect(call.getSnapshot().status).toBe('connected')
    room().emit(RoomEvent.SignalReconnecting)
    expect(call.getSnapshot().status).toBe('reconnecting')
  })

  it('names who speaks by Matrix user id', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    room().emit(RoomEvent.ActiveSpeakersChanged, [
      { identity: `${BOB}|PHONE` },
      { identity: `${BOB}|LAPTOP` },
      { identity: `${ME}|DEVICE1` },
      { identity: 'agent' },
    ])
    expect(call.getSnapshot().speakers).toEqual([BOB, ME])
  })

  it('becomes listen-only when the service takes the right to speak away, and back', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    const local = room().localParticipant
    local.permissions = { canPublish: false }
    room().emit(RoomEvent.ParticipantPermissionsChanged, { canPublish: true }, local)
    // Shown muted once the microphone is silenced, not before.
    expect(call.getSnapshot()).toMatchObject({ listenOnly: true, muted: false, muting: true })
    await vi.waitFor(() =>
      expect(call.getSnapshot()).toMatchObject({ listenOnly: true, muted: true })
    )
    local.permissions = { canPublish: true }
    room().emit(RoomEvent.ParticipantPermissionsChanged, { canPublish: false }, local)
    expect(call.getSnapshot()).toMatchObject({ listenOnly: false, muted: true })
    // Another participant's rights are not the member's.
    room().emit(RoomEvent.ParticipantPermissionsChanged, undefined, { identity: BOB })
    expect(call.getSnapshot().listenOnly).toBe(false)
  })

  it.each([
    [new DOMException('Permission denied', 'NotAllowedError'), 'microphone-denied'],
    [new DOMException('Requested device not found', 'NotFoundError'), 'microphone-missing'],
    [new DOMException('Could not start audio source', 'NotReadableError'), 'microphone-in-use'],
    [new DOMException('Constraints', 'OverconstrainedError'), 'microphone'],
    [new Error('anything else'), 'microphone'],
  ])(
    'stays in the call, muted, and says why the microphone would not turn on (%s)',
    async (error, problem) => {
      const { call, rooms } = setup()
      const joining = call.join(STANDUP)
      rooms[0]!.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(error)
      await joining
      expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: true, problem })
    }
  )

  it('forgets why the microphone would not turn on once it does', async () => {
    const { call, rooms } = setup()
    const joining = call.join(STANDUP)
    rooms[0]!.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(
      new DOMException('No device', 'NotFoundError')
    )
    await joining
    expect(call.getSnapshot().problem).toBe('microphone-missing')
    // The member plugged one in, and unmutes.
    await call.setMuted(false)
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: false })
    expect(call.getSnapshot()).not.toHaveProperty('problem')
  })

  it.each([
    [403, 'forbidden'],
    [503, 'unavailable'],
  ])('fails with the service’s refusal (%i), without connecting', async (status, problem) => {
    const { call, room, mount } = setup({
      answers: [() => new Response('{}', { status })],
    })
    await call.join(STANDUP)
    expect(room().connect).not.toHaveBeenCalled()
    expect(mount.children).toHaveLength(0)
    expect(call.getSnapshot()).toMatchObject({ status: 'failed', roomId: STANDUP, problem })
  })

  it('forgets the last problem on leaving, and on joining again', async () => {
    const { call } = setup({
      answers: [
        () => new Response('{}', { status: 503 }),
        () => new Response('{}', { status: 503 }),
      ],
    })
    await call.join(STANDUP)
    expect(call.getSnapshot().problem).toBe('unavailable')
    await call.leave()
    expect(call.getSnapshot()).not.toHaveProperty('problem')

    await call.join(STANDUP)
    expect(call.getSnapshot().problem).toBe('unavailable')
    const retrying = call.join(STANDUP)
    expect(call.getSnapshot()).toMatchObject({ status: 'connecting' })
    expect(call.getSnapshot()).not.toHaveProperty('problem')
    await retrying
    expect(call.getSnapshot().status).toBe('connected')
    expect(call.getSnapshot()).not.toHaveProperty('problem')
  })

  it('fails as unavailable when LiveKit refuses the connection', async () => {
    const { call, rooms } = setup()
    const joining = call.join(STANDUP)
    rooms[0]!.connect.mockRejectedValueOnce(new Error('could not establish signal connection'))
    await joining
    expect(call.getSnapshot()).toMatchObject({ status: 'failed', problem: 'unavailable' })
    expect(rooms[0]!.listening()).toBe(0)
  })

  it("never connects to another organisation's LiveKit server, under the same matrix domain", async () => {
    const elsewhere = () =>
      Response.json({
        url: 'wss://rtc.other-org.kodera.test',
        token: LIVEKIT_TOKEN,
        listen_only: false,
      })
    const { call, rooms } = setup({ answers: [elsewhere] })
    await call.join(STANDUP)
    expect(call.getSnapshot()).toMatchObject({ status: 'failed', problem: 'malformed' })
    expect(rooms[0]!.connect).not.toHaveBeenCalled()
  })
})

describe('CallController: the microphone is never shown off while it may be on', () => {
  const turnOff = {
    mute: (call: ReturnType<typeof setup>['call']) => call.setMuted(true),
    deafen: (call: ReturnType<typeof setup>['call']) => call.setDeafened(true),
  }

  it.each(Object.keys(turnOff) as (keyof typeof turnOff)[])(
    'stops the microphone track itself when LiveKit fails to turn it off (%s)',
    async (action) => {
      const { call, room } = setup()
      await call.join(STANDUP)
      const track = room().microphone!.track
      room().localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(new Error('sdk failed'))
      await turnOff[action](call)
      expect(track.stop).toHaveBeenCalled()
      expect(room().localParticipant.unpublishTrack).toHaveBeenCalledWith(track, true)
      expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: true })
      expect(call.getSnapshot()).not.toHaveProperty('problem')
    }
  )

  it.each(Object.keys(turnOff) as (keyof typeof turnOff)[])(
    'ends the call when the microphone cannot be turned off at all (%s)',
    async (action) => {
      const { call, room, mount } = setup()
      await call.join(STANDUP)
      room().publish(`${BOB}|PHONE`)
      const track = room().microphone!.track
      room().localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(new Error('sdk failed'))
      track.stop.mockImplementationOnce(() => {
        throw new Error('stop failed')
      })
      track.mediaStreamTrack.stop.mockImplementation(() => undefined)
      room().localParticipant.unpublishTrack.mockRejectedValueOnce(new Error('unpublish failed'))
      await turnOff[action](call)
      expect(room().disconnect).toHaveBeenCalledTimes(1)
      expect(mount.children).toHaveLength(0)
      expect(room().listening()).toBe(0)
      expect(call.getSnapshot()).toMatchObject({
        status: 'ended',
        roomId: STANDUP,
        muted: true,
        problem: 'microphone-stuck',
      })
    }
  )
})

describe('CallController: the member’s mute and deafen choices follow a switch of room', () => {
  it('stays muted on joining another room from a call where the member muted', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    await call.setMuted(true)
    const mic = room().localParticipant.setMicrophoneEnabled
    mic.mockClear()
    const switching = call.join(RETRO)
    expect(call.getSnapshot()).toMatchObject({ status: 'connecting', roomId: RETRO, muted: true })
    await switching
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', roomId: RETRO, muted: true })
    expect(mic.mock.calls.filter(([on]) => on)).toEqual([])
  })

  it('stays deafened on joining another room, silencing what is there and what arrives', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    await call.setDeafened(true)
    const mic = room().localParticipant.setMicrophoneEnabled
    mic.mockClear()
    // Someone already publishing in the next room when it connects, before any subscription.
    const waiting = new FakePublication()
    room().connect.mockImplementationOnce(async () => {
      room().state = ConnectionState.Connected
      const carol = new FakeRemote('@carol:matrix.acme-sa.kodera.test|LAPTOP')
      carol.audioTrackPublications.set('TR_0', waiting)
      room().remoteParticipants.set(carol.identity, carol)
    })
    await call.join(RETRO)
    expect(call.getSnapshot()).toMatchObject({
      status: 'connected',
      roomId: RETRO,
      muted: true,
      deafened: true,
    })
    expect(mic.mock.calls.filter(([on]) => on)).toEqual([])
    expect(waiting.setEnabled).toHaveBeenLastCalledWith(false)
    const bob = room().publish(`${BOB}|PHONE`)
    expect(bob.track.elements[0]!.muted).toBe(true)
    expect(bob.publication.setEnabled).toHaveBeenLastCalledWith(false)
  })

  it('restores the microphone as it was before deafening, after a switch', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    await call.setMuted(true)
    await call.setDeafened(true)
    await call.join(RETRO)
    const mic = room().localParticipant.setMicrophoneEnabled
    mic.mockClear()
    await call.setDeafened(false)
    expect(call.getSnapshot()).toMatchObject({ deafened: false, muted: true })
    expect(mic).not.toHaveBeenCalled()

    await call.setDeafened(true)
    await call.setMuted(false)
    await call.join(STANDUP)
    await call.setDeafened(true)
    await call.join(RETRO)
    mic.mockClear()
    await call.setDeafened(false)
    expect(call.getSnapshot()).toMatchObject({ deafened: false, muted: false })
    expect(mic).toHaveBeenLastCalledWith(...MIC_ON)
  })

  it('stays muted across a join that failed, and a call the server ended', async () => {
    const { call, room } = setup({
      answers: [() => grant(), () => new Response('{}', { status: 503 })],
    })
    await call.join(STANDUP)
    await call.setMuted(true)
    await call.join(RETRO)
    expect(call.getSnapshot()).toMatchObject({ status: 'failed', muted: true })
    const mic = room().localParticipant.setMicrophoneEnabled
    mic.mockClear()
    await call.join(STANDUP)
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: true })

    room().emit(RoomEvent.Disconnected, DisconnectReason.SIGNAL_CLOSE)
    expect(call.getSnapshot()).toMatchObject({ status: 'ended', muted: true })
    await call.join(RETRO)
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: true })
    expect(mic.mock.calls.filter(([on]) => on)).toEqual([])
  })

  it('starts a fresh call after leaving: unmuted, hearing, microphone on', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    await call.setDeafened(true)
    await call.leave()
    expect(call.getSnapshot()).toMatchObject({ status: 'idle', muted: false, deafened: false })
    const mic = room().localParticipant.setMicrophoneEnabled
    mic.mockClear()
    await call.join(RETRO)
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: false, deafened: false })
    expect(mic).toHaveBeenCalledWith(...MIC_ON)
    await call.setMuted(true)
    await call.leave()
    await call.join(STANDUP)
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: false })
  })

  it('still forces a listen-only room to muted, whatever the member chose before', async () => {
    const { call, room } = setup({ answers: [() => grant(), () => grant(true)] })
    await call.join(STANDUP)
    expect(call.getSnapshot().muted).toBe(false)
    const mic = room().localParticipant.setMicrophoneEnabled
    mic.mockClear()
    await call.join(RETRO)
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', listenOnly: true, muted: true })
    expect(mic).not.toHaveBeenCalled()
  })
})

/**
 * Holds the next `setMicrophoneEnabled` call until released, as a browser's permission prompt
 * does; an enable then publishes on whatever connection the room has by then.
 */
function hold(room: FakeRoom, announce = true): () => void {
  let release: () => void = () => undefined
  room.localParticipant.setMicrophoneEnabled.mockImplementationOnce(
    (enabled: boolean) =>
      new Promise<unknown>((resolve) => {
        release = () => {
          room.applyMicrophone(enabled, announce)
          resolve(undefined)
        }
      })
  )
  return () => release()
}

/** Holds the next `setMicrophoneEnabled` call until refused. */
function holdThenRefuse(room: FakeRoom): (error: Error) => void {
  let refuse: (error: Error) => void = () => undefined
  room.localParticipant.setMicrophoneEnabled.mockImplementationOnce(
    () => new Promise<unknown>((_resolve, reject) => (refuse = reject))
  )
  return (error) => refuse(error)
}

describe('CallController: the member’s last word on the microphone wins a race with LiveKit', () => {
  const turnOn = {
    join: async (call: ReturnType<typeof setup>['call']) => call.join(STANDUP),
    unmute: async (call: ReturnType<typeof setup>['call']) => {
      await call.join(STANDUP)
      await call.setMuted(true)
    },
    undeafen: async (call: ReturnType<typeof setup>['call']) => {
      await call.join(STANDUP)
      await call.setDeafened(true)
    },
  }

  it.each(Object.keys(turnOn) as (keyof typeof turnOn)[])(
    'turns the microphone off again when the member mutes while it turns on (%s)',
    async (path) => {
      const { call, room } = setup()
      let turning: Promise<void>
      let release: () => void
      if (path === 'join') {
        turning = call.join(STANDUP)
        release = hold(room())
      } else {
        await turnOn[path](call)
        release = hold(room())
        turning = path === 'unmute' ? call.setMuted(false) : call.setDeafened(false)
      }
      const mic = room().localParticipant.setMicrophoneEnabled
      await vi.waitFor(() => expect(mic).toHaveBeenLastCalledWith(...MIC_ON))
      await call.setMuted(true)
      release()
      await turning
      expect(room().liveMicrophone()).toBe(false)
      expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: true })
    }
  )

  it.each([
    ['unmutes', [false], false],
    ['unmutes then mutes again', [false, true], true],
  ] as const)(
    'ends as the member last asked when they change their mind while it turns off (%s)',
    async (_name, changes, muted) => {
      const { call, room } = setup()
      await call.join(STANDUP)
      const release = hold(room())
      const muting = call.setMuted(true)
      for (const change of changes) await call.setMuted(change)
      release()
      await muting
      expect(room().liveMicrophone()).toBe(!muted)
      expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted })
    }
  )
})

describe('CallController: a listen-only room’s mute is not the member’s choice', () => {
  it.each([
    ['never muted', false],
    ['had muted', true],
  ] as const)(
    'restores what the member chose on leaving a listen-only room for another (%s)',
    async (_name, chosen) => {
      const { call, room } = setup({ answers: [() => grant(), () => grant(true), () => grant()] })
      await call.join(STANDUP)
      if (chosen) await call.setMuted(true)
      await call.join(RETRO)
      expect(call.getSnapshot()).toMatchObject({ listenOnly: true, muted: true })
      const mic = room().localParticipant.setMicrophoneEnabled
      mic.mockClear()
      await call.join(STANDUP)
      expect(call.getSnapshot()).toMatchObject({
        status: 'connected',
        listenOnly: false,
        muted: chosen,
      })
      if (chosen) expect(mic).not.toHaveBeenCalled()
      else expect(mic).toHaveBeenLastCalledWith(...MIC_ON)
    }
  )

  it('does not carry a mute the service imposed in the call either', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    const local = room().localParticipant
    local.permissions = { canPublish: false }
    room().emit(RoomEvent.ParticipantPermissionsChanged, { canPublish: true }, local)
    await vi.waitFor(() => expect(call.getSnapshot().muted).toBe(true))
    local.permissions = { canPublish: true }
    room().emit(RoomEvent.ParticipantPermissionsChanged, { canPublish: false }, local)
    // In the room, the member turns the microphone back on, nobody else.
    expect(call.getSnapshot()).toMatchObject({ listenOnly: false, muted: true })
    local.setMicrophoneEnabled.mockClear()
    await call.join(RETRO)
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: false })
    expect(local.setMicrophoneEnabled).toHaveBeenLastCalledWith(...MIC_ON)
  })
})

describe('CallController: a microphone turned on for one room never sends into the next', () => {
  const quiet = {
    mute: (call: ReturnType<typeof setup>['call']) => call.setMuted(true),
    deafen: (call: ReturnType<typeof setup>['call']) => call.setDeafened(true),
  }

  it.each(Object.keys(quiet) as (keyof typeof quiet)[])(
    'stops what the first room’s pending enable publishes into the next, muted (%s)',
    async (action) => {
      const { call, room } = setup()
      const first = call.join(STANDUP)
      const release = hold(room())
      const mic = room().localParticipant.setMicrophoneEnabled
      await vi.waitFor(() => expect(mic).toHaveBeenCalledWith(...MIC_ON))
      const second = call.join(RETRO)
      await quiet[action](call)
      await second
      expect(call.getSnapshot()).toMatchObject({ status: 'connected', roomId: RETRO, muted: true })
      release()
      await first
      expect(room().liveMicrophone()).toBe(false)
      expect(call.getSnapshot()).toMatchObject({ status: 'connected', roomId: RETRO, muted: true })
    }
  )

  it('stops it too when the first room’s disable gave up before the enable landed', async () => {
    const { call, room } = setup()
    const first = call.join(STANDUP)
    const release = hold(room())
    const mic = room().localParticipant.setMicrophoneEnabled
    await vi.waitFor(() => expect(mic).toHaveBeenCalledWith(...MIC_ON))
    // LiveKit's disable waits for the pending enable, then times out.
    mic.mockRejectedValueOnce(new Error('publishing rejected as engine not connected'))
    await call.setMuted(true)
    await call.join(RETRO)
    release()
    await first
    expect(room().liveMicrophone()).toBe(false)
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', roomId: RETRO, muted: true })
  })

  it('stops a superseded enable’s microphone when it settles, even unannounced', async () => {
    const { call, room } = setup()
    const first = call.join(STANDUP)
    const release = hold(room(), false)
    const mic = room().localParticipant.setMicrophoneEnabled
    await vi.waitFor(() => expect(mic).toHaveBeenCalledWith(...MIC_ON))
    const second = call.join(RETRO)
    await call.setMuted(true)
    await second
    release()
    await first
    expect(room().liveMicrophone()).toBe(false)
  })

  it('stops a microphone LiveKit publishes on its own while the member is muted', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    await call.setMuted(true)
    const track = room().publishMicrophone()
    expect(track.stopped).toBe(true)
    await vi.waitFor(() =>
      expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: true })
    )
    expect(track.muted).toBe(true)
    expect(room().liveMicrophone()).toBe(false)
  })

  it('unpublishes a microphone left on the connection when a muted call connects', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    await call.setMuted(true)
    let left: FakeMicrophone | undefined
    room().connect.mockImplementationOnce(async () => {
      room().state = ConnectionState.Connected
      left = room().publishMicrophone(false)
    })
    await call.join(RETRO)
    expect(left?.stopped).toBe(true)
    expect(room().liveMicrophone()).toBe(false)
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', roomId: RETRO, muted: true })
  })
})

describe('CallController: a stopped microphone that stays published is muted too', () => {
  it.each([
    ['holds', true],
    ['fails', false],
  ] as const)(
    'counts it off only when muting it %s, as a reconnect restarts a track not muted',
    async (_name, mutes) => {
      const { call, room } = setup()
      await call.join(STANDUP)
      const track = room().microphone!.track
      room().localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(new Error('sdk failed'))
      room().localParticipant.unpublishTrack.mockRejectedValue(new Error('unpublish failed'))
      if (!mutes) track.mute.mockRejectedValue(new Error('mute failed'))
      await call.setMuted(true)
      expect(track.stop).toHaveBeenCalled()
      if (mutes) {
        expect(track.muted).toBe(true)
        expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: true })
        expect(call.getSnapshot()).not.toHaveProperty('problem')
      } else {
        expect(call.getSnapshot()).toMatchObject({ status: 'ended', problem: 'microphone-stuck' })
      }
    }
  )
})

describe('CallController: after the fallback turned the microphone off', () => {
  it('turns it back on when the member unmuted while the fallback ran', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    const local = room().localParticipant
    local.setMicrophoneEnabled.mockRejectedValueOnce(new Error('sdk failed'))
    let unpublished: () => void = () => undefined
    local.unpublishTrack.mockImplementationOnce(
      () =>
        new Promise<unknown>((resolve) => {
          unpublished = () => {
            room().microphone = undefined
            resolve(undefined)
          }
        })
    )
    const muting = call.setMuted(true)
    await vi.waitFor(() => expect(local.unpublishTrack).toHaveBeenCalled())
    await call.setMuted(false)
    unpublished()
    await muting
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: false })
    expect(room().liveMicrophone()).toBe(true)
  })

  it('can turn it back on when the track stayed published: it was muted, not only stopped', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    const local = room().localParticipant
    local.setMicrophoneEnabled.mockRejectedValueOnce(new Error('sdk failed'))
    local.unpublishTrack.mockRejectedValueOnce(new Error('unpublish failed'))
    await call.setMuted(true)
    expect(room().liveMicrophone()).toBe(false)
    await call.setMuted(false)
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: false })
    expect(room().liveMicrophone()).toBe(true)
  })
})

describe('CallController: muted is shown once the microphone is silenced, not when asked', () => {
  const turnOff = {
    mute: (call: ReturnType<typeof setup>['call']) => call.setMuted(true),
    deafen: (call: ReturnType<typeof setup>['call']) => call.setDeafened(true),
  }

  it.each(Object.keys(turnOff) as (keyof typeof turnOff)[])(
    'stops the capture at once, without waiting on LiveKit’s own disable (%s)',
    async (action) => {
      const { call, room } = setup()
      await call.join(STANDUP)
      const track = room().microphone!.track
      hold(room()) // LiveKit's disable, never settling
      void turnOff[action](call)
      expect(track.stop).toHaveBeenCalled()
      expect(track.mute).toHaveBeenCalled()
      expect(call.getSnapshot()).toMatchObject({ muted: false, muting: true })
      await vi.waitFor(() =>
        expect(call.getSnapshot()).toMatchObject({ muted: true, muting: false })
      )
      expect(room().liveMicrophone()).toBe(false)
      expect(call.getSnapshot().status).toBe('connected')
    }
  )

  it('deafening silences the microphone itself, even when the member is shown muted', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    await call.setMuted(true)
    // A track LiveKit left capturing, whatever the snapshot says.
    const left = room().publishMicrophone(false)
    await call.setDeafened(true)
    expect(left.stopped).toBe(true)
    expect(room().liveMicrophone()).toBe(false)
  })

  it('ends the call when silencing is not confirmed within the deadline', async () => {
    const { call, room } = setup({ deadline: 30 })
    await call.join(STANDUP)
    const track = room().microphone!.track
    hold(room())
    track.mute.mockImplementationOnce(() => new Promise<FakeMicrophone>(() => undefined))
    void call.setMuted(true)
    expect(track.stop).toHaveBeenCalled()
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: false, muting: true })
    await vi.waitFor(() =>
      expect(call.getSnapshot()).toMatchObject({ status: 'ended', problem: 'microphone-stuck' })
    )
    expect(room().disconnect).toHaveBeenCalled()
  })

  it('unmutes after such a stop: LiveKit restarts the stopped, muted track', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    const track = room().microphone!.track
    await call.setMuted(true)
    expect(track).toMatchObject({ muted: true, stopped: true })
    await call.setMuted(false)
    expect(room().microphone?.track).toBe(track)
    expect(room().liveMicrophone()).toBe(true)
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: false })
  })
})

describe('CallController: only the member’s last microphone operation speaks for it', () => {
  it('ignores an older enable’s failure once the member unmuted again', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    await call.setMuted(true)
    const refuse = holdThenRefuse(room())
    const first = call.setMuted(false)
    await call.setMuted(true)
    await call.setMuted(false)
    refuse(new DOMException('Permission dismissed', 'NotAllowedError'))
    await first
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: false })
    expect(call.getSnapshot()).not.toHaveProperty('problem')
    expect(room().liveMicrophone()).toBe(true)
  })

  it('silences whatever is capturing when the last enable fails and shows muted', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    await call.setMuted(true)
    // A track left capturing by a restart that failed after acquiring it.
    const left = room().publishMicrophone(false)
    room().localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(new Error('restart failed'))
    await call.setMuted(false)
    expect(call.getSnapshot()).toMatchObject({ muted: true, problem: 'microphone' })
    expect(left.stopped).toBe(true)
  })
})

describe('CallController: silence is what the browser says, not what LiveKit answered', () => {
  it('stays muting while the capture keeps running after stop and mute, until unpublished', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    const track = room().microphone!.track
    // A stop that does nothing, a mute that resolves, and LiveKit's disable never settling.
    track.stop.mockImplementation(() => undefined)
    track.mediaStreamTrack.stop.mockImplementation(() => undefined)
    hold(room())
    let unpublished: () => void = () => undefined
    room().localParticipant.unpublishTrack.mockImplementationOnce(
      () =>
        new Promise<unknown>((resolve) => {
          unpublished = () => {
            room().microphone = undefined
            resolve(undefined)
          }
        })
    )
    void call.setMuted(true)
    await vi.waitFor(() => expect(room().localParticipant.unpublishTrack).toHaveBeenCalled())
    expect(track.mediaStreamTrack.readyState).toBe('live')
    expect(call.getSnapshot()).toMatchObject({ muted: false, muting: true })
    unpublished()
    await vi.waitFor(() => expect(call.getSnapshot()).toMatchObject({ muted: true, muting: false }))
  })

  it('shows the call ended at the deadline only once the disconnect is through', async () => {
    const { call, room } = setup({ deadline: 30 })
    await call.join(STANDUP)
    const track = room().microphone!.track
    // Nothing ends the capture: only the disconnect can take the microphone away.
    track.mute.mockImplementation(() => new Promise<FakeMicrophone>(() => undefined))
    track.stop.mockImplementation(() => undefined)
    track.mediaStreamTrack.stop.mockImplementation(() => undefined)
    hold(room())
    let disconnected: () => void = () => undefined
    room().disconnect.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (disconnected = () => resolve(undefined)))
    )
    void call.setMuted(true)
    await vi.waitFor(() => expect(room().disconnect).toHaveBeenCalled(), { timeout: 2000 })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: false, muting: true })
    disconnected()
    await vi.waitFor(() =>
      expect(call.getSnapshot()).toMatchObject({ status: 'ended', problem: 'microphone-stuck' })
    )
  })

  it('brings the microphone back when an older disable stops it and fails after an unmute', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    const track = room().microphone!.track
    const refuse = holdThenRefuse(room())
    const muting = call.setMuted(true)
    await vi.waitFor(() => expect(call.getSnapshot().muted).toBe(true))
    await call.setMuted(false)
    expect(room().liveMicrophone()).toBe(true)
    // LiveKit's older disable ends the capture behind the member's unmute, then gives up.
    track.mediaStreamTrack.readyState = 'ended'
    refuse(new Error('engine not connected'))
    await muting
    await vi.waitFor(() => expect(room().liveMicrophone()).toBe(true))
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: false })
  })

  it('turns a dead microphone back on when the member unmutes, though shown unmuted', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    room().microphone!.track.mediaStreamTrack.readyState = 'ended'
    await call.setMuted(false)
    expect(room().liveMicrophone()).toBe(true)
  })
})

/** A finite positive fixture gate; every new test releases its gates in finally. */
function retirementGate() {
  let release: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    release = () => resolve()
  })
  return { promise, release: () => release() }
}

type RetirementResult = { error: unknown }

function retirementFixture(fixture: ReturnType<typeof setup>) {
  const trace: string[] = []
  const releases: (() => void)[] = []
  const subscriptions: (() => void)[] = []
  const restorations: (() => void)[] = []
  const operations: Promise<RetirementResult>[] = []
  const begin = (operation: Promise<void>, name: string) => {
    const result = operation.then(
      () => {
        trace.push(`${name}:fulfilled`)
        return { error: undefined }
      },
      (error: unknown) => {
        trace.push(`${name}:rejected`)
        return { error }
      }
    )
    operations.push(result)
    return result
  }
  const gate = () => {
    const value = retirementGate()
    releases.push(value.release)
    return value
  }
  const disconnects = (...names: string[]) => {
    const room = fixture.room()
    const saved = room.disconnect.getMockImplementation()
    if (saved === undefined) throw new Error('Missing real FakeRoom disconnect body')
    return names.map((name) => {
      const entered = retirementGate()
      const released = gate()
      const completed = retirementGate()
      const outcome: { error?: Error } = {}
      room.disconnect.mockImplementationOnce(async () => {
        trace.push(`${name}:entered`)
        entered.release()
        await released.promise
        await saved()
        trace.push(`${name}:completed`)
        completed.release()
        if (outcome.error !== undefined) throw outcome.error
      })
      return {
        entered: entered.promise,
        completed: completed.promise,
        release: released.release,
        rejectAfterBody: (error: Error) => {
          outcome.error = error
        },
      }
    })
  }
  const checkpoint = () => Promise.resolve().then(() => trace.push('checkpoint'))
  const finish = async () => {
    for (const unsubscribe of subscriptions) unsubscribe()
    for (const restore of restorations) restore()
    for (const release of releases) release()
    await Promise.all(operations)
    const cleanup = await fixture.call.leave().then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error })
    )
    let drained = 0
    while (drained !== operations.length) {
      drained = operations.length
      await Promise.all(operations)
    }
    expect(cleanup.error, 'NewFixtureCleanupFailed').toBeUndefined()
  }
  return {
    ...fixture,
    trace,
    begin,
    gate,
    disconnects,
    checkpoint,
    finish,
    subscriptions,
    restorations,
  }
}

describe('CallController: local retirement barrier', () => {
  it('awaits an in-flight local disconnect for a second leave', async () => {
    const f = retirementFixture(setup())
    let first: Promise<RetirementResult> | undefined
    let second: Promise<RetirementResult> | undefined
    let atCheckpoint: string[] = []
    try {
      await f.call.join(STANDUP)
      expect(f.room().state).toBe(ConnectionState.Connected)
      const capture = f.room().microphone!.track.mediaStreamTrack
      expect(capture.readyState).toBe('live')
      const remote = f.room().publish(`${BOB}|PHONE`)
      expect(remote.track.elements[0]?.isConnected).toBe(true)
      expect(f.room().listening()).toBeGreaterThan(0)
      const [held] = f.disconnects('disconnect')
      first = f.begin(f.call.leave(), 'first')
      expect(capture.readyState).toBe('ended')
      expect(remote.track.detach).toHaveBeenCalledTimes(1)
      expect(f.mount.querySelectorAll('audio')).toHaveLength(0)
      expect(f.room().listening()).toBe(0)
      expect(f.call.getSnapshot().status).toBe('idle')
      await held!.entered
      // Journal both outcomes before the explicit native Promise-job checkpoint.
      second = f.begin(f.call.leave(), 'second')
      await f.checkpoint()
      atCheckpoint = [...f.trace]
      expect(atCheckpoint).toContain('disconnect:entered')
      expect(atCheckpoint).toContain('checkpoint')
      expect(f.room().state).toBe(ConnectionState.Connected)
      held!.release()
    } finally {
      await f.finish()
    }
    expect((await first!).error).toBeUndefined()
    expect((await second!).error).toBeUndefined()
    expect(f.trace).toContain('disconnect:completed')
    expect(f.room().disconnect).toHaveBeenCalledTimes(1)
    expect(f.room().state).toBe(ConnectionState.Disconnected)
    console.log('LOCAL_RETIREMENT_TRACE', JSON.stringify({ atCheckpoint, drained: f.trace }))
    expect(
      atCheckpoint.includes('second:fulfilled'),
      'SecondLeaveCompletedBeforeLocalDisconnect'
    ).toBe(false)
  })

  it('returns harmlessly from repeated leave after local retirement drains', async () => {
    const f = retirementFixture(setup())
    try {
      await f.call.join(STANDUP)
      await f.begin(f.call.leave(), 'first')
      await f.begin(f.call.leave(), 'second')
      await f.begin(f.call.leave(), 'third')
      expect(f.room().disconnect).toHaveBeenCalledTimes(1)
      expect(f.call.getSnapshot().status).toBe('idle')
      expect(f.room().listening()).toBe(0)
    } finally {
      await f.finish()
    }
  })

  it('defers join admission behind explicit leave while preserving gesture and pending choices', async () => {
    const f = retirementFixture(setup())
    try {
      await f.call.join(STANDUP)
      const [held] = f.disconnects('old')
      f.begin(f.call.leave(), 'leave')
      await held!.entered
      const join = f.begin(f.call.join(RETRO), 'join')
      expect(f.room().startAudio).toHaveBeenCalledTimes(2)
      expect(f.call.getSnapshot()).toMatchObject({ status: 'connecting', roomId: RETRO })
      await f.call.setMuted(true)
      await f.call.setDeafened(true)
      await f.checkpoint()
      expect(f.fetchImpl).toHaveBeenCalledTimes(1)
      expect(f.room().connect).toHaveBeenCalledTimes(1)
      held!.release()
      expect((await join).error).toBeUndefined()
      expect(f.call.getSnapshot()).toMatchObject({
        status: 'connected',
        roomId: RETRO,
        muted: true,
        deafened: true,
      })
      expect(f.room().liveMicrophone()).toBe(false)
    } finally {
      await f.finish()
    }
  })

  it('cancels a join waiting for retirement without fetching a grant', async () => {
    const f = retirementFixture(setup())
    try {
      await f.call.join(STANDUP)
      const [held] = f.disconnects('old')
      f.begin(f.call.leave(), 'leave')
      await held!.entered
      const joining = f.begin(f.call.join(RETRO), 'join')
      const canceled = f.begin(f.call.leave(), 'cancel')
      await f.checkpoint()
      expect(f.fetchImpl).toHaveBeenCalledTimes(1)
      held!.release()
      expect((await joining).error).toBeUndefined()
      expect((await canceled).error).toBeUndefined()
      expect(f.fetchImpl).toHaveBeenCalledTimes(1)
      expect(f.call.getSnapshot().status).toBe('idle')
    } finally {
      await f.finish()
    }
  })

  it('waits for both independent closes when they settle in either order', async () => {
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      const f = retirementFixture(setup())
      try {
        await f.call.join(STANDUP)
        const held = f.disconnects('A', 'B')
        f.begin(f.call.join(RETRO), 'B-join')
        await held[0]!.entered
        f.begin(f.call.leave(), 'B-leave')
        await held[1]!.entered
        const current = f.begin(f.call.join(STANDUP), 'C-join')
        held[order[0]!]!.release()
        await held[order[0]!]!.completed
        await f.checkpoint()
        expect(f.fetchImpl).toHaveBeenCalledTimes(1)
        expect(f.room().connect).toHaveBeenCalledTimes(1)
        held[order[1]!]!.release()
        expect((await current).error).toBeUndefined()
        expect(f.fetchImpl).toHaveBeenCalledTimes(2)
        expect(f.call.getSnapshot()).toMatchObject({ status: 'connected', roomId: STANDUP })
      } finally {
        await f.finish()
      }
    }
  })

  it('keeps the idle subscriber join outside the older leave ownership', async () => {
    const grantWait = retirementGate(),
      grantEntered = retirementGate()
    const f = retirementFixture(
      setup({
        answers: [
          () => grant(),
          async () => {
            grantEntered.release()
            await grantWait.promise
            return grant()
          },
        ],
      })
    )
    try {
      await f.call.join(STANDUP)
      const [held] = f.disconnects('A')
      let newer: Promise<RetirementResult> | undefined
      let fired = false
      f.subscriptions.push(
        f.call.subscribe(() => {
          if (!fired && f.call.getSnapshot().status === 'idle') {
            fired = true
            newer = f.begin(f.call.join(RETRO), 'newer')
          }
        })
      )
      const leaving = f.begin(f.call.leave(), 'leave')
      await held!.entered
      expect(fired).toBe(true)
      expect(f.call.getSnapshot()).toMatchObject({ status: 'connecting', roomId: RETRO })
      expect(f.fetchImpl).toHaveBeenCalledTimes(1)
      held!.release()
      expect((await leaving).error).toBeUndefined()
      await grantEntered.promise
      await f.checkpoint()
      expect(f.trace).toContain('leave:fulfilled')
      expect(f.trace).not.toContain('newer:fulfilled')
      grantWait.release()
      expect((await newer!).error).toBeUndefined()
      expect(f.call.getSnapshot()).toMatchObject({ status: 'connected', roomId: RETRO })
    } finally {
      grantWait.release()
      await f.finish()
    }
  })

  it('preregisters the previous close before connecting subscriber reentry', async () => {
    const f = retirementFixture(setup())
    try {
      await f.call.join(STANDUP)
      const remote = f.room().publish(`${BOB}|PHONE`)
      const savedDetach = remote.track.detach.getMockImplementation()!
      const savedDisconnect = f.room().disconnect.getMockImplementation()!
      const entered = retirementGate(),
        completed = retirementGate(),
        release = f.gate()
      let detachedA = false,
        heldA = false
      remote.track.detach.mockImplementationOnce(() => {
        detachedA = true
        return savedDetach()
      })
      f.room().disconnect.mockImplementation(async () => {
        if (detachedA && !heldA) {
          heldA = true
          f.trace.push('A:entered')
          entered.release()
          await release.promise
          await savedDisconnect()
          f.trace.push('A:completed')
          completed.release()
        } else {
          await savedDisconnect()
        }
      })
      const held = {
        entered: entered.promise,
        completed: completed.promise,
        release: release.release,
      }
      let newer: Promise<RetirementResult> | undefined
      let fired = false
      f.subscriptions.push(
        f.call.subscribe(() => {
          const snapshot = f.call.getSnapshot()
          if (!fired && snapshot.status === 'connecting' && snapshot.roomId === RETRO) {
            fired = true
            newer = f.begin(f.call.join(STANDUP), 'C')
          }
        })
      )
      const replaced = f.begin(f.call.join(RETRO), 'B')
      await held.entered
      expect(fired).toBe(true)
      expect(detachedA).toBe(true)
      expect(heldA).toBe(true)
      expect(f.trace).not.toContain('A:completed')
      await f.checkpoint()
      expect(f.fetchImpl).toHaveBeenCalledTimes(1)
      held!.release()
      expect((await replaced).error).toBeUndefined()
      expect((await newer!).error).toBeUndefined()
      expect(f.fetchImpl).toHaveBeenCalledTimes(2)
      expect(f.call.getSnapshot()).toMatchObject({ status: 'connected', roomId: STANDUP })
    } finally {
      await f.finish()
    }
  })

  it('starts teardown once when track detachment reenters leave', async () => {
    const f = retirementFixture(setup())
    try {
      await f.call.join(STANDUP)
      const remote = f.room().publish(`${BOB}|PHONE`)
      const saved = remote.track.detach.getMockImplementation()!
      let nested: Promise<RetirementResult> | undefined
      remote.track.detach.mockImplementationOnce(() => {
        nested = f.begin(f.call.leave(), 'nested')
        return saved()
      })
      const [held] = f.disconnects('A')
      const leaving = f.begin(f.call.leave(), 'outer')
      await held!.entered
      await f.checkpoint()
      expect(f.trace).not.toContain('nested:fulfilled')
      held!.release()
      expect((await leaving).error).toBeUndefined()
      expect((await nested!).error).toBeUndefined()
      expect(f.room().disconnect).toHaveBeenCalledTimes(1)
      expect(remote.track.detach).toHaveBeenCalledTimes(1)
    } finally {
      await f.finish()
    }
  })

  it('preserves a newer join when an older failed join finishes cleanup', async () => {
    const f = retirementFixture(setup({ answers: [() => new Response('{}', { status: 503 })] }))
    try {
      const failed = f.begin(f.call.join(STANDUP), 'failed-A')
      const [held] = f.disconnects('A-failure')
      await held!.entered
      const newer = f.begin(f.call.join(RETRO), 'B')
      held!.release()
      expect((await failed).error).toBeUndefined()
      expect((await newer).error).toBeUndefined()
      expect(f.call.getSnapshot()).toMatchObject({ status: 'connected', roomId: RETRO })
      expect(f.call.getSnapshot()).not.toHaveProperty('problem')
    } finally {
      await f.finish()
    }
  })

  it('preserves a newer leave when an older failed join finishes cleanup', async () => {
    const f = retirementFixture(setup({ answers: [() => new Response('{}', { status: 503 })] }))
    try {
      const failed = f.begin(f.call.join(STANDUP), 'failed-A')
      const [held] = f.disconnects('A-failure')
      await held!.entered
      const newer = f.begin(f.call.leave(), 'newer-leave')
      held!.release()
      expect((await failed).error).toBeUndefined()
      expect((await newer).error).toBeUndefined()
      expect(f.call.getSnapshot()).toMatchObject({ status: 'idle', roomId: null })
      expect(f.call.getSnapshot()).not.toHaveProperty('problem')
    } finally {
      await f.finish()
    }
  })

  it('preserves newer intent during a terminal Room teardown reentry', async () => {
    const f = retirementFixture(setup())
    try {
      await f.call.join(STANDUP)
      const remote = f.room().publish(`${BOB}|PHONE`)
      const saved = remote.track.detach.getMockImplementation()!
      let newer: Promise<RetirementResult> | undefined
      remote.track.detach.mockImplementationOnce(() => {
        newer = f.begin(f.call.join(RETRO), 'newer')
        return saved()
      })
      const [held] = f.disconnects('terminal')
      f.room().emit(RoomEvent.Disconnected, DisconnectReason.PARTICIPANT_REMOVED)
      await held!.entered
      expect(f.call.getSnapshot()).toMatchObject({ status: 'connecting', roomId: RETRO })
      held!.release()
      expect((await newer!).error).toBeUndefined()
      expect(f.call.getSnapshot()).toMatchObject({ status: 'connected', roomId: RETRO })
      expect(f.call.getSnapshot()).not.toHaveProperty('problem')
    } finally {
      await f.finish()
    }
  })

  it('drains sessionless late-enable fallback before admitting a new join', async () => {
    for (const mode of ['quiet', 'nonquiet', 'rejected-fallback'] as const) {
      const f = retirementFixture(setup())
      try {
        const old = await retirementLateEnable(f, mode !== 'quiet')
        const fallback = mode === 'quiet' ? undefined : f.disconnects('fallback')[0]!
        if (mode === 'rejected-fallback')
          fallback!.rejectAfterBody(new Error('declared disconnect rejected'))
        const newer = f.begin(f.call.join(RETRO), 'B')
        expect(f.call.getSnapshot()).toMatchObject({ status: 'connecting', roomId: RETRO })
        expect(f.room().startAudio).toHaveBeenCalledTimes(2)
        await f.checkpoint()
        expect(f.fetchImpl).toHaveBeenCalledTimes(1)
        old.stop.release()
        if (fallback !== undefined) {
          await fallback.entered
          expect(f.room().microphone!.track.mediaStreamTrack.readyState).toBe('live')
          expect(f.room().state).toBe(ConnectionState.Connected)
          expect(f.trace).toContain('explicit-A:entered')
          expect(f.trace).not.toContain('explicit-A:completed')
          old.restore()
          old.heldLeave!.release()
          await old.heldLeave!.completed
          expect((await old.leaving).error).toBeUndefined()
          expect(old.capture().readyState).toBe('ended')
          expect(f.room().state).toBe(ConnectionState.Disconnected)
          await f.checkpoint()
          expect(f.fetchImpl).toHaveBeenCalledTimes(1)
          expect(f.room().connect).toHaveBeenCalledTimes(1)
          expect(f.call.getSnapshot()).toMatchObject({ status: 'connecting', roomId: RETRO })
          expect(f.trace).not.toContain('B:fulfilled')
          expect(f.trace).not.toContain('B:rejected')
          expect(f.trace).toContain('fallback:entered')
          expect(f.trace).not.toContain('fallback:completed')
          fallback.release()
        }
        expect((await old.first).error).toBeUndefined()
        expect(old.capture().readyState).toBe('ended')
        expect((await newer).error).toBeUndefined()
        expect(f.room().disconnect).toHaveBeenCalledTimes(mode === 'quiet' ? 1 : 2)
        expect(f.call.getSnapshot()).toMatchObject({ status: 'connected', roomId: RETRO })
        expect(f.room().liveMicrophone()).toBe(true)
        expect(f.room().microphone!.track.mediaStreamTrack).not.toBe(old.capture())
      } finally {
        await f.finish()
      }
    }
  })

  it('cancels a join behind sessionless cleanup and still admits a later current join', async () => {
    const f = retirementFixture(setup())
    try {
      const old = await retirementLateEnable(f, false)
      const [held] = f.disconnects('cancel-B')
      const canceled = f.begin(f.call.join(RETRO), 'B')
      const leaving = f.begin(f.call.leave(), 'cancel')
      await held!.entered
      held!.release()
      await held!.completed
      expect(old.capture().readyState).toBe('ended')
      await f.checkpoint()
      expect(f.fetchImpl).toHaveBeenCalledTimes(1)
      expect(f.room().connect).toHaveBeenCalledTimes(1)
      for (const outcome of ['B:fulfilled', 'B:rejected', 'cancel:fulfilled', 'cancel:rejected']) {
        expect(f.trace).not.toContain(outcome)
      }
      old.stop.release()
      expect((await old.first).error).toBeUndefined()
      expect(old.capture().readyState).toBe('ended')
      expect((await canceled).error).toBeUndefined()
      expect((await leaving).error).toBeUndefined()
      expect(f.call.getSnapshot()).toMatchObject({ status: 'idle', roomId: null })
      expect(f.room().disconnect).toHaveBeenCalledTimes(2)
      expect((await f.begin(f.call.join(RETRO), 'current')).error).toBeUndefined()
      expect(f.fetchImpl).toHaveBeenCalledTimes(2)
      expect(f.room().connect).toHaveBeenCalledTimes(2)
      expect(f.call.getSnapshot()).toMatchObject({ status: 'connected', roomId: RETRO })
      expect(f.room().liveMicrophone()).toBe(true)
    } finally {
      await f.finish()
    }
    // A distinct current-positive control: the old enable lands AFTER B is connected/unmuted.
    const current = retirementFixture(setup())
    try {
      const first = current.begin(current.call.join(STANDUP), 'old-enable')
      const entered = retirementGate(),
        enable = current.gate()
      const room = current.room(),
        saved = room.localParticipant.setMicrophoneEnabled.getMockImplementation()!
      room.localParticipant.setMicrophoneEnabled.mockImplementationOnce(async (enabled) => {
        entered.release()
        await enable.promise
        return saved(enabled)
      })
      await entered.promise
      expect((await current.begin(current.call.join(RETRO), 'B')).error).toBeUndefined()
      const capture = room.microphone!.track.mediaStreamTrack
      expect(capture.readyState).toBe('live')
      const disconnects = room.disconnect.mock.calls.length
      enable.release()
      expect((await first).error).toBeUndefined()
      expect(room.disconnect).toHaveBeenCalledTimes(disconnects)
      expect(room.microphone!.track.mediaStreamTrack).toBe(capture)
      expect(capture.readyState).toBe('live')
      expect(current.call.getSnapshot()).toMatchObject({
        status: 'connected',
        roomId: RETRO,
        muted: false,
      })
    } finally {
      await current.finish()
    }
  })

  it('keeps caught disconnect rejection local and creates no unhandled bookkeeping rejection', async () => {
    const f = retirementFixture(setup())
    try {
      await f.call.join(STANDUP)
      const [held] = f.disconnects('rejected-disconnect')
      held!.rejectAfterBody(new Error('declared disconnect rejected'))
      const owner = f.begin(f.call.leave(), 'owner')
      const observer = f.begin(f.call.leave(), 'observer')
      await held!.entered
      held!.release()
      expect((await owner).error).toBeUndefined()
      expect((await observer).error).toBeUndefined()
      await f.checkpoint()
      expect(f.trace).toContain('rejected-disconnect:completed')
      expect(f.room().state).toBe(ConnectionState.Disconnected)
      expect((await f.begin(f.call.join(RETRO), 'next')).error).toBeUndefined()
    } finally {
      await f.finish()
    }
  })

  it('drains captured retirements before propagating its own teardown error', async () => {
    const f = retirementFixture(setup())
    try {
      await f.call.join(STANDUP)
      const [held] = f.disconnects('A')
      f.begin(f.call.join(RETRO), 'switch-B')
      await held!.entered
      const error = new Error('owned detach failed')
      retirementThrowNextOff(f.room(), error)
      const owner = f.begin(f.call.leave(), 'owner')
      await f.checkpoint()
      expect(f.trace).not.toContain('owner:rejected')
      held!.release()
      expect((await owner).error).toBe(error)
      expect(f.trace.indexOf('A:completed')).toBeLessThan(f.trace.indexOf('owner:rejected'))
    } finally {
      await f.finish()
    }
  })

  it('does not lend an old teardown error to a null-session observer or a later join', async () => {
    const f = retirementFixture(setup())
    try {
      await f.call.join(STANDUP)
      const [held] = f.disconnects('A')
      f.begin(f.call.join(RETRO), 'switch-B')
      await held!.entered
      const error = new Error('owned detach failed')
      retirementThrowNextOff(f.room(), error)
      const owner = f.begin(f.call.leave(), 'owner')
      const observer = f.begin(f.call.leave(), 'observer')
      const next = f.begin(f.call.join(STANDUP), 'next')
      await f.checkpoint()
      expect(f.trace).not.toContain('owner:rejected')
      expect(f.trace).not.toContain('observer:fulfilled')
      expect(f.fetchImpl).toHaveBeenCalledTimes(1)
      held!.release()
      expect((await owner).error).toBe(error)
      expect((await observer).error).toBeUndefined()
      expect((await next).error).toBeUndefined()
      expect(f.call.getSnapshot()).toMatchObject({ status: 'connected', roomId: STANDUP })
    } finally {
      await f.finish()
    }
  })

  it('starts the prepared previous retirement when connecting notification throws', async () => {
    for (const variant of ['notification', 'gesture']) {
      const f = retirementFixture(setup())
      try {
        await f.call.join(STANDUP)
        const [held] = f.disconnects('A')
        const error = new Error(`${variant} failed`)
        if (variant === 'notification') {
          let once = false
          f.subscriptions.push(
            f.call.subscribe(() => {
              if (!once && f.call.getSnapshot().status === 'connecting') {
                once = true
                throw error
              }
            })
          )
        } else {
          f.room().startAudio.mockImplementationOnce(() => {
            throw error
          })
        }
        const joining = f.begin(f.call.join(RETRO), 'join')
        await held!.entered
        expect(f.room().microphone?.track.mediaStreamTrack.readyState).not.toBe('live')
        held!.release()
        expect((await joining).error).toBe(error)
        expect(f.fetchImpl).toHaveBeenCalledTimes(1)
      } finally {
        await f.finish()
      }
    }
  })

  it('starts the captured retirement when idle notification throws', async () => {
    const f = retirementFixture(setup())
    try {
      await f.call.join(STANDUP)
      const [held] = f.disconnects('A')
      const error = new Error('idle notification failed')
      let once = false
      f.subscriptions.push(
        f.call.subscribe(() => {
          if (!once && f.call.getSnapshot().status === 'idle') {
            once = true
            throw error
          }
        })
      )
      const leaving = f.begin(f.call.leave(), 'leave')
      await held!.entered
      held!.release()
      expect((await leaving).error).toBe(error)
      expect(f.room().listening()).toBe(0)
    } finally {
      await f.finish()
    }
  })
})

/** Preserve the saved off body, then fail one directly owned non-disconnect teardown. */
function retirementThrowNextOff(room: FakeRoom, error: Error): void {
  const saved = room.off.bind(room)
  let once = false
  vi.spyOn(room, 'off').mockImplementation((event, handler) => {
    const result = saved(event, handler)
    if (!once) {
      once = true
      throw error
    }
    return result
  })
}

/** Drives a late real enable into the no-session stop/unpublish path with a finite held stop. */
async function retirementLateEnable(f: ReturnType<typeof retirementFixture>, nonquiet: boolean) {
  const first = f.begin(f.call.join(STANDUP), 'old-enable')
  const entered = retirementGate(),
    enable = f.gate()
  const room = f.room(),
    local = room.localParticipant
  const savedEnable = local.setMicrophoneEnabled.getMockImplementation()!
  let capture: FakeCapture | undefined
  let restore: () => void = () => undefined
  f.restorations.push(() => restore())
  local.setMicrophoneEnabled.mockImplementationOnce(async (enabled) => {
    entered.release()
    await enable.promise
    const result = await savedEnable(enabled)
    const track = room.microphone!.track
    capture = track.mediaStreamTrack
    if (nonquiet) {
      const savedStop = track.stop.getMockImplementation()!
      const savedCaptureStop = capture.stop.getMockImplementation()!
      restore = () => {
        track.stop.mockImplementation(savedStop)
        track.mediaStreamTrack.stop.mockImplementation(savedCaptureStop)
      }
      track.stop.mockImplementation(() => undefined)
      capture.stop.mockImplementation(() => undefined)
    }
    return result
  })
  await entered.promise
  const heldLeave = nonquiet ? f.disconnects('explicit-A')[0]! : undefined
  const leaving = f.begin(f.call.leave(), 'explicit-leave')
  if (heldLeave === undefined) expect((await leaving).error).toBeUndefined()
  else {
    await heldLeave.entered
    expect(room.state).toBe(ConnectionState.Connected)
  }
  expect(f.call.getSnapshot().status).toBe('idle')
  const stop = f.gate(),
    stopping = retirementGate()
  const savedUnpublish = local.unpublishTrack.getMockImplementation()!
  local.unpublishTrack.mockImplementationOnce(async (track, stopOnUnpublish) => {
    stopping.release()
    await stop.promise
    const result = await savedUnpublish(track, stopOnUnpublish)
    // A declared republish races the actual saved unpublish: quiet cannot be inferred from its return.
    if (nonquiet) room.microphone = { source: Track.Source.Microphone, track }
    return result
  })
  enable.release()
  await stopping.promise
  expect(room.microphone!.track.mediaStreamTrack.readyState).toBe(nonquiet ? 'live' : 'ended')
  return { first, stop, leaving, heldLeave, capture: () => capture!, restore: () => restore() }
}

describe("CallController: the member's own microphone level", () => {
  function meter(value = 0.25) {
    const level = vi.fn((_track: MediaStreamTrack) => value)
    const close = vi.fn()
    return { level, close, make: vi.fn((): MicMeter => ({ level, close })) }
  }

  it('reads the live capture itself, once connected and unmuted, alone in the room', async () => {
    const reader = meter()
    const { call, room } = setup({ createMeter: reader.make })
    expect(call.micLevel()).toBe(0)
    const joining = call.join(STANDUP)
    // Made at the click, before any await: a context made later would start suspended.
    expect(reader.make).toHaveBeenCalledTimes(1)
    // Connecting: nothing to read yet.
    expect(call.micLevel()).toBe(0)
    await joining
    expect(call.getSnapshot().participants).toEqual([ME])
    expect(call.micLevel()).toBe(0.25)
    // The very track the call publishes, not a copy that would keep the microphone on.
    expect(reader.level).toHaveBeenLastCalledWith(room().microphone!.track.mediaStreamTrack)
  })

  it('reads 0, without touching the capture, while muted, deafened or listen-only', async () => {
    const reader = meter()
    const { call } = setup({ createMeter: reader.make })
    await call.join(STANDUP)
    await call.setMuted(true)
    reader.level.mockClear()
    expect(call.micLevel()).toBe(0)
    await call.setMuted(false)
    await call.setDeafened(true)
    reader.level.mockClear()
    expect(call.micLevel()).toBe(0)
    expect(reader.level).not.toHaveBeenCalled()

    const listening = meter()
    const second = setup({ answers: [() => grant(true)], createMeter: listening.make })
    await second.call.join(STANDUP)
    expect(second.call.getSnapshot().listenOnly).toBe(true)
    expect(second.call.micLevel()).toBe(0)
    expect(listening.level).not.toHaveBeenCalled()
  })

  it('reads 0 while the call reconnects, and again once it is through', async () => {
    const reader = meter()
    const { call, room } = setup({ createMeter: reader.make })
    await call.join(STANDUP)
    expect(call.micLevel()).toBe(0.25)
    room().emit(RoomEvent.Reconnecting)
    reader.level.mockClear()
    expect(call.micLevel()).toBe(0)
    expect(reader.level).not.toHaveBeenCalled()
    room().emit(RoomEvent.Reconnected)
    expect(call.micLevel()).toBe(0.25)
  })

  it('reads 0 from the moment the member mutes, before the browser confirms it', async () => {
    const reader = meter()
    const { call, room } = setup({ createMeter: reader.make })
    await call.join(STANDUP)
    const track = room().microphone!.track
    // A capture that keeps running, and a mute that never settles.
    track.stop.mockImplementation(() => undefined)
    track.mediaStreamTrack.stop.mockImplementation(() => undefined)
    track.mute.mockImplementation(() => new Promise<FakeMicrophone>(() => undefined))
    hold(room())
    void call.setMuted(true)
    expect(call.getSnapshot().muting).toBe(true)
    expect(track.stopped).toBe(false)
    reader.level.mockClear()
    expect(call.micLevel()).toBe(0)
    expect(reader.level).not.toHaveBeenCalled()
  })

  it('reads 0 once the capture has ended under it', async () => {
    const reader = meter()
    const { call, room } = setup({ createMeter: reader.make })
    await call.join(STANDUP)
    room().microphone!.track.stopped = true
    expect(call.micLevel()).toBe(0)
  })

  it('closes the meter with its call, and makes a new one for the next join', async () => {
    const reader = meter()
    const { call } = setup({ createMeter: reader.make })
    await call.join(STANDUP)
    await call.join(RETRO)
    expect(reader.make).toHaveBeenCalledTimes(2)
    expect(reader.close).toHaveBeenCalledTimes(1)
    await call.leave()
    expect(reader.close).toHaveBeenCalledTimes(2)
    expect(call.micLevel()).toBe(0)
  })

  it('joins all the same when the meter cannot start', async () => {
    const { call } = setup({
      createMeter: () => {
        throw new Error('no audio context')
      },
    })
    await call.join(STANDUP)
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: false })
    expect(call.micLevel()).toBe(0)
  })
})

describe("CallController: the member's microphone and output", () => {
  const HEADSET = 'headset-mic'
  const SPEAKERS = 'desk-speakers'
  function kept(choice: AudioDeviceChoice = NO_CHOICE) {
    const save = vi.fn((_choice: AudioDeviceChoice) => true)
    return { read: () => choice, save }
  }
  const failure = (name: string) => Object.assign(new Error(name), { name })

  it('captures the remembered microphone, that one and no other, and the default without one', async () => {
    const chosen = setup({ deviceChoice: kept({ input: HEADSET, output: null }) })
    await chosen.call.join(STANDUP)
    expect(chosen.room().localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, {
      deviceId: { exact: HEADSET },
    })
    expect(chosen.call.getSnapshot()).toMatchObject({ status: 'connected', muted: false })
    expect(chosen.call.getSnapshot().inputMissing).toBeFalsy()

    const plain = setup()
    await plain.call.join(STANDUP)
    expect(plain.room().localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(...MIC_ON)
  })

  it.each(['OverconstrainedError', 'NotFoundError'])(
    'takes the default when the remembered microphone is not plugged in (%s), and keeps the choice',
    async (name) => {
      const choice = kept({ input: HEADSET, output: null })
      const { call, room } = setup({ deviceChoice: choice })
      const created = call.join(STANDUP)
      room().localParticipant.setMicrophoneEnabled.mockImplementationOnce(async () => {
        throw failure(name)
      })
      await created
      const calls = room().localParticipant.setMicrophoneEnabled.mock.calls
      // The default by name: the room would otherwise ask again for the device it last switched to.
      expect(room().switchActiveDevice).toHaveBeenCalledWith('audioinput', 'default', false)
      expect(calls.at(-1)).toEqual([...MIC_ON])
      expect(call.getSnapshot()).toMatchObject({ muted: false, inputMissing: true })
      expect(call.getSnapshot().problem).toBeUndefined()
      expect(room().liveMicrophone()).toBe(true)
      // Kept for when it is back: nothing was forgotten.
      expect(call.getDeviceChoice().input).toBe(HEADSET)
      expect(choice.save).not.toHaveBeenCalled()
      // A new call starts without the notice; it is said again only if it is still true.
      await call.leave()
      expect(call.getSnapshot().inputMissing).toBeFalsy()
    }
  )

  it('says no microphone is found when even the default is not there', async () => {
    const { call, room } = setup({ deviceChoice: kept({ input: HEADSET, output: null }) })
    const created = call.join(STANDUP)
    room().localParticipant.setMicrophoneEnabled.mockImplementation(async () => {
      throw failure('NotFoundError')
    })
    await created
    expect(call.getSnapshot()).toMatchObject({ muted: true, problem: 'microphone-missing' })
    // Not « the default one is used »: none is.
    expect(call.getSnapshot().inputMissing).toBe(false)
  })

  it('takes the default on an unmute too, when the chosen microphone went while muted', async () => {
    const { call, room } = setup({ deviceChoice: kept({ input: HEADSET, output: null }) })
    await call.join(STANDUP)
    await call.setMuted(true)
    room().switchActiveDevice.mockClear()
    room().localParticipant.setMicrophoneEnabled.mockImplementationOnce(async () => {
      throw failure('OverconstrainedError')
    })
    await call.setMuted(false)
    // The track the call has restarts on the device it was switched to: switched to the default.
    expect(room().switchActiveDevice).toHaveBeenCalledWith('audioinput', 'default', false)
    expect(call.getSnapshot()).toMatchObject({ muted: false, inputMissing: true })
    expect(room().liveMicrophone()).toBe(true)
  })

  it('captures the default by name in a later call, not the device the room was last switched to', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    await call.chooseInput(HEADSET)
    await call.leave()
    await call.chooseInput(null)
    const local = room().localParticipant
    local.setMicrophoneEnabled.mockClear()
    await call.join(RETRO)
    expect(local.setMicrophoneEnabled).toHaveBeenCalledWith(...MIC_ON)
  })

  it('follows a microphone chosen while the capture was starting', async () => {
    const { call, room } = setup()
    const joining = call.join(STANDUP)
    const release = hold(room())
    await vi.waitFor(() => expect(room().localParticipant.setMicrophoneEnabled).toHaveBeenCalled())
    await call.chooseInput(HEADSET)
    room().switchActiveDevice.mockClear()
    release()
    await joining
    await vi.waitFor(() =>
      expect(room().switchActiveDevice).toHaveBeenCalledWith('audioinput', HEADSET, true)
    )
  })

  it("does not take the default for a refused microphone: that is the member's to allow", async () => {
    const { call, room } = setup({ deviceChoice: kept({ input: HEADSET, output: null }) })
    const created = call.join(STANDUP)
    room().localParticipant.setMicrophoneEnabled.mockImplementationOnce(async () => {
      throw failure('NotAllowedError')
    })
    await created
    expect(room().localParticipant.setMicrophoneEnabled).toHaveBeenCalledTimes(1)
    expect(call.getSnapshot()).toMatchObject({ muted: true, problem: 'microphone-denied' })
    expect(call.getSnapshot().inputMissing).toBeFalsy()
  })

  it('switches the microphone in the call at once, remembers it, and clears the notice', async () => {
    const choice = kept({ input: HEADSET, output: null })
    const { call, room } = setup({ deviceChoice: choice })
    const created = call.join(STANDUP)
    room().localParticipant.setMicrophoneEnabled.mockImplementationOnce(async () => {
      throw failure('OverconstrainedError')
    })
    await created
    expect(call.getSnapshot().inputMissing).toBe(true)

    await call.chooseInput('desk-mic')
    expect(room().switchActiveDevice).toHaveBeenLastCalledWith('audioinput', 'desk-mic', true)
    expect(choice.save).toHaveBeenLastCalledWith({ input: 'desk-mic', output: null })
    expect(call.getDeviceChoice().input).toBe('desk-mic')
    expect(call.getSnapshot().inputMissing).toBe(false)

    // Back to the system's default: whatever the browser calls it, not that exact id.
    await call.chooseInput(null)
    expect(room().switchActiveDevice).toHaveBeenLastCalledWith('audioinput', 'default', false)
    expect(choice.save).toHaveBeenLastCalledWith({ input: null, output: null })
  })

  it('keeps the microphone it had when the chosen one will not start, and says why', async () => {
    const choice = kept()
    const { call, room } = setup({ deviceChoice: choice })
    await call.join(STANDUP)
    room().switchActiveDevice.mockImplementationOnce(async () => {
      throw failure('NotReadableError')
    })
    await call.chooseInput('busy-mic')
    expect(call.getSnapshot().problem).toBe('microphone-in-use')
    // LiveKit stopped the old capture to try the new one, and would keep asking for that one.
    expect(room().switchActiveDevice).toHaveBeenLastCalledWith('audioinput', 'default', false)
    expect(call.getSnapshot().muted).toBe(false)
    expect(call.getDeviceChoice().input).toBeNull()
    expect(choice.save).not.toHaveBeenCalled()
    // A choice that starts clears it.
    await call.chooseInput('desk-mic')
    expect(call.getSnapshot().problem).toBeUndefined()
  })

  it('goes back to the default it stood in with, not the chosen one still unplugged', async () => {
    const { call, room } = setup({ deviceChoice: kept({ input: HEADSET, output: null }) })
    const created = call.join(STANDUP)
    room().localParticipant.setMicrophoneEnabled.mockImplementationOnce(async () => {
      throw failure('OverconstrainedError')
    })
    await created
    room().switchActiveDevice.mockClear()
    room().switchActiveDevice.mockImplementationOnce(async () => {
      throw failure('NotReadableError')
    })
    await call.chooseInput('busy-mic')
    expect(room().switchActiveDevice).toHaveBeenLastCalledWith('audioinput', 'default', false)
    expect(call.getSnapshot()).toMatchObject({ muted: false, problem: 'microphone-in-use' })
  })

  it('unmutes on the microphone chosen last, though LiveKit restarts on the one it had', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    await call.setMuted(true)
    // Picked while the capture was starting: the switch only reached the room, not the track.
    await call.chooseInput(HEADSET)
    room().switchActiveDevice.mockClear()
    const local = room().localParticipant
    local.setMicrophoneEnabled.mockClear()
    await call.setMuted(false)
    expect(room().switchActiveDevice).toHaveBeenCalledWith('audioinput', HEADSET, true)
    // Set on the muted track before the unmute restarts it.
    expect(room().switchActiveDevice.mock.invocationCallOrder[0]!).toBeLessThan(
      local.setMicrophoneEnabled.mock.invocationCallOrder[0]!
    )
  })

  it('goes on with the default it stood in with across an unmute, though the chosen one is back', async () => {
    const { call, room } = setup({ deviceChoice: kept({ input: HEADSET, output: null }) })
    const created = call.join(STANDUP)
    room().localParticipant.setMicrophoneEnabled.mockImplementationOnce(async () => {
      throw failure('OverconstrainedError')
    })
    await created
    await call.setMuted(true)
    room().switchActiveDevice.mockClear()
    await call.setMuted(false)
    expect(room().switchActiveDevice).toHaveBeenCalledWith('audioinput', 'default', false)
    expect(room().switchActiveDevice).not.toHaveBeenCalledWith('audioinput', HEADSET, true)
    expect(call.getSnapshot()).toMatchObject({ muted: false, inputMissing: true })
  })

  it('goes back to the microphone it captured when one chosen while starting will not', async () => {
    const { call, room } = setup()
    const joining = call.join(STANDUP)
    const release = hold(room())
    await vi.waitFor(() => expect(room().localParticipant.setMicrophoneEnabled).toHaveBeenCalled())
    await call.chooseInput(HEADSET)
    room().switchActiveDevice.mockClear()
    room().switchActiveDevice.mockImplementationOnce(async () => {
      throw failure('NotReadableError')
    })
    release()
    await joining
    await vi.waitFor(() =>
      expect(room().switchActiveDevice).toHaveBeenLastCalledWith('audioinput', 'default', false)
    )
    expect(call.getSnapshot().muted).toBe(false)
  })

  it('mutes the member, saying why, when not even the microphone they had starts again', async () => {
    const { call, room } = setup({ deviceChoice: kept({ input: HEADSET, output: null }) })
    await call.join(STANDUP)
    room()
      .switchActiveDevice.mockImplementationOnce(async () => {
        throw failure('NotReadableError')
      })
      .mockImplementationOnce(async () => {
        throw failure('NotFoundError')
      })
    await call.chooseInput('busy-mic')
    expect(room().switchActiveDevice).toHaveBeenLastCalledWith('audioinput', HEADSET, true)
    expect(call.getSnapshot()).toMatchObject({ muted: true, problem: 'microphone-missing' })
    expect(room().liveMicrophone()).toBe(false)
    expect(call.getDeviceChoice().input).toBe(HEADSET)
  })

  it('remembers a microphone chosen out of a call, for the next one, without touching any', async () => {
    const choice = kept()
    const { call, rooms } = setup({ deviceChoice: choice })
    await call.chooseInput(HEADSET)
    expect(rooms).toHaveLength(0)
    expect(choice.save).toHaveBeenCalledWith({ input: HEADSET, output: null })
    await call.join(STANDUP)
    expect(rooms[0]!.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, {
      deviceId: { exact: HEADSET },
    })
  })

  it("plays the call's sound on the remembered output from the start, and on a new one at once", async () => {
    const choice = kept({ input: null, output: SPEAKERS })
    const { call, room } = setup({ deviceChoice: choice })
    const joining = call.join(STANDUP)
    // Set before the connection, so that every participant's sound plays there.
    expect(room().switchActiveDevice).toHaveBeenCalledWith('audiooutput', SPEAKERS)
    expect(room().connect).not.toHaveBeenCalled()
    await joining

    await call.chooseOutput('headphones')
    expect(room().switchActiveDevice).toHaveBeenLastCalledWith('audiooutput', 'headphones')
    expect(choice.save).toHaveBeenLastCalledWith({ input: null, output: 'headphones' })
    await call.chooseOutput(null)
    // The system's output is the empty sink id.
    expect(room().switchActiveDevice).toHaveBeenLastCalledWith('audiooutput', '')
  })

  it('still remembers an output a browser cannot choose, and does not throw', async () => {
    const choice = kept()
    const { call, room } = setup({ deviceChoice: choice })
    await call.join(STANDUP)
    room().switchActiveDevice.mockImplementation(async () => {
      throw new Error('cannot switch audio output, the current browser does not support it')
    })
    await expect(call.chooseOutput(SPEAKERS)).resolves.toBeUndefined()
    expect(choice.save).toHaveBeenCalledWith({ input: null, output: SPEAKERS })
    // Nor does a join with it.
    await expect(call.join(RETRO)).resolves.toBeUndefined()
    expect(call.getSnapshot().status).toBe('connected')
  })

  it('touches no output without a choice', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    expect(room().switchActiveDevice).not.toHaveBeenCalled()
  })
})

function fakeSoundPort() {
  return {
    play: vi.fn((() => ({ allowed: true }) as unknown as SoundDecision) as CallSoundPort['play']),
    stopAllLoops: vi.fn(),
    setActiveVoiceCall: vi.fn(),
    setParticipantCount: vi.fn(),
    setOutputDevice: vi.fn(async () => true),
    resetCooldowns: vi.fn(),
  } satisfies CallSoundPort
}

describe('CallController: Sonic Identity cues in live voice calls', () => {
  it('activates the voice call ducking state and plays voice_self_join on connect, and voice_self_leave on user leave', async () => {
    const sounds = fakeSoundPort()
    const { call } = setup({ sounds })
    await call.join(STANDUP)
    expect(sounds.resetCooldowns).toHaveBeenCalledTimes(1)
    expect(sounds.setActiveVoiceCall).toHaveBeenCalledWith(true)
    expect(sounds.setParticipantCount).toHaveBeenCalledWith(1)
    expect(sounds.play).toHaveBeenCalledWith('voice_self_join')

    sounds.play.mockClear()
    await call.leave()
    expect(sounds.stopAllLoops).toHaveBeenCalled()
    expect(sounds.setActiveVoiceCall).toHaveBeenLastCalledWith(false)
    expect(sounds.play).toHaveBeenCalledWith('voice_self_leave')

    // Leaving again while idle does not replay voice_self_leave.
    sounds.play.mockClear()
    await call.leave()
    expect(sounds.play).not.toHaveBeenCalledWith('voice_self_leave')
  })

  it('clears active voice call and loops on server disconnect without playing voice_self_leave', async () => {
    const sounds = fakeSoundPort()
    const { call, room } = setup({ sounds })
    await call.join(STANDUP)
    sounds.play.mockClear()
    sounds.stopAllLoops.mockClear()
    sounds.setActiveVoiceCall.mockClear()

    room().emit(RoomEvent.Disconnected, DisconnectReason.SERVER_SHUTDOWN)
    expect(sounds.stopAllLoops).toHaveBeenCalledTimes(1)
    expect(sounds.setActiveVoiceCall).toHaveBeenCalledWith(false)
    expect(sounds.play).not.toHaveBeenCalledWith('voice_self_leave')
  })

  it('plays voice_mute_on and voice_mute_off when toggling microphone mute (setMuted and setMicMuted)', async () => {
    const sounds = fakeSoundPort()
    const { call } = setup({ sounds })
    await call.join(STANDUP)
    sounds.play.mockClear()

    await call.setMuted(true)
    expect(sounds.play).toHaveBeenLastCalledWith('voice_mute_on')

    await call.setMicMuted(false)
    expect(sounds.play).toHaveBeenLastCalledWith('voice_mute_off')
  })

  it('plays voice_deafen_on and voice_deafen_off when toggling deafen', async () => {
    const sounds = fakeSoundPort()
    const { call } = setup({ sounds })
    await call.join(STANDUP)
    sounds.play.mockClear()

    await call.setDeafened(true)
    expect(sounds.play).toHaveBeenLastCalledWith('voice_deafen_on')

    await call.setDeafened(false)
    expect(sounds.play).toHaveBeenLastCalledWith('voice_deafen_off')
  })

  it('forwards audio output device changes to the sound engine', async () => {
    const sounds = fakeSoundPort()
    const { call } = setup({ sounds })
    await call.chooseOutput('headset')
    expect(sounds.setOutputDevice).toHaveBeenLastCalledWith('headset')
    await call.chooseOutput(null)
    expect(sounds.setOutputDevice).toHaveBeenLastCalledWith(null)
  })

  it('emits voice_peer_join and voice_peer_leave with participantCount, applying crowd scaling and 2500 ms burst coalescing', async () => {
    localStorage.clear()
    let clock = 10_000
    const engine = new SoundEngine({
      now: () => clock,
      documentHiddenQuery: () => false,
      reducedMotionQuery: () => false,
      audioContextFactory: () => null,
    })
    const decisions: SoundDecision[] = []
    const origPlay = engine.play.bind(engine)
    vi.spyOn(engine, 'play').mockImplementation((trigger, context) => {
      const decision = origPlay(trigger, context)
      decisions.push(decision)
      return decision
    })

    const { call, room } = setup({ sounds: engine })
    await call.join(STANDUP)
    expect(decisions.map((d) => d.triggerId)).toEqual(['voice_self_join'])
    const baseSelfJoinGain = decisions[0]!.gain
    expect(baseSelfJoinGain).toBeGreaterThan(0)
    decisions.length = 0

    // Peer 1 joins (total 2 participants -> 1..4 full gain)
    const p1 = new FakeRemote('@p1:matrix.acme-sa.kodera.test|D1')
    room().remoteParticipants.set(p1.identity, p1)
    room().emit(RoomEvent.ParticipantConnected, p1)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({
      triggerId: 'voice_peer_join',
      allowed: true,
      reason: 'none',
    })
    const fullPeerGain = decisions[0]!.gain

    // Burst peer 2 within 2500 ms -> coalesced by SoundEngine
    clock += 500
    const p2 = new FakeRemote('@p2:matrix.acme-sa.kodera.test|D1')
    room().remoteParticipants.set(p2.identity, p2)
    room().emit(RoomEvent.ParticipantConnected, p2)
    expect(decisions).toHaveLength(2)
    expect(decisions[1]).toMatchObject({
      triggerId: 'voice_peer_join',
      allowed: false,
      reason: 'peer-burst-coalesced',
    })

    // Advance past 2500 ms and add peers up to 5 total participants (local + 4 remotes -> 5..8 attenuated gain)
    clock += 2600
    const p3 = new FakeRemote('@p3:matrix.acme-sa.kodera.test|D1')
    const p4 = new FakeRemote('@p4:matrix.acme-sa.kodera.test|D1')
    room().remoteParticipants.set(p3.identity, p3)
    room().remoteParticipants.set(p4.identity, p4)
    room().emit(RoomEvent.ParticipantConnected, p4)
    expect(decisions).toHaveLength(3)
    expect(decisions[2]).toMatchObject({
      triggerId: 'voice_peer_join',
      allowed: true,
      reason: 'none',
    })
    expect(decisions[2]!.gain).toBeCloseTo(fullPeerGain * CROWD_ATTENUATED_GAIN, 5)

    // Advance past 2500 ms and grow room to 9 total participants (local + 8 remotes -> >= 9 suppressed)
    clock += 2600
    for (let i = 5; i <= 8; i++) {
      const peer = new FakeRemote(`@p${i}:matrix.acme-sa.kodera.test|D1`)
      room().remoteParticipants.set(peer.identity, peer)
    }
    room().emit(
      RoomEvent.ParticipantConnected,
      room().remoteParticipants.get('@p8:matrix.acme-sa.kodera.test|D1')
    )
    expect(decisions).toHaveLength(4)
    expect(decisions[3]).toMatchObject({
      triggerId: 'voice_peer_join',
      allowed: false,
      reason: 'crowd-limit',
    })

    // Drop back to 3 total participants (local + 2 remotes) after 2500 ms -> voice_peer_leave plays at full gain
    clock += 2600
    for (let i = 3; i <= 8; i++) {
      room().remoteParticipants.delete(`@p${i}:matrix.acme-sa.kodera.test|D1`)
    }
    room().emit(RoomEvent.ParticipantDisconnected, p3)
    expect(decisions).toHaveLength(5)
    expect(decisions[4]).toMatchObject({
      triggerId: 'voice_peer_leave',
      allowed: true,
      reason: 'none',
    })
    expect(decisions[4]!.gain).toBeCloseTo(fullPeerGain, 5)
    engine.destroy()
  })
})
