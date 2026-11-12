import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardBody } from '@/ui/Card/Card'
import { StatusPill, type StatusPillState } from '@/ui/StatusPill/StatusPill'
import { ModuleGlyph } from '@/ui/icons/ModuleGlyph'
import { ProximityFrame, UuidV7, bytesToHex, truncateUtf8Bytes } from './codec'
import { safetyStatusPriority } from './transport'
import {
  type DeviceIdentitySigner,
  type ProximityRosterCheckIn,
  MAX_PROXIMITY_TEXT_BYTES,
  MAX_PROXIMITY_TTL_HOPS,
  SafetyStatus,
} from './types'

/**
 * What a connected panel needs from the device: the organisation's beacon salt, a clock, the
 * device's own signing identity and the check-ins already heard. There is no default for any of
 * them. Without a transport the panel draws one line, « Non connecté », and offers nothing to
 * send: the proximity relay is in development, and a check-in must never look sent when it
 * went nowhere.
 */
export interface ProximityPanelTransport {
  readonly orgBeaconSalt: Uint8Array
  readonly unixSecs: number
  readonly localSigner: DeviceIdentitySigner
  readonly initialRoster: readonly ProximityRosterCheckIn[]
  readonly defaultTtlHops?: number | undefined
}

export interface ProximityRoomPanelProps {
  readonly channelName: string
  readonly transport?: ProximityPanelTransport | undefined
  readonly localDisplayName?: string | undefined
  readonly defaultRosterCollapsed?: boolean | undefined
  readonly onCheckIn?:
    ((checkIn: ProximityRosterCheckIn, wireBytes: Uint8Array) => void) | undefined
}

const STATUS_KEYS = {
  [SafetyStatus.Safe]: 'console.workspace.emergency.status-safe',
  [SafetyStatus.NeedAssistance]: 'console.workspace.emergency.status-assistance',
  [SafetyStatus.MusterPoint]: 'console.workspace.emergency.status-muster',
  [SafetyStatus.MessageOnly]: 'console.workspace.emergency.status-note',
} as const

const STATUS_PILLS: Record<SafetyStatus, StatusPillState> = {
  [SafetyStatus.Safe]: 'success',
  [SafetyStatus.NeedAssistance]: 'danger',
  [SafetyStatus.MusterPoint]: 'warning',
  [SafetyStatus.MessageOnly]: 'info',
}

const ACTIONS = [SafetyStatus.Safe, SafetyStatus.NeedAssistance, SafetyStatus.MusterPoint] as const

export function ProximityRoomPanel({ transport, ...props }: ProximityRoomPanelProps) {
  return transport === undefined ? (
    <DisconnectedBar channelName={props.channelName} />
  ) : (
    <ConnectedPanel transport={transport} {...props} />
  )
}

function PanelTitle({ id, channelName }: { readonly id: string; readonly channelName: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-c-ink">
        <ModuleGlyph name="messaging" />
      </span>
      <h2 id={id} className="truncate text-sm font-semibold text-c-ink">
        {t('console.workspace.emergency.title')}
      </h2>
      <span className="truncate text-xs text-c-ink-3">{channelName}</span>
    </div>
  )
}

function DisconnectedBar({ channelName }: { readonly channelName: string }) {
  const { t } = useTranslation()
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      data-testid="proximity-disconnected"
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-c-border-soft bg-c-sunken px-3 py-2"
    >
      <PanelTitle id={headingId} channelName={channelName} />
      <span className="flex items-center gap-2 text-xs text-c-ink-2">
        {t('console.workspace.emergency.disconnected-body')}
        <StatusPill state="neutral">
          {t('console.workspace.emergency.state-disconnected')}
        </StatusPill>
      </span>
    </section>
  )
}

function ConnectedPanel({
  channelName,
  transport,
  localDisplayName,
  defaultRosterCollapsed = false,
  onCheckIn,
}: ProximityRoomPanelProps & { readonly transport: ProximityPanelTransport }) {
  const { t } = useTranslation()
  const headingId = useId()
  const messageInputId = useId()
  const { unixSecs, localSigner } = transport
  const ttl = Math.max(
    1,
    Math.min(MAX_PROXIMITY_TTL_HOPS, transport.defaultTtlHops ?? MAX_PROXIMITY_TTL_HOPS)
  )
  const localName = localDisplayName ?? t('console.workspace.emergency.local-name')

  const [peerRoster, setPeerRoster] = useState<readonly ProximityRosterCheckIn[]>(
    transport.initialRoster
  )
  const [selectedStatus, setSelectedStatus] = useState<SafetyStatus | null>(null)
  const [draftMessage, setDraftMessage] = useState('')
  const [sequenceCounter, setSequenceCounter] = useState(1)
  const [isRosterCollapsed, setIsRosterCollapsed] = useState<boolean>(defaultRosterCollapsed)

  const sortedRoster = useMemo(
    () =>
      [...peerRoster].sort(
        (a, b) =>
          safetyStatusPriority(b.status) - safetyStatusPriority(a.status) ||
          b.timestampMs - a.timestampMs
      ),
    [peerRoster]
  )

  function emit(status: SafetyStatus) {
    const text = truncateUtf8Bytes(draftMessage.trim(), MAX_PROXIMITY_TEXT_BYTES)
    const timestampMs = unixSecs * 1000 + sequenceCounter
    const randBytes = new Uint8Array(10)
    randBytes[0] = sequenceCounter & 0xff
    randBytes[1] = status & 0xff
    const frame = ProximityFrame.newSigned(
      UuidV7.fromParts(timestampMs, randBytes),
      ttl,
      status,
      text,
      localSigner
    )
    const wireBytes = frame.encode()
    const senderPublicKeyHex = bytesToHex(frame.senderPublicKey)
    const checkIn: ProximityRosterCheckIn = {
      messageId: frame.messageId.toString(),
      senderPublicKeyHex,
      displayName: localName,
      status: frame.status,
      text: frame.text,
      ttlHops: frame.ttlHops,
      timestampMs,
      isLocal: true,
    }
    setSequenceCounter((prev) => prev + 1)
    setSelectedStatus(status)
    setPeerRoster((prev) => [
      checkIn,
      ...prev.filter((entry) => entry.senderPublicKeyHex !== senderPublicKeyHex && !entry.isLocal),
    ])
    onCheckIn?.(checkIn, wireBytes)
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <Card>
        <CardBody className="flex flex-col gap-3 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <PanelTitle id={headingId} channelName={channelName} />
            <StatusPill state="success">
              {t('console.workspace.emergency.state-connected')}
            </StatusPill>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={messageInputId} className="text-xs font-medium text-c-ink-2">
              {t('console.workspace.emergency.message-label')}
            </label>
            <input
              id={messageInputId}
              type="text"
              value={draftMessage}
              onChange={(event) =>
                setDraftMessage(truncateUtf8Bytes(event.target.value, MAX_PROXIMITY_TEXT_BYTES))
              }
              placeholder={t('console.workspace.emergency.message-placeholder')}
              className="h-8 rounded-md border border-c-border-input bg-c-surface px-3 text-sm text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
            />
          </div>

          <div
            role="group"
            aria-label={t('console.workspace.emergency.actions-label')}
            className="grid grid-cols-1 gap-2 md:grid-cols-3"
          >
            {ACTIONS.map((status) => {
              const isSelected = selectedStatus === status
              return (
                <button
                  key={status}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => emit(status)}
                  className={
                    isSelected
                      ? 'flex items-center justify-between gap-2 rounded-md border border-c-accent-ink bg-c-accent-soft px-3 py-2 text-left text-xs font-semibold text-c-accent-ink focus-visible:ring focus-visible:outline-hidden'
                      : 'flex items-center justify-between gap-2 rounded-md border border-c-border-soft bg-c-surface px-3 py-2 text-left text-xs font-semibold text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden'
                  }
                >
                  {t(STATUS_KEYS[status])}
                </button>
              )
            })}
          </div>

          {selectedStatus === null ? null : (
            <p
              role="status"
              aria-live="polite"
              className="rounded-md border border-c-ok-border bg-c-ok-soft px-3 py-2 text-xs font-medium text-c-ok-ink"
            >
              {t('console.workspace.emergency.sent', { status: t(STATUS_KEYS[selectedStatus]) })}
            </p>
          )}

          <div className="flex flex-col gap-2 border-t border-c-border-soft pt-2">
            <button
              type="button"
              data-testid="proximity-roster-toggle"
              aria-expanded={!isRosterCollapsed}
              onClick={() => setIsRosterCollapsed((prev) => !prev)}
              className="flex items-center justify-between gap-2 rounded-sm px-2 py-1 text-left text-xs font-semibold text-c-ink-2 hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden"
            >
              <span>
                {t('console.workspace.emergency.roster-count', { count: sortedRoster.length })}
              </span>
              <span className="text-xs text-c-ink-3">
                {t(
                  isRosterCollapsed
                    ? 'console.workspace.emergency.roster-show'
                    : 'console.workspace.emergency.roster-hide'
                )}
              </span>
            </button>
            {isRosterCollapsed ? null : (
              <ul
                aria-label={t('console.workspace.emergency.roster-label')}
                className="flex flex-col gap-2"
              >
                {sortedRoster.map((entry) => (
                  <li
                    key={entry.messageId}
                    className="flex flex-col gap-1 rounded-md border border-c-border-soft bg-c-surface px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-c-ink">
                        {entry.displayName}
                        {entry.roleLabel === undefined ? null : (
                          <span className="ml-2 text-xs font-regular text-c-ink-3">
                            {entry.roleLabel}
                          </span>
                        )}
                      </span>
                      <StatusPill state={STATUS_PILLS[entry.status]}>
                        {t(STATUS_KEYS[entry.status])}
                      </StatusPill>
                    </div>
                    {entry.text.length > 0 ? (
                      <p className="text-xs font-regular text-c-ink-2">{entry.text}</p>
                    ) : null}
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
