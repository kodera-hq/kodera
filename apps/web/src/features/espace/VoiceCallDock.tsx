// The call under the workspace: what went wrong with it, the click a browser asks for before it
// plays sound, and the dock with the people in the room, mute, deafen and leave. It reads the
// call itself, so who is speaking draws the dock and nothing else of the view.

import { memo, useSyncExternalStore } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageKey } from '../../i18n'
import { AudioDock } from '../../ui/AudioDock/AudioDock'
import { Button } from '../../ui/Button/Button'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { profileMessages } from '../profile/profileMessages'
import { studioMessages } from '../workspace/studioMessages'
import type { CallProblem } from './audio/call'
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
          : t('console.workspace.audio.status-connected')
  const callProblem = callSnapshot.problem

  // The call controls stay outside the mobile chooser, so mute and leave never require reopening it.
  return (
    <>
      <div aria-live="polite" className="flex flex-col gap-2">
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
          <AudioDock
            key={callSnapshot.roomId}
            layout="studio"
            localParticipantId={viewerId}
            previewCamera={call.mode === 'local-preview'}
            participants={callSnapshot.participants.map((id) => ({
              id,
              name:
                snapshot.rooms.find((room) => room.roomId === callSnapshot.roomId)?.names?.[id] ??
                displayNameOf(id),
              roleLabel:
                profileCopy[store.getProfileRole?.(callSnapshot.roomId ?? '', id) ?? 'member'],
              speaking: dockStatus === 'connected' && callSnapshot.speakers.includes(id),
            }))}
            participantsLabel={studioMessages[locale].participants}
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
