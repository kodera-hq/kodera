import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/ui/Button/Button'
import { Card, CardBody } from '@/ui/Card/Card'
import { StatusPill, type StatusPillState } from '@/ui/StatusPill/StatusPill'
import {
  PROXIMITY_DURATION_PRESETS,
  PROXIMITY_MAX_STATUS_NOTE_CHARS,
  ProximityVoluntaryError,
  type ProximityDistanceBand,
  type ProximityDurationSeconds,
  type ProximityVoluntaryBrokerAdapter,
  type VoluntaryCheckInRecord,
  type VoluntaryProximityPeer,
} from './voluntaryCheckIn'

export interface ProximityCheckInViewProps {
  readonly workspaceId: string
  readonly channelName?: string | undefined
  readonly eventScope?: string | undefined
  readonly broker: ProximityVoluntaryBrokerAdapter
  readonly nowUnixSeconds?: number | undefined
  readonly onOpenEphemeralThread?: ((peer: VoluntaryProximityPeer) => void) | undefined
  readonly onStartEphemeralCall?: ((peer: VoluntaryProximityPeer) => void) | undefined
}

const DURATION_KEYS = {
  900: 'console.workspace.proximity.radar-duration-15m',
  1800: 'console.workspace.proximity.radar-duration-30m',
  3600: 'console.workspace.proximity.radar-duration-1h',
  7200: 'console.workspace.proximity.radar-duration-2h',
} as const

const BAND_KEYS = {
  immediate: 'console.workspace.proximity.radar-band-immediate',
  near: 'console.workspace.proximity.radar-band-near',
  ambient: 'console.workspace.proximity.radar-band-ambient',
} as const

type RadarErrorKey =
  'console.workspace.proximity.radar-error-gps' | 'console.workspace.proximity.radar-error-note'

const BAND_PILL_STATES: Record<ProximityDistanceBand, StatusPillState> = {
  immediate: 'success',
  near: 'info',
  ambient: 'neutral',
}

function RadarGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0"
    >
      <circle cx="8" cy="8" r="2" />
      <path d="M4.8 4.8a4.5 4.5 0 0 0 0 6.4" />
      <path d="M11.2 4.8a4.5 4.5 0 0 1 0 6.4" />
      <path d="M2.6 2.6a7.6 7.6 0 0 0 0 10.8" />
      <path d="M13.4 2.6a7.6 7.6 0 0 1 0 10.8" />
    </svg>
  )
}

function ShieldLockGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0"
    >
      <path d="M8 1.8 3 3.8v4c0 3.2 2.1 5.6 5 6.4 2.9-.8 5-3.2 5-6.4v-4L8 1.8Z" />
      <path d="M6.2 8.2 7.5 9.5 10 6.8" />
    </svg>
  )
}

function ThreadBubbleGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0"
    >
      <path d="M2.5 3.5h11v7.5H6l-3.5 2.5V3.5Z" />
    </svg>
  )
}

function AudioWaveGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0"
    >
      <path d="M3 6.5v3" />
      <path d="M6.3 4v8" />
      <path d="M9.7 5.2v5.6" />
      <path d="M13 6.5v3" />
    </svg>
  )
}

function LeaveCrossGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M5.8 5.8 10.2 10.2" />
      <path d="M10.2 5.8 5.8 10.2" />
    </svg>
  )
}

/**
 * Voluntary `#proximity` check-in & live nearby peer radar view (`ciel` & `nuit` token-styled).
 * Enforces explicit opt-in, rotating 15-minute HKDF beacon tokens, zero GPS coordinates,
 * bounded duration (`15 min`, `30 min`, `1 h`, `2 h`), and instant *Quitter la proximité* wipe.
 */
export function ProximityCheckInView({
  workspaceId,
  channelName = '#proximity',
  eventScope = 'default',
  broker,
  nowUnixSeconds,
  onOpenEphemeralThread,
  onStartEphemeralCall,
}: ProximityCheckInViewProps) {
  const { t } = useTranslation()
  const headingId = useId()
  const noteInputId = useId()

  const [durationSeconds, setDurationSeconds] = useState<ProximityDurationSeconds>(1800)
  const [statusNote, setStatusNote] = useState('')
  const [activeRecord, setActiveRecord] = useState<VoluntaryCheckInRecord | null>(null)
  const [peers, setPeers] = useState<readonly VoluntaryProximityPeer[]>([])
  const [busy, setBusy] = useState(false)
  const [errorKey, setErrorKey] = useState<RadarErrorKey | null>(null)
  const [wallClockUnixSeconds, setWallClockUnixSeconds] = useState(() =>
    Math.trunc(nowUnixSeconds ?? Date.now() / 1000)
  )

  const effectiveNow =
    nowUnixSeconds !== undefined ? Math.trunc(nowUnixSeconds) : wallClockUnixSeconds
  const visibleRecord =
    activeRecord !== null && effectiveNow < activeRecord.expiresAtUnixSeconds ? activeRecord : null
  const visiblePeers = visibleRecord === null ? [] : peers

  useEffect(() => {
    if (nowUnixSeconds !== undefined || visibleRecord === null) return
    const timer = window.setInterval(() => {
      setWallClockUnixSeconds(Math.trunc(Date.now() / 1000))
    }, 15_000)
    return () => {
      window.clearInterval(timer)
    }
  }, [nowUnixSeconds, visibleRecord])

  useEffect(() => {
    if (visibleRecord === null) return
    let current = true
    broker
      .listNearby({ workspaceId, eventScope, nowUnixSeconds: effectiveNow })
      .then((latest) => {
        if (current) setPeers(latest)
      })
      .catch(() => {
        if (current) {
          setActiveRecord(null)
          setPeers([])
        }
      })
    return () => {
      current = false
    }
  }, [broker, effectiveNow, eventScope, visibleRecord, workspaceId])

  async function handleJoinProximity() {
    setBusy(true)
    setErrorKey(null)
    const submitTime =
      nowUnixSeconds !== undefined ? Math.trunc(nowUnixSeconds) : Math.trunc(Date.now() / 1000)
    setWallClockUnixSeconds(submitTime)
    try {
      const response = await broker.checkIn({
        workspaceId,
        eventScope,
        durationSeconds,
        statusNote,
        nowUnixSeconds: submitTime,
      })
      setActiveRecord(response.record)
      setPeers(response.peers)
    } catch (error) {
      if (error instanceof ProximityVoluntaryError && error.code === 'ForbiddenGpsCoordinates') {
        setErrorKey('console.workspace.proximity.radar-error-gps')
      } else {
        setErrorKey('console.workspace.proximity.radar-error-note')
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleLeaveProximity() {
    setBusy(true)
    setErrorKey(null)
    try {
      await broker.leaveProximity({ workspaceId, eventScope })
    } finally {
      setActiveRecord(null)
      setPeers([])
      setBusy(false)
    }
  }

  const remainingMinutes =
    visibleRecord === null
      ? 0
      : Math.max(1, Math.ceil((visibleRecord.expiresAtUnixSeconds - effectiveNow) / 60))

  return (
    <section
      aria-labelledby={headingId}
      data-testid="proximity-radar-panel"
      className="flex flex-col gap-3"
    >
      <Card>
        <CardBody className="flex flex-col gap-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 text-c-ink">
              <RadarGlyph />
              <h2 id={headingId} className="truncate text-sm font-semibold text-c-ink">
                {t('console.workspace.proximity.radar-title')}
              </h2>
              <span className="truncate font-mono text-xs text-c-ink-3">{channelName}</span>
            </div>
            <StatusPill state={visibleRecord === null ? 'neutral' : 'success'}>
              {t(
                visibleRecord === null
                  ? 'console.workspace.proximity.radar-state-idle'
                  : 'console.workspace.proximity.radar-state-active'
              )}
            </StatusPill>
          </div>

          <div
            role="note"
            data-testid="proximity-radar-pledge"
            className="flex items-start gap-2 rounded-md border border-c-border-soft bg-c-sunken px-3 py-2 text-xs font-regular text-c-ink-2"
          >
            <span className="mt-1 text-c-accent-ink">
              <ShieldLockGlyph />
            </span>
            <div className="flex flex-col gap-1">
              <p>{t('console.workspace.proximity.radar-pledge')}</p>
              <p className="text-c-ink-3">{t('console.workspace.proximity.notice')}</p>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-c-ink-2">
              {t('console.workspace.proximity.radar-duration-label')}
            </span>
            <div
              role="group"
              aria-label={t('console.workspace.proximity.radar-duration-label')}
              className="grid grid-cols-2 gap-2 md:grid-cols-4"
            >
              {PROXIMITY_DURATION_PRESETS.map((preset) => {
                const selected = durationSeconds === preset
                return (
                  <button
                    key={preset}
                    type="button"
                    disabled={visibleRecord !== null}
                    aria-pressed={selected}
                    onClick={() => setDurationSeconds(preset)}
                    className={
                      selected
                        ? 'h-8 rounded-md border border-c-accent-ink bg-c-accent-soft px-3 text-xs font-semibold text-c-accent-ink focus-visible:ring focus-visible:outline-hidden'
                        : 'h-8 rounded-md border border-c-border-soft bg-c-surface px-3 text-xs font-semibold text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden'
                    }
                  >
                    {t(DURATION_KEYS[preset])}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={noteInputId} className="text-xs font-medium text-c-ink-2">
              {t('console.workspace.proximity.radar-note-label')}
            </label>
            <input
              id={noteInputId}
              type="text"
              disabled={visibleRecord !== null}
              maxLength={PROXIMITY_MAX_STATUS_NOTE_CHARS}
              value={statusNote}
              onChange={(event) => setStatusNote(event.target.value)}
              placeholder={t('console.workspace.proximity.radar-note-placeholder')}
              className="h-8 rounded-md border border-c-border-input bg-c-surface px-3 text-sm text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
            />
          </div>

          {errorKey === null ? null : (
            <p
              role="status"
              aria-live="polite"
              className="rounded-md border border-c-bad bg-c-bad-soft px-3 py-2 text-xs font-medium text-c-bad-ink"
            >
              {t(errorKey)}
            </p>
          )}

          {visibleRecord === null ? (
            <div>
              <Button
                variant="primary"
                size="md"
                loading={busy}
                icon={<RadarGlyph />}
                data-testid="proximity-radar-join"
                onClick={() => {
                  void handleJoinProximity()
                }}
              >
                {t('console.workspace.proximity.radar-join')}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-c-border-soft bg-c-sunken px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-c-ink-2">
                <span>{t('console.workspace.proximity.radar-token-label')}</span>
                <code className="rounded-sm bg-c-surface px-2 py-1 font-mono text-xs text-c-accent-ink">
                  {`prox-${visibleRecord.rollingPseudonymHex.slice(0, 8)}`}
                </code>
                <span className="text-c-ink-3">
                  {t('console.workspace.proximity.radar-expires-in', {
                    minutes: remainingMinutes,
                  })}
                </span>
              </div>
              <Button
                variant="destructive"
                size="sm"
                loading={busy}
                icon={<LeaveCrossGlyph />}
                data-testid="proximity-radar-leave"
                onClick={() => {
                  void handleLeaveProximity()
                }}
              >
                {t('console.workspace.proximity.radar-leave')}
              </Button>
            </div>
          )}

          <div className="flex flex-col gap-2 border-t border-c-border-soft pt-3">
            <h3 className="text-xs font-semibold text-c-ink-2">
              {t('console.workspace.proximity.radar-peers-heading')}
            </h3>
            {visiblePeers.length === 0 ? (
              <p className="text-xs font-regular text-c-ink-3">
                {t('console.workspace.proximity.radar-peers-empty')}
              </p>
            ) : (
              <ul
                aria-label={t('console.workspace.proximity.radar-peers-heading')}
                data-testid="proximity-radar-peer-list"
                className="flex flex-col gap-2"
              >
                {visiblePeers.map((peer) => (
                  <li
                    key={peer.peerId}
                    className="flex flex-col gap-2 rounded-md border border-c-border-soft bg-c-surface px-3 py-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-sm font-semibold text-c-ink">
                        {peer.handle}
                      </span>
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusPill state={BAND_PILL_STATES[peer.distanceBand]}>
                          {t(BAND_KEYS[peer.distanceBand])}
                        </StatusPill>
                        {peer.viaLanMdnsQuic ? (
                          <StatusPill state="info">
                            {t('console.workspace.proximity.radar-lan-badge')}
                          </StatusPill>
                        ) : null}
                      </div>
                    </div>
                    {peer.statusNote.length > 0 ? (
                      <p className="text-xs font-regular text-c-ink-2">{peer.statusNote}</p>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<ThreadBubbleGlyph />}
                        onClick={() => onOpenEphemeralThread?.(peer)}
                      >
                        {t('console.workspace.proximity.radar-open-thread')}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<AudioWaveGlyph />}
                        onClick={() => onStartEphemeralCall?.(peer)}
                      >
                        {t('console.workspace.proximity.radar-start-call')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardBody>
      </Card>
    </section>
  )
}
