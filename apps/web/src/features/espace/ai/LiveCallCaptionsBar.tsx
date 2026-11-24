// Consent-gated live call captions and subtitle translation bar (H3.2).
// Enforces pre-subscription explicit consent, reactive auto-pause on non-consenting participant
// joins, bounded consent-state polling, per-call teardown leave, standalone audio container
// segments, 1-click consent withdrawal, and a rolling 2-line accessible overlay.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ApiProblem,
  fetchLiveCallCaptionSession,
  grantMemberWorkspaceAiConsent,
  postLiveCallCaptionChunk,
  postLiveCallCaptionSession,
  type LiveCallCaptionSessionView,
} from './aiTranslationApi'
import {
  SUPPORTED_TRANSLATION_LANGUAGES,
  aiTranslationMessages,
  isSupportedTranslationLanguage,
  type SupportedTranslationLanguage,
} from './aiTranslationMessages'
import type { CallCaptionPacket } from '../audio/call'

const MAX_CALL_CHUNK_BYTES = 1_048_576
const MAX_ROLLING_LINES = 2
const MAX_SEEN_SEGMENTS = 128
const RECORDER_SEGMENT_MS = 3_000
const SESSION_POLL_INTERVAL_MS = 3_000

export interface LiveCallAudioChunkPayload {
  readonly audioBase64: string
  readonly contentType?: string
  readonly filename?: string
}

export interface LiveCallChunkSource {
  subscribe: (listener: (chunk: LiveCallAudioChunkPayload) => void) => () => void
}

export interface LiveCallCaptionsBarProps {
  readonly organisationId: string | null
  readonly channelId: string
  readonly participants: readonly string[]
  readonly permitsPlaintext: boolean
  readonly callInstanceId?: string | undefined
  readonly visible?: boolean | undefined
  readonly localAudioTrack?: MediaStreamTrack | null | undefined
  readonly chunkSource?: LiveCallChunkSource | undefined
  readonly defaultExpanded?: boolean | undefined
  readonly localSpeakerLabel?: string | undefined
  readonly resolveSpeakerName?: ((userId: string) => string) | undefined
  readonly publishCaptionPacket?: ((packet: CallCaptionPacket) => Promise<boolean>) | undefined
  readonly subscribeCaptionPackets?:
    | ((listener: (packet: CallCaptionPacket) => void) => () => void)
    | undefined
}

interface CaptionLine {
  readonly id: number
  readonly text: string
  readonly language: SupportedTranslationLanguage
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...slice)
  }
  return globalThis.btoa(binary)
}

function estimateDecodedByteLength(base64: string): number {
  const clean = base64.replace(/\s+/gu, '')
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.floor((clean.length * 3) / 4) - padding
}

function isNonTerminalState(
  state: LiveCallCaptionSessionView['state'] | undefined
): state is 'awaiting_all_consents' | 'active' | 'paused_unconsented_participant' {
  return (
    state === 'awaiting_all_consents' ||
    state === 'active' ||
    state === 'paused_unconsented_participant'
  )
}

export function LiveCallCaptionsBar({
  organisationId,
  channelId,
  participants,
  permitsPlaintext,
  callInstanceId,
  visible = true,
  localAudioTrack,
  chunkSource,
  defaultExpanded = false,
  localSpeakerLabel,
  resolveSpeakerName,
  publishCaptionPacket,
  subscribeCaptionPackets,
}: LiveCallCaptionsBarProps) {
  const { i18n } = useTranslation()
  const locale = i18n.resolvedLanguage === 'en' ? 'en' : 'fr'
  const copy = aiTranslationMessages[locale]
  const languageSelectId = useId()

  const uniqueParticipants = useMemo(() => {
    const seen = new Set<string>()
    const ordered: string[] = []
    for (const raw of participants) {
      const trimmed = raw.trim()
      if (trimmed === '' || seen.has(trimmed)) continue
      seen.add(trimmed)
      ordered.push(trimmed)
    }
    return ordered
  }, [participants])

  const participantsKey = useMemo(
    () => [...uniqueParticipants].sort().join('\u0000'),
    [uniqueParticipants]
  )

  const boundCallInstanceId =
    callInstanceId !== undefined && callInstanceId.trim() !== '' ? callInstanceId.trim() : null

  const [expanded, setExpanded] = useState(defaultExpanded)
  const [targetLanguage, setTargetLanguage] = useState<SupportedTranslationLanguage>(locale)
  const [session, setSession] = useState<LiveCallCaptionSessionView | null>(null)
  const [captionLines, setCaptionLines] = useState<readonly CaptionLine[]>([])
  const [busyAction, setBusyAction] = useState<'consent' | 'withdraw' | null>(null)
  const [errorNotice, setErrorNotice] = useState<string | null>(null)
  const nextScopeKey = `${organisationId ?? ''}:${channelId}:${String(permitsPlaintext)}:${boundCallInstanceId ?? ''}`
  const [scopeKey, setScopeKey] = useState(nextScopeKey)

  if (scopeKey !== nextScopeKey) {
    setScopeKey(nextScopeKey)
    setSession(null)
    setCaptionLines([])
    setErrorNotice(null)
    if (!permitsPlaintext) {
      setExpanded(false)
    }
  }

  const lineCounterRef = useRef(0)
  const seenSegmentIdsRef = useRef<Set<string>>(new Set())
  const liveSessionSnapshotRef = useRef<LiveCallCaptionSessionView | null>(null)
  const chunkAbortRef = useRef<AbortController | null>(null)
  const syncedRosterRef = useRef<{ sessionId: string; key: string } | null>(null)
  const activeSessionRef = useRef<{
    organisationId: string
    channelId: string
    sessionId: string
  } | null>(null)

  const rememberSegmentId = useCallback((segmentId: string): boolean => {
    const seen = seenSegmentIdsRef.current
    if (seen.has(segmentId)) return false
    if (seen.size >= MAX_SEEN_SEGMENTS) {
      const oldest = seen.values().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
    seen.add(segmentId)
    return true
  }, [])

  const abortInFlightChunksAndClear = useCallback(() => {
    chunkAbortRef.current?.abort()
    chunkAbortRef.current = null
    seenSegmentIdsRef.current.clear()
    setCaptionLines([])
  }, [])

  // Track the live non-terminal session so unmount or call disconnect sends an explicit `leave`,
  // preventing consents from carrying over into a subsequent call on the same channel.
  useEffect(() => {
    liveSessionSnapshotRef.current = session
    if (session === null) {
      return
    }
    if (
      permitsPlaintext &&
      organisationId !== null &&
      channelId !== '' &&
      isNonTerminalState(session.state)
    ) {
      activeSessionRef.current = {
        organisationId,
        channelId,
        sessionId: session.sessionId,
      }
      return
    }
    activeSessionRef.current = null
  }, [permitsPlaintext, organisationId, channelId, session])

  useEffect(() => {
    chunkAbortRef.current?.abort()
    chunkAbortRef.current = null
    seenSegmentIdsRef.current.clear()
    syncedRosterRef.current = null
    return () => {
      chunkAbortRef.current?.abort()
      chunkAbortRef.current = null
      const live = activeSessionRef.current
      if (live !== null) {
        activeSessionRef.current = null
        void postLiveCallCaptionSession({
          organisationId: live.organisationId,
          channelId: live.channelId,
          body: {
            action: 'leave',
            sessionId: live.sessionId,
          },
        }).catch(() => undefined)
      }
    }
  }, [nextScopeKey])

  // Hydrate any existing non-terminal call caption session bound to THIS `callInstanceId`.
  useEffect(() => {
    if (
      !expanded ||
      !permitsPlaintext ||
      organisationId === null ||
      channelId === '' ||
      boundCallInstanceId === null
    ) {
      return
    }
    if (session !== null) return

    const controller = new AbortController()
    fetchLiveCallCaptionSession({
      organisationId,
      channelId,
      callInstanceId: boundCallInstanceId,
      signal: controller.signal,
    })
      .then((existing) => {
        if (controller.signal.aborted || existing === null) return
        if (
          existing.callInstanceId !== undefined &&
          existing.callInstanceId !== boundCallInstanceId
        ) {
          return
        }
        setSession(existing)
        if (isSupportedTranslationLanguage(existing.targetLanguage)) {
          setTargetLanguage(existing.targetLanguage)
        }
      })
      .catch(() => undefined)

    return () => {
      controller.abort()
    }
  }, [expanded, permitsPlaintext, organisationId, channelId, boundCallInstanceId, session])

  const sessionId = session?.sessionId
  const sessionState = session?.state
  const sessionGeneration = session?.sessionEpoch
  const sessionRosterCount = session?.rosterCount ?? 0
  const rosterGrewWhileActive =
    sessionState === 'active' && uniqueParticipants.length > sessionRosterCount

  // Bounded 3s consent-state polling while awaiting/paused/active so remote participant grants,
  // joins, or withdrawals reflect immediately across all call participants.
  useEffect(() => {
    if (
      !permitsPlaintext ||
      organisationId === null ||
      channelId === '' ||
      boundCallInstanceId === null
    ) {
      return
    }
    const shouldPoll = isNonTerminalState(sessionState) || (expanded && sessionState === undefined)
    if (!shouldPoll) return

    let activeController: AbortController | null = null
    const timer = globalThis.setInterval(() => {
      activeController?.abort()
      const controller = new AbortController()
      activeController = controller

      fetchLiveCallCaptionSession({
        organisationId,
        channelId,
        callInstanceId: boundCallInstanceId,
        ...(sessionId === undefined ? {} : { sessionId }),
        signal: controller.signal,
      })
        .then((polled) => {
          if (controller.signal.aborted) return
          if (
            polled === null ||
            (polled.callInstanceId !== undefined && polled.callInstanceId !== boundCallInstanceId)
          ) {
            if (sessionId !== undefined) {
              activeSessionRef.current = null
              chunkAbortRef.current?.abort()
              chunkAbortRef.current = null
              setCaptionLines([])
              setSession(null)
            }
            return
          }
          if (
            polled.state !== 'active' ||
            (sessionGeneration !== undefined && polled.sessionEpoch !== sessionGeneration)
          ) {
            chunkAbortRef.current?.abort()
            chunkAbortRef.current = null
            seenSegmentIdsRef.current.clear()
            setCaptionLines([])
          }
          setSession(polled)
          if (isSupportedTranslationLanguage(polled.targetLanguage)) {
            setTargetLanguage(polled.targetLanguage)
          }
        })
        .catch(() => undefined)
    }, SESSION_POLL_INTERVAL_MS)

    return () => {
      globalThis.clearInterval(timer)
      activeController?.abort()
    }
  }, [
    permitsPlaintext,
    organisationId,
    channelId,
    boundCallInstanceId,
    expanded,
    sessionId,
    sessionState,
    sessionGeneration,
  ])

  // Reactive roster sync: the instant room participants change during a non-terminal session,
  // reconcile with the server so non-consenting joins trigger immediate auto-pause.
  useEffect(() => {
    if (
      !permitsPlaintext ||
      organisationId === null ||
      channelId === '' ||
      boundCallInstanceId === null ||
      sessionId === undefined ||
      !isNonTerminalState(sessionState)
    ) {
      return
    }
    const previous = syncedRosterRef.current
    if (previous !== null && previous.sessionId === sessionId && previous.key === participantsKey) {
      return
    }

    if (rosterGrewWhileActive) {
      chunkAbortRef.current?.abort()
      chunkAbortRef.current = null
    }

    syncedRosterRef.current = { sessionId, key: participantsKey }
    const controller = new AbortController()

    postLiveCallCaptionSession({
      organisationId,
      channelId,
      body: {
        action: 'sync_roster',
        sessionId,
        callInstanceId: boundCallInstanceId,
        participantUserIds: uniqueParticipants,
      },
      signal: controller.signal,
    })
      .then((updated) => {
        if (controller.signal.aborted || updated === null) return
        if (updated.state !== 'active') {
          chunkAbortRef.current?.abort()
          chunkAbortRef.current = null
          seenSegmentIdsRef.current.clear()
          setCaptionLines([])
        }
        setSession(updated)
      })
      .catch(() => undefined)

    return () => {
      controller.abort()
    }
  }, [
    permitsPlaintext,
    organisationId,
    channelId,
    boundCallInstanceId,
    sessionId,
    sessionState,
    rosterGrewWhileActive,
    participantsKey,
    uniqueParticipants,
  ])

  const handleGrantConsent = async () => {
    if (
      !permitsPlaintext ||
      organisationId === null ||
      channelId === '' ||
      boundCallInstanceId === null ||
      busyAction !== null
    ) {
      return
    }
    setBusyAction('consent')
    setErrorNotice(null)

    const startingNew = session === null || !isNonTerminalState(session.state)
    const requestBody = {
      action: startingNew ? ('start' as const) : ('consent' as const),
      ...(startingNew ? {} : { sessionId: session.sessionId }),
      callInstanceId: boundCallInstanceId,
      targetLanguage,
      grantCallConsent: true,
      participantUserIds: uniqueParticipants,
    }

    try {
      let updated: LiveCallCaptionSessionView | null
      try {
        updated = await postLiveCallCaptionSession({
          organisationId,
          channelId,
          body: requestBody,
        })
      } catch (firstErr: unknown) {
        if (
          firstErr instanceof ApiProblem &&
          firstErr.status === 403 &&
          session?.callerMemberAiConsent !== true
        ) {
          await grantMemberWorkspaceAiConsent({ organisationId })
          updated = await postLiveCallCaptionSession({
            organisationId,
            channelId,
            body: requestBody,
          })
        } else {
          throw firstErr
        }
      }
      if (updated !== null) {
        syncedRosterRef.current = { sessionId: updated.sessionId, key: participantsKey }
        setSession(updated)
      }
    } catch (err: unknown) {
      if (err instanceof ApiProblem && err.status === 429) {
        setErrorNotice(copy.captionsBudgetExhausted)
      } else {
        setErrorNotice(copy.captionsRefused)
      }
    } finally {
      setBusyAction(null)
    }
  }

  const handleWithdrawConsent = async () => {
    if (organisationId === null || channelId === '' || session === null || busyAction !== null) {
      return
    }
    abortInFlightChunksAndClear()
    setBusyAction('withdraw')
    setErrorNotice(null)
    try {
      const updated = await postLiveCallCaptionSession({
        organisationId,
        channelId,
        body: {
          action: 'withdraw',
          sessionId: session.sessionId,
        },
      })
      if (updated !== null) {
        activeSessionRef.current = null
        setSession(updated)
      }
    } catch {
      setErrorNotice(copy.captionsRefused)
    } finally {
      setBusyAction(null)
    }
  }

  const handleLanguageChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value
    if (!isSupportedTranslationLanguage(next)) return
    setTargetLanguage(next)
    if (
      permitsPlaintext &&
      organisationId !== null &&
      channelId !== '' &&
      session !== null &&
      isNonTerminalState(session.state)
    ) {
      void postLiveCallCaptionSession({
        organisationId,
        channelId,
        body: {
          action: 'set_language',
          sessionId: session.sessionId,
          targetLanguage: next,
        },
      })
        .then((updated) => {
          if (updated !== null) setSession(updated)
        })
        .catch(() => undefined)
    }
  }

  const canStreamChunks =
    permitsPlaintext &&
    organisationId !== null &&
    channelId !== '' &&
    boundCallInstanceId !== null &&
    session !== null &&
    session.state === 'active' &&
    !rosterGrewWhileActive &&
    session.allConsented &&
    session.callerConsentState === 'consented'

  const activeStreamSessionId = canStreamChunks && session !== null ? session.sessionId : null
  const activeStreamGeneration = canStreamChunks && session !== null ? session.sessionEpoch : null

  const submitAudioChunk = useCallback(
    (payload: LiveCallAudioChunkPayload, sessionIdToSubmit: string, expectedGeneration: number) => {
      if (organisationId === null || channelId === '') return
      const byteLength = estimateDecodedByteLength(payload.audioBase64)
      if (byteLength <= 0 || byteLength > MAX_CALL_CHUNK_BYTES) return

      const controller = new AbortController()
      chunkAbortRef.current = controller

      postLiveCallCaptionChunk({
        organisationId,
        channelId,
        body: {
          sessionId: sessionIdToSubmit,
          sessionEpoch: expectedGeneration,
          audioBase64: payload.audioBase64,
          contentType: payload.contentType ?? 'audio/ogg',
          ...(payload.filename === undefined ? {} : { filename: payload.filename }),
          targetLanguage,
          participantUserIds: uniqueParticipants,
        },
        signal: controller.signal,
      })
        .then((res) => {
          if (controller.signal.aborted) return
          const lineText = (res.translatedText || res.sourceText).trim()
          if (lineText === '') return
          const rawSource = res.sourceText.trim() || lineText
          const current = liveSessionSnapshotRef.current
          if (
            current === null ||
            current.state !== 'active' ||
            current.sessionEpoch !== expectedGeneration
          ) {
            return
          }
          lineCounterRef.current += 1
          const nextId = lineCounterRef.current
          const segmentId = globalThis.crypto.randomUUID()
          rememberSegmentId(segmentId)
          const nextLine: CaptionLine = {
            id: nextId,
            text: lineText,
            language: res.targetLanguage,
          }
          setCaptionLines((prev) => [...prev.slice(-(MAX_ROLLING_LINES - 1)), nextLine])
          if (permitsPlaintext && boundCallInstanceId !== null && publishCaptionPacket) {
            const sourceLang = /^[a-z]{2,8}$/u.test(res.sourceLanguage)
              ? res.sourceLanguage
              : res.targetLanguage
            void publishCaptionPacket({
              v: 1,
              callInstanceId: boundCallInstanceId,
              sessionEpoch: expectedGeneration,
              segmentId,
              speakerLabel: (localSpeakerLabel ?? '').slice(0, 80),
              sourceLanguage: sourceLang,
              text: rawSource.slice(0, 2048),
              translations: { [res.targetLanguage]: lineText.slice(0, 2048) },
            }).catch(() => undefined)
          }
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return
          if (err instanceof ApiProblem) {
            if (err.status === 429) {
              setErrorNotice(copy.captionsBudgetExhausted)
              return
            }
            if (err.status === 403 || err.status === 409) {
              abortInFlightChunksAndClear()
              void fetchLiveCallCaptionSession({
                organisationId,
                channelId,
                sessionId: sessionIdToSubmit,
                ...(boundCallInstanceId === null ? {} : { callInstanceId: boundCallInstanceId }),
              })
                .then((refreshed) => {
                  if (refreshed === null) {
                    activeSessionRef.current = null
                  }
                  setSession(refreshed)
                })
                .catch(() => undefined)
            }
          }
        })
    },
    [
      organisationId,
      channelId,
      boundCallInstanceId,
      permitsPlaintext,
      localSpeakerLabel,
      publishCaptionPacket,
      rememberSegmentId,
      targetLanguage,
      uniqueParticipants,
      copy.captionsBudgetExhausted,
      abortInFlightChunksAndClear,
    ]
  )

  // Subscribe to verified ephemeral LiveKit DataChannel caption packets from consenting peers so
  // muted and listenOnly participants also read real-time room captions without raw audio sharing.
  useEffect(() => {
    if (
      !permitsPlaintext ||
      boundCallInstanceId === null ||
      subscribeCaptionPackets === undefined ||
      session === null ||
      session.state !== 'active' ||
      rosterGrewWhileActive ||
      !session.allConsented
    ) {
      return
    }
    const activeEpoch = session.sessionEpoch
    return subscribeCaptionPackets((packet) => {
      if (
        packet.v !== 1 ||
        packet.callInstanceId !== boundCallInstanceId ||
        packet.sessionEpoch !== activeEpoch ||
        !rememberSegmentId(packet.segmentId)
      ) {
        return
      }
      const preferred = packet.translations[targetLanguage]?.trim()
      const chosenText = (preferred && preferred !== '' ? preferred : packet.text).trim()
      if (chosenText === '') return
      const chosenLang: SupportedTranslationLanguage =
        preferred && preferred !== ''
          ? targetLanguage
          : isSupportedTranslationLanguage(packet.sourceLanguage)
            ? packet.sourceLanguage
            : targetLanguage
      const rawSpeaker =
        packet.senderUserId !== undefined && packet.senderUserId.trim() !== ''
          ? resolveSpeakerName !== undefined
            ? resolveSpeakerName(packet.senderUserId)
            : packet.senderUserId
          : packet.speakerLabel
      const speaker = rawSpeaker.trim()
      const displayText = speaker !== '' ? `${speaker}: ${chosenText}` : chosenText
      lineCounterRef.current += 1
      const nextLine: CaptionLine = {
        id: lineCounterRef.current,
        text: displayText,
        language: chosenLang,
      }
      setCaptionLines((prev) => [...prev.slice(-(MAX_ROLLING_LINES - 1)), nextLine])
    })
  }, [
    permitsPlaintext,
    boundCallInstanceId,
    subscribeCaptionPackets,
    resolveSpeakerName,
    session,
    rosterGrewWhileActive,
    rememberSegmentId,
    targetLanguage,
  ])

  // Pre-subscription all-party consent gate: subscribe to audio chunks ONLY while 100% consented.
  // Depend strictly on primitive session identifiers (`activeStreamSessionId`,
  // `activeStreamGeneration`) rather than the `session` object reference so 3s consent polling
  // never tears down or cancels active `MediaRecorder` segments!
  useEffect(() => {
    if (!canStreamChunks || activeStreamSessionId === null || activeStreamGeneration === null) {
      return
    }

    if (chunkSource !== undefined) {
      return chunkSource.subscribe((chunk) => {
        submitAudioChunk(chunk, activeStreamSessionId, activeStreamGeneration)
      })
    }

    if (
      localAudioTrack === null ||
      localAudioTrack === undefined ||
      localAudioTrack.readyState !== 'live' ||
      typeof globalThis.MediaRecorder === 'undefined' ||
      typeof globalThis.MediaStream === 'undefined'
    ) {
      return
    }

    const preferredMime =
      typeof MediaRecorder.isTypeSupported === 'function' &&
      MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/ogg'

    let stream: MediaStream
    try {
      stream = new MediaStream([localAudioTrack])
    } catch {
      return
    }

    let cancelled = false
    let currentRecorder: MediaRecorder | null = null
    let segmentTimer: ReturnType<typeof globalThis.setTimeout> | null = null

    const startStandaloneSegment = () => {
      if (cancelled || localAudioTrack.readyState !== 'live') return
      let recorder: MediaRecorder
      try {
        recorder = new MediaRecorder(stream, { mimeType: preferredMime })
      } catch {
        return
      }
      currentRecorder = recorder
      const parts: BlobPart[] = []

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          parts.push(event.data)
        }
      }

      recorder.onstop = () => {
        if (cancelled) return
        const standaloneBlob = new Blob(parts, { type: preferredMime })
        if (standaloneBlob.size > 0 && standaloneBlob.size <= MAX_CALL_CHUNK_BYTES) {
          void standaloneBlob.arrayBuffer().then((buffer) => {
            if (cancelled) return
            const base64 = bytesToBase64(new Uint8Array(buffer))
            submitAudioChunk(
              {
                audioBase64: base64,
                contentType: preferredMime,
                filename: preferredMime === 'audio/webm' ? 'call-chunk.webm' : 'call-chunk.ogg',
              },
              activeStreamSessionId,
              activeStreamGeneration
            )
          })
        }
        startStandaloneSegment()
      }

      try {
        // Call `start()` without a timeslice so `stop()` finalizes a standalone container header.
        recorder.start()
      } catch {
        return
      }

      segmentTimer = globalThis.setTimeout(() => {
        if (!cancelled && recorder.state === 'recording') {
          try {
            recorder.stop()
          } catch {
            // Ignore recorder stop errors on track teardown.
          }
        }
      }, RECORDER_SEGMENT_MS)
    }

    startStandaloneSegment()

    return () => {
      cancelled = true
      if (segmentTimer !== null) {
        globalThis.clearTimeout(segmentTimer)
      }
      if (currentRecorder !== null && currentRecorder.state !== 'inactive') {
        try {
          currentRecorder.stop()
        } catch {
          // Ignore recorder stop errors on track teardown.
        }
      }
    }
  }, [
    canStreamChunks,
    activeStreamSessionId,
    activeStreamGeneration,
    chunkSource,
    localAudioTrack,
    submitAudioChunk,
  ])

  if (!visible) {
    return null
  }

  if (!permitsPlaintext) {
    return (
      <div
        data-testid="live-captions-bar"
        className="mx-3 mt-2 flex items-center justify-between gap-2 rounded-md border border-c-rail-line bg-c-inverse-2 px-3 py-2 text-xs text-c-on-inverse-dim"
      >
        <button
          type="button"
          disabled
          data-testid="live-captions-confidential-disabled"
          aria-label={copy.captionsConfidentialDisabled}
          className="cursor-not-allowed rounded-sm text-left text-xs font-medium text-c-on-inverse-dim opacity-60"
        >
          {copy.captionsConfidentialDisabled}
        </button>
      </div>
    )
  }

  if (organisationId === null || channelId === '') {
    return null
  }

  const callerHasConsented =
    session !== null &&
    isNonTerminalState(session.state) &&
    session.callerConsentState === 'consented'
  const showConsentPrompt =
    expanded &&
    (session === null ||
      session.state === 'ended' ||
      session.state === 'stopped_withdrawn' ||
      session.callerConsentState !== 'consented')

  return (
    <div
      data-testid="live-captions-bar"
      className="mx-3 mt-2 flex flex-col gap-2 rounded-lg border border-c-rail-line bg-c-inverse-2 px-3 py-2 text-xs text-c-on-inverse"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="live-captions-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
            className="focus-offset inline-flex items-center gap-2 rounded-md bg-c-inverse px-3 py-1 text-xs font-semibold text-c-on-inverse hover:underline focus-visible:ring focus-visible:ring-offset-2 focus-visible:outline-hidden"
          >
            <span>{copy.captionsToggle}</span>
          </button>

          {session?.state === 'paused_unconsented_participant' ? (
            <span
              role="status"
              data-testid="live-captions-paused-pill"
              className="inline-flex items-center rounded-full bg-c-warn-soft px-3 py-1 text-xs font-medium text-c-warn-ink"
            >
              {copy.pausedUnconsented}
            </span>
          ) : session?.state === 'awaiting_all_consents' ? (
            <span
              role="status"
              data-testid="live-captions-awaiting-pill"
              className="inline-flex items-center rounded-full bg-c-inverse px-3 py-1 font-mono text-xs font-medium text-c-on-inverse-dim"
            >
              {copy.awaitingAllConsents(session.consentedCount, session.rosterCount)}
            </span>
          ) : session?.state === 'active' ? (
            <span
              role="status"
              data-testid="live-captions-active-pill"
              className="inline-flex items-center rounded-full bg-c-inverse px-3 py-1 text-xs font-medium text-c-ok-on-dark"
            >
              {copy.activeLive}
            </span>
          ) : session?.state === 'stopped_withdrawn' ? (
            <span
              role="status"
              data-testid="live-captions-withdrawn-pill"
              className="inline-flex items-center rounded-full bg-c-inverse px-3 py-1 text-xs font-medium text-c-bad-on-dark"
            >
              {copy.stoppedWithdrawn}
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {expanded ? (
            <div className="flex items-center gap-2">
              <label htmlFor={languageSelectId} className="sr-only">
                {copy.subtitleLanguageLabel}
              </label>
              <select
                id={languageSelectId}
                data-testid="live-captions-language"
                aria-label={copy.subtitleLanguageLabel}
                value={targetLanguage}
                onChange={handleLanguageChange}
                className="rounded-sm border border-c-rail-line bg-c-inverse px-2 py-1 font-mono text-xs font-medium text-c-on-inverse focus-visible:ring focus-visible:outline-hidden"
              >
                {SUPPORTED_TRANSLATION_LANGUAGES.map((code) => (
                  <option key={code} value={code}>
                    {copy.languages[code]}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {callerHasConsented ? (
            <button
              type="button"
              data-testid="live-captions-withdraw-consent"
              disabled={busyAction === 'withdraw'}
              onClick={() => void handleWithdrawConsent()}
              className="focus-offset rounded-md border border-c-rail-line bg-c-inverse px-3 py-1 text-xs font-semibold text-c-bad-on-dark hover:underline focus-visible:ring focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:opacity-60"
            >
              {busyAction === 'withdraw' ? copy.consentWithdrawing : copy.consentWithdraw}
            </button>
          ) : null}
        </div>
      </div>

      {showConsentPrompt ? (
        <div
          data-testid="live-captions-consent-banner"
          className="flex flex-col gap-2 rounded-md border border-c-rail-line bg-c-inverse p-3"
        >
          <div className="flex flex-col gap-1">
            <p className="text-xs font-semibold text-c-on-inverse">{copy.consentPromptTitle}</p>
            <p className="text-xs text-c-on-inverse-dim">{copy.consentPromptBody}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="live-captions-grant-consent"
              disabled={busyAction === 'consent' || boundCallInstanceId === null}
              onClick={() => void handleGrantConsent()}
              className="focus-offset rounded-md bg-c-action px-3 py-1 text-xs font-semibold text-c-on-inverse hover:opacity-95 focus-visible:ring focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:opacity-60"
            >
              {busyAction === 'consent' ? copy.consentSubmitting : copy.consentGrant}
            </button>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="focus-offset rounded-md px-2 py-1 text-xs font-medium text-c-on-inverse-dim hover:text-c-on-inverse focus-visible:ring focus-visible:outline-hidden"
            >
              {copy.dismissBanner}
            </button>
          </div>
        </div>
      ) : null}

      {errorNotice !== null ? (
        <p
          role="alert"
          data-testid="live-captions-error"
          className="rounded-sm bg-c-bad-soft px-2 py-1 text-xs text-c-bad-ink"
        >
          {errorNotice}
        </p>
      ) : null}

      {session?.state === 'active' && !rosterGrewWhileActive ? (
        <div
          role="region"
          aria-live="polite"
          aria-atomic="false"
          aria-label={copy.captionsRegionLabel}
          data-testid="live-captions-overlay"
          className="flex min-h-[40px] flex-col justify-end gap-1 rounded-md border border-c-rail-line bg-c-inverse px-3 py-2"
        >
          {captionLines.slice(-MAX_ROLLING_LINES).map((line) => (
            <p
              key={line.id}
              data-testid="live-captions-line"
              lang={line.language}
              className="line-clamp-1 text-sm font-medium text-c-on-inverse"
            >
              {line.text}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}
