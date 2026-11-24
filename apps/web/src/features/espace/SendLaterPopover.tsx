// Send Later popover + scheduled messages banner in MessageComposer.
// Strictly hidden and refused whenever the room boundary does not permit plaintext.

import { useEffect, useId, useState, useSyncExternalStore, type FormEvent, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiProblem } from '../../api/client'
import { formatTime } from '../../i18n/format'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { Popover } from '../../ui/Popover/Popover'
import { TOUCH_TARGET } from '../../ui/touchTarget'
import {
  cancelScheduledMessage,
  createScheduledMessage,
  getScheduledRevision,
  listScheduledMessages,
  subscribeScheduledRevision,
  useExperiencePreferences,
  type ScheduledMessageItem,
} from './experienceApi'
import { experienceCopy } from './experienceMessages'

function ClockIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8V8l2.2 1.6" />
    </svg>
  )
}

function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function tomorrowMorningIso(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d.toISOString()
}

export function SendLaterPopover({
  organisationId,
  channelId,
  roomId,
  plaintextPermitted,
  disabled,
  draftText,
  anchorRef,
  onScheduled,
}: {
  organisationId: string | null
  channelId?: string | undefined
  roomId: string
  plaintextPermitted: boolean
  disabled?: boolean | undefined
  draftText: string
  anchorRef?: RefObject<HTMLElement | null>
  onScheduled: () => void
}) {
  const { i18n } = useTranslation()
  const copy = experienceCopy(i18n.resolvedLanguage).sendLater
  const prefs = useExperiencePreferences(organisationId)
  const [open, setOpen] = useState(false)
  const [customValue, setCustomValue] = useState(() =>
    toLocalInputValue(new Date(Date.now() + 3_600_000))
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const customInputId = useId()

  if (!organisationId || !plaintextPermitted || !prefs.labsFlags.send_later) {
    return null
  }

  const trimmed = draftText.trim()

  async function scheduleAt(isoTime: string) {
    if (!organisationId || !plaintextPermitted || busy) return
    if (!trimmed) {
      setError(copy.emptyDraftHint)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await createScheduledMessage(organisationId, {
        channelId,
        roomId,
        body: trimmed,
        deliverAt: isoTime,
      })
      onScheduled()
      setOpen(false)
    } catch (err) {
      if (err instanceof ApiProblem && err.status === 403) {
        setError(copy.errConfidential)
      } else if (err instanceof ApiProblem && err.status === 422) {
        setError(copy.errPast)
      } else {
        setError(copy.errGeneric)
      }
    } finally {
      setBusy(false)
    }
  }

  function handleCustomSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsed = new Date(customValue)
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now() + 5_000) {
      setError(copy.errPast)
      return
    }
    void scheduleAt(parsed.toISOString())
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setError(null)
          setCustomValue(toLocalInputValue(new Date(Date.now() + 3_600_000)))
        }
        setOpen(next)
      }}
      side="top"
      align="end"
      {...(anchorRef === undefined ? {} : { anchorRef })}
      label={copy.popoverLabel}
      trigger={
        <button
          type="button"
          data-testid="send-later-trigger"
          aria-label={copy.triggerLabel}
          title={copy.triggerLabel}
          disabled={disabled}
          className={cx(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-c-ink-3',
            'hover:bg-c-sunken hover:text-c-ink',
            'disabled:cursor-not-allowed disabled:text-c-on-disabled disabled:hover:bg-transparent',
            'data-[state=open]:bg-c-sunken data-[state=open]:text-c-ink',
            TOUCH_TARGET,
            'focus-visible:ring focus-visible:outline-hidden'
          )}
        >
          <ClockIcon />
        </button>
      }
    >
      <div data-testid="send-later-popover" className="flex w-[256px] flex-col gap-3 text-c-ink">
        <p className="text-xs font-semibold text-c-ink-2">{copy.heading}</p>
        <div className="flex flex-col gap-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => void scheduleAt(new Date(Date.now() + 30 * 60_000).toISOString())}
            className="rounded-sm px-2 py-1 text-left text-sm hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden"
          >
            {copy.preset30m}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void scheduleAt(new Date(Date.now() + 2 * 3_600_000).toISOString())}
            className="rounded-sm px-2 py-1 text-left text-sm hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden"
          >
            {copy.preset2h}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void scheduleAt(tomorrowMorningIso())}
            className="rounded-sm px-2 py-1 text-left text-sm hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden"
          >
            {copy.presetTomorrow}
          </button>
        </div>

        <form onSubmit={handleCustomSubmit} className="flex flex-col gap-2 border-t border-c-border-soft pt-2">
          <label htmlFor={customInputId} className="text-xs font-medium text-c-ink-2">
            {copy.customLabel}
          </label>
          <input
            id={customInputId}
            type="datetime-local"
            value={customValue}
            onChange={(event) => {
              setCustomValue(event.target.value)
              setError(null)
            }}
            className="h-8 rounded-sm border border-c-border-input bg-c-surface px-2 text-xs text-c-ink focus-visible:ring focus-visible:outline-hidden"
          />
          <Button type="submit" variant="primary" size="sm" disabled={busy}>
            {busy ? copy.scheduling : copy.scheduleAction}
          </Button>
        </form>

        {error !== null ? (
          <p role="alert" className="text-xs text-c-bad-ink">
            {error}
          </p>
        ) : null}
      </div>
    </Popover>
  )
}

export function ScheduledMessagesBanner({
  organisationId,
  channelId,
  roomId,
  plaintextPermitted,
}: {
  organisationId: string | null
  channelId?: string | undefined
  roomId: string
  plaintextPermitted: boolean
}) {
  const { i18n } = useTranslation()
  const locale = i18n.resolvedLanguage === 'en' ? 'en' : 'fr'
  const copy = experienceCopy(i18n.resolvedLanguage).sendLater
  const prefs = useExperiencePreferences(organisationId)
  const revision = useSyncExternalStore(subscribeScheduledRevision, () =>
    getScheduledRevision(organisationId)
  )
  const [items, setItems] = useState<readonly ScheduledMessageItem[]>([])
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    // Only fetch after a scheduling mutation in this session (revision > 0) or when channel changes
    // if items were already observed, keeping cold test mounts network-silent unless scheduled.
    if (!organisationId || !plaintextPermitted || !prefs.labsFlags.send_later || revision === 0) {
      return
    }
    let live = true
    void listScheduledMessages(organisationId, channelId)
      .then((rows) => {
        if (!live) return
        setItems(
          rows.filter(
            (item) =>
              (item.state === 'pending' || item.state === 'in_flight') &&
              (channelId ? item.channelId === channelId : item.roomId === roomId)
          )
        )
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [organisationId, channelId, roomId, plaintextPermitted, prefs.labsFlags.send_later, revision])

  if (!organisationId || !plaintextPermitted || !prefs.labsFlags.send_later || items.length === 0) {
    return null
  }

  async function handleCancel(id: string) {
    if (!organisationId) return
    try {
      await cancelScheduledMessage(organisationId, id)
      setItems((prev) => prev.filter((item) => item.id !== id))
    } catch {
      // Retain row if cancellation failed.
    }
  }

  return (
    <div
      data-testid="scheduled-messages-banner"
      className="flex flex-col gap-2 rounded-md border border-c-border-soft bg-c-sunken px-3 py-2 text-xs text-c-ink-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-c-ink">{copy.scheduledBanner(items.length)}</span>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
          className="rounded-sm px-1 font-medium text-c-accent-ink hover:underline focus-visible:ring focus-visible:outline-hidden"
        >
          {expanded ? copy.hideScheduled : copy.showScheduled}
        </button>
      </div>
      {expanded ? (
        <ul className="flex flex-col gap-1 border-t border-c-border-soft pt-2">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="shrink-0 font-mono text-c-ink-3">
                  {formatTime(item.deliverAt, locale)}
                </span>
                <span className="min-w-0 truncate text-c-ink">{item.body}</span>
              </div>
              {item.state === 'pending' ? (
                <button
                  type="button"
                  onClick={() => void handleCancel(item.id)}
                  className="shrink-0 rounded-sm px-1 text-c-bad-ink hover:underline focus-visible:ring focus-visible:outline-hidden"
                >
                  {copy.cancelAction}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
