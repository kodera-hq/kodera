// Async voice-note recorder for non-confidential channels.
// Disabled whenever !permitsPlaintext(boundary) so confidential rooms never capture or upload
// plaintext audio. Enforces a 90s auto-stop recording ceiling and renders pure icon-only buttons
// so composer toolbar density stays minimal.

import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cx } from '../../../ui/cx'
import { CloseIcon } from '../../../ui/icons/Close'
import { EspaceGlyph } from '../../../ui/icons/EspaceGlyph'
import { Tooltip } from '../../../ui/Tooltip/Tooltip'
import { TOUCH_TARGET } from '../../../ui/touchTarget'
import type { AttachmentQueue } from './attachmentQueue'
import type { VoiceNoteMimeType } from './attachmentRefs'
import { useMessagingOrganisation } from '../organisationContext'
import { voiceNoteMessages } from './voiceNoteMessages'

export const MAX_VOICE_NOTE_DURATION_MS = 90_000

const CANDIDATE_RECORDER_MIMES: readonly {
  readonly recorderMime: string
  readonly contentType: VoiceNoteMimeType
  readonly ext: string
}[] = [
  { recorderMime: 'audio/ogg;codecs=opus', contentType: 'audio/ogg', ext: 'ogg' },
  { recorderMime: 'audio/ogg', contentType: 'audio/ogg', ext: 'ogg' },
  { recorderMime: 'audio/webm;codecs=opus', contentType: 'audio/webm', ext: 'webm' },
  { recorderMime: 'audio/webm', contentType: 'audio/webm', ext: 'webm' },
  { recorderMime: 'audio/mp4', contentType: 'audio/mp4', ext: 'm4a' },
]

function selectRecorderFormat(): {
  readonly recorderMime: string
  readonly contentType: VoiceNoteMimeType
  readonly ext: string
} {
  if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
    for (const candidate of CANDIDATE_RECORDER_MIMES) {
      try {
        if (MediaRecorder.isTypeSupported(candidate.recorderMime)) {
          return candidate
        }
      } catch {
        // Ignore unsupported probe failures.
      }
    }
  }
  return { recorderMime: '', contentType: 'audio/webm', ext: 'webm' }
}

function quantizePeaks(samples: readonly number[], buckets = 24): number[] {
  if (samples.length === 0) {
    return Array.from({ length: buckets }, () => 18)
  }
  const out: number[] = []
  for (let i = 0; i < buckets; i += 1) {
    const start = Math.floor((i * samples.length) / buckets)
    const end = Math.max(start + 1, Math.floor(((i + 1) * samples.length) / buckets))
    let peak = 0
    for (let j = start; j < end && j < samples.length; j += 1) {
      const val = samples[j] ?? 0
      if (val > peak) peak = val
    }
    out.push(Math.max(8, Math.min(100, Math.round(peak * 100))))
  }
  return out
}

export interface VoiceNoteRecorderProps {
  readonly roomId: string
  readonly uploads: AttachmentQueue | null
  readonly plaintextPermitted: boolean
  readonly disabled?: boolean | undefined
  readonly onRecordingChange?: ((recording: boolean) => void) | undefined
}

export function VoiceNoteRecorder({
  roomId,
  uploads,
  plaintextPermitted,
  disabled = false,
  onRecordingChange,
}: VoiceNoteRecorderProps) {
  const { i18n } = useTranslation()
  const copy = voiceNoteMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  const organisationId = useMessagingOrganisation()
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState(false)

  const [scope, setScope] = useState({ organisationId, roomId, plaintextPermitted, uploads })
  if (
    scope.organisationId !== organisationId ||
    scope.roomId !== roomId ||
    scope.plaintextPermitted !== plaintextPermitted ||
    scope.uploads !== uploads
  ) {
    setScope({ organisationId, roomId, plaintextPermitted, uploads })
    setRecording(false)
  }
  const captureGenerationRef = useRef(0)
  const pendingStartRef = useRef(false)
  const mountedRef = useRef(true)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const sampleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const peaksRef = useRef<number[]>([])
  const startedAtRef = useRef<number>(0)
  const discardRef = useRef(false)

  const releaseCapture = () => {
    if (maxDurationTimerRef.current !== null) {
      clearTimeout(maxDurationTimerRef.current)
      maxDurationTimerRef.current = null
    }
    if (sampleTimerRef.current !== null) {
      clearInterval(sampleTimerRef.current)
      sampleTimerRef.current = null
    }
    if (audioCtxRef.current !== null) {
      void audioCtxRef.current.close().catch(() => {})
      audioCtxRef.current = null
    }
    if (streamRef.current !== null) {
      for (const track of streamRef.current.getTracks()) {
        try {
          track.stop()
        } catch {
          // Best-effort track teardown.
        }
      }
      streamRef.current = null
    }
    recorderRef.current = null
  }

  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      captureGenerationRef.current += 1
      mountedRef.current = false
      discardRef.current = true
      try {
        if (recorderRef.current !== null && recorderRef.current.state !== 'inactive') {
          recorderRef.current.stop()
        }
      } catch {
        // Ignore recorder stop failure during unmount.
      }
      releaseCapture()
    }
  }, [organisationId, roomId, plaintextPermitted, uploads])

  const isDisabled = disabled || !plaintextPermitted || uploads === null

  const finishRecording = (cancel: boolean) => {
    discardRef.current = cancel
    const active = recorderRef.current
    if (active !== null && active.state !== 'inactive') {
      try {
        active.stop()
        return
      } catch {
        // Fall through to manual cleanup if MediaRecorder.stop throws.
      }
    }
    releaseCapture()
    if (mountedRef.current) {
      setRecording(false)
      onRecordingChange?.(false)
    }
  }

  const startRecording = async () => {
    if (isDisabled || recording || pendingStartRef.current) return
    setError(false)
    const getUserMedia = globalThis.navigator?.mediaDevices?.getUserMedia
    if (typeof getUserMedia !== 'function' || typeof MediaRecorder === 'undefined') {
      setError(true)
      return
    }
    const generation = captureGenerationRef.current
    pendingStartRef.current = true
    try {
      const stream = await getUserMedia.call(globalThis.navigator.mediaDevices, { audio: true })
      if (
        generation !== captureGenerationRef.current ||
        !mountedRef.current ||
        !plaintextPermitted ||
        uploads === null
      ) {
        for (const track of stream.getTracks()) {
          try {
            track.stop()
          } catch {
            /* Release every track even if one stop fails. */
          }
        }
        return
      }
      streamRef.current = stream
      const chosen = selectRecorderFormat()
      const recorder = chosen.recorderMime
        ? new MediaRecorder(stream, { mimeType: chosen.recorderMime })
        : new MediaRecorder(stream)

      chunksRef.current = []
      peaksRef.current = []
      discardRef.current = false
      startedAtRef.current = Date.now()
      streamRef.current = stream
      recorderRef.current = recorder

      // Sample live amplitude for quantized waveform metadata without cloning tracks.
      const AudioCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (typeof AudioCtor === 'function') {
        try {
          const ctx = new AudioCtor()
          const src = ctx.createMediaStreamSource(stream)
          const analyser = ctx.createAnalyser()
          analyser.fftSize = 256
          src.connect(analyser)
          const buf = new Uint8Array(new ArrayBuffer(256))
          audioCtxRef.current = ctx
          sampleTimerRef.current = setInterval(() => {
            analyser.getByteTimeDomainData(buf)
            let sum = 0
            for (let i = 0; i < buf.length; i += 1) {
              const v = ((buf[i] ?? 128) - 128) / 128
              sum += v * v
            }
            peaksRef.current.push(Math.min(1, Math.sqrt(sum / buf.length) * 3))
          }, 80)
        } catch {
          // Waveform sampling is optional metadata; recording continues cleanly.
        }
      }

      recorder.ondataavailable = (event: BlobEvent) => {
        if (generation !== captureGenerationRef.current) return
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }

      recorder.onstop = () => {
        if (generation !== captureGenerationRef.current) return
        const shouldDiscard = discardRef.current
        const recordedChunks = chunksRef.current
        const durationMs = Math.min(
          MAX_VOICE_NOTE_DURATION_MS,
          Math.max(250, Date.now() - startedAtRef.current)
        )
        const waveform = quantizePeaks(peaksRef.current)
        chunksRef.current = []
        peaksRef.current = []
        releaseCapture()
        if (mountedRef.current) {
          setRecording(false)
          onRecordingChange?.(false)
        }
        if (
          shouldDiscard ||
          recordedChunks.length === 0 ||
          uploads === null ||
          !plaintextPermitted
        ) {
          return
        }
        const blob = new Blob(recordedChunks, { type: chosen.contentType })
        if (blob.size <= 0) return
        const file = new File([blob], `voice-note-${Date.now()}.${chosen.ext}`, {
          type: chosen.contentType,
        })
        void uploads.add(roomId, [file], { durationMs, waveform })
      }

      recorder.start(200)
      maxDurationTimerRef.current = setTimeout(() => {
        finishRecording(false)
      }, MAX_VOICE_NOTE_DURATION_MS)
      setRecording(true)
      onRecordingChange?.(true)
    } catch {
      if (generation !== captureGenerationRef.current) return
      releaseCapture()
      if (mountedRef.current) {
        setRecording(false)
        onRecordingChange?.(false)
        setError(true)
      }
    } finally {
      pendingStartRef.current = false
    }
  }

  const idleLabel = !plaintextPermitted ? copy.recordConfidentialDisabled : copy.recordStart

  return (
    <>
      {recording ? (
        <span className="inline-flex shrink-0 items-center gap-1">
          <Tooltip content={copy.recordStop} names>
            <button
              type="button"
              data-testid="voice-note-stop"
              aria-label={copy.recordStop}
              onClick={() => finishRecording(false)}
              className={cx(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-c-action text-c-on-inverse',
                TOUCH_TARGET,
                'focus-visible:ring focus-visible:outline-hidden'
              )}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="h-4 w-4">
                <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip content={copy.recordCancel} names>
            <button
              type="button"
              data-testid="voice-note-cancel"
              aria-label={copy.recordCancel}
              onClick={() => finishRecording(true)}
              className={cx(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-c-ink-3 hover:bg-c-sunken hover:text-c-ink',
                TOUCH_TARGET,
                'focus-visible:ring focus-visible:outline-hidden'
              )}
            >
              <CloseIcon />
            </button>
          </Tooltip>
        </span>
      ) : (
        <Tooltip content={idleLabel} names>
          <button
            type="button"
            data-testid="voice-note-record"
            aria-label={idleLabel}
            disabled={isDisabled}
            onClick={() => void startRecording()}
            className={cx(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-c-ink-3',
              'hover:bg-c-sunken hover:text-c-ink',
              'disabled:cursor-not-allowed disabled:text-c-on-disabled disabled:hover:bg-transparent',
              TOUCH_TARGET,
              'focus-visible:ring focus-visible:outline-hidden'
            )}
          >
            <EspaceGlyph name="mic" />
          </button>
        </Tooltip>
      )}
      {error ? (
        <span role="status" className="sr-only">
          {copy.recordError}
        </span>
      ) : null}
    </>
  )
}
