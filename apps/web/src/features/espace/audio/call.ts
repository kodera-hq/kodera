// The one thin Kodera layer over livekit-client (messaging-pilot design §2.7), as `matrix/` is
// over matrix-js-sdk: an ESLint rule keeps the SDK from being imported anywhere else. A screen
// reads the call through `subscribe` and `getSnapshot`, and acts on it through `join`, `leave`,
// `setMuted`, `setDeafened` and `startAudio`; nothing here knows about React.
//
// A join asks the room-access service for a token for that one room (`roomAccess.ts`), connects,
// and turns the microphone on unless the token is listen-only. The service's guard removes a
// member who is no longer in the room and corrects publish rights on its own (design §2.2), so
// the call also ends, or loses its microphone, without the member doing anything.
//
// One LiveKit `Room` serves every join of a controller, reconnected each time: a Room makes an
// AudioContext as soon as playback is unlocked, and closes it only when a connection ends, so a
// Room per join leaked one context for each join that never connected.
//
// Who is in a room is not read from here: the sidebar keeps reading the room's occupancy state
// event, which everyone in the workspace sees, not only those in the call.
//
// Video is the member's to turn on, and never carried from one room to the next: the camera and a
// shared screen start off in every call, stop their capture the moment the member turns them off,
// and stop with the call (docs/specs/espace-video-and-screenshare.md). A screen is shared with the
// `detail` content hint, so text and lines stay sharp rather than smooth. A screen reads the
// feeds through `videos` and draws each in its own `<video>` (`attachVideo`); the SDK stays here.

import {
  ConnectionState,
  DisconnectReason,
  LogLevel,
  MediaDeviceFailure,
  Room,
  RoomEvent,
  setLogLevel,
  Track,
  type LocalTrack,
  type LocalTrackPublication,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RoomEventCallbacks,
  type RoomOptions,
  type ScreenShareCaptureOptions,
  type TrackPublication,
  type TrackPublishOptions,
  type VideoCaptureOptions,
  VideoPresets,
} from 'livekit-client'
import {
  fetchRoomGrant,
  RoomAccessFailed,
  type MatrixTokens,
  type RoomAccessProblem,
} from './roomAccess'
import { SILENT_METER, webAudioMeter, type MicMeter } from './meter'
import { readDeviceChoice, saveDeviceChoice, type AudioDeviceChoice } from './devices'
import { soundEngine, type SoundEngine } from '../../sounds/SoundEngine'
import { callPreferences, type CallPreferences } from './callPreferences'

export type CallStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'failed'

export type CallProblem =
  /** The join was refused by the room-access service (see `RoomAccessProblem`). */
  | RoomAccessProblem
  /** The server removed the member: no longer in the room, or the room archived. */
  | 'removed'
  /** The room's call was closed on the server. */
  | 'room-closed'
  /** The same member joined from this device elsewhere (another tab), which took the call. */
  | 'elsewhere'
  /** The connection was lost and could not be resumed. */
  | 'connection-lost'
  /** Connected, but the microphone could not be turned on, for a reason the browser did not say. */
  | 'microphone'
  /** Connected, but the browser refuses the microphone to this site (the member, or a policy). */
  | 'microphone-denied'
  /** Connected, but the browser finds no microphone. */
  | 'microphone-missing'
  /** Connected, but the microphone is held by another application. */
  | 'microphone-in-use'
  /**
   * The microphone could not be turned off, by LiveKit nor by stopping its track: the call was
   * ended so that nothing the member says reaches the room.
   */
  | 'microphone-stuck'

/** What a video feed shows: a person's camera, or a screen they share. */
export type VideoSource = 'camera' | 'screen'

/** A video the call can draw: `attachVideo(key, element)` puts it in a `<video>`. */
export interface VideoFeed {
  /** LiveKit's id for the track; stable while it is published. */
  readonly key: string
  /** Whose it is, by Matrix user id. */
  readonly userId: string
  readonly source: VideoSource
  /** The member's own camera or screen. */
  readonly local: boolean
}

/** The member's camera or screen: off, being turned on (a permission prompt, say), or on. */
export type MediaState = 'off' | 'starting' | 'on'

export type VideoProblem =
  /** The camera would not start, for a reason the browser did not say. */
  | 'camera'
  /** The browser refuses the camera to this site. */
  | 'camera-denied'
  /** The browser finds no camera. */
  | 'camera-missing'
  /** The camera is held by another application. */
  | 'camera-in-use'
  /** The screen could not be shared (a refusal of the picker is not a problem: it is a choice). */
  | 'screen'
  /** The member may listen and not speak in this room: no video either. */
  | 'video-forbidden'

export interface CallSnapshot {
  status: CallStatus
  /** The audio room's Matrix room id; null when idle. */
  roomId: string | null
  /**
   * The member's microphone is off, and known to be: the browser says its capture has ended (and
   * LiveKit holds it muted), or it is no longer published. Never shown on the member's word, nor
   * on LiveKit's, alone.
   */
  muted: boolean
  /**
   * The member turned the microphone off, and that is not confirmed yet: `muted` stays false
   * meanwhile, and a call still muting at the deadline ends (`microphone-stuck`). The controller
   * always sets it; it is optional so that a screen's own idle snapshot need not.
   */
  muting?: boolean
  /** The member hears nothing, and is muted too: shown, like `muted`, once that is confirmed. */
  deafened: boolean
  /** The member deafened, and the microphone's silence is not confirmed yet (see `muting`). */
  deafening?: boolean
  /** The member may listen and not speak. */
  listenOnly: boolean
  /** Who is speaking now, by Matrix user id. */
  speakers: readonly string[]
  /** Who is in the call, the member included, by Matrix user id. */
  participants: readonly string[]
  /**
   * The member's own Matrix user id in this call, once it is through: whose ring the member's own
   * microphone level draws (`micLevel`). Optional so that a screen's own idle snapshot need not.
   */
  self?: string | null
  /**
   * The browser holds back the call's sound until the member acts on the page (an autoplay
   * policy): `startAudio`, from a click, lets it play.
   */
  playbackBlocked: boolean
  /** Why the call failed or ended, or what is wrong while connected. */
  problem?: CallProblem
  /**
   * The microphone the member chose is not plugged in: the call took the system's default, and
   * the choice is kept for when it is back. Optional so that a screen's own snapshot need not.
   */
  inputMissing?: boolean
  /**
   * The videos the call can draw: shared screens first, then cameras, the member's own last. A
   * camera turned off (muted) is not listed. Optional, like the fields below, so that a screen's
   * own idle snapshot need not.
   */
  videos?: readonly VideoFeed[]
  /** The member's camera. */
  camera?: MediaState
  /** The member's shared screen. */
  screen?: MediaState
  /** Why the camera or the screen is off when the member asked for it. */
  videoProblem?: VideoProblem
}

/** What the controller uses of a LiveKit `Room`; tests hand it a fake. */
export type CallRoom = Pick<
  Room,
  | 'connect'
  | 'disconnect'
  | 'startAudio'
  | 'on'
  | 'off'
  | 'localParticipant'
  | 'remoteParticipants'
  | 'state'
  | 'canPlaybackAudio'
  | 'switchActiveDevice'
>

/** What the controller uses of the sound engine; tests may hand a fake. */
export type CallSoundPort = Pick<
  SoundEngine,
  'play' | 'setActiveVoiceCall' | 'setParticipantCount' | 'setOutputDevice' | 'stopAllLoops'
> & {
  resetCooldowns?: () => void
}

export interface CallControllerOptions {
  /** The workspace's homeserver, whose origin serves the room-access call. */
  homeserver: string
  /** The session's Matrix server name: the LiveKit server must be on it or under it. */
  serverName: string
  tokens: MatrixTokens
  /** The controller's one room, made at its first join and reconnected for each join after. */
  createRoom?: () => CallRoom
  fetch?: typeof fetch
  /** Where the hidden audio elements go: the document's body by default. */
  mount?: () => HTMLElement
  /** How long turning the microphone off may take before the call ends instead. */
  microphoneDeadlineMs?: number
  /** Each call's level reader, made at the join's click: Web Audio by default; tests hand a fake. */
  createMeter?: () => MicMeter
  /** Where the member's choice of devices is kept: this browser's storage by default. */
  deviceChoice?: {
    read: () => AudioDeviceChoice
    save: (choice: AudioDeviceChoice) => boolean
  }
  /** Where the call's interface cues play: the shared sound engine by default. */
  sounds?: CallSoundPort
  /** The member's call preferences (noise suppression): this browser's by default. */
  preferences?: Pick<CallPreferences, 'getSnapshot' | 'update'>
}

/** Muting stops the capture at once and is confirmed within a tick: this is for a stuck SDK. */
export const MICROPHONE_DEADLINE_MS = 5000

const IDLE: CallSnapshot = Object.freeze({
  status: 'idle',
  roomId: null,
  muted: false,
  muting: false,
  deafened: false,
  deafening: false,
  listenOnly: false,
  speakers: Object.freeze([]) as readonly string[],
  participants: Object.freeze([]) as readonly string[],
  self: null,
  playbackBlocked: false,
  videos: Object.freeze([]) as readonly VideoFeed[],
  camera: 'off',
  screen: 'off',
})

/** The camera, at 720p: enough for a tile, and kind to the uplink of a call of several. */
const CAMERA_CAPTURE: VideoCaptureOptions = Object.freeze({
  resolution: VideoPresets.h720.resolution,
})

/**
 * A shared screen: no sound, the `detail` content hint (text and lines kept sharp, frames dropped
 * rather than detail), and Kodera's own tab not offered, so the member does not share the call
 * into itself. No resolution is asked: Safari captures at a low one when any is.
 */
export const SCREEN_CAPTURE: ScreenShareCaptureOptions = Object.freeze({
  audio: false,
  contentHint: 'detail',
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'include',
  systemAudio: 'exclude',
})

/** A shared screen keeps its resolution when the network is short, and loses frames instead. */
const SCREEN_PUBLISH: TrackPublishOptions = Object.freeze({
  degradationPreference: 'maintain-resolution',
})

const SOURCE_OF: Record<VideoSource, Track.Source> = {
  camera: Track.Source.Camera,
  screen: Track.Source.ScreenShare,
}

function videoSourceOf(source: Track.Source): VideoSource | null {
  if (source === Track.Source.Camera) return 'camera'
  if (source === Track.Source.ScreenShare) return 'screen'
  return null
}

function cameraProblemOf(error: unknown): VideoProblem {
  switch (MediaDeviceFailure.getFailure(error)) {
    case MediaDeviceFailure.PermissionDenied:
      return 'camera-denied'
    case MediaDeviceFailure.NotFound:
      return 'camera-missing'
    case MediaDeviceFailure.DeviceInUse:
      return 'camera-in-use'
    default:
      return 'camera'
  }
}

/** A screen the member chose not to share (the picker closed) says nothing; anything else does. */
function screenProblemOf(error: unknown): VideoProblem | undefined {
  return (error as { name?: unknown } | null)?.name === 'NotAllowedError' ? undefined : 'screen'
}

/** What the controller needs of a video track: to be drawn in an element, and to stop. */
interface VideoEntry {
  readonly track: Pick<Track, 'attach' | 'detach'> & Partial<Pick<LocalTrack, 'stop'>>
  readonly userId: string
  readonly source: VideoSource
  readonly local: boolean
  muted: boolean
  readonly elements: Set<HTMLMediaElement>
}

/**
 * The Matrix user id of a LiveKit identity. The room-access service names every participant
 * `{matrix_user_id}|{device_id}`; a Matrix user id never contains `|`.
 */
export function matrixUserOf(identity: string): string | null {
  const separator = identity.indexOf('|')
  const userId = separator === -1 ? identity : identity.slice(0, separator)
  return userId.startsWith('@') && userId.indexOf(':') > 1 ? userId : null
}

function usersOf(participants: Iterable<Participant>): string[] {
  const users: string[] = []
  for (const participant of participants) {
    const userId = matrixUserOf(participant.identity)
    if (userId !== null && !users.includes(userId)) users.push(userId)
  }
  return users
}

/**
 * The system's default microphone, asked for by name. LiveKit keeps the last device a switch asked
 * for as the room's own default, from one call to the next: a capture that asks for nothing would
 * get that one.
 */
const SYSTEM_INPUT = { ideal: 'default' }

/** A capture refused because the device asked for is not there, as a chosen one unplugged is. */
function unplugged(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  return name === 'OverconstrainedError' || name === 'NotFoundError'
}

/** A microphone that would not turn on, as the browser says why (see `CallProblem`). */
export type MicrophoneProblem = Extract<CallProblem, `microphone${string}`>

function microphoneProblemOf(error: unknown): Exclude<MicrophoneProblem, 'microphone-stuck'> {
  switch (MediaDeviceFailure.getFailure(error)) {
    case MediaDeviceFailure.PermissionDenied:
      return 'microphone-denied'
    case MediaDeviceFailure.NotFound:
      return 'microphone-missing'
    case MediaDeviceFailure.DeviceInUse:
      return 'microphone-in-use'
    default:
      return 'microphone'
  }
}

/** The problems turning the microphone on again can clear: not a stuck one, which ended the call. */
const MICROPHONE_OFF: ReadonlySet<CallProblem> = new Set([
  'microphone',
  'microphone-denied',
  'microphone-missing',
  'microphone-in-use',
])

function endedBy(reason: DisconnectReason | undefined): CallProblem {
  switch (reason) {
    case DisconnectReason.PARTICIPANT_REMOVED:
      return 'removed'
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.ROOM_CLOSED:
      return 'room-closed'
    case DisconnectReason.DUPLICATE_IDENTITY:
      return 'elsewhere'
    default:
      return 'connection-lost'
  }
}

export const ROOM_OPTIONS: Readonly<RoomOptions> = Object.freeze({
  // Audio plays through plain elements, so silencing one is muting it (see `#silence`).
  webAudioMix: false,
  adaptiveStream: false,
  dynacast: false,
  // Muting stops the microphone's track, not only its sending, so the browser's recording
  // indicator goes off while the member is muted or deafened.
  publishDefaults: { stopMicTrackOnMute: true },
})

function defaultRoom(): CallRoom {
  // LiveKit's own logging stays at warnings: nothing it says about a connection reaches the
  // console at info level, where a URL or a token could.
  setLogLevel(LogLevel.warn)
  return new Room({ ...ROOM_OPTIONS })
}

/** The browser's capture under a local track has ended. */
function ended(track: LocalTrack): boolean {
  return track.mediaStreamTrack.readyState === 'ended'
}

/**
 * Stops a local track's capture: through LiveKit, then on the browser's track directly, should
 * LiveKit's stop not have ended it. Stopping the browser's track does not fire its `ended` event,
 * so LiveKit does not restart it.
 */
function endCapture(track: LocalTrack): void {
  try {
    track.stop()
  } catch {
    // The browser's track is stopped directly below.
  }
  try {
    if (!ended(track)) track.mediaStreamTrack.stop()
  } catch {
    // What the browser says is checked by the caller.
  }
}

interface LocalRetirement {
  readonly result: Promise<void>
  readonly settled: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
  started: boolean
}

interface Session {
  readonly room: CallRoom
  readonly container: HTMLElement
  /** The audio elements attached for each remote track. */
  readonly elements: Map<RemoteTrack, HTMLMediaElement>
  readonly detach: (() => void)[]
  closed: boolean
  retirement: LocalRetirement | null
  /** Turn-offs of the microphone not yet confirmed: the snapshot says `muting` meanwhile. */
  cutting: number
  /** This call's level reader, closed with it. */
  readonly meter: MicMeter
  /** The videos the call can draw, by track id. */
  readonly videos: Map<string, VideoEntry>
  /** What the member asked of the camera and the screen in this call: never carried to the next. */
  readonly videoWanted: Record<VideoSource, boolean>
  /** Counts the member's operations on each: the outcome of a replaced one says nothing. */
  readonly videoGeneration: Record<VideoSource, number>
}

export class CallController {
  readonly #homeserver: string
  readonly #serverName: string
  readonly #tokens: MatrixTokens
  readonly #createRoom: () => CallRoom
  readonly #fetch: typeof fetch | undefined
  readonly #mount: () => HTMLElement
  readonly #deadline: number
  readonly #createMeter: () => MicMeter
  readonly #saveChoice: (choice: AudioDeviceChoice) => boolean
  readonly #sounds: NonNullable<CallControllerOptions['sounds']>
  readonly #preferences: NonNullable<CallControllerOptions['preferences']>
  /** The microphone and output the member chose, applied to every call. */
  #deviceChoice: AudioDeviceChoice
  readonly #listeners = new Set<() => void>()
  #snapshot: CallSnapshot = IDLE
  #room: CallRoom | null = null
  #session: Session | null = null
  readonly #retirements = new Set<LocalRetirement>()
  /** Correlates commands even while their session has been cleared for teardown. */
  #intent = 0
  /** Whether the microphone was off before deafening, to restore it after. */
  #mutedBeforeDeafen = false
  /**
   * Whether the member muted themselves. A listen-only room, the service taking the right to
   * speak away, or a microphone that would not turn on also mute, but are not the member's
   * choice: only this, and deafening, follow the member from one room to the next, and only
   * `leave` forgets them.
   */
  #chosenMuted = false
  /**
   * Whether the microphone is to be off: what the member asked, or what listen-only imposes. The
   * snapshot's `muted` says it is off only once that is confirmed (see `#derive`).
   */
  #muteRequested = false
  /** Whether the member deafened: incoming sound follows it at once, `deafened` once confirmed. */
  #deafenRequested = false
  /**
   * Counts the member's operations on the microphone: the outcome of one that a later one
   * replaced says nothing about the microphone now.
   */
  #generation = 0
  #watchdog: ReturnType<typeof setTimeout> | null = null

  constructor(options: CallControllerOptions) {
    this.#homeserver = options.homeserver
    this.#serverName = options.serverName
    this.#tokens = options.tokens
    this.#createRoom = options.createRoom ?? defaultRoom
    this.#fetch = options.fetch
    this.#mount = options.mount ?? (() => document.body)
    this.#deadline = options.microphoneDeadlineMs ?? MICROPHONE_DEADLINE_MS
    this.#createMeter = options.createMeter ?? (() => webAudioMeter())
    this.#saveChoice = options.deviceChoice?.save ?? saveDeviceChoice
    this.#deviceChoice = (options.deviceChoice?.read ?? readDeviceChoice)()
    this.#sounds = options.sounds ?? soundEngine
    this.#preferences = options.preferences ?? callPreferences
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getSnapshot = (): CallSnapshot => this.#snapshot

  /**
   * The member's own microphone level now, 0 to 1, for a meter and the speaking ring. It is read
   * here, from the live capture itself, so it moves when the member is alone in the room; the
   * server's speakers (`speakers`) need someone else to hear. It is 0 whenever the microphone is
   * off, being turned off, or not on yet, and while the call reconnects. Cheap enough to read on
   * every frame; not in the snapshot, which would re-render the screen as often.
   */
  micLevel = (): number => {
    const session = this.#session
    if (session === null || session.closed || this.#muteRequested) return 0
    if (this.#snapshot.status !== 'connected') return 0
    let track
    try {
      track = session.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
    } catch {
      return 0
    }
    if (track === undefined || track.isMuted || ended(track)) return 0
    return session.meter.level(track.mediaStreamTrack)
  }

  /**
   * Joins an audio room, leaving the one the member is in first. Call it from the click itself:
   * it unlocks audio playback while the browser still counts the gesture.
   *
   * A member who muted or deafened stays so in the next room: a switch never turns a microphone
   * on that the member turned off. Only a call started after `leave` starts unmuted.
   */
  async join(roomId: string): Promise<void> {
    const current = this.#snapshot
    if (
      current.roomId === roomId &&
      (current.status === 'connecting' ||
        current.status === 'connected' ||
        current.status === 'reconnecting')
    ) {
      return
    }
    const intent = ++this.#intent
    const previous = this.#session
    const closing = previous === null ? undefined : this.#prepareClose(previous)
    const captured = [...this.#retirements].map((retirement) => retirement.settled)
    let session!: Session
    try {
      try {
        session = this.#open()
        this.#session = session
        this.#mutedBeforeDeafen = this.#chosenMuted
        const choices = this.#choices()
        // Push-to-talk: the microphone stays off until the key is held, from the join on, so it
        // never opens for the moment between connecting and the key's binding.
        if (this.#preferences.getSnapshot().inputMode === 'push-to-talk') choices.muted = true
        this.#reset({ status: 'connecting', roomId, ...choices })
        // Autoplay policies: playback is allowed once started from a user gesture, which is now.
        void session.room.startAudio().catch(() => undefined)
      } finally {
        // A subscriber or the gesture call can throw; the reserved teardown still starts now.
        if (previous !== null) this.#startClose(previous)
      }
    } catch (error) {
      await Promise.all(captured)
      throw error
    }
    if (closing !== undefined) {
      await Promise.all(captured)
      // Settlement observers never borrow this directly owned close's error.
      await closing.result
    }
    // Superseded while the previous call closed: ask for no token on its behalf.
    if (this.#intent !== intent || this.#session !== session) return
    while (this.#retirements.size > 0) {
      await Promise.all([...this.#retirements].map((retirement) => retirement.settled))
      if (this.#intent !== intent || this.#session !== session) return
    }
    // No await between the final empty/current check and starting this command's grant.
    if (this.#intent !== intent || this.#session !== session) return
    try {
      const grant = await fetchRoomGrant(
        this.#homeserver,
        this.#tokens,
        roomId,
        this.#serverName,
        this.#fetch
      )
      if (this.#session !== session) return
      await session.room.connect(grant.url, grant.token)
      if (this.#session !== session) return
      // `connect` can resolve on a connection already gone (closed while it was being set up).
      if (session.room.state !== ConnectionState.Connected) throw new Error('not connected')
      const canPublish = session.room.localParticipant.permissions?.canPublish !== false
      const listenOnly = grant.listenOnly || !canPublish
      const muted = listenOnly || this.#muteRequested
      // Muted: nothing may stay capturing from before, such as a previous room's enable that
      // LiveKit held for this connection. Silenced before the call says it is connected.
      const silencing = muted ? this.#turnOff(session) : undefined
      const participants = this.#participants(session)
      this.#set({
        status: 'connected',
        listenOnly,
        muted,
        participants,
        self: matrixUserOf(session.room.localParticipant.identity),
        playbackBlocked: !session.room.canPlaybackAudio,
      })
      try {
        this.#sounds.resetCooldowns?.()
        this.#sounds.setActiveVoiceCall(true)
        this.#sounds.setParticipantCount(participants.length)
        void this.#sounds.play('voice_self_join')
      } catch {
        // Sound cues never block or fail a call.
      }
      // Deafened from the previous room: what this one already publishes is not received either.
      if (this.#deafenRequested) this.#silence(session, true)
      if (silencing === undefined) await this.#turnOn(session)
      else await silencing
    } catch (error) {
      if (this.#session !== session) return
      this.#session = null
      await this.#close(session)
      if (this.#intent !== intent || this.#session !== null) return
      try {
        this.#sounds.stopAllLoops()
        this.#sounds.setActiveVoiceCall(false)
      } catch {
        // Sound cues never block or fail a call.
      }
      this.#reset({
        status: 'failed',
        roomId,
        problem: error instanceof RoomAccessFailed ? error.problem : 'unavailable',
        ...this.#choices(),
      })
    }
  }

  /** Leaves the call, or forgets one that failed or ended. */
  async leave(): Promise<void> {
    ++this.#intent
    const wasInCall =
      this.#snapshot.status === 'connected' || this.#snapshot.status === 'reconnecting'
    const session = this.#session
    this.#session = null
    const closing = session === null ? undefined : this.#prepareClose(session)
    // Freeze this leave's work before an idle subscriber can start a newer command.
    const captured = [...this.#retirements].map((retirement) => retirement.settled)
    this.#mutedBeforeDeafen = false
    this.#chosenMuted = false
    try {
      this.#sounds.stopAllLoops()
      this.#sounds.setActiveVoiceCall(false)
      if (wasInCall) void this.#sounds.play('voice_self_leave')
    } catch {
      // Sound cues never block or fail a call.
    }
    try {
      try {
        this.#reset({})
      } finally {
        if (session !== null) this.#startClose(session)
      }
    } catch (error) {
      await Promise.all(captured)
      throw error
    }
    await Promise.all(captured)
    if (closing !== undefined) await closing.result
  }

  /**
   * Lets the call's sound play when the browser held it back (`playbackBlocked`). Call it from
   * the member's click: the browser allows playback from a gesture only.
   */
  async startAudio(): Promise<void> {
    const session = this.#session
    if (session === null) return
    try {
      await session.room.startAudio()
    } catch {
      // Still blocked: the snapshot keeps saying so, and the member can try again.
    }
    if (this.#session === session) this.#set({ playbackBlocked: !session.room.canPlaybackAudio })
  }

  /** The microphone and output the member chose, each null for the system's default. */
  getDeviceChoice = (): AudioDeviceChoice => this.#deviceChoice

  /**
   * Captures from `input` (null: the system's default) from now on, in this call at once and in
   * every one after, and remembers it. A microphone that will not start says why, as unmuting
   * does, and the call keeps the one it had, as does the choice. Muted, the capture stays off:
   * the new microphone is the one unmuting starts.
   */
  async chooseInput(input: string | null): Promise<void> {
    const session = this.#session
    if (session !== null && !session.closed) {
      const captured = this.#snapshot.inputMissing === true ? null : this.#deviceChoice.input
      const refused = await this.#switchInput(session, input, captured)
      if (refused !== null) {
        if (this.#session === session && !session.closed && !this.#snapshot.muted)
          this.#set({ problem: microphoneProblemOf(refused) })
        return
      }
    }
    this.#remember({ input })
    if (this.#session === session && session !== null) {
      const { problem } = this.#snapshot
      this.#set({
        inputMissing: false,
        ...(problem !== undefined && MICROPHONE_OFF.has(problem) ? { problem: undefined } : {}),
      })
    }
  }

  /** Plays the call's sound on `output` (null: the system's default), and remembers it. */
  async chooseOutput(output: string | null): Promise<void> {
    this.#remember({ output })
    try {
      void this.#sounds.setOutputDevice(output).catch(() => false)
    } catch {
      // Sound engine output routing never blocks a call.
    }
    const room = this.#room
    if (room === null) return
    try {
      await room.switchActiveDevice('audiooutput', output ?? '')
    } catch {
      // A browser that cannot choose plays on the system's output; the panel says so.
    }
  }

  /**
   * Turns the member's camera on or off in the call they are in. Off stops the capture at once,
   * before LiveKit unpublishes it, so the browser's camera light goes out with the click. On asks
   * the browser (a prompt, the first time), and says why when it refuses (`videoProblem`).
   */
  setCameraEnabled = (on: boolean): Promise<void> => this.#setVideo('camera', on)

  /**
   * Shares a screen the member picks, or stops sharing it. The browser's own « Arrêter le
   * partage » ends it too. Closing the picker without choosing is not a problem: it is a choice.
   */
  setScreenShareEnabled = (on: boolean): Promise<void> => this.#setVideo('screen', on)

  /**
   * Draws the feed `key` (from `videos`) in `element`, muted (the call's sound plays through its
   * own hidden elements), and returns how to stop drawing it there. A feed gone, or no call, draws
   * nothing.
   */
  attachVideo = (key: string, element: HTMLVideoElement): (() => void) => {
    const session = this.#session
    const entry = session?.videos.get(key)
    if (session == null || session.closed || entry === undefined) return () => undefined
    element.muted = true
    element.playsInline = true
    element.autoplay = true
    entry.track.attach(element)
    entry.elements.add(element)
    return () => {
      if (!entry.elements.delete(element)) return
      try {
        entry.track.detach(element)
      } catch {
        // The element is the caller's, and goes with it.
      }
    }
  }

  /** Whether the browser's noise suppression cleans the member's microphone. */
  getNoiseSuppression = (): boolean => this.#preferences.getSnapshot().noiseSuppression

  /**
   * Turns the browser's noise suppression on or off, for the microphone capturing now and every
   * one after, and remembers it. A browser that cannot change it on a live capture applies it at
   * the next.
   */
  setNoiseSuppression = async (on: boolean): Promise<void> => {
    this.#preferences.update({ noiseSuppression: on })
    const session = this.#session
    if (session === null || session.closed) return
    let capture: MediaStreamTrack | undefined
    try {
      capture = session.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
        ?.mediaStreamTrack
    } catch {
      return
    }
    if (capture === undefined || capture.readyState === 'ended') return
    try {
      await capture.applyConstraints({ ...capture.getConstraints(), noiseSuppression: on })
    } catch {
      // Applied at the next capture.
    }
  }

  /** The capture's processing, as the member chose it: only what differs from the default. */
  #processing(): { noiseSuppression?: false } {
    return this.#preferences.getSnapshot().noiseSuppression ? {} : { noiseSuppression: false }
  }

  async #setVideo(source: VideoSource, on: boolean): Promise<void> {
    const session = this.#session
    if (session === null || session.closed || !this.#live()) return
    if (!on) {
      ++session.videoGeneration[source]
      session.videoWanted[source] = false
      this.#set({ [source]: 'off', videoProblem: undefined })
      await this.#stopVideo(session, source)
      return
    }
    if (this.#snapshot.listenOnly) {
      this.#set({ videoProblem: 'video-forbidden' })
      return
    }
    // Already on, or on its way: a second press is not a second operation.
    if (session.videoWanted[source]) return
    const generation = ++session.videoGeneration[source]
    session.videoWanted[source] = true
    this.#set({ [source]: 'starting', videoProblem: undefined })
    const local = session.room.localParticipant
    let publication: LocalTrackPublication | undefined
    try {
      publication =
        source === 'camera'
          ? await local.setCameraEnabled(true, CAMERA_CAPTURE)
          : await local.setScreenShareEnabled(true, SCREEN_CAPTURE, SCREEN_PUBLISH)
    } catch (error) {
      if (this.#session !== session || session.closed) return
      if (generation !== session.videoGeneration[source]) return
      session.videoWanted[source] = false
      const problem = source === 'camera' ? cameraProblemOf(error) : screenProblemOf(error)
      this.#set({ [source]: 'off', videoProblem: problem })
      // Whatever it left capturing goes too.
      await this.#stopVideo(session, source)
      return
    }
    if (this.#session !== session || session.closed) return
    if (generation !== session.videoGeneration[source] || !session.videoWanted[source]) {
      // Turned off while it started (a prompt open): it goes now.
      await this.#stopVideo(session, source)
      return
    }
    publication ??= local.getTrackPublication(SOURCE_OF[source])
    if (publication?.track === undefined) {
      session.videoWanted[source] = false
      this.#set({ [source]: 'off' })
      return
    }
    this.#localVideoPublished(session, source, publication)
  }

  /** The member's camera or screen, published: drawn, or stopped if they no longer want it. */
  #localVideoPublished(
    session: Session,
    source: VideoSource,
    publication: LocalTrackPublication
  ): void {
    const track = publication.track
    if (track === undefined) return
    if (!session.videoWanted[source]) {
      // Published for an operation the member has since replaced, or never asked in this call.
      void this.#stopVideo(session, source)
      return
    }
    if (source === 'screen') {
      try {
        // LiveKit sets it from `SCREEN_CAPTURE`; a browser that dropped it gets it again.
        if (track.mediaStreamTrack.contentHint !== 'detail') {
          track.mediaStreamTrack.contentHint = 'detail'
        }
      } catch {
        // The hint is advice; the share goes on without it.
      }
    }
    const userId = matrixUserOf(session.room.localParticipant.identity)
    if (userId !== null && !session.videos.has(publication.trackSid)) {
      session.videos.set(publication.trackSid, {
        track,
        userId,
        source,
        local: true,
        muted: false,
        elements: new Set(),
      })
    }
    this.#set({ [source]: 'on', videos: this.#feeds(session) })
  }

  /**
   * Stops the member's camera or screen: its capture ends at once, through LiveKit and on the
   * browser's track, before it is unpublished. A shared screen's sound goes with it.
   */
  async #stopVideo(session: Session, source: VideoSource): Promise<void> {
    const local = session.room.localParticipant
    const sources =
      source === 'camera'
        ? [Track.Source.Camera]
        : [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]
    const unpublishing: Promise<unknown>[] = []
    for (const trackSource of sources) {
      let publication: LocalTrackPublication | undefined
      try {
        publication = local.getTrackPublication(trackSource)
      } catch {
        continue
      }
      const track = publication?.track
      if (publication === undefined || track === undefined) continue
      endCapture(track)
      this.#removeVideo(session, publication.trackSid)
      unpublishing.push(local.unpublishTrack(track, true).catch(() => undefined))
    }
    if (
      this.#session === session &&
      this.#snapshot[source] !== 'off' &&
      !session.videoWanted[source]
    ) {
      this.#set({ [source]: 'off' })
    }
    await Promise.all(unpublishing)
  }

  #addVideo(session: Session, key: string, entry: VideoEntry): void {
    const previous = session.videos.get(key)
    if (previous !== undefined) this.#detachVideo(previous)
    session.videos.set(key, entry)
    this.#set({ videos: this.#feeds(session) })
  }

  #removeVideo(session: Session, key: string): void {
    const entry = session.videos.get(key)
    if (entry === undefined) return
    session.videos.delete(key)
    this.#detachVideo(entry)
    if (this.#session === session) this.#set({ videos: this.#feeds(session) })
  }

  #detachVideo(entry: VideoEntry): void {
    for (const element of entry.elements) {
      try {
        entry.track.detach(element)
      } catch {
        // The element is the caller's.
      }
    }
    entry.elements.clear()
  }

  /** Shared screens first, then cameras; the member's own after the others'. Muted ones hidden. */
  #feeds(session: Session): VideoFeed[] {
    const feeds: VideoFeed[] = []
    for (const [key, entry] of session.videos) {
      if (entry.muted) continue
      feeds.push({ key, userId: entry.userId, source: entry.source, local: entry.local })
    }
    const rank = (feed: VideoFeed) => (feed.source === 'screen' ? 0 : 2) + (feed.local ? 1 : 0)
    return feeds.sort((a, b) => rank(a) - rank(b))
  }

  /**
   * Switches the call's capture to `input`; the refusal when it would not start, else null.
   * LiveKit stops the capture before it asks for the new device, and keeps asking for that one: a
   * refusal goes back to `captured`, the one the call had, and when that will not start either,
   * the member is muted, saying why.
   */
  async #switchInput(
    session: Session,
    input: string | null,
    captured: string | null
  ): Promise<unknown> {
    const { room } = session
    try {
      // An id the member picked must be that device; the default may be named differently.
      await room.switchActiveDevice('audioinput', input ?? 'default', input !== null)
      return null
    } catch (refused) {
      try {
        await room.switchActiveDevice('audioinput', captured ?? 'default', captured !== null)
      } catch (error) {
        if (this.#session !== session || session.closed) return refused
        const silencing = this.#turnOff(session)
        this.#set({ muted: true, problem: microphoneProblemOf(error) })
        await silencing
      }
      return refused
    }
  }

  #remember(patch: Partial<AudioDeviceChoice>): void {
    this.#deviceChoice = { ...this.#deviceChoice, ...patch }
    this.#saveChoice(this.#deviceChoice)
  }

  /**
   * Muting stops the microphone's capture at once, then shows it muted once that is confirmed
   * (`muting` meanwhile); LiveKit's own disable follows, and is not waited on for the snapshot.
   */
  async setMuted(muted: boolean): Promise<void> {
    const current = this.#snapshot
    const session = this.#session
    if (session === null || session.closed) return
    if (!muted && current.listenOnly) return
    // Unmuting again turns on a microphone that died under the member (its capture ended).
    if (this.#muteRequested === muted && (muted || !this.#microphoneDead(session))) return
    this.#chosenMuted = muted
    this.#generation++
    // Speaking again means hearing again, as in every call application.
    if (!muted && this.#deafenRequested) {
      this.#silence(session, false)
    }
    const live = this.#live()
    const silencing = live && muted ? this.#turnOff(session) : undefined
    this.#set({
      muted,
      deafened: muted ? this.#deafenRequested : false,
      ...(current.problem !== undefined && MICROPHONE_OFF.has(current.problem)
        ? { problem: undefined }
        : {}),
    })
    try {
      void this.#sounds.play(muted ? 'voice_mute_on' : 'voice_mute_off')
    } catch {
      // Sound cues never block or fail a call.
    }
    if (!live) return
    if (muted) await Promise.all([silencing, this.#disable(session)])
    else await this.#turnOn(session)
  }

  setMicMuted = (muted: boolean): Promise<void> => this.setMuted(muted)

  /** Deafening silences the microphone too, on its own path, whatever the snapshot says. */
  async setDeafened(deafened: boolean): Promise<void> {
    const current = this.#snapshot
    const session = this.#session
    if (session === null || session.closed || this.#deafenRequested === deafened) return
    this.#generation++
    this.#silence(session, deafened)
    const live = this.#live()
    if (deafened) {
      this.#mutedBeforeDeafen = this.#muteRequested
      const silencing = live ? this.#turnOff(session) : undefined
      this.#set({ deafened: true, muted: true })
      try {
        void this.#sounds.play('voice_deafen_on')
      } catch {
        // Sound cues never block or fail a call.
      }
      if (live) await Promise.all([silencing, this.#disable(session)])
      return
    }
    const muted = this.#mutedBeforeDeafen || current.listenOnly
    this.#set({ deafened: false, muted })
    try {
      void this.#sounds.play('voice_deafen_off')
    } catch {
      // Sound cues never block or fail a call.
    }
    if (live && !muted) await this.#turnOn(session)
  }

  /**
   * What carries over from one room to the next: the member's own mute and deafen, never a mute
   * imposed on them. Idle (after `leave`, or before any call) has none, so a fresh call starts
   * unmuted.
   */
  #choices(): Pick<CallSnapshot, 'muted' | 'deafened'> {
    const deafened = this.#snapshot.status !== 'idle' && this.#deafenRequested
    return { muted: this.#chosenMuted || deafened, deafened }
  }

  /**
   * A new call's state: nothing of the previous one, its problem included, carries over, except
   * what the patch carries (the member's choices, from `#choices`).
   */
  #reset(patch: Partial<CallSnapshot>): void {
    this.#muteRequested = patch.muted ?? false
    this.#deafenRequested = patch.deafened ?? false
    this.#snapshot = this.#derive({ ...IDLE, ...patch })
    for (const listener of this.#listeners) listener()
  }

  /**
   * A patch's `muted` and `deafened` are what the member asks; the snapshot says what is
   * confirmed.
   */
  #set(patch: { [K in keyof CallSnapshot]?: CallSnapshot[K] | undefined }): void {
    if (patch.muted !== undefined) this.#muteRequested = patch.muted
    if (patch.deafened !== undefined) this.#deafenRequested = patch.deafened
    const next = { ...this.#snapshot, ...patch }
    if (next.problem === undefined) delete next.problem
    this.#snapshot = this.#derive(next as CallSnapshot)
    for (const listener of this.#listeners) listener()
  }

  /**
   * `muted` (and `deafened`) once asked and no turn-off of the microphone is still unconfirmed in
   * the live call; `muting` (and `deafening`) in between, watched by a deadline.
   */
  #derive(next: CallSnapshot): CallSnapshot {
    const session = this.#session
    const live = next.status === 'connected' || next.status === 'reconnecting'
    const unconfirmed = live && session !== null && session.cutting > 0
    next.muted = this.#muteRequested && !unconfirmed
    next.muting = this.#muteRequested && unconfirmed
    next.deafened = this.#deafenRequested && !unconfirmed
    next.deafening = this.#deafenRequested && unconfirmed
    this.#watch(next.muting || next.deafening)
    return next
  }

  /** Ends the call when the microphone stays unconfirmed off for longer than the deadline. */
  #watch(muting: boolean): void {
    if (!muting) {
      if (this.#watchdog !== null) clearTimeout(this.#watchdog)
      this.#watchdog = null
      return
    }
    if (this.#watchdog !== null) return
    const session = this.#session
    this.#watchdog = setTimeout(() => {
      this.#watchdog = null
      if (!this.#snapshot.muting && !this.#snapshot.deafening) return
      if (session !== null && this.#session === session) void this.#endStuck(session)
      else this.#set({})
    }, this.#deadline)
  }

  #live(): boolean {
    const { status } = this.#snapshot
    return status === 'connected' || status === 'reconnecting'
  }

  #open(): Session {
    this.#room ??= this.#createRoom()
    const room = this.#room
    const container = document.createElement('div')
    container.hidden = true
    container.dataset['espaceAudio'] = ''
    this.#mount().append(container)
    const session: Session = {
      room,
      container,
      elements: new Map(),
      detach: [],
      closed: false,
      retirement: null,
      cutting: 0,
      // From the join's click: a meter's audio context made later would start suspended.
      meter: this.#meter(),
      videos: new Map(),
      videoWanted: { camera: false, screen: false },
      videoGeneration: { camera: 0, screen: 0 },
    }
    const on = <E extends keyof RoomEventCallbacks>(event: E, handler: RoomEventCallbacks[E]) => {
      room.on(event, handler)
      session.detach.push(() => room.off(event, handler))
    }
    const mine = () => this.#session === session && !session.closed
    // The member's output, for this call's sound from its first participant on. One that is gone,
    // or a browser that cannot choose, plays on the system's output.
    const { output } = this.#deviceChoice
    if (output !== null) void room.switchActiveDevice('audiooutput', output).catch(() => undefined)

    on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (!mine()) return
      if (track.kind === Track.Kind.Video) {
        const source = videoSourceOf(publication.source)
        const identity: unknown = participant?.identity
        const userId = typeof identity === 'string' ? matrixUserOf(identity) : null
        if (source === null || userId === null) return
        this.#addVideo(session, publication.trackSid, {
          track,
          userId,
          source,
          local: false,
          muted: publication.isMuted,
          elements: new Set(),
        })
        return
      }
      if (track.kind !== Track.Kind.Audio) return
      this.#attach(session, track, publication)
    })
    on(RoomEvent.TrackUnsubscribed, (track, publication) => {
      if (session.videos.has(publication.trackSid)) {
        this.#removeVideo(session, publication.trackSid)
        return
      }
      const element = session.elements.get(track)
      session.elements.delete(track)
      track.detach()
      element?.remove()
    })
    const muteChanged = (publication: TrackPublication) => {
      const entry = session.videos.get(publication.trackSid)
      if (!mine() || entry === undefined || entry.muted === publication.isMuted) return
      entry.muted = publication.isMuted
      this.#set({ videos: this.#feeds(session) })
    }
    on(RoomEvent.TrackMuted, muteChanged)
    on(RoomEvent.TrackUnmuted, muteChanged)
    on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      if (mine()) this.#set({ speakers: usersOf(speakers) })
    })
    const roster = (trigger: 'voice_peer_join' | 'voice_peer_leave') => () => {
      if (!mine()) return
      const participants = this.#participants(session)
      this.#set({ participants })
      if (this.#snapshot.status === 'connected') {
        const participantCount = participants.length
        try {
          this.#sounds.setParticipantCount(participantCount)
          void this.#sounds.play(trigger, { participantCount })
        } catch {
          // Sound cues never block or fail a call.
        }
      }
    }
    on(RoomEvent.ParticipantConnected, roster('voice_peer_join'))
    on(RoomEvent.ParticipantDisconnected, roster('voice_peer_leave'))
    // However the microphone got published (a previous room's enable landing on this connection,
    // a republish after a reconnect), it goes again unless the member wants it now.
    on(RoomEvent.LocalTrackPublished, (publication) => {
      if (!mine()) return
      if (publication.source === Track.Source.Microphone) {
        void this.#dropMicrophone()
        return
      }
      const source = videoSourceOf(publication.source)
      if (source !== null) this.#localVideoPublished(session, source, publication)
    })
    on(RoomEvent.LocalTrackUnpublished, (publication) => {
      if (!mine()) return
      const source = videoSourceOf(publication.source)
      if (source === null) return
      this.#removeVideo(session, publication.trackSid)
      // Stopped by the browser (« Arrêter le partage »), or the right to publish taken away.
      if (session.videoWanted[source] && this.#snapshot[source] === 'on') {
        session.videoWanted[source] = false
        this.#set({ [source]: 'off' })
      }
    })
    on(RoomEvent.ParticipantPermissionsChanged, (_previous, participant) => {
      if (!mine() || participant !== room.localParticipant) return
      const canPublish = participant.permissions?.canPublish !== false
      // The service decides; LiveKit unpublishes the microphone itself when the right goes, and
      // it is silenced here too before the call shows it muted. When the right comes back, the
      // member turns the microphone on, nobody else.
      if (canPublish) {
        this.#set({ listenOnly: false })
        return
      }
      this.#generation++
      const silencing = this.#turnOff(session)
      this.#set({ listenOnly: true, muted: true })
      void silencing
      // No right to publish: no camera nor screen either, their capture stopped here too.
      void this.#stopVideo(session, 'camera')
      void this.#stopVideo(session, 'screen')
    })
    const reconnecting = () => {
      if (mine() && this.#snapshot.status === 'connected') this.#set({ status: 'reconnecting' })
    }
    on(RoomEvent.Reconnecting, reconnecting)
    on(RoomEvent.SignalReconnecting, reconnecting)
    on(RoomEvent.Reconnected, () => {
      if (mine() && this.#snapshot.status === 'reconnecting') this.#set({ status: 'connected' })
    })
    on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (mine()) this.#set({ playbackBlocked: !room.canPlaybackAudio })
    })
    on(RoomEvent.Disconnected, (reason) => {
      if (!mine()) return
      const roomId = this.#snapshot.roomId
      // Before the connection was through, the join's own failure says what went wrong.
      if (this.#snapshot.status === 'connecting') return
      const intent = ++this.#intent
      this.#session = null
      void this.#close(session)
      if (this.#intent !== intent || this.#session !== null) return
      try {
        this.#sounds.stopAllLoops()
        this.#sounds.setActiveVoiceCall(false)
      } catch {
        // Sound cues never block or fail a call.
      }
      this.#reset({ status: 'ended', roomId, problem: endedBy(reason), ...this.#choices() })
    })
    return session
  }

  #meter(): MicMeter {
    try {
      return this.#createMeter()
    } catch {
      // A meter that cannot start never stops a call.
      return SILENT_METER
    }
  }

  #attach(session: Session, track: RemoteTrack, publication: RemoteTrackPublication): void {
    if (session.elements.has(track)) return
    const element = track.attach()
    element.muted = this.#deafenRequested
    session.container.append(element)
    session.elements.set(track, element)
    if (this.#deafenRequested) publication.setEnabled(false)
  }

  /**
   * Deafening stops what the member receives, then mutes what is already playing: LiveKit's
   * `startAudio` unmutes every attached element (iOS calls it again on each return to the page),
   * so a muted element alone would not hold.
   */
  #silence(session: Session, deafened: boolean): void {
    for (const participant of session.room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        publication.setEnabled(!deafened)
      }
    }
    for (const element of session.elements.values()) element.muted = deafened
  }

  #participants(session: Session): string[] {
    const { room } = session
    return usersOf([room.localParticipant, ...room.remoteParticipants.values()])
  }

  /**
   * Turns the microphone on, as the member's latest operation on it.
   *
   * It can fail (refused, missing): the member is then shown muted and told, and whatever it left
   * capturing is silenced first. The failure of an enable that a later operation replaced is
   * ignored: it says nothing about the microphone now.
   *
   * One Room serves every join, and LiveKit holds a pending enable until the next connection: an
   * enable made for a room the member has since left can publish into the next one. Once it
   * settles, the microphone goes again unless the member wants it there; so too when the member
   * muted while it ran (a permission prompt open, say).
   */
  async #turnOn(session: Session): Promise<void> {
    const generation = ++this.#generation
    const local = session.room.localParticipant
    let restarts = false
    try {
      // LiveKit's unmute restarts a muted track only: one whose capture ended without it being
      // muted (stopped behind LiveKit's back) would stay dead, so it is muted first.
      const track = local.getTrackPublication(Track.Source.Microphone)?.track
      if (track !== undefined && !track.isMuted && ended(track)) await track.mute()
      restarts = track?.isMuted === true
    } catch {
      // LiveKit's own enable is still tried.
    }
    if (generation !== this.#generation || this.#session !== session) return
    const wanted = this.#deviceChoice.input
    // While the default stands in for the one chosen, it goes on standing in (spec 11).
    const chosen = this.#snapshot.inputMissing === true ? null : wanted
    try {
      // LiveKit's unmute restarts a muted track on the device it last asked for and takes no
      // device: one chosen since (while the capture was starting, say) is set on it first. A
      // muted track only notes it, before the switch's first await, so the enable is not held.
      if (restarts) {
        void session.room
          .switchActiveDevice('audioinput', chosen ?? 'default', chosen !== null)
          .catch(() => undefined)
      }
      try {
        // The member's microphone, that one and no other (a first capture; an unmute restarts the
        // track on the device it already has).
        await local.setMicrophoneEnabled(true, {
          deviceId: chosen === null ? SYSTEM_INPUT : { exact: chosen },
          ...this.#processing(),
        })
      } catch (error) {
        if (chosen === null || !unplugged(error)) throw error
        if (generation !== this.#generation || this.#session !== session) return
        // Not plugged in: the system's default, and the choice kept for when it is back. A track
        // the call already has restarts on the device it was switched to, so it is switched too.
        this.#set({ inputMissing: true })
        await session.room.switchActiveDevice('audioinput', 'default', false)
        await local.setMicrophoneEnabled(true, { deviceId: SYSTEM_INPUT, ...this.#processing() })
      }
    } catch (error) {
      if (generation !== this.#generation || this.#session !== session) return
      const silencing = this.#turnOff(session)
      // No microphone at all: the panel does not say the default is used.
      this.#set({ muted: true, inputMissing: false, problem: microphoneProblemOf(error) })
      await silencing
      return
    }
    // Chosen while the capture was starting (a permission prompt open): LiveKit started the one
    // asked for before.
    const now = this.#deviceChoice.input
    if (now !== wanted && this.#session === session && !session.closed && !this.#muteRequested) {
      await this.#switchInput(session, now, this.#snapshot.inputMissing === true ? null : chosen)
    }
    if (this.#session !== session) await this.#dropMicrophone()
    else if (this.#live() && this.#muteRequested) await this.#turnOff(session)
  }

  /**
   * Silences the microphone at once, without waiting on LiveKit (see `#stopMicrophone`), and
   * ends the call when that cannot be confirmed. While it runs the snapshot says `muting`.
   *
   * The member can unmute while it runs, and an unpublish can take the very track they turned
   * back on: once it settles, the microphone is turned on again if they want it.
   */
  async #turnOff(session: Session, unpublish = false): Promise<void> {
    session.cutting++
    try {
      const stopping = this.#stopMicrophone(session.room, unpublish)
      this.#set({})
      const silenced = await stopping
      if (this.#session !== session || session.closed) return
      // Not silenced by stopping or unpublishing: the call ends, and stays unconfirmed until then.
      if (!silenced && this.#muteRequested) {
        await this.#endStuck(session)
        return
      }
    } finally {
      session.cutting--
    }
    if (this.#session !== session || session.closed) return
    this.#set({})
    if (this.#live() && !this.#muteRequested) await this.#turnOn(session)
  }

  /**
   * LiveKit's own disable, after ours has silenced the microphone: LiveKit also mutes a
   * publication still on its way. However it settles, the microphone is brought back to what the
   * member wants now: when it fails and they still want it off, ours runs again and unpublishes
   * too; when they unmuted meanwhile, it may have stopped what they turned back on, failing or
   * not.
   */
  async #disable(session: Session): Promise<void> {
    let failed = false
    try {
      await session.room.localParticipant.setMicrophoneEnabled(false)
    } catch {
      failed = true
    }
    if (this.#session !== session || session.closed) return
    if (this.#muteRequested) {
      if (failed) await this.#turnOff(session, true)
    } else if (this.#live()) {
      await this.#turnOn(session)
    }
  }

  /** In a live call, no microphone capturing: none published, or its capture ended. */
  #microphoneDead(session: Session): boolean {
    if (!this.#live()) return false
    try {
      const track = session.room.localParticipant.getTrackPublication(
        Track.Source.Microphone
      )?.track
      return track === undefined || ended(track)
    } catch {
      return false
    }
  }

  /**
   * Takes the microphone off the connection unless the member wants it there now: in a call that
   * is connected, and not muted.
   */
  async #dropMicrophone(): Promise<void> {
    const room = this.#room
    const session = this.#session
    if (room === null) return
    if (session !== null) {
      if (!this.#live() || this.#muteRequested) await this.#turnOff(session)
    } else {
      // Reserve before stop/unpublish can yield or reenter. A newer join may reserve a session,
      // but cannot acquire a grant while this cached-Room cleanup is unsettled.
      const retirement = this.#retire()
      try {
        if (!(await this.#stopMicrophone(room, true))) {
          // No admitted call to end: the connection itself goes, and every track with it.
          await room.disconnect().catch(() => undefined)
        }
        retirement.resolve()
      } catch (error) {
        retirement.reject(error)
        throw error
      }
    }
  }

  /**
   * Ends the call because its microphone could not be turned off. The snapshot keeps saying the
   * silence is unconfirmed until the capture has ended or the disconnect is through.
   */
  async #endStuck(session: Session): Promise<void> {
    if (session.closed) return
    const closing = this.#close(session)
    if (!this.#captureEnded(session.room)) await closing
    if (this.#session !== session) return
    this.#session = null
    try {
      this.#sounds.stopAllLoops()
      this.#sounds.setActiveVoiceCall(false)
    } catch {
      // Sound cues never block or fail a call.
    }
    this.#reset({
      status: 'ended',
      roomId: this.#snapshot.roomId,
      problem: 'microphone-stuck',
      ...this.#choices(),
    })
    await closing
  }

  /**
   * Turns the local microphone off without LiveKit's own disable. Its track is muted (so that a
   * reconnect, which republishes a track left published, does not restart it) and its capture
   * stopped, through LiveKit and then on the browser's track directly, synchronously, before
   * anything here is awaited. The track stays published, as LiveKit's own mute leaves it, so that
   * unmuting restarts it; it is unpublished when that is not confirmed, or when `unpublish` asks.
   *
   * True when the browser confirms it (see `#silent`): what LiveKit answers is not enough.
   */
  async #stopMicrophone(room: CallRoom, unpublish: boolean): Promise<boolean> {
    const local = room.localParticipant
    let track
    try {
      track = local.getTrackPublication(Track.Source.Microphone)?.track
    } catch {
      return false
    }
    if (track === undefined) return true
    let muting: Promise<unknown>
    try {
      muting = track.mute().catch(() => undefined)
    } catch {
      muting = Promise.resolve()
    }
    endCapture(track)
    await muting
    if (!unpublish && this.#silent(room)) return true
    try {
      await local.unpublishTrack(track, true)
    } catch {
      // What the browser says decides, below.
    }
    return this.#silent(room)
  }

  /**
   * The microphone sends nothing, by the browser's own account: no microphone published, or its
   * capture ended and the track muted (a reconnect restarts a published track not muted).
   */
  #silent(room: CallRoom): boolean {
    try {
      const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
      return track === undefined || (track.isMuted && ended(track))
    } catch {
      return false
    }
  }

  /** No microphone capturing: none published, or its capture ended. */
  #captureEnded(room: CallRoom): boolean {
    try {
      const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
      return track === undefined || ended(track)
    } catch {
      return false
    }
  }

  /** Records settlement without lending a directly owned error to unrelated observers. */
  #retire(): LocalRetirement {
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const result = new Promise<void>((fulfilled, failed) => {
      resolve = fulfilled
      reject = failed
    })
    const settled = () => {
      this.#retirements.delete(retirement)
    }
    const retirement: LocalRetirement = {
      result,
      settled: result.then(settled, settled),
      resolve,
      reject,
      started: false,
    }
    this.#retirements.add(retirement)
    return retirement
  }

  #prepareClose(session: Session): LocalRetirement {
    if (session.retirement === null) {
      session.closed = true
      session.retirement = this.#retire()
    }
    return session.retirement
  }

  #startClose(session: Session): void {
    const retirement = this.#prepareClose(session)
    if (retirement.started) return
    retirement.started = true
    void this.#teardown(session).then(retirement.resolve, retirement.reject)
  }

  async #close(session: Session): Promise<void> {
    const retirement = this.#prepareClose(session)
    this.#startClose(session)
    return retirement.result
  }

  async #teardown(session: Session): Promise<void> {
    for (const detach of session.detach.splice(0)) detach()
    for (const [track, element] of session.elements) {
      track.detach()
      element.remove()
    }
    session.elements.clear()
    // The camera's and the screen's capture end now, as the microphone's does below.
    for (const [key, entry] of session.videos) {
      this.#detachVideo(entry)
      if (entry.local) {
        session.videos.delete(key)
        try {
          endCapture(entry.track as LocalTrack)
        } catch {
          // The disconnect stops it too.
        }
      }
    }
    session.videos.clear()
    for (const source of ['camera', 'screen'] as const) {
      session.videoWanted[source] = false
      try {
        const track = session.room.localParticipant.getTrackPublication(SOURCE_OF[source])?.track
        if (track !== undefined) endCapture(track)
      } catch {
        // The disconnect stops it too.
      }
    }
    session.container.remove()
    try {
      session.meter.close()
    } catch {
      // Nothing else depends on it.
    }
    // The microphone's capture ends now, whatever the disconnect does or takes.
    try {
      const track = session.room.localParticipant.getTrackPublication(
        Track.Source.Microphone
      )?.track
      if (track !== undefined) endCapture(track)
    } catch {
      // The disconnect stops it too.
    }
    await session.room.disconnect().catch(() => undefined)
  }
}

export function createCallController(options: CallControllerOptions): CallController {
  return new CallController(options)
}
