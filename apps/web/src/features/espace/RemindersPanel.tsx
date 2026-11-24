// Personal Reminders dialog (opened from MessageRow) and RemindersPanel popover (in EspaceChannelHeader).
// Strictly hidden and refused whenever the room boundary does not permit plaintext.

import { useEffect, useId, useState, useSyncExternalStore, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiProblem } from '../../api/client'
import { formatTime } from '../../i18n/format'
import { Button } from '../../ui/Button/Button'
import { Dialog } from '../../ui/Dialog/Dialog'
import { Popover } from '../../ui/Popover/Popover'
import {
  createPersonalReminder,
  deletePersonalReminder,
  getRemindersRevision,
  listPersonalReminders,
  subscribeRemindersRevision,
  updatePersonalReminder,
  useExperiencePreferences,
  type PersonalReminderItem,
} from './experienceApi'
import { experienceCopy } from './experienceMessages'

function BellIcon() {
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
      <path d="M8 2.2a3.8 3.8 0 0 0-3.8 3.8v2.6L3 10.5h10l-1.2-1.9V6A3.8 3.8 0 0 0 8 2.2z" />
      <path d="M6.6 12.2a1.6 1.6 0 0 0 2.8 0" />
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

export function ReminderCreateDialog({
  open,
  onOpenChange,
  organisationId,
  channelId,
  roomId,
  targetEventId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  organisationId: string
  channelId?: string | undefined
  roomId?: string | undefined
  targetEventId: string
}) {
  const { i18n } = useTranslation()
  const copy = experienceCopy(i18n.resolvedLanguage).reminders
  const customId = useId()
  const noteId = useId()
  const [customValue, setCustomValue] = useState(() =>
    toLocalInputValue(new Date(Date.now() + 3_600_000))
  )
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function saveAt(isoTime: string) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await createPersonalReminder(organisationId, {
        channelId,
        roomId,
        targetEventId,
        note: note.trim(),
        remindAt: isoTime,
      })
      setNote('')
      onOpenChange(false)
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
    void saveAt(parsed.toISOString())
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null)
        onOpenChange(next)
      }}
      title={copy.dialogTitle}
      closeLabel={copy.closeAction}
      size="sm"
    >
      <div data-testid="reminder-create-dialog" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor={noteId} className="text-xs font-semibold text-c-ink-2">
            {copy.noteLabel}
          </label>
          <textarea
            id={noteId}
            rows={2}
            maxLength={500}
            value={note}
            placeholder={copy.notePlaceholder}
            onChange={(event) => setNote(event.target.value)}
            className="rounded-md border border-c-border-input bg-c-surface px-3 py-2 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void saveAt(new Date(Date.now() + 20 * 60_000).toISOString())}
          >
            {copy.preset20m}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void saveAt(new Date(Date.now() + 3_600_000).toISOString())}
          >
            {copy.preset1h}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void saveAt(tomorrowMorningIso())}
          >
            {copy.presetTomorrow}
          </Button>
        </div>

        <form onSubmit={handleCustomSubmit} className="flex flex-col gap-2 border-t border-c-border-soft pt-3">
          <label htmlFor={customId} className="text-xs font-semibold text-c-ink-2">
            {copy.customLabel}
          </label>
          <div className="flex items-center gap-2">
            <input
              id={customId}
              type="datetime-local"
              value={customValue}
              onChange={(event) => {
                setCustomValue(event.target.value)
                setError(null)
              }}
              className="h-10 min-w-0 flex-1 rounded-md border border-c-border-input bg-c-surface px-2 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
            />
            <Button type="submit" variant="primary" size="sm" disabled={busy}>
              {busy ? copy.saving : copy.saveAction}
            </Button>
          </div>
        </form>

        {error !== null ? (
          <p role="alert" className="text-xs text-c-bad-ink">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}

export function RemindersPanel({
  organisationId,
  plaintextPermitted,
  onShowMessage,
}: {
  organisationId: string | null
  plaintextPermitted: boolean
  onShowMessage?: ((eventId: string) => boolean) | undefined
}) {
  const { i18n } = useTranslation()
  const locale = i18n.resolvedLanguage === 'en' ? 'en' : 'fr'
  const copy = experienceCopy(i18n.resolvedLanguage).reminders
  const prefs = useExperiencePreferences(organisationId)
  const revision = useSyncExternalStore(subscribeRemindersRevision, () =>
    getRemindersRevision(organisationId)
  )
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<readonly PersonalReminderItem[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (!organisationId || !plaintextPermitted || !prefs.labsFlags.personal_reminders) return
    if (!open && revision === 0) return
    let live = true
    void listPersonalReminders(organisationId)
      .then((rows) => {
        if (live) setItems(rows)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [organisationId, plaintextPermitted, prefs.labsFlags.personal_reminders, open, revision])

  if (!organisationId || !plaintextPermitted || !prefs.labsFlags.personal_reminders) {
    return null
  }

  const label = items.length > 0 ? copy.headerButtonCount(items.length) : copy.headerButton

  async function handleSnooze(item: PersonalReminderItem) {
    if (!organisationId || busyId !== null) return
    setBusyId(item.id)
    try {
      const updated = await updatePersonalReminder(organisationId, item.id, {
        remindAt: new Date(Date.now() + 3_600_000).toISOString(),
        state: 'snoozed',
      })
      setItems((prev) => prev.map((r) => (r.id === item.id ? updated : r)))
    } finally {
      setBusyId(null)
    }
  }

  async function handleComplete(item: PersonalReminderItem) {
    if (!organisationId || busyId !== null) return
    setBusyId(item.id)
    try {
      await updatePersonalReminder(organisationId, item.id, { state: 'completed' })
      setItems((prev) => prev.filter((r) => r.id !== item.id))
    } finally {
      setBusyId(null)
    }
  }

  async function handleDelete(item: PersonalReminderItem) {
    if (!organisationId || busyId !== null) return
    setBusyId(item.id)
    try {
      await deletePersonalReminder(organisationId, item.id)
      setItems((prev) => prev.filter((r) => r.id !== item.id))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      label={copy.panelHeading}
      trigger={
        <Button
          variant="tertiary"
          size="sm"
          icon={<BellIcon />}
          iconOnly
          aria-label={label}
          data-testid="reminders-panel-trigger"
        />
      }
    >
      <div data-testid="reminders-panel" className="flex w-[288px] flex-col gap-3 text-c-ink">
        <p className="text-xs font-semibold text-c-ink-2">{copy.panelHeading}</p>
        {items.length === 0 ? (
          <p className="text-xs text-c-ink-3">{copy.empty}</p>
        ) : (
          <ul className="flex max-h-[256px] flex-col gap-2 overflow-y-auto">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-1 rounded-md border border-c-border-soft bg-c-sunken p-2 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-c-ink-3">
                    {formatTime(item.remindAt, locale)}
                  </span>
                  <span className="rounded-full bg-c-accent-soft px-2 py-[1px] font-medium text-c-accent-ink">
                    {item.state === 'fired'
                      ? copy.firedBadge
                      : item.state === 'snoozed'
                        ? copy.snoozedBadge
                        : copy.pendingBadge}
                  </span>
                </div>
                {item.note ? (
                  <p className="break-words text-c-ink">{item.note}</p>
                ) : null}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {onShowMessage ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (onShowMessage(item.targetEventId)) setOpen(false)
                      }}
                      className="rounded-sm font-medium text-c-accent-ink hover:underline focus-visible:ring focus-visible:outline-hidden"
                    >
                      {copy.jumpAction}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={busyId === item.id}
                    onClick={() => void handleSnooze(item)}
                    className="rounded-sm text-c-ink-2 hover:underline focus-visible:ring focus-visible:outline-hidden"
                  >
                    {copy.snooze1hAction}
                  </button>
                  <button
                    type="button"
                    disabled={busyId === item.id}
                    onClick={() => void handleComplete(item)}
                    className="rounded-sm text-c-ink-2 hover:underline focus-visible:ring focus-visible:outline-hidden"
                  >
                    {copy.completeAction}
                  </button>
                  <button
                    type="button"
                    disabled={busyId === item.id}
                    onClick={() => void handleDelete(item)}
                    className="ml-auto rounded-sm text-c-bad-ink hover:underline focus-visible:ring focus-visible:outline-hidden"
                  >
                    {copy.deleteAction}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Popover>
  )
}
