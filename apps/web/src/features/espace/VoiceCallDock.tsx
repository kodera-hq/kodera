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
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageKey } from '../../i18n'
import { AudioDock, type SignalQuality } from '../../ui/AudioDock/AudioDock'
import { Button } from '../../ui/Button/Button'
import { cssProperty } from '../../ui/cssom'
import { cx } from '../../ui/cx'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { profileMessages } from '../profile/profileMessages'
import { usePassportServices } from '../profile/passportContext'
import { studioMessages } from '../workspace/studioMessages'
import type { CallProblem, CallQuality, VideoProblem } from './audio/call'
import { callPreferences } from './audio/callPreferences'
import { CallDockRegion, FloatingCallPill } from './audio/FloatingCallPill'
import { bindPushToTalk } from './audio/pushToTalk'
import { Rejoiner, REJOIN_ATTEMPTS, type RejoinSnapshot } from './audio/rejoin'
import type { StagePresentation } from './video/VideoStage'
import { audioPreviewMessages } from './audio/previewMessages'
import { AudioSettings, type AudioSettingsCall } from './AudioSettings'
import {
  LIVE_CALL,
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
  useSyncExternalStore(avatars?.subscribe ?? subscribeToNoRejoin, avatars?.getVersion ?? noAvatarVersion)
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
  const pendingFocusRef = useRef<'detach' | 'redock' | null>(null)

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
              'flex min-w-0 flex-col border-b border-c-border-soft bg-c-inverse',
              fullStage
                ? 'min-h-0 flex-1 overflow-y-auto'
                : 'call-stage-bounded shrink-0 overflow-y-auto'
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
              {...(media === undefined ? {} : { media })}
              {...(call.micLevel === undefined ? {} : { meterRef })}
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
                    profileCopy[store.getProfileRole?.(callSnapshot.roomId ?? '', id) ?? 'member'],
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
              {...(call.micLevel === undefined ? {} : { meterRef })}
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
  )
}

export const VoiceCallDock = memo(VoiceCallDockView)
