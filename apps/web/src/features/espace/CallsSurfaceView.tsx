// In-pane « Appels » overview (`docs/specs/espace-video-and-screenshare.md`): replaces the
// blocking modal scrim with live voice/video room cards, quick Join / Return-to-stage actions, and
// an opt-in pre-join audio and microphone check reusing existing device and Web Audio meter
// primitives. Opening this surface never activates the microphone until the member clicks test or
// joins a room.

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { ConnectionQualityBars } from '../../ui/AudioDock/AudioDock'
import { Avatar } from '../../ui/Avatar/Avatar'
import { Button } from '../../ui/Button/Button'
import { cssProperty, initialCssProperty } from '../../ui/cssom'
import { EmptyState } from '../../ui/EmptyState/EmptyState'
import { EspaceGlyph } from '../../ui/icons/EspaceGlyph'
import { StudioGlyph } from '../../ui/icons/StudioGlyph'
import { studioMessages } from '../workspace/studioMessages'
import {
  categoryLabel,
  channelLabel,
  type Workspace,
  type WorkspaceChannel,
} from '../workspace/workspace'
import { readDeviceChoice, saveDeviceChoice, playTestTone } from './audio/devices'
import { webAudioMeter, type MicMeter } from './audio/meter'
import { AudioSettings, type AudioSettingsCall } from './AudioSettings'
import {
  LIVE_CALL,
  noCallSnapshot,
  occupantsForRoom,
  roomForChannel,
  roomResolved,
  subscribeToNoCall,
  type AudioCallLike,
  type CallChannel,
  type EspaceStoreLike,
} from './liveViewModel'
import type { RoomSummary } from './matrix/store'

export interface CallsSurfaceViewProps {
  readonly workspace: Workspace
  readonly store: EspaceStoreLike
  readonly call: AudioCallLike | null
  readonly callChannel: CallChannel | null
  readonly deviceSettings: AudioSettingsCall | null
  readonly onJoinRoom: (
    channel: WorkspaceChannel,
    room: RoomSummary | undefined,
    categoryName: string | undefined
  ) => void
  readonly onOpenStage: () => void
}

export function CallsSurfaceView({
  workspace,
  store,
  call,
  callChannel,
  deviceSettings,
  onJoinRoom,
  onOpenStage,
}: CallsSurfaceViewProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage === 'en' ? 'en' : 'fr'
  const copy = studioMessages[locale]
  const headingId = useId()
  const roomsHeadingId = useId()
  const prejoinHeadingId = useId()

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const callSnapshot = useSyncExternalStore(
    call?.subscribe ?? subscribeToNoCall,
    call?.getSnapshot ?? noCallSnapshot
  )
  const callLive = LIVE_CALL.has(callSnapshot.status) && callChannel !== null

  const fallbackSettings = useMemo<AudioSettingsCall>(() => {
    if (deviceSettings !== null) return deviceSettings
    return {
      getDeviceChoice: readDeviceChoice,
      chooseInput: async (input) => {
        saveDeviceChoice({ ...readDeviceChoice(), input })
      },
      chooseOutput: async (output) => {
        saveDeviceChoice({ ...readDeviceChoice(), output })
      },
    }
  }, [deviceSettings])

  const dummyPanelMeterRef = useRef<HTMLSpanElement | null>(null)
  const prejoinMeterFillRef = useRef<HTMLSpanElement | null>(null)
  const initialMeterRef = useMemo(
    () => initialCssProperty<HTMLSpanElement>('transform', 'scaleX(0)', prejoinMeterFillRef),
    []
  )

  const [testingMic, setTestingMic] = useState(false)
  const [micPending, setMicPending] = useState(false)
  const [micError, setMicError] = useState(false)
  const mountedRef = useRef(true)
  const micRequestIdRef = useRef(0)
  const micPendingRef = useRef(false)
  const micCleanupRef = useRef<(() => void) | null>(null)

  const stopStreamTracks = (stream: MediaStream) => {
    for (const item of stream.getTracks()) {
      try {
        item.stop()
      } catch {
        // Best-effort track teardown.
      }
    }
  }

  const runMicCleanup = () => {
    const cleanup = micCleanupRef.current
    micCleanupRef.current = null
    cleanup?.()
  }

  const stopMicTest = () => {
    micRequestIdRef.current += 1
    micPendingRef.current = false
    runMicCleanup()
    if (mountedRef.current) {
      setMicPending(false)
      setTestingMic(false)
    }
    cssProperty('transform', 'scaleX(0)')(prejoinMeterFillRef.current)
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      micRequestIdRef.current += 1
      micPendingRef.current = false
      runMicCleanup()
    }
  }, [])

  const toggleMicTest = async () => {
    if (testingMic) {
      stopMicTest()
      return
    }
    if (micPendingRef.current) return
    runMicCleanup()
    setMicError(false)
    const getUserMedia = globalThis.navigator?.mediaDevices?.getUserMedia
    if (typeof getUserMedia !== 'function') {
      setMicError(true)
      return
    }
    const requestId = ++micRequestIdRef.current
    micPendingRef.current = true
    setMicPending(true)
    try {
      const chosenInput = fallbackSettings.getDeviceChoice().input
      const stream = await getUserMedia.call(globalThis.navigator.mediaDevices, {
        audio: chosenInput !== null ? { deviceId: { ideal: chosenInput } } : true,
      })
      if (!mountedRef.current || micRequestIdRef.current !== requestId) {
        stopStreamTracks(stream)
        return
      }
      const track = stream.getAudioTracks()[0]
      if (track === undefined) {
        stopStreamTracks(stream)
        micPendingRef.current = false
        setMicPending(false)
        setMicError(true)
        return
      }
      let meter: MicMeter | null = null
      try {
        meter = webAudioMeter()
      } catch {
        meter = null
      }
      if (!mountedRef.current || micRequestIdRef.current !== requestId) {
        try {
          meter?.close()
        } catch {
          // Closing an audio context never blocks cleanup.
        }
        stopStreamTracks(stream)
        return
      }
      runMicCleanup()
      let frame = 0
      let active = true
      const tick = () => {
        if (!active) return
        const level = meter ? Math.min(1, Math.max(0, meter.level(track))) : 0
        cssProperty('transform', `scaleX(${level.toFixed(3)})`)(prejoinMeterFillRef.current)
        frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
      micCleanupRef.current = () => {
        active = false
        cancelAnimationFrame(frame)
        try {
          meter?.close()
        } catch {
          // Closing an audio context never blocks cleanup.
        }
        stopStreamTracks(stream)
      }
      micPendingRef.current = false
      setMicPending(false)
      setTestingMic(true)
    } catch {
      if (!mountedRef.current || micRequestIdRef.current !== requestId) return
      micPendingRef.current = false
      setMicPending(false)
      setMicError(true)
      stopMicTest()
    }
  }

  const audioEntries = useMemo(() => {
    const list: { channel: WorkspaceChannel; categoryName: string | undefined }[] = []
    for (const category of workspace.categories) {
      const catName = categoryLabel(category, t)
      for (const channel of category.channels) {
        if (channel.kind === 'audio') list.push({ channel, categoryName: catName })
      }
    }
    for (const channel of workspace.uncategorised_channels) {
      if (channel.kind === 'audio') list.push({ channel, categoryName: undefined })
    }
    return list
  }, [workspace, t])

  const unnamed = t('console.workspace.members.unnamed')

  return (
    <section
      aria-labelledby={headingId}
      data-testid="espace-calls-canvas"
      className="flex min-h-0 flex-1 flex-col gap-6"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-lg font-semibold text-c-ink">
          {t('console.workspace.calls.title')}
        </h2>
        <p className="text-sm text-c-ink-3">{t('console.workspace.calls.subtitle')}</p>
      </div>

      {callLive && callChannel !== null && call !== null ? (
        <div
          data-testid="calls-active-banner"
          className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-c-border bg-c-inverse p-4 text-c-on-inverse"
        >
          <div className="flex min-w-0 items-center gap-3">
            <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full bg-c-ok-on-dark" />
            <div className="flex min-w-0 flex-col">
              <span className="text-xs font-semibold text-c-ok-on-dark">
                {t('console.workspace.calls.active-heading')}
              </span>
              <div className="flex items-center gap-2">
                <strong className="truncate text-md font-bold">{callChannel.roomName}</strong>
                <ConnectionQualityBars
                  quality={callSnapshot.connectionQuality ?? 'unknown'}
                  status={
                    callSnapshot.status === 'reconnecting'
                      ? 'reconnecting'
                      : callSnapshot.status === 'connecting'
                        ? 'connecting'
                        : 'connected'
                  }
                />
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" onClick={onOpenStage}>
              {t('console.workspace.calls.action-return-stage')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void call.leave()}>
              {t('console.workspace.audio.action-leave')}
            </Button>
          </div>
        </div>
      ) : null}

      <section aria-labelledby={roomsHeadingId} className="flex flex-col gap-3">
        <h3 id={roomsHeadingId} className="text-sm font-semibold text-c-ink">
          {t('console.workspace.calls.rooms-heading')}
        </h3>
        {audioEntries.length === 0 ? (
          <EmptyState title={copy.calls} body={copy.noCalls} />
        ) : (
          <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 narrow:grid-cols-1">
            {audioEntries.map(({ channel, categoryName }) => {
              const label = channelLabel(channel, t)
              const room = roomForChannel(channel, snapshot.channels, snapshot.rooms)
              const resolved = roomResolved(channel, snapshot.channels)
              const resolvedEntry = snapshot.channels.get(channel.id)
              const refused =
                room === undefined &&
                resolvedEntry?.state === 'resolved' &&
                store.getJoinState?.(resolvedEntry.roomId) === 'refused'
              const unavailable = !resolved
                ? t('console.workspace.channel.label-preparing')
                : channel.lifecycle === 'archived'
                  ? t('console.workspace.channel.label-archived')
                  : room === undefined && refused
                    ? t('console.workspace.audio.label-join-refused')
                    : room === undefined && snapshot.status === 'live'
                      ? t('console.workspace.audio.label-arriving')
                      : undefined
              const occupants = occupantsForRoom(room, unnamed)
              const inThisRoom =
                callLive && room !== undefined && callSnapshot.roomId === room.roomId

              return (
                <li
                  key={channel.id}
                  className="flex flex-col justify-between gap-4 rounded-xl border border-c-border bg-c-surface p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={inThisRoom ? 'text-c-ok' : 'text-c-ink-3'}
                      >
                        <StudioGlyph name="calls" />
                      </span>
                      <div className="flex min-w-0 flex-col">
                        <strong className="truncate text-md font-semibold text-c-ink">
                          {label}
                        </strong>
                        {categoryName === undefined ? null : (
                          <span className="truncate text-xs text-c-ink-3">{categoryName}</span>
                        )}
                      </div>
                    </div>
                    <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-c-muted px-2 font-mono text-xs font-medium text-c-ink-2 tabular-nums">
                      {occupants.length === 0
                        ? t('console.workspace.audio.label-empty')
                        : t('console.workspace.audio.count-people', { count: occupants.length })}
                    </span>
                  </div>

                  {occupants.length > 0 ? (
                    <ul className="m-0 flex list-none flex-wrap items-center gap-2 p-0">
                      {occupants.map((occupant) => (
                        <li
                          key={occupant.id}
                          className="flex items-center gap-1 rounded-full bg-c-muted px-2 py-1 text-xs text-c-ink-2"
                        >
                          <Avatar name={occupant.name} identity={occupant.id} size="xs" />
                          <span className="max-w-[140px] truncate">{occupant.name}</span>
                          {occupant.sharingScreen === true ? (
                            <EspaceGlyph name="screen" className="h-3 w-3 shrink-0 text-c-ink-3" />
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <div className="flex items-center justify-between gap-2">
                    {unavailable !== undefined ? (
                      <span className="text-xs text-c-ink-3">{unavailable}</span>
                    ) : (
                      <span />
                    )}
                    {inThisRoom ? (
                      <Button variant="primary" size="sm" onClick={onOpenStage}>
                        {t('console.workspace.calls.action-return-stage')}
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={unavailable !== undefined || call === null || room === undefined}
                        onClick={() => {
                          stopMicTest()
                          onJoinRoom(channel, room, categoryName)
                        }}
                      >
                        {t('console.workspace.audio.action-join-room', { room: label })}
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section
        aria-labelledby={prejoinHeadingId}
        className="flex flex-col gap-4 rounded-xl border border-c-border bg-c-surface p-4"
      >
        <div className="flex flex-col gap-1">
          <h3 id={prejoinHeadingId} className="text-sm font-semibold text-c-ink">
            {t('console.workspace.calls.prejoin-heading')}
          </h3>
          <p className="text-xs text-c-ink-3">{t('console.workspace.calls.prejoin-hint')}</p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm font-medium text-c-ink-2">
              {t('console.workspace.audio.label-input-level')}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={micPending}
              icon={<EspaceGlyph name={testingMic ? 'mic-off' : 'mic'} />}
              onClick={() => void toggleMicTest()}
            >
              {t(
                testingMic
                  ? 'console.workspace.calls.action-stop-mic-test'
                  : 'console.workspace.calls.action-test-mic'
              )}
            </Button>
          </div>
          <span
            aria-hidden="true"
            data-testid="calls-prejoin-mic-meter"
            className="block h-2 w-full overflow-hidden rounded-full bg-c-muted"
          >
            <span ref={initialMeterRef} className="block h-full w-full origin-left bg-c-ok" />
          </span>
          {micError ? (
            <p role="alert" className="text-xs text-c-bad-ink">
              {t('console.workspace.calls.problem-mic-test')}
            </p>
          ) : null}
        </div>

        <AudioSettings
          embedded
          call={fallbackSettings}
          inputMissing={callSnapshot.inputMissing === true}
          meterRef={dummyPanelMeterRef}
          playTone={playTestTone}
        />
      </section>
    </section>
  )
}
