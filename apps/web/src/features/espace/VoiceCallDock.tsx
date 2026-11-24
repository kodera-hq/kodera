import { confidentialMessages } from './confidentialMessages'
// The call surface across the workspace (`docs/specs/espace-video-and-screenshare.md`):
// - `stage`: bounded call stage in the main pane (`max-height: min(58vh, 540px)` when split with
//   chat, or full-pane toggle), showing decoded video feeds (`video/VideoStage.tsx`) or clean
//   participant cards in audio-only calls, with centered icon-only controls and live connection
//   quality bars.
// - `sidebar`: compact 56 px bottom-sidebar voice connection card when browsing text channels, DMs,
//   Docs, Files, or Calls, reclaiming 100% of the main pane width and height.
// - `floating`: mouse- and keyboard-draggable floating pill (`audio/FloatingCallPill.tsx`),
//   positioned strictly via CSSOM custom properties (`cssProperty`).

import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthLifetime, type AuthLifetime } from '../../auth/AuthProvider'
import {
  getMatrixRegistrationStamp,
  getMatrixSession,
  subscribeMatrixSession,
  type MatrixSession,
} from '../../auth/matrix'
import type { MessageKey } from '../../i18n'
import {
  AudioDock,
  type AudioDockCompanionChat,
  type SignalQuality,
} from '../../ui/AudioDock/AudioDock'
import { Button } from '../../ui/Button/Button'
import { cssProperty } from '../../ui/cssom'
import { cx } from '../../ui/cx'
import { Drawer } from '../../ui/Drawer/Drawer'
import { CloseIcon } from '../../ui/icons/Close'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { Skeleton } from '../../ui/Skeleton/Skeleton'
import { TOUCH_TARGET } from '../../ui/touchTarget'
import { permitsPlaintext } from '../confidential/room-boundary'
import { useMessagingOrganisation } from '../messaging/organisationContext'
import { PollCard } from '../polls/PollCard'
import { pollMessages } from '../polls/pollMessages'
import { pollStore } from '../polls/pollStore'
import { profileMessages } from '../profile/profileMessages'
import { usePassportServices } from '../profile/passportContext'
import { studioMessages } from '../workspace/studioMessages'
import type { Workspace } from '../workspace/workspace'
import type { CallProblem, CallQuality, VideoProblem } from './audio/call'
import { callPreferences } from './audio/callPreferences'
import { CallDockRegion, FloatingCallPill } from './audio/FloatingCallPill'
import { KoderaVoiceVisualizer } from './audio/KoderaVoiceVisualizer'
import { bindPushToTalk } from './audio/pushToTalk'
import { Rejoiner, REJOIN_ATTEMPTS, type RejoinSnapshot } from './audio/rejoin'
import type { StagePresentation } from './video/VideoStage'
import { audioPreviewMessages } from './audio/previewMessages'
import { AudioSettings, type AudioSettingsCall } from './AudioSettings'
import type { DraftChannel, DraftPatch } from './draftChannel'
import {
  EMPTY_DRAFT,
  useEspaceDraftMemory,
  type ChannelDraft,
  type DraftMemory,
} from './EspaceDraftProvider'
import {
  LIVE_CALL,
  NO_MESSAGES,
  noCallSnapshot,
  safeDisplayName,
  subscribeToNoCall,
  type AudioCallLike,
  type CallChannel,
  type EspaceStoreLike,
} from './liveViewModel'

export type CallPlacement = 'stage' | 'sidebar' | 'floating'

const CALL_PROBLEM: Record<CallProblem, MessageKey> = {
  forbidden: 'console.workspace.audio.problem-forbidden',
  unavailable: 'console.workspace.audio.problem-unavailable',
  malformed: 'console.workspace.audio.problem-unavailable',
  network: 'console.workspace.audio.problem-network',
  unauthenticated: 'console.workspace.audio.problem-unauthenticated',
  removed: 'console.workspace.audio.problem-removed',
  'room-closed': 'console.workspace.audio.problem-room-closed',
  elsewhere: 'console.workspace.audio.problem-elsewhere',
  'connection-lost': 'console.workspace.audio.problem-connection-lost',
  microphone: 'console.workspace.audio.problem-microphone',
  'microphone-denied': 'console.workspace.audio.problem-microphone-denied',
  'microphone-missing': 'console.workspace.audio.problem-microphone-missing',
  'microphone-in-use': 'console.workspace.audio.problem-microphone-in-use',
  'microphone-stuck': 'console.workspace.audio.problem-microphone-stuck',
  'media-encryption-unavailable': 'console.workspace.audio.problem-unavailable',
  'media-transforms-unavailable': 'console.workspace.audio.problem-unavailable',
  'media-encryption-revoked': 'console.workspace.audio.problem-unavailable',
}

const VIDEO_PROBLEM: Record<VideoProblem, MessageKey> = {
  camera: 'console.workspace.audio.problem-camera',
  'camera-denied': 'console.workspace.audio.problem-camera-denied',
  'camera-missing': 'console.workspace.audio.problem-camera-missing',
  'camera-in-use': 'console.workspace.audio.problem-camera-in-use',
  screen: 'console.workspace.audio.problem-screen',
  'video-forbidden': 'console.workspace.audio.problem-video-forbidden',
}

const QUALITY_KEY: Record<CallQuality, MessageKey> = {
  excellent: 'console.workspace.audio.quality-excellent',
  good: 'console.workspace.audio.quality-good',
  poor: 'console.workspace.audio.quality-poor',
  lost: 'console.workspace.audio.quality-lost',
  unknown: 'console.workspace.audio.quality-unknown',
}

// Its own chunk: a call nobody shows video in never downloads it.
const VideoStage = lazy(() => import('./video/VideoStage'))
// Loaded only when the member opens the in-call companion chat pane/drawer.
const LazyCallCompanionChatDrawer = lazy(() => import('./CallCompanionChatDrawer'))
const LazySoundboardPopover = lazy(() =>
  import('../sounds/SoundboardPopover').then((module) => ({ default: module.SoundboardPopover }))
)
const LazyLiveCallCaptionsBar = lazy(() =>
  import('./ai/LiveCallCaptionsBar').then((module) => ({ default: module.LiveCallCaptionsBar }))
)

const COMPANION_COPY = {
  fr: {
    title: 'Discussion de l’appel',
    close: 'Fermer la discussion de l’appel',
    unreadLabel: (badge: string) => `Discussion de l’appel (${badge})`,
  },
  en: {
    title: 'Call chat',
    close: 'Close call chat',
    unreadLabel: (badge: string) => `Call chat (${badge})`,
  },
} as const

const NO_REJOIN: RejoinSnapshot = Object.freeze({
  phase: 'idle',
  attempt: 0,
  attempts: REJOIN_ATTEMPTS,
})
const subscribeToNoRejoin = () => () => undefined
const noRejoin = () => NO_REJOIN
const noAvatarVersion = () => 0

function canShareScreen(): boolean {
  return typeof globalThis.navigator?.mediaDevices?.getDisplayMedia === 'function'
}

/** A problem the member can act on by joining again. */
const RETRYABLE: ReadonlySet<CallProblem> = new Set([
  'unavailable',
  'malformed',
  'network',
  'connection-lost',
])

export interface CompanionDraftScope {
  readonly memory: DraftMemory | null
  readonly organisationId: string | null
  readonly store: EspaceStoreLike
  readonly viewerId: string
  readonly roomId: string | null
  readonly protectionUnavailable: boolean
}

interface CompanionDraftOwner {
  readonly memory: DraftMemory
  readonly lifetime: AuthLifetime
  readonly organisationId: string
  readonly store: EspaceStoreLike
  readonly viewerId: string
  readonly roomId: string
  readonly issuer: string
  readonly subject: string
  readonly session: MatrixSession
  readonly baseUrl: string
  readonly userId: string
  readonly deviceId: string
  readonly matrixStamp: object
  readonly coreStamp: object
  readonly generation: number
}

export class CompanionDraftController {
  private draft: ChannelDraft = EMPTY_DRAFT
  private generation = 0
  private scopeGeneration = 0
  private owner: CompanionDraftOwner | null = null
  private lifetime: AuthLifetime | null = null
  private scope: CompanionDraftScope | null
  private listeners = new Set<() => void>()

  constructor(initialScope: CompanionDraftScope | null = null) {
    this.scope = initialScope
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getGeneration = () => this.generation
  getScopeGeneration = () => this.scopeGeneration

  private publish() {
    for (const listener of [...this.listeners]) {
      if (this.listeners.has(listener)) listener()
    }
  }

  private scrub(retireScope: boolean) {
    const changed = this.draft !== EMPTY_DRAFT || retireScope
    this.draft = EMPTY_DRAFT
    this.owner = null
    if (retireScope) {
      this.generation += 1
      this.scopeGeneration += 1
    }
    if (changed) this.publish()
  }

  private isTerminal(owner: CompanionDraftOwner, scope: CompanionDraftScope): boolean {
    if (
      scope.memory === null ||
      scope.memory !== owner.memory ||
      this.lifetime === null ||
      this.lifetime !== owner.lifetime ||
      scope.organisationId === null ||
      scope.organisationId !== owner.organisationId ||
      scope.store !== owner.store ||
      scope.viewerId !== owner.viewerId ||
      scope.roomId === null ||
      scope.roomId !== owner.roomId
    ) {
      return true
    }
    const live = this.lifetime.getSnapshot()
    const identity = live.user?.identity
    const session = getMatrixSession()
    if (identity === undefined || session === undefined) return true
    return (
      live.status === 'unauthenticated' ||
      !this.lifetime.hasUsableCredential() ||
      live.generation !== owner.generation ||
      this.lifetime.getRetirementStamp() !== owner.coreStamp ||
      identity.issuer !== owner.issuer ||
      identity.subject !== owner.subject ||
      session !== owner.session ||
      getMatrixRegistrationStamp() !== owner.matrixStamp ||
      session.baseUrl !== owner.baseUrl ||
      session.userId !== owner.userId ||
      session.deviceId !== owner.deviceId
    )
  }

  private authorizedFor(expected: CompanionDraftScope): boolean {
    if (expected.roomId === null || expected.protectionUnavailable) return false
    if (expected.memory === null) return true
    if (this.lifetime === null || expected.organisationId === null) return false
    const session = getMatrixSession()
    if (session === undefined || session.userId !== expected.viewerId) return false
    if (
      !expected.memory.canPresent(
        session,
        { organisation_id: expected.organisationId } as Workspace,
        expected.store
      )
    ) {
      return false
    }
    return !(this.owner !== null && this.isTerminal(this.owner, expected))
  }

  private isCurrentAuthorizedScope(expected: CompanionDraftScope): boolean {
    const current = this.scope
    if (
      current === null ||
      current.roomId === null ||
      expected.roomId === null ||
      current.protectionUnavailable ||
      expected.protectionUnavailable ||
      current.store !== expected.store ||
      current.viewerId !== expected.viewerId ||
      current.roomId !== expected.roomId ||
      current.organisationId !== expected.organisationId ||
      current.memory !== expected.memory
    ) {
      return false
    }
    return this.authorizedFor(current)
  }

  private captureOwner(expected: CompanionDraftScope) {
    if (
      expected.roomId === null ||
      expected.memory === null ||
      this.lifetime === null ||
      expected.organisationId === null
    ) {
      return
    }
    const live = this.lifetime.getSnapshot()
    const identity = live.user?.identity
    const session = getMatrixSession()
    if (identity === undefined || session === undefined) return
    this.owner = {
      memory: expected.memory,
      lifetime: this.lifetime,
      organisationId: expected.organisationId,
      store: expected.store,
      viewerId: expected.viewerId,
      roomId: expected.roomId,
      issuer: identity.issuer,
      subject: identity.subject,
      session,
      baseUrl: session.baseUrl,
      userId: session.userId,
      deviceId: session.deviceId,
      matrixStamp: getMatrixRegistrationStamp(),
      coreStamp: this.lifetime.getRetirementStamp(),
      generation: live.generation,
    }
  }

  sync(next: CompanionDraftScope) {
    const previous = this.scope
    this.scope = next
    if (previous === null) {
      if (next.roomId === null || next.protectionUnavailable) {
        this.draft = EMPTY_DRAFT
        this.owner = null
      }
      return
    }
    const scopeRetired =
      next.roomId === null ||
      previous.roomId !== next.roomId ||
      previous.protectionUnavailable !== next.protectionUnavailable ||
      previous.store !== next.store ||
      previous.viewerId !== next.viewerId ||
      previous.organisationId !== next.organisationId ||
      previous.memory !== next.memory
    if (scopeRetired) {
      this.scrub(true)
      return
    }
    if (next.protectionUnavailable) {
      this.scrub(false)
      return
    }
    if (this.owner !== null && this.isTerminal(this.owner, next)) {
      this.scrub(true)
    }
  }

  connect(lifetime: AuthLifetime, memory: DraftMemory) {
    this.lifetime = lifetime
    const reconcile = () => {
      if (this.scope !== null && this.owner !== null && this.isTerminal(this.owner, this.scope)) {
        this.scrub(true)
        return
      }
      this.publish()
    }
    const offLifetime = lifetime.subscribe(reconcile)
    const offMatrix = subscribeMatrixSession(reconcile)
    const offMemory = memory.subscribe(reconcile)
    reconcile()
    return () => {
      offLifetime()
      offMatrix()
      offMemory()
      if (this.lifetime === lifetime) {
        this.lifetime = null
      }
    }
  }

  channelFor(expected: CompanionDraftScope): DraftChannel {
    const boundGeneration = this.scopeGeneration
    const isLive = () =>
      boundGeneration === this.scopeGeneration && this.isCurrentAuthorizedScope(expected)
    return {
      subscribe: this.subscribe,
      read: () => (isLive() ? this.draft : EMPTY_DRAFT),
      update: (patch: DraftPatch) => {
        if (!isLive()) {
          if (
            boundGeneration === this.scopeGeneration &&
            this.owner !== null &&
            this.scope !== null &&
            this.isTerminal(this.owner, this.scope)
          ) {
            this.scrub(true)
          }
          return
        }
        if (this.owner === null) this.captureOwner(expected)
        const change = typeof patch === 'function' ? patch(this.draft) : patch
        this.draft = { ...this.draft, ...change }
        this.publish()
      },
      command: (effect, patch) => {
        if (!isLive()) {
          if (
            boundGeneration === this.scopeGeneration &&
            this.owner !== null &&
            this.scope !== null &&
            this.isTerminal(this.owner, this.scope)
          ) {
            this.scrub(true)
          }
          return false
        }
        if (this.owner === null) this.captureOwner(expected)
        if (patch !== undefined) {
          this.draft = { ...this.draft, ...patch }
        }
        try {
          effect()
        } finally {
          if (patch !== undefined) this.publish()
        }
        return true
      },
    }
  }
}

function CompanionAuthLifetimeSync({
  controller,
  memory,
}: {
  readonly controller: CompanionDraftController
  readonly memory: DraftMemory
}) {
  const lifetime = useAuthLifetime()
  useLayoutEffect(() => controller.connect(lifetime, memory), [controller, lifetime, memory])
  return null
}

export interface VoiceCallDockProps {
  /** The view's call; none where the view has no way to make one. */
  call: AudioCallLike | null
  /** The audio room the member chose, as the sidebar labelled it. */
  channel: CallChannel | null
  /** Names the people in the room, and their roles. */
  store: EspaceStoreLike
  viewerId: string
  /** The call's device choices, when it can make them: « Réglages audio ». */
  deviceSettings: AudioSettingsCall | null
  /** The member's own microphone, drawn on these frame by frame (`useMicActivity`). */
  meterRef: RefObject<HTMLSpanElement | null>
  panelMeterRef: RefObject<HTMLSpanElement | null>
  /** Where the call is currently placed (`stage` by default when rendered standalone). */
  placement?: CallPlacement
  narrow?: boolean
  sidebarWidth?: number
  fullStage?: boolean
  onToggleFullStage?: () => void
  onOpenStage?: () => void
  onDetach?: () => void
  onRedock?: () => void
  className?: string
}

function VoiceCallDockView({
  call,
  channel,
  store,
  viewerId,
  deviceSettings,
  meterRef,
  panelMeterRef,
  placement: controlledPlacement,
  narrow = false,
  sidebarWidth,
  fullStage: controlledFullStage,
  onToggleFullStage,
  onOpenStage,
  onDetach,
  onRedock,
  className,
}: VoiceCallDockProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage === 'en' ? 'en' : 'fr'
  const profileCopy = profileMessages(i18n.resolvedLanguage)
  const callSnapshot = useSyncExternalStore(
    call?.subscribe ?? subscribeToNoCall,
    call?.getSnapshot ?? noCallSnapshot
  )
  // The people in the room are named, and given their role, from the store.
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const avatars = usePassportServices()?.avatars
  useSyncExternalStore(
    avatars?.subscribe ?? subscribeToNoRejoin,
    avatars?.getVersion ?? noAvatarVersion
  )
  const preferences = useSyncExternalStore(callPreferences.subscribe, callPreferences.getSnapshot)
  // A preview adapter makes no media: no video, no retry, no push-to-talk on it.
  const realCall = call !== null && call.mode !== 'local-preview' ? call : null
  // Watches the call only while read here (`Rejoiner.subscribe`): making it holds nothing.
  const rejoiner = useMemo(() => (realCall === null ? null : new Rejoiner(realCall)), [realCall])
  const rejoin = useSyncExternalStore(
    rejoiner?.subscribe ?? subscribeToNoRejoin,
    rejoiner?.getSnapshot ?? noRejoin
  )
  const [presentation, setPresentation] = useState<StagePresentation>('expanded')
  const [localPlacement, setLocalPlacement] = useState<CallPlacement>('stage')
  const [localFullStage, setLocalFullStage] = useState(false)

  const placement = controlledPlacement ?? localPlacement
  const fullStage = controlledFullStage ?? localFullStage

  const connectedNow = callSnapshot.status === 'connected'
  const pushToTalk = preferences.inputMode === 'push-to-talk'
  // Bound while the call is through: a reconnect lets go of the key, and binds it again after.
  useEffect(() => {
    if (realCall === null || !connectedNow || !pushToTalk) return
    return bindPushToTalk(realCall)
  }, [realCall, connectedNow, pushToTalk])

  // The dock says where the media connection stands, not the chat's sync.
  const callLive = LIVE_CALL.has(callSnapshot.status) && channel !== null
  const callOver = callSnapshot.status === 'ended' || callSnapshot.status === 'failed'
  const dockStatus =
    callSnapshot.status === 'reconnecting'
      ? 'reconnecting'
      : callSnapshot.status === 'connecting'
        ? 'connecting'
        : 'connected'
  const dockStatusLabel =
    dockStatus === 'reconnecting'
      ? t('console.workspace.audio.status-reconnecting')
      : dockStatus === 'connecting'
        ? t('console.workspace.audio.status-connecting')
        : callSnapshot.listenOnly
          ? t('console.workspace.audio.status-listen-only')
          : pushToTalk && placement === 'stage'
            ? `${t('console.workspace.audio.status-connected')} · ${t('console.workspace.audio.status-push-to-talk')}`
            : t('console.workspace.audio.status-connected')
  // While a lost connection is joined again, the banner says so in the problem's place.
  const rejoining = rejoin.phase !== 'idle'
  const callProblem = rejoining ? undefined : callSnapshot.problem
  const callRoom = snapshot.rooms.find((room) => room.roomId === callSnapshot.roomId)
  const unnamed = t('console.workspace.members.unnamed')
  const nameOf = (id: string) => safeDisplayName(callRoom?.names?.[id], id, unnamed)
  // Before the media connection is through, who is already in the room, as the sidebar shows it.
  const preJoin = callSnapshot.status === 'connecting'
  const people = preJoin
    ? (callRoom?.occupancy?.participants ?? []).filter((id) => id !== viewerId)
    : callSnapshot.participants
  const callParticipantIds = useMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const candidate of [viewerId, ...people]) {
      if (candidate !== '' && !seen.has(candidate)) {
        seen.add(candidate)
        list.push(candidate)
      }
    }
    return list
  }, [viewerId, people])
  const videos = callSnapshot.videos ?? []
  const attachVideo = realCall?.attachVideo
  const setCamera = realCall?.setCameraEnabled
  const setScreen = realCall?.setScreenShareEnabled
  const camera = callSnapshot.camera ?? 'off'
  const screen = callSnapshot.screen ?? 'off'
  const localQuality: SignalQuality = callSnapshot.connectionQuality ?? 'unknown'
  const qualityLabel = t(QUALITY_KEY[localQuality])

  const media =
    setCamera === undefined || attachVideo === undefined || callSnapshot.listenOnly || preJoin
      ? undefined
      : {
          camera: {
            on: camera === 'on',
            busy: camera === 'starting',
            label: t(
              camera === 'off'
                ? 'console.workspace.audio.action-camera-on'
                : 'console.workspace.audio.action-camera-off'
            ),
            onToggle: () => void setCamera(camera === 'off'),
          },
          ...(setScreen === undefined || !canShareScreen()
            ? {}
            : {
                screen: {
                  on: screen === 'on',
                  busy: screen === 'starting',
                  label: t(
                    screen === 'off'
                      ? 'console.workspace.audio.action-screen-on'
                      : 'console.workspace.audio.action-screen-off'
                  ),
                  onToggle: () => void setScreen(screen === 'off'),
                },
              }),
        }

  const detachButtonRef = useRef<HTMLButtonElement>(null)
  const redockButtonRef = useRef<HTMLButtonElement>(null)
  const chatButtonRef = useRef<HTMLButtonElement>(null)
  const pendingFocusRef = useRef<'detach' | 'redock' | null>(null)
  const [companionOpen, setCompanionOpen] = useState(false)
  const currentCallRoomId = callLive && channel !== null ? channel.roomId : null
  const effectiveCallInstanceId =
    (callSnapshot.status === 'connected' || callSnapshot.status === 'reconnecting') &&
    callSnapshot.callInstanceId !== undefined &&
    callSnapshot.callInstanceId.trim() !== ''
      ? callSnapshot.callInstanceId.trim()
      : undefined
  const [activeCompanionRoomId, setActiveCompanionRoomId] = useState<string | null>(
    currentCallRoomId
  )
  const [companionWatermark, setCompanionWatermark] = useState<{
    roomId: string | null
    openedOnce: boolean
    lastSeenEventKey: string | null
  }>({
    roomId: currentCallRoomId,
    openedOnce: false,
    lastSeenEventKey: null,
  })

  if (activeCompanionRoomId !== currentCallRoomId) {
    setActiveCompanionRoomId(currentCallRoomId)
    setCompanionOpen(false)
    setCompanionWatermark({
      roomId: currentCallRoomId,
      openedOnce: false,
      lastSeenEventKey: null,
    })
  }

  const simulation = store.simulation === true
  const companionBoundary =
    currentCallRoomId === null
      ? undefined
      : store.getRoomBoundary !== undefined
        ? store.getRoomBoundary(currentCallRoomId)
        : simulation
          ? 'ordinary'
          : undefined
  const companionProtectionUnavailable =
    companionBoundary === undefined || !permitsPlaintext(companionBoundary)

  const memory = useEspaceDraftMemory()
  const organisationId = useMessagingOrganisation()
  const companionDraftScope = useMemo<CompanionDraftScope>(
    () => ({
      memory,
      organisationId,
      store,
      viewerId,
      roomId: currentCallRoomId,
      protectionUnavailable: companionProtectionUnavailable,
    }),
    [memory, organisationId, store, viewerId, currentCallRoomId, companionProtectionUnavailable]
  )
  const [companionDraftController] = useState(
    () => new CompanionDraftController(companionDraftScope)
  )
  useLayoutEffect(() => {
    companionDraftController.sync(companionDraftScope)
  }, [companionDraftController, companionDraftScope])

  const companionScopeGeneration = useSyncExternalStore(
    companionDraftController.subscribe,
    companionDraftController.getScopeGeneration
  )
  const companionDraft = useMemo(() => {
    void companionScopeGeneration
    return companionDraftController.channelFor(companionDraftScope)
  }, [companionDraftController, companionDraftScope, companionScopeGeneration])
  const companionDraftGeneration = useSyncExternalStore(
    companionDraftController.subscribe,
    companionDraftController.getGeneration
  )

  const companionRoom =
    currentCallRoomId === null
      ? undefined
      : snapshot.rooms.find((room) => room.roomId === currentCallRoomId)
  const rawCompanionUnread =
    companionRoom === undefined ? 0 : Math.max(companionRoom.unread, companionRoom.mentions)
  const companionTimeline =
    currentCallRoomId === null || companionProtectionUnavailable
      ? NO_MESSAGES
      : store.getTimeline(currentCallRoomId)
  const latestCompanionKey = companionTimeline.at(-1)?.key ?? null

  if (
    companionOpen &&
    currentCallRoomId !== null &&
    companionWatermark.roomId === currentCallRoomId &&
    (!companionWatermark.openedOnce ||
      (latestCompanionKey !== null && companionWatermark.lastSeenEventKey !== latestCompanionKey))
  ) {
    setCompanionWatermark({
      roomId: currentCallRoomId,
      openedOnce: true,
      lastSeenEventKey: latestCompanionKey ?? companionWatermark.lastSeenEventKey,
    })
  }

  const countTimelineMessagesAfter = (afterKey: string | null): number => {
    if (afterKey === null) {
      let count = 0
      for (const msg of companionTimeline) {
        if (!msg.redacted && msg.sender !== viewerId) count += 1
      }
      return count
    }
    const seenIndex = companionTimeline.findIndex((msg) => msg.key === afterKey)
    if (seenIndex < 0) return rawCompanionUnread
    let count = 0
    for (let i = seenIndex + 1; i < companionTimeline.length; i += 1) {
      const msg = companionTimeline[i]
      if (msg !== undefined && !msg.redacted && msg.sender !== viewerId) count += 1
    }
    return count
  }

  const effectiveCompanionUnread =
    companionOpen || companionProtectionUnavailable || currentCallRoomId === null
      ? 0
      : !companionWatermark.openedOnce
        ? rawCompanionUnread
        : countTimelineMessagesAfter(companionWatermark.lastSeenEventKey)

  const companionCopy = COMPANION_COPY[locale]
  const pollCopy = pollMessages[locale]
  const pollVersion = useSyncExternalStore(pollStore.subscribe, pollStore.getVersion)
  const [pollOverlayExpanded, setPollOverlayExpanded] = useState(false)
  const isCallModerator = useCallback(
    (userId: string): boolean => {
      if (currentCallRoomId === null) return false
      const profileRole = store.getProfileRole?.(currentCallRoomId, userId)
      if (profileRole === 'admin' || profileRole === 'maintainer') {
        return true
      }
      if (store.getMemberRole?.(currentCallRoomId, userId) === 'admin') return true
      return userId === viewerId && store.canPin?.(currentCallRoomId) === true
    },
    [currentCallRoomId, store, viewerId]
  )
  const activeCallPolls = useMemo(() => {
    void pollVersion
    if (currentCallRoomId === null || companionProtectionUnavailable) return []
    return pollStore
      .derivePolls(currentCallRoomId, companionTimeline, viewerId, {
        sink: store,
        isModerator: isCallModerator,
      })
      .filter((item) => !item.closed)
  }, [
    currentCallRoomId,
    companionProtectionUnavailable,
    companionTimeline,
    viewerId,
    pollVersion,
    store,
    isCallModerator,
  ])
  const latestActivePoll =
    activeCallPolls.length > 0 ? activeCallPolls[activeCallPolls.length - 1] : undefined
  const companionBadgeText =
    effectiveCompanionUnread > 99 ? '99+' : String(effectiveCompanionUnread)
  const companionButtonLabel =
    !companionOpen && effectiveCompanionUnread > 0
      ? companionCopy.unreadLabel(companionBadgeText)
      : companionCopy.title

  const closeCompanionToTrigger = () => {
    setCompanionOpen(false)
    chatButtonRef.current?.focus()
  }

  const companionChat: AudioDockCompanionChat = {
    open: companionOpen,
    unread: effectiveCompanionUnread,
    label: companionButtonLabel,
    onToggle: () => {
      if (companionOpen) closeCompanionToTrigger()
      else setCompanionOpen(true)
    },
  }

  const handleDrawerEscapeKeyDown = (event: globalThis.KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      channel === null
    ) {
      return
    }
    const companionRoot = document.querySelector('[data-testid="call-companion-chat"]')
    if (companionRoot !== null && companionRoot.querySelector('[role="listbox"]') !== null) {
      event.preventDefault()
      return
    }
    const current = companionDraft.read()
    if (current.editing !== null && current.editing.roomId === channel.roomId) {
      event.preventDefault()
      companionDraft.update({ editing: null, text: '' })
      return
    }
    if (
      current.replyTo !== null &&
      current.replyTo.roomId === channel.roomId &&
      companionTimeline.some((candidate) => candidate.eventId === current.replyTo?.eventId)
    ) {
      event.preventDefault()
      companionDraft.update({ replyTo: null })
    }
  }

  const handleSplitPaneKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.key !== 'Escape' ||
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return
    }
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('[role="dialog"], [role="menu"], [role="listbox"]') !== null) return
    event.preventDefault()
    closeCompanionToTrigger()
  }

  const handleOpenStage = () => {
    pendingFocusRef.current = 'detach'
    setPresentation('expanded')
    if (onOpenStage !== undefined) onOpenStage()
    else setLocalPlacement('stage')
  }
  const handleDetach = () => {
    pendingFocusRef.current = 'redock'
    if (onDetach !== undefined) onDetach()
    else setLocalPlacement('floating')
  }
  const handleRedock = () => {
    pendingFocusRef.current = 'detach'
    if (onRedock !== undefined) onRedock()
    else setLocalPlacement('sidebar')
  }
  const handlePresentationChange = (next: StagePresentation) => {
    setPresentation(next)
    if (next === 'expanded' && placement === 'sidebar') {
      handleOpenStage()
    }
  }
  const handleToggleFullStage = () => {
    if (onToggleFullStage !== undefined) onToggleFullStage()
    else setLocalFullStage((value) => !value)
  }

  const isFloating = placement === 'floating'

  useEffect(() => {
    if (!callLive || call === null || channel === null) {
      pendingFocusRef.current = null
      return
    }
    const target = pendingFocusRef.current
    if (target === 'redock' && isFloating) {
      pendingFocusRef.current = null
      redockButtonRef.current?.focus()
    } else if (target === 'detach' && !isFloating) {
      pendingFocusRef.current = null
      detachButtonRef.current?.focus()
    }
  }, [call, callLive, channel, isFloating, placement])

  const hasAlerts =
    callSnapshot.status === 'reconnecting' ||
    (rejoining && rejoiner !== null) ||
    (callLive && callSnapshot.videoProblem !== undefined) ||
    callProblem !== undefined ||
    (callLive && call !== null && callSnapshot.playbackBlocked)

  if (!hasAlerts && !(callLive && call !== null)) {
    return null
  }

  const alerts = hasAlerts ? (
    <div aria-live="polite" className="flex flex-col gap-2 py-1">
      {callSnapshot.status === 'reconnecting' ? (
        <div className="px-2">
          <InlineAlert kind="info" inLiveRegion>
            {t('console.workspace.audio.label-resuming')}
          </InlineAlert>
        </div>
      ) : null}
      {rejoining && rejoiner !== null ? (
        <div className="flex flex-col gap-2 px-2" data-rejoin={rejoin.phase}>
          <InlineAlert kind="warning" inLiveRegion>
            {rejoin.phase === 'gave-up'
              ? t('console.workspace.audio.label-rejoin-gave-up')
              : rejoin.phase === 'offline'
                ? t('console.workspace.audio.label-rejoin-offline')
                : rejoin.phase === 'trying'
                  ? t('console.workspace.audio.label-rejoin-trying', {
                      attempt: rejoin.attempt,
                      attempts: rejoin.attempts,
                    })
                  : t('console.workspace.audio.label-rejoin-waiting', {
                      attempt: rejoin.attempt,
                      attempts: rejoin.attempts,
                    })}
          </InlineAlert>
          <div className="flex flex-wrap gap-2">
            {rejoin.phase === 'trying' ? null : (
              <Button variant="secondary" size="sm" onClick={rejoiner.retryNow}>
                {t(
                  rejoin.phase === 'gave-up'
                    ? 'console.workspace.audio.action-retry'
                    : 'console.workspace.audio.action-rejoin-now'
                )}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                rejoiner.cancel()
                void call?.leave()
              }}
            >
              {t('console.workspace.audio.action-dismiss')}
            </Button>
          </div>
        </div>
      ) : null}
      {callLive && callSnapshot.videoProblem !== undefined ? (
        <div className="px-2">
          <InlineAlert kind="warning" inLiveRegion>
            {t(VIDEO_PROBLEM[callSnapshot.videoProblem])}
          </InlineAlert>
        </div>
      ) : null}
      {callProblem === undefined ? null : (
        <div className="flex flex-col gap-2 px-2">
          <InlineAlert kind="warning" inLiveRegion>
            {callProblem === 'media-encryption-unavailable' ||
            callProblem === 'media-transforms-unavailable' ||
            callProblem === 'media-encryption-revoked'
              ? confidentialMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr'][callProblem]
              : t(CALL_PROBLEM[callProblem])}
          </InlineAlert>
          {callOver ? (
            <div className="flex flex-wrap gap-2">
              {RETRYABLE.has(callProblem) && channel !== null && call !== null ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void call.join(channel.roomId)}
                >
                  {t('console.workspace.audio.action-retry')}
                </Button>
              ) : null}
              <Button variant="secondary" size="sm" onClick={() => void call?.leave()}>
                {t('console.workspace.audio.action-dismiss')}
              </Button>
            </div>
          ) : null}
        </div>
      )}
      {callLive && call !== null && callSnapshot.playbackBlocked ? (
        <div className="flex flex-col gap-2 px-2">
          <InlineAlert kind="warning" inLiveRegion>
            {t('console.workspace.audio.label-playback-blocked')}
          </InlineAlert>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              // From the click itself: the browser lets the sound play from a gesture only.
              onClick={() => void call.startAudio()}
            >
              {t('console.workspace.audio.action-start-audio')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  ) : null

  const hasVideo = attachVideo !== undefined && videos.length > 0
  const dockLayout = placement === 'sidebar' ? (narrow ? 'banner' : 'compact') : 'studio'
  const useCompanionDrawer = narrow || placement === 'sidebar' || placement === 'floating'
  const showStageSplitPane =
    companionOpen && !useCompanionDrawer && callLive && call !== null && channel !== null

  const widthRef = cssProperty(
    'width',
    !narrow && placement === 'sidebar' && sidebarWidth !== undefined
      ? `${sidebarWidth}px`
      : undefined
  )

  return (
    <div
      ref={widthRef}
      data-call-placement={placement}
      className={cx(
        placement === 'stage'
          ? cx(
              'flex min-w-0 border-b border-c-border-soft bg-c-inverse',
              showStageSplitPane ? 'flex-row' : 'flex-col',
              fullStage
                ? cx('min-h-0 flex-1', showStageSplitPane ? 'overflow-hidden' : 'overflow-y-auto')
                : cx(
                    'call-stage-bounded shrink-0',
                    showStageSplitPane ? 'overflow-hidden' : 'overflow-y-auto'
                  )
            )
          : placement === 'sidebar'
            ? cx(
                'flex shrink-0 flex-col',
                narrow ? 'px-2 pt-2' : 'border-t border-r border-c-border-soft bg-c-inverse'
              )
            : 'contents',
        className
      )}
    >
      {memory === null ? null : (
        <CompanionAuthLifetimeSync controller={companionDraftController} memory={memory} />
      )}
      <div
        className={
          placement === 'stage'
            ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto'
            : 'contents'
        }
      >
        {alerts}
        {callLive && call !== null && channel !== null ? (
          <CallDockRegion
            key={callSnapshot.roomId}
            label={t('console.workspace.audio.label-dock')}
            floating={isFloating}
            dockLayout={dockLayout}
            onRedock={handleRedock}
            dockedClassName={cx(
              'focus-ground-inverse inverse-edge flex w-full flex-col bg-c-inverse text-c-on-inverse',
              dockLayout === 'compact' ? 'h-[56px] justify-center' : '',
              dockLayout === 'banner' ? 'rounded-lg' : ''
            )}
          >
            {call.mode === 'local-preview' && placement === 'stage' ? (
              <p role="status" className="px-3 pt-2 text-xs text-c-on-inverse-dim">
                {audioPreviewMessages[locale].notice}
              </p>
            ) : null}
            {hasVideo ? (
              <Suspense fallback={null}>
                <VideoStage
                  feeds={videos}
                  attach={attachVideo}
                  nameOf={nameOf}
                  speakers={dockStatus === 'connected' ? callSnapshot.speakers : []}
                  {...(callSnapshot.qualities === undefined
                    ? {}
                    : { qualities: callSnapshot.qualities })}
                  presentation={placement === 'sidebar' ? 'docked' : presentation}
                  onPresentationChange={handlePresentationChange}
                  compactPreview={isFloating}
                />
              </Suspense>
            ) : null}
            {placement === 'stage' && latestActivePoll !== undefined ? (
              <div
                data-testid="call-active-poll-banner"
                className="mx-3 mt-2 flex flex-col gap-2 rounded-lg border border-c-on-inverse-dim bg-c-inverse-2 p-2 text-c-on-inverse"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="inline-flex shrink-0 items-center rounded-full bg-c-action px-2 py-1 font-mono text-xs font-semibold text-c-on-inverse">
                      {pollCopy.callOverlayBadge(activeCallPolls.length)}
                    </span>
                    <span className="truncate text-sm font-semibold text-c-on-inverse">
                      {latestActivePoll.question}
                    </span>
                  </div>
                  <button
                    type="button"
                    data-testid="call-poll-banner-toggle"
                    aria-expanded={pollOverlayExpanded}
                    onClick={() => setPollOverlayExpanded((prev) => !prev)}
                    className="focus-offset rounded-md bg-c-inverse px-2 py-1 text-xs font-semibold text-c-on-inverse hover:underline focus-visible:ring focus-visible:ring-offset-2 focus-visible:outline-hidden"
                  >
                    {pollOverlayExpanded ? pollCopy.callOverlayHide : pollCopy.callOverlayShow}
                  </button>
                </div>
                {pollOverlayExpanded ? (
                  <PollCard
                    poll={latestActivePoll}
                    currentUserId={viewerId}
                    canClose={latestActivePoll.createdBy === viewerId || isCallModerator(viewerId)}
                    locale={locale}
                    onVote={(_pollId, optionId) => {
                      pollStore.vote(latestActivePoll, optionId, viewerId, store)
                    }}
                    onClosePoll={() => {
                      pollStore.close(
                        latestActivePoll,
                        store,
                        latestActivePoll.createdBy === viewerId || isCallModerator(viewerId)
                      )
                    }}
                  />
                ) : null}
              </div>
            ) : null}
            {call.mode !== 'local-preview' ? (
              <Suspense fallback={null}>
                <LazyLiveCallCaptionsBar
                  organisationId={organisationId}
                  channelId={channel.channelId}
                  callInstanceId={effectiveCallInstanceId}
                  participants={callParticipantIds}
                  permitsPlaintext={!companionProtectionUnavailable}
                  visible={placement === 'stage'}
                  localSpeakerLabel={nameOf(viewerId)}
                  resolveSpeakerName={(userId) => nameOf(userId)}
                  publishCaptionPacket={call.publishCallCaptionPacket}
                  subscribeCaptionPackets={call.subscribeCallCaptionPackets}
                  localAudioTrack={
                    callSnapshot.muted || callSnapshot.deafened || callSnapshot.listenOnly
                      ? null
                      : (call.localMicTrack?.() ?? null)
                  }
                />
              </Suspense>
            ) : null}
            {isFloating ? (
              <FloatingCallPill
                asSection={false}
                redockButtonRef={redockButtonRef}
                label={t('console.workspace.audio.label-dock')}
                room={channel.roomName}
                {...(channel.categoryName === undefined ? {} : { category: channel.categoryName })}
                status={dockStatus}
                statusLabel={
                  call.mode === 'local-preview'
                    ? audioPreviewMessages[locale].status
                    : dockStatusLabel
                }
                quality={localQuality}
                qualityLabel={qualityLabel}
                muted={callSnapshot.muted}
                deafened={callSnapshot.deafened}
                companionChat={companionChat}
                companionChatButtonRef={chatButtonRef}
                activePollCount={activeCallPolls.length}
                {...(latestActivePoll === undefined
                  ? {}
                  : { activePollLabel: pollCopy.pillBadgeLabel(latestActivePoll.question) })}
                {...(media === undefined ? {} : { media })}
                {...(call.micLevel === undefined && call.localMicTrack === undefined
                  ? {}
                  : {
                      ...(call.micLevel === undefined ? {} : { meterRef }),
                      visualizer: (
                        <KoderaVoiceVisualizer
                          trackSource={call.localMicTrack}
                          levelSampler={call.micLevel}
                          muted={
                            callSnapshot.muted || callSnapshot.deafened || callSnapshot.listenOnly
                          }
                          connected={callSnapshot.status === 'connected'}
                          surface="inverse"
                          compact
                        />
                      ),
                    })}
                onToggleMute={() => void call.setMuted(!callSnapshot.muted)}
                onToggleDeafen={() => void call.setDeafened(!callSnapshot.deafened)}
                onOpenCall={handleOpenStage}
                onRedock={handleRedock}
                onLeave={() => void call.leave()}
                labels={{
                  mute: t('console.workspace.audio.action-mute'),
                  deafen: t('console.workspace.audio.action-deafen'),
                  leave: t('console.workspace.audio.action-leave'),
                  openCall: t('console.workspace.audio.action-open-stage'),
                  redock: t('console.workspace.audio.action-redock'),
                }}
              />
            ) : (
              <AudioDock
                asSection={false}
                layout={dockLayout}
                detachButtonRef={detachButtonRef}
                hideParticipants={hasVideo && presentation === 'expanded' && placement === 'stage'}
                localParticipantId={viewerId}
                previewCamera={call.mode === 'local-preview'}
                quality={localQuality}
                qualityLabel={qualityLabel}
                participants={people.map((id) => {
                  const mxc =
                    id === viewerId ? store.getOwnProfile?.()?.avatarUrl : callRoom?.avatars?.[id]
                  const avatarSrc = mxc === undefined ? undefined : avatars?.get(mxc)
                  return {
                    id,
                    name: nameOf(id),
                    roleLabel:
                      profileCopy[
                        store.getProfileRole?.(callSnapshot.roomId ?? '', id) ?? 'member'
                      ],
                    speaking: dockStatus === 'connected' && callSnapshot.speakers.includes(id),
                    ...(avatarSrc === undefined
                      ? {}
                      : {
                          avatarSrc,
                          onAvatarError: () => {
                            if (mxc !== undefined) avatars?.forget(mxc)
                          },
                        }),
                    ...(callSnapshot.qualities?.[id] === undefined
                      ? {}
                      : { quality: callSnapshot.qualities[id] }),
                  }
                })}
                participantsLabel={
                  preJoin
                    ? t('console.workspace.audio.label-already-here')
                    : studioMessages[locale].participants
                }
                {...(media === undefined ? {} : { media })}
                companionChat={companionChat}
                companionChatButtonRef={chatButtonRef}
                cameraUnavailable={studioMessages[locale].cameraGap}
                label={t('console.workspace.audio.label-dock')}
                room={channel.roomName}
                {...(channel.categoryName === undefined ? {} : { category: channel.categoryName })}
                status={dockStatus}
                statusLabel={
                  call.mode === 'local-preview'
                    ? audioPreviewMessages[locale].status
                    : dockStatusLabel
                }
                muted={callSnapshot.muted}
                deafened={callSnapshot.deafened}
                {...(call.micLevel === undefined && call.localMicTrack === undefined
                  ? {}
                  : {
                      ...(call.micLevel === undefined ? {} : { meterRef }),
                      visualizer: (
                        <KoderaVoiceVisualizer
                          trackSource={call.localMicTrack}
                          levelSampler={call.micLevel}
                          muted={
                            callSnapshot.muted || callSnapshot.deafened || callSnapshot.listenOnly
                          }
                          connected={callSnapshot.status === 'connected'}
                          surface="inverse"
                          compact={dockLayout === 'compact'}
                        />
                      ),
                    })}
                {...(dockLayout === 'studio'
                  ? {
                      soundboard: (
                        <Suspense fallback={null}>
                          <LazySoundboardPopover
                            roomId={callSnapshot.roomId}
                            listenOnly={callSnapshot.listenOnly}
                            deafened={callSnapshot.deafened}
                          />
                        </Suspense>
                      ),
                    }
                  : {})}
                {...(deviceSettings === null || dockLayout === 'compact'
                  ? {}
                  : {
                      settings: (
                        <AudioSettings
                          call={deviceSettings}
                          inputMissing={callSnapshot.inputMissing === true}
                          meterRef={panelMeterRef}
                        />
                      ),
                    })}
                {...(placement === 'sidebar' ? { onOpenCall: handleOpenStage } : {})}
                onDetach={handleDetach}
                fullStage={fullStage}
                onToggleFullStage={handleToggleFullStage}
                onToggleMute={() => void call.setMuted(!callSnapshot.muted)}
                onToggleDeafen={() => void call.setDeafened(!callSnapshot.deafened)}
                onLeave={() => void call.leave()}
                labels={{
                  mute: t('console.workspace.audio.action-mute'),
                  deafen: t('console.workspace.audio.action-deafen'),
                  leave: t('console.workspace.audio.action-leave'),
                  openCall: t('console.workspace.audio.action-open-stage'),
                  detach: t('console.workspace.audio.action-detach'),
                  fullStage: t(
                    fullStage
                      ? 'console.workspace.audio.action-split-stage'
                      : 'console.workspace.audio.action-full-stage'
                  ),
                }}
              />
            )}
          </CallDockRegion>
        ) : null}
      </div>
      {showStageSplitPane && channel !== null ? (
        // Captures Escape inside the collapsible stage companion chat pane to close and restore focus.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
        <aside
          aria-label={companionCopy.title}
          data-testid="call-companion-split-pane"
          onKeyDown={handleSplitPaneKeyDown}
          className="flex min-h-0 w-[360px] max-w-full shrink-0 flex-col border-l border-c-border bg-c-surface p-3 text-c-ink motion-reduce:transition-none"
        >
          <div className="flex items-center justify-between gap-2 border-b border-c-border-soft pb-2">
            <div className="flex min-w-0 flex-col">
              <h3 className="truncate text-sm font-semibold text-c-ink">{companionCopy.title}</h3>
              <p className="truncate text-xs text-c-ink-3">🔊 {channel.roomName}</p>
            </div>
            <button
              type="button"
              aria-label={companionCopy.close}
              onClick={closeCompanionToTrigger}
              className={cx(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-c-ink-3 hover:bg-c-sunken hover:text-c-ink focus-visible:ring focus-visible:outline-hidden motion-reduce:transition-none',
                TOUCH_TARGET
              )}
            >
              <CloseIcon />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col pt-2">
            <Suspense
              fallback={
                <div className="flex flex-col gap-2 py-2">
                  <Skeleton shape="text" />
                  <Skeleton shape="block" />
                </div>
              }
            >
              <LazyCallCompanionChatDrawer
                store={store}
                channel={channel}
                viewerId={viewerId}
                open={companionOpen}
                narrow={narrow}
                draft={companionDraft}
                draftGeneration={companionDraftGeneration}
              />
            </Suspense>
          </div>
        </aside>
      ) : null}
      {useCompanionDrawer && callLive && call !== null && channel !== null ? (
        <Drawer
          open={companionOpen}
          onOpenChange={setCompanionOpen}
          onEscapeKeyDown={handleDrawerEscapeKeyDown}
          title={companionCopy.title}
          description={channel.roomName}
          closeLabel={companionCopy.close}
          side={narrow ? 'bottom' : 'right'}
          size="sm"
          returnFocusTo={chatButtonRef}
        >
          {companionOpen ? (
            <div className="flex h-full min-h-[320px] flex-col">
              <Suspense
                fallback={
                  <div className="flex flex-col gap-2 py-2">
                    <Skeleton shape="text" />
                    <Skeleton shape="block" />
                  </div>
                }
              >
                <LazyCallCompanionChatDrawer
                  store={store}
                  channel={channel}
                  viewerId={viewerId}
                  open={companionOpen}
                  narrow={narrow}
                  draft={companionDraft}
                  draftGeneration={companionDraftGeneration}
                />
              </Suspense>
            </div>
          ) : null}
        </Drawer>
      ) : null}
    </div>
  )
}

export const VoiceCallDock = memo(VoiceCallDockView)
