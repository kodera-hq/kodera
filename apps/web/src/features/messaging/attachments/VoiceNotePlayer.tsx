// Credential-free voice-note decoding and CSP-safe Web Audio playback with lifecycle cleanup,
// seek and speed controls, quantized waveform bars, and opt-in server-side transcription.

import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { coreApi } from '../../../api/client'
import { Button } from '../../../ui/Button/Button'
import { cssProperty } from '../../../ui/cssom'
import { cx } from '../../../ui/cx'
import { formatBytes } from '../../../ui/formatBytes'
import { cleanText } from '../../../ui/safeText'
import { TOUCH_TARGET } from '../../../ui/touchTarget'
import type { AttachmentRef } from './attachmentRefs'
import { loadVoiceNoteBlob } from './audioPreview'
import { voiceNoteMessages } from './voiceNoteMessages'

export const PLAYBACK_SPEEDS = [1, 1.5, 2] as const
export type VoiceNoteSpeed = (typeof PLAYBACK_SPEEDS)[number]

const DEFAULT_WAVEFORM = [
  24, 42, 68, 52, 80, 60, 36, 74, 90, 58, 44, 66, 82, 48, 34, 62, 76, 54, 40, 64, 50, 38, 28, 20,
]

function formatDurationMs(durationMs: number | undefined): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) return null
  const totalSec = Math.max(1, Math.round(durationMs / 1000))
  const mins = Math.floor(totalSec / 60)
  const secs = totalSec % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function safeHttpsDownloadUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null
    return url.href
  } catch {
    return null
  }
}

export interface VoiceNotePlayerProps {
  readonly attachment: AttachmentRef
  readonly organisationId: string | null
}

export function VoiceNotePlayer({ attachment, organisationId }: VoiceNotePlayerProps) {
  return (
    <VoiceNotePlayerInner
      key={`${organisationId ?? 'none'}:${attachment.id}`}
      attachment={attachment}
      organisationId={organisationId}
    />
  )
}

function VoiceNotePlayerInner({ attachment, organisationId }: VoiceNotePlayerProps) {
  const { i18n } = useTranslation()
  const locale = i18n.resolvedLanguage === 'en' ? 'en' : 'fr'
  const copy = voiceNoteMessages[locale]
  const transcriptBodyId = useId()

  const contextRef = useRef<AudioContext | null>(null)
  const bufferRef = useRef<AudioBuffer | null>(null)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const offsetRef = useRef(0)
  const startedAtRef = useRef(0)
  const rateRef = useRef<VoiceNoteSpeed>(1)
  const abortRef = useRef<AbortController | null>(null)
  const transcribeAbortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  const [loadingAudio, setLoadingAudio] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [audioReady, setAudioReady] = useState(false)
  const [playbackRate, setPlaybackRate] = useState<VoiceNoteSpeed>(1)
  const [audioError, setAudioError] = useState(false)
  const [progressRatio, setProgressRatio] = useState(0)

  const [transcribing, setTranscribing] = useState(false)
  const [transcript, setTranscript] = useState<string | null>(null)
  const [transcriptExpanded, setTranscriptExpanded] = useState(true)
  const [transcribeNotice, setTranscribeNotice] = useState<string | null>(null)

  const position = () => {
    const elapsed =
      sourceRef.current !== null && contextRef.current !== null
        ? (contextRef.current.currentTime - startedAtRef.current) * rateRef.current
        : 0
    return Math.min(bufferRef.current?.duration ?? 0, offsetRef.current + elapsed)
  }

  const stopSource = () => {
    const source = sourceRef.current
    sourceRef.current = null
    if (source !== null) {
      source.onended = null
      source.stop()
      source.disconnect()
    }
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
      transcribeAbortRef.current?.abort()
      transcribeAbortRef.current = null
      stopSource()
      bufferRef.current = null
      const context = contextRef.current
      contextRef.current = null
      if (context !== null) void context.close().catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      const context = contextRef.current
      const buffer = bufferRef.current
      if (sourceRef.current !== null && context !== null && buffer !== null) {
        const elapsed = (context.currentTime - startedAtRef.current) * rateRef.current
        setProgressRatio(Math.min(1, (offsetRef.current + elapsed) / buffer.duration))
      }
    }, 100)
    return () => clearInterval(timer)
  }, [playing])

  const startSource = () => {
    const context = contextRef.current
    const buffer = bufferRef.current
    if (context === null || buffer === null || !mountedRef.current) return
    if (offsetRef.current >= buffer.duration) offsetRef.current = 0
    const source = context.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = rateRef.current
    source.connect(context.destination)
    source.onended = () => {
      if (sourceRef.current !== source) return
      source.disconnect()
      sourceRef.current = null
      offsetRef.current = 0
      if (mountedRef.current) {
        setPlaying(false)
        setProgressRatio(0)
      }
    }
    startedAtRef.current = context.currentTime
    try {
      source.start(0, offsetRef.current)
    } catch (error) {
      source.disconnect()
      throw error
    }
    sourceRef.current = source
    setPlaying(true)
  }

  const cyclePlaybackRate = () => {
    const idx = PLAYBACK_SPEEDS.indexOf(rateRef.current)
    const next = PLAYBACK_SPEEDS[(idx + 1) % PLAYBACK_SPEEDS.length] ?? 1
    offsetRef.current = position()
    startedAtRef.current = contextRef.current?.currentTime ?? 0
    rateRef.current = next
    setPlaybackRate(next)
    if (sourceRef.current !== null) sourceRef.current.playbackRate.value = next
  }

  const seek = (ratio: number) => {
    const buffer = bufferRef.current
    if (buffer === null) return
    const wasPlaying = sourceRef.current !== null
    stopSource()
    const nextRatio = Math.max(0, Math.min(1, ratio))
    if (nextRatio === 1) {
      offsetRef.current = 0
      setProgressRatio(0)
      setPlaying(false)
      return
    }
    offsetRef.current = nextRatio * buffer.duration
    setProgressRatio(nextRatio)
    if (wasPlaying) startSource()
  }

  const togglePlay = async () => {
    if (organisationId === null) return
    setAudioError(false)
    if (sourceRef.current !== null) {
      offsetRef.current = position()
      setProgressRatio(offsetRef.current / (bufferRef.current?.duration ?? 1))
      stopSource()
      setPlaying(false)
      return
    }

    abortRef.current?.abort()
    const abort = new AbortController()
    abortRef.current = abort
    setLoadingAudio(true)
    try {
      // Create/resume during the user gesture, before fetching or decoding the attachment.
      const context = contextRef.current ?? new AudioContext()
      contextRef.current = context
      await context.resume()
      if (abort.signal.aborted || !mountedRef.current) return
      if (bufferRef.current === null) {
        const { data } = await coreApi().GET(
          '/organisations/{organisation_id}/workspace/attachments/{attachment_id}',
          {
            params: { path: { organisation_id: organisationId, attachment_id: attachment.id } },
            signal: abort.signal,
          }
        )
        const href = safeHttpsDownloadUrl(data?.downloadUrl)
        if (href === null) throw new Error('voice-note-unavailable')
        const blob = await loadVoiceNoteBlob(href, attachment, abort.signal)
        if (abort.signal.aborted || !mountedRef.current) return
        const buffer = await context.decodeAudioData(await blob.arrayBuffer())
        if (abort.signal.aborted || !mountedRef.current) return
        bufferRef.current = buffer
        setAudioReady(true)
      }
      if (abort.signal.aborted || !mountedRef.current) return
      startSource()
    } catch {
      if (!abort.signal.aborted && mountedRef.current) {
        stopSource()
        setPlaying(false)
        setAudioError(true)
      }
    } finally {
      if (abortRef.current === abort && mountedRef.current) setLoadingAudio(false)
    }
  }

  const requestTranscription = async () => {
    if (organisationId === null || transcribing) return
    transcribeAbortRef.current?.abort()
    const abort = new AbortController()
    transcribeAbortRef.current = abort
    setTranscribing(true)
    setTranscribeNotice(null)
    try {
      const idempotencyKey =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `vn-${attachment.id}-${Date.now()}`
      const { data, response } = await coreApi().POST(
        '/organisations/{organisation_id}/workspace/attachments/{attachment_id}/actions/transcribe',
        {
          params: {
            path: { organisation_id: organisationId, attachment_id: attachment.id },
            header: { 'Idempotency-Key': idempotencyKey },
          },
          body: { language: locale },
          signal: abort.signal,
        }
      )
      if (abort.signal.aborted || !mountedRef.current) return
      if (response.status === 403) {
        setTranscribeNotice(copy.transcribeForbidden)
        return
      }
      if (!response.ok || !data) {
        setTranscribeNotice(copy.transcribeError)
        return
      }
      setTranscript(data.text)
      setTranscriptExpanded(true)
    } catch {
      if (!abort.signal.aborted && mountedRef.current) {
        setTranscribeNotice(copy.transcribeError)
      }
    } finally {
      if (transcribeAbortRef.current === abort && mountedRef.current) {
        setTranscribing(false)
      }
    }
  }

  const peaks =
    attachment.waveform !== undefined && attachment.waveform.length > 0
      ? attachment.waveform
      : DEFAULT_WAVEFORM
  const durationLabel = formatDurationMs(attachment.durationMs)
  const activeCount = Math.round(progressRatio * peaks.length)

  return (
    <div
      data-testid="voice-note-player"
      className="flex max-w-[384px] flex-col gap-2 rounded-lg border border-c-border bg-c-sunken p-3"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="voice-note-play-toggle"
          aria-label={playing ? copy.pause : copy.play}
          disabled={organisationId === null || loadingAudio}
          onClick={() => void togglePlay()}
          className={cx(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-c-action text-c-on-inverse',
            'disabled:cursor-not-allowed disabled:bg-c-disabled disabled:text-c-on-disabled',
            TOUCH_TARGET,
            'focus-visible:ring focus-visible:outline-hidden'
          )}
        >
          {playing ? (
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="h-4 w-4">
              <rect x="4" y="3.5" width="3" height="9" rx="0.75" fill="currentColor" />
              <rect x="9" y="3.5" width="3" height="9" rx="0.75" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="h-4 w-4">
              <path d="M5 3.5l7.5 4.5L5 12.5z" fill="currentColor" />
            </svg>
          )}
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div
            aria-hidden="true"
            data-testid="voice-note-waveform"
            className="flex h-6 items-center gap-1"
          >
            {peaks.map((peak, index) => (
              <span
                key={index}
                ref={cssProperty('height', `${Math.max(16, Math.min(100, peak))}%`)}
                className={cx(
                  'w-1 flex-1 rounded-full transition-colors',
                  index < activeCount ? 'bg-c-action' : 'bg-c-border'
                )}
              />
            ))}
          </div>
          <input
            type="range"
            data-testid="voice-note-seek"
            aria-label={copy.seek}
            min={0}
            max={1}
            step={0.01}
            value={progressRatio}
            disabled={!audioReady}
            onChange={(event) => seek(Number(event.currentTarget.value))}
            className="w-full accent-c-accent"
          />
          <div className="flex items-center justify-between gap-2 text-xs text-c-ink-3">
            <span className="truncate">{cleanText(attachment.filename, 80)}</span>
            <span className="shrink-0 font-mono tabular-nums">
              {loadingAudio
                ? copy.loading
                : (durationLabel ?? formatBytes(attachment.sizeBytes, i18n.resolvedLanguage))}
            </span>
          </div>
        </div>

        <button
          type="button"
          data-testid="voice-note-speed-toggle"
          aria-label={copy.speedLabel(playbackRate)}
          onClick={cyclePlaybackRate}
          className={cx(
            'shrink-0 rounded-md border border-c-border-soft bg-c-surface px-2 py-1 font-mono text-xs font-semibold text-c-ink-2 hover:bg-c-muted',
            TOUCH_TARGET,
            'focus-visible:ring focus-visible:outline-hidden'
          )}
        >
          {playbackRate}×
        </button>

        <Button
          size="sm"
          variant="secondary"
          data-testid="voice-note-transcribe"
          disabled={organisationId === null || transcribing}
          onClick={() => void requestTranscription()}
        >
          {transcribing ? copy.transcribing : copy.transcribe}
        </Button>
      </div>

      {transcript !== null ? (
        <div className="flex flex-col gap-1 rounded-md border border-c-border-soft bg-c-surface p-2 text-xs text-c-ink-2">
          <div className="flex items-center justify-between gap-2">
            <strong className="font-semibold text-c-ink">{copy.transcriptHeading}</strong>
            <button
              type="button"
              data-testid="voice-note-transcript-toggle"
              aria-expanded={transcriptExpanded}
              aria-controls={transcriptBodyId}
              onClick={() => setTranscriptExpanded((prev) => !prev)}
              className="rounded-sm px-1 text-xs font-medium text-c-accent-ink hover:underline focus-visible:ring focus-visible:outline-hidden"
            >
              {transcriptExpanded ? copy.transcriptHide : copy.transcriptShow}
            </button>
          </div>
          {transcriptExpanded ? (
            <div id={transcriptBodyId} data-testid="voice-note-transcript">
              <span>{transcript}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {transcribeNotice !== null ? (
        <p
          role="status"
          data-testid="voice-note-transcribe-refusal"
          className="text-xs text-c-bad-ink"
        >
          {transcribeNotice}
        </p>
      ) : null}

      {audioError ? (
        <p role="status" className="text-xs text-c-bad-ink">
          {copy.audioError}
        </p>
      ) : null}
    </div>
  )
}
