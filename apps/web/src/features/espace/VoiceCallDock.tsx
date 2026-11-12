// The call under the workspace: what went wrong with it, the click a browser asks for before it
// plays sound, and the dock with the people in the room, camera, screen, mute, deafen and leave.
// It reads the call itself, so who is speaking draws the dock and nothing else of the view.
//
// Above the dock, the call's video once anyone shows some (a lazy chunk, `video/VideoStage.tsx`),
// expanded or docked as a thumbnail that stays while the member moves between the workspace's
// channels; a banner while a lost connection is joined again (`audio/rejoin.ts`); push-to-talk
// while the member chose it (`audio/pushToTalk.ts`). While the call connects, the dock lists who
// is already in the room, from the room's occupancy, which everyone in the workspace sees
// (docs/specs/espace-video-and-screenshare.md).

import { lazy, memo, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageKey } from '../../i18n'
import { AudioDock } from '../../ui/AudioDock/AudioDock'
import { Button } from '../../ui/Button/Button'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { profileMessages } from '../profile/profileMessages'
import { studioMessages } from '../workspace/studioMessages'
import type { CallProblem, VideoProblem } from './audio/call'
import { callPreferences } from './audio/callPreferences'
import { bindPushToTalk } from './audio/pushToTalk'
import { Rejoiner, REJOIN_ATTEMPTS, type RejoinSnapshot } from './audio/rejoin'
import type { StagePresentation } from './video/VideoStage'
import { audioPreviewMessages } from './audio/previewMessages'
import { AudioSettings, type AudioSettingsCall } from './AudioSettings'
import {
  displayNameOf,
  LIVE_CALL,
  noCallSnapshot,
  subscribeToNoCall,
  type AudioCallLike,
  type CallChannel,
  type EspaceStoreLike,
} from './liveViewModel'

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
}

const VIDEO_PROBLEM: Record<VideoProblem, MessageKey> = {
  camera: 'console.workspace.audio.problem-camera',
  'camera-denied': 'console.workspace.audio.problem-camera-denied',
  'camera-missing': 'console.workspace.audio.problem-camera-missing',
  'camera-in-use': 'console.workspace.audio.problem-camera-in-use',
  screen: 'console.workspace.audio.problem-screen',
  'video-forbidden': 'console.workspace.audio.problem-video-forbidden',
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
}

function VoiceCallDockView({
  call,
  channel,
  store,
  viewerId,
  deviceSettings,
  meterRef,
  panelMeterRef,
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
          : pushToTalk
            ? `${t('console.workspace.audio.status-connected')} · ${t('console.workspace.audio.status-push-to-talk')}`
            : t('console.workspace.audio.status-connected')
  // While a lost connection is joined again, the banner says so in the problem's place.
  const rejoining = rejoin.phase !== 'idle'
  const callProblem = rejoining ? undefined : callSnapshot.problem
  const callRoom = snapshot.rooms.find((room) => room.roomId === callSnapshot.roomId)
  const nameOf = (id: string) => callRoom?.names?.[id] ?? displayNameOf(id)
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

  // The call controls stay outside the mobile chooser, so mute and leave never require reopening it.
  return (
    <>
      <div aria-live="polite" className="flex flex-col gap-2">
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
              {t(CALL_PROBLEM[callProblem])}
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

      {callLive && call !== null ? (
        <>
          {call.mode === 'local-preview' ? (
            <p role="status" className="px-3 py-2 text-xs text-c-ink-3">
              {audioPreviewMessages[locale].notice}
            </p>
          ) : null}
          {attachVideo !== undefined && videos.length > 0 ? (
            <Suspense fallback={null}>
              <VideoStage
                feeds={videos}
                attach={attachVideo}
                nameOf={nameOf}
                speakers={dockStatus === 'connected' ? callSnapshot.speakers : []}
                presentation={presentation}
                onPresentationChange={setPresentation}
              />
            </Suspense>
          ) : null}
          <AudioDock
            key={callSnapshot.roomId}
            layout="studio"
            localParticipantId={viewerId}
            previewCamera={call.mode === 'local-preview'}
            participants={people.map((id) => ({
              id,
              name: nameOf(id),
              roleLabel:
                profileCopy[store.getProfileRole?.(callSnapshot.roomId ?? '', id) ?? 'member'],
              speaking: dockStatus === 'connected' && callSnapshot.speakers.includes(id),
            }))}
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
              call.mode === 'local-preview' ? audioPreviewMessages[locale].status : dockStatusLabel
            }
            muted={callSnapshot.muted}
            deafened={callSnapshot.deafened}
            {...(call.micLevel === undefined ? {} : { meterRef })}
            {...(deviceSettings === null
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
            onToggleMute={() => void call.setMuted(!callSnapshot.muted)}
            onToggleDeafen={() => void call.setDeafened(!callSnapshot.deafened)}
            onLeave={() => void call.leave()}
            labels={{
              mute: t('console.workspace.audio.action-mute'),
              deafen: t('console.workspace.audio.action-deafen'),
              leave: t('console.workspace.audio.action-leave'),
            }}
          />
        </>
      ) : null}
    </>
  )
}

export const VoiceCallDock = memo(VoiceCallDockView)
