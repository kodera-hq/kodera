import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionState, RoomEvent, Track, VideoPresets } from 'livekit-client'
import { createCallController, SCREEN_CAPTURE, type CallRoom } from './call'
import { NO_CHOICE } from './devices'
import { CallPreferences } from './callPreferences'
import type { MicMeter } from './meter'

const HS = 'https://matrix.acme-sa.kodera.test'
const STANDUP = '!standup:matrix.acme-sa.kodera.test'
const RETRO = '!retro:matrix.acme-sa.kodera.test'
const ME = '@me:matrix.acme-sa.kodera.test'
const BOB = '@bob:matrix.acme-sa.kodera.test'

type Handler = (...args: never[]) => void

class FakeCapture {
  readyState: 'live' | 'ended' = 'live'
  contentHint = ''
  constraints: MediaTrackConstraints = { echoCancellation: true }
  stop = vi.fn(() => {
    this.readyState = 'ended'
  })
  getConstraints = () => this.constraints
  applyConstraints = vi.fn(async (constraints: MediaTrackConstraints) => {
    this.constraints = constraints
  })
}

class FakeLocalTrack {
  readonly mediaStreamTrack = new FakeCapture()
  muted = false
  readonly attached: HTMLMediaElement[] = []
  constructor(readonly source: Track.Source) {}
  get isMuted() {
    return this.muted
  }
  mute = vi.fn(async () => {
    this.muted = true
    return this
  })
  stop = vi.fn(() => this.mediaStreamTrack.stop())
  attach = vi.fn((element: HTMLMediaElement) => {
    this.attached.push(element)
    return element
  })
  detach = vi.fn((element: HTMLMediaElement) => {
    this.attached.splice(this.attached.indexOf(element), 1)
    return element
  })
}

class FakeRemoteVideo {
  readonly kind = 'video'
  readonly attached: HTMLMediaElement[] = []
  attach = vi.fn((element: HTMLMediaElement) => {
    this.attached.push(element)
    return element
  })
  detach = vi.fn((element?: HTMLMediaElement) => {
    if (element !== undefined) this.attached.splice(this.attached.indexOf(element), 1)
    return element
  })
}

let sid = 0

interface Held {
  resolve: () => void
  reject: (error: unknown) => void
}

class FakeRoom {
  readonly handlers = new Map<string, Set<Handler>>()
  readonly remoteParticipants = new Map<
    string,
    { identity: string; audioTrackPublications: Map<string, unknown> }
  >()
  readonly published = new Map<
    Track.Source,
    { source: Track.Source; trackSid: string; track: FakeLocalTrack }
  >()
  state: ConnectionState = ConnectionState.Disconnected
  canPlaybackAudio = true
  /** The next camera or screen enable: refused with this error, or held until the test says. */
  refuse: Partial<Record<Track.Source, unknown>> = {}
  hold: Partial<Record<Track.Source, Held>> = {}
  holdNext = new Set<Track.Source>()

  readonly localParticipant = {
    identity: `${ME}|DEVICE1`,
    permissions: { canPublish: true } as { canPublish: boolean } | undefined,
    setMicrophoneEnabled: vi.fn(async (enabled: boolean, _options?: unknown) => {
      if (enabled && !this.published.has(Track.Source.Microphone)) {
        this.published.set(Track.Source.Microphone, {
          source: Track.Source.Microphone,
          trackSid: `TR_mic_${sid++}`,
          track: new FakeLocalTrack(Track.Source.Microphone),
        })
      }
      return undefined
    }),
    setCameraEnabled: vi.fn((enabled: boolean, _options?: unknown) =>
      this.enable(Track.Source.Camera, enabled)
    ),
    setScreenShareEnabled: vi.fn((enabled: boolean, _options?: unknown, _publish?: unknown) =>
      this.enable(Track.Source.ScreenShare, enabled)
    ),
    getTrackPublication: vi.fn((source: Track.Source) => this.published.get(source)),
    unpublishTrack: vi.fn(async (track: FakeLocalTrack, _stop?: boolean) => {
      for (const [source, publication] of this.published) {
        if (publication.track !== track) continue
        this.published.delete(source)
        this.emit(RoomEvent.LocalTrackUnpublished, publication, this.localParticipant)
      }
      return undefined
    }),
  }

  async enable(source: Track.Source, enabled: boolean) {
    if (!enabled) return undefined
    const refusal = this.refuse[source]
    if (refusal !== undefined) {
      delete this.refuse[source]
      throw refusal
    }
    if (this.holdNext.delete(source)) {
      await new Promise<void>((resolve, reject) => (this.hold[source] = { resolve, reject }))
    }
    const publication = {
      source,
      trackSid: `TR_${source}_${sid++}`,
      track: new FakeLocalTrack(source),
    }
    this.published.set(source, publication)
    this.emit(RoomEvent.LocalTrackPublished, publication, this.localParticipant)
    return publication
  }

  connect = vi.fn(async () => {
    this.state = ConnectionState.Connected
  })
  disconnect = vi.fn(async () => {
    if (this.state === ConnectionState.Disconnected) return
    this.state = ConnectionState.Disconnected
    for (const publication of this.published.values()) publication.track.stop()
    this.published.clear()
  })
  startAudio = vi.fn(async () => undefined)
  switchActiveDevice = vi.fn(async () => true)
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
  /** A remote member's camera (or screen), subscribed. */
  remoteVideo(identity: string, source = Track.Source.Camera, muted = false) {
    const track = new FakeRemoteVideo()
    const publication = { source, trackSid: `TR_remote_${sid++}`, isMuted: muted }
    this.emit(RoomEvent.TrackSubscribed, track, publication, { identity })
    return { track, publication }
  }
}

const SILENT: MicMeter = { level: () => 0, close: () => undefined }

function grant(listenOnly = false) {
  return new Response(
    JSON.stringify({
      url: 'wss://rtc.acme-sa.kodera.test',
      token: 'lk.jwt',
      listen_only: listenOnly,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

function setup(options: { listenOnly?: boolean; preferences?: CallPreferences } = {}) {
  const rooms: FakeRoom[] = []
  const preferences = options.preferences ?? new CallPreferences()
  const call = createCallController({
    homeserver: HS,
    serverName: 'acme-sa.kodera.test',
    tokens: { current: () => 'syt_member', renew: vi.fn(async () => 'syt_next') },
    fetch: vi.fn(async () => grant(options.listenOnly)) as unknown as typeof fetch,
    mount: () => document.body,
    createMeter: () => SILENT,
    deviceChoice: { read: () => NO_CHOICE, save: () => true },
    sounds: {
      play: vi.fn(async () => undefined),
      setActiveVoiceCall: vi.fn(),
      setParticipantCount: vi.fn(),
      setOutputDevice: vi.fn(async () => true),
      stopAllLoops: vi.fn(),
    } as never,
    preferences,
    createRoom: () => {
      const room = new FakeRoom()
      rooms.push(room)
      return room as unknown as CallRoom
    },
  })
  return { call, room: () => rooms[0]!, preferences }
}

function failure(name: string) {
  return Object.assign(new Error(name), { name })
}

beforeEach(() => {
  vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
})

afterEach(() => {
  document.body.replaceChildren()
  window.localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('the camera', () => {
  it('is off at a join, on when the member asks, and drawn where a screen attaches it', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    expect(call.getSnapshot()).toMatchObject({ camera: 'off', screen: 'off', videos: [] })

    await call.setCameraEnabled(true)
    expect(room().localParticipant.setCameraEnabled).toHaveBeenCalledWith(true, {
      resolution: VideoPresets.h720.resolution,
    })
    const [feed] = call.getSnapshot().videos!
    expect(call.getSnapshot().camera).toBe('on')
    expect(feed).toMatchObject({ userId: ME, source: 'camera', local: true })

    const element = document.createElement('video')
    const detach = call.attachVideo(feed!.key, element)
    const track = room().published.get(Track.Source.Camera)!.track
    expect(track.attach).toHaveBeenCalledWith(element)
    expect(element.muted).toBe(true)
    detach()
    expect(track.detach).toHaveBeenCalledWith(element)
  })

  it('stops its capture with the click, before LiveKit unpublishes it', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    await call.setCameraEnabled(true)
    const track = room().published.get(Track.Source.Camera)!.track
    room().localParticipant.unpublishTrack.mockImplementationOnce(
      () => new Promise(() => undefined)
    )

    void call.setCameraEnabled(false)
    expect(track.mediaStreamTrack.readyState).toBe('ended')
    expect(call.getSnapshot()).toMatchObject({ camera: 'off', videos: [] })
  })

  it('says why the browser refused it, and stays off', async () => {
    for (const [name, problem] of [
      ['NotAllowedError', 'camera-denied'],
      ['NotFoundError', 'camera-missing'],
      ['NotReadableError', 'camera-in-use'],
      ['TypeError', 'camera'],
    ] as const) {
      const { call, room } = setup()
      await call.join(STANDUP)
      room().refuse[Track.Source.Camera] = failure(name)
      await call.setCameraEnabled(true)
      expect(call.getSnapshot()).toMatchObject({ camera: 'off', videoProblem: problem, videos: [] })
      await call.leave()
    }
  })

  it('turned off while the browser still asks, it never goes out once allowed', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    room().holdNext.add(Track.Source.Camera)
    const starting = call.setCameraEnabled(true)
    await vi.waitFor(() => expect(room().hold[Track.Source.Camera]).toBeDefined())
    expect(call.getSnapshot().camera).toBe('starting')
    await call.setCameraEnabled(false)
    room().hold[Track.Source.Camera]!.resolve()
    await starting
    expect(room().published.has(Track.Source.Camera)).toBe(false)
    expect(call.getSnapshot()).toMatchObject({ camera: 'off', videos: [] })
  })

  it('is refused in a listen-only room, without asking the browser', async () => {
    const { call, room } = setup({ listenOnly: true })
    await call.join(STANDUP)
    await call.setCameraEnabled(true)
    await call.setScreenShareEnabled(true)
    expect(room().localParticipant.setCameraEnabled).not.toHaveBeenCalled()
    expect(room().localParticipant.setScreenShareEnabled).not.toHaveBeenCalled()
    expect(call.getSnapshot()).toMatchObject({ camera: 'off', videoProblem: 'video-forbidden' })
  })

  it('is not asked for outside a call that is through', async () => {
    const { call, room } = setup()
    await call.setCameraEnabled(true)
    void call.join(STANDUP)
    await call.setCameraEnabled(true)
    expect(room().localParticipant.setCameraEnabled).not.toHaveBeenCalled()
  })

  it('stops with the call, and is off again in the next room', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    await call.setCameraEnabled(true)
    await call.setScreenShareEnabled(true)
    const camera = room().published.get(Track.Source.Camera)!.track
    const screen = room().published.get(Track.Source.ScreenShare)!.track

    await call.join(RETRO)
    expect(camera.mediaStreamTrack.readyState).toBe('ended')
    expect(screen.mediaStreamTrack.readyState).toBe('ended')
    expect(call.getSnapshot()).toMatchObject({
      roomId: RETRO,
      camera: 'off',
      screen: 'off',
      videos: [],
    })
    expect(room().localParticipant.setCameraEnabled).toHaveBeenCalledTimes(1)

    await call.setCameraEnabled(true)
    const again = room().published.get(Track.Source.Camera)!.track
    await call.leave()
    expect(again.mediaStreamTrack.readyState).toBe('ended')
    expect(call.getSnapshot()).toMatchObject({ status: 'idle', camera: 'off', videos: [] })
  })

  it('stops when the right to publish is taken away', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    await call.setCameraEnabled(true)
    const camera = room().published.get(Track.Source.Camera)!.track
    room().localParticipant.permissions = { canPublish: false }
    room().emit(RoomEvent.ParticipantPermissionsChanged, undefined, room().localParticipant)
    expect(camera.mediaStreamTrack.readyState).toBe('ended')
    await vi.waitFor(() => expect(call.getSnapshot()).toMatchObject({ camera: 'off', videos: [] }))
  })
})

describe('sharing a screen', () => {
  it('asks for the detail content hint and no sound, and lists screens before cameras', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    room().remoteVideo(`${BOB}|PHONE`)
    await call.setScreenShareEnabled(true)
    expect(room().localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        audio: false,
        contentHint: 'detail',
        selfBrowserSurface: 'exclude',
      }),
      { degradationPreference: 'maintain-resolution' }
    )
    expect(SCREEN_CAPTURE.contentHint).toBe('detail')
    expect(room().published.get(Track.Source.ScreenShare)!.track.mediaStreamTrack.contentHint).toBe(
      'detail'
    )
    expect(call.getSnapshot().videos!.map((feed) => [feed.userId, feed.source])).toEqual([
      [ME, 'screen'],
      [BOB, 'camera'],
    ])
  })

  it('says nothing when the member closes the picker, and something when it fails', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    room().refuse[Track.Source.ScreenShare] = failure('NotAllowedError')
    await call.setScreenShareEnabled(true)
    expect(call.getSnapshot().screen).toBe('off')
    expect(call.getSnapshot().videoProblem).toBeUndefined()

    room().refuse[Track.Source.ScreenShare] = failure('AbortError')
    await call.setScreenShareEnabled(true)
    expect(call.getSnapshot()).toMatchObject({ screen: 'off', videoProblem: 'screen' })
  })

  it('ends when the browser’s own « Stop sharing » ends it', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    await call.setScreenShareEnabled(true)
    const publication = room().published.get(Track.Source.ScreenShare)!
    room().published.delete(Track.Source.ScreenShare)
    room().emit(RoomEvent.LocalTrackUnpublished, publication, room().localParticipant)
    expect(call.getSnapshot()).toMatchObject({ screen: 'off', videos: [] })
    // Sharing again is the member's to ask.
    await call.setScreenShareEnabled(true)
    expect(call.getSnapshot().screen).toBe('on')
  })
})

describe('other people’s video', () => {
  it('lists a camera while it is on, by its Matrix user, and forgets it when it goes', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    const { track, publication } = room().remoteVideo(`${BOB}|PHONE`)
    expect(call.getSnapshot().videos).toEqual([
      { key: publication.trackSid, userId: BOB, source: 'camera', local: false },
    ])
    const element = document.createElement('video')
    call.attachVideo(publication.trackSid, element)
    expect(track.attach).toHaveBeenCalledWith(element)

    publication.isMuted = true
    room().emit(RoomEvent.TrackMuted, publication, { identity: `${BOB}|PHONE` })
    expect(call.getSnapshot().videos).toEqual([])
    publication.isMuted = false
    room().emit(RoomEvent.TrackUnmuted, publication, { identity: `${BOB}|PHONE` })
    expect(call.getSnapshot().videos).toHaveLength(1)

    room().emit(RoomEvent.TrackUnsubscribed, track, publication, { identity: `${BOB}|PHONE` })
    expect(call.getSnapshot().videos).toEqual([])
    expect(track.detach).toHaveBeenCalledWith(element)
  })

  it('ignores a feed whose participant is not a Matrix user, and draws nothing for a key it lacks', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    room().remoteVideo('DEVICE9')
    room().remoteVideo(`${BOB}|PHONE`, Track.Source.ScreenShareAudio)
    expect(call.getSnapshot().videos).toEqual([])
    const element = document.createElement('video')
    expect(() => call.attachVideo('TR_unknown', element)()).not.toThrow()
  })
})

describe('noise suppression', () => {
  it('is the browser’s default unless the member turns it off, then applies to the live microphone', async () => {
    const preferences = new CallPreferences()
    const { call, room } = setup({ preferences })
    await call.join(STANDUP)
    expect(room().localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, {
      deviceId: { ideal: 'default' },
    })
    expect(call.getNoiseSuppression()).toBe(true)

    const capture = room().published.get(Track.Source.Microphone)!.track.mediaStreamTrack
    await call.setNoiseSuppression(false)
    expect(capture.applyConstraints).toHaveBeenCalledWith({
      echoCancellation: true,
      noiseSuppression: false,
    })
    expect(preferences.getSnapshot().noiseSuppression).toBe(false)

    await call.join(RETRO)
    expect(room().localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true, {
      deviceId: { ideal: 'default' },
      noiseSuppression: false,
    })
  })
})

describe('push-to-talk at a join', () => {
  it('never turns the microphone on: the member speaks by holding the key', async () => {
    const preferences = new CallPreferences()
    preferences.update({ inputMode: 'push-to-talk' })
    const { call, room } = setup({ preferences })
    await call.join(STANDUP)
    expect(room().localParticipant.setMicrophoneEnabled).not.toHaveBeenCalledWith(
      true,
      expect.anything()
    )
    expect(call.getSnapshot()).toMatchObject({ status: 'connected', muted: true })
    // Holding the key unmutes, as the dock's button does.
    await call.setMuted(false)
    expect(room().localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, {
      deviceId: { ideal: 'default' },
    })
  })

  it('asks the browser for the camera once, however often the member presses', async () => {
    const { call, room } = setup()
    await call.join(STANDUP)
    room().holdNext.add(Track.Source.Camera)
    const first = call.setCameraEnabled(true)
    await vi.waitFor(() => expect(room().hold[Track.Source.Camera]).toBeDefined())
    await call.setCameraEnabled(true)
    room().hold[Track.Source.Camera]!.resolve()
    await first
    expect(room().localParticipant.setCameraEnabled).toHaveBeenCalledTimes(1)
    expect(call.getSnapshot().camera).toBe('on')
  })
})
