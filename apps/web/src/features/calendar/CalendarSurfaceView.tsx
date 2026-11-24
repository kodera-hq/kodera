import { cx } from '@/ui/cx'
import { TOUCH_TARGET } from '@/ui/touchTarget'
import { lazy, Suspense, useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  defaultCalendarTransport,
  expandCalendarOccurrencesInWindow,
  safeHttpsHref,
  triggerIcsDownload,
  type BookingPageItem,
  type CaldavSourceItem,
  type CalendarEventItem,
  type CalendarTransport,
  type PublicBookingTransport,
} from './calendarApi'
import { calendarCopy } from './calendarMessages'

const LazyBookingPublicPage = lazy(() =>
  import('./BookingPublicPage').then((m) => ({ default: m.BookingPublicPage }))
)

export type CalendarGridMode = 'week' | 'month'
type ActiveDrawer = 'event' | 'caldav' | 'booking' | null

export interface CalendarSurfaceViewProps {
  readonly organisationId: string
  readonly initialDate?: Date | undefined
  readonly initialMode?: CalendarGridMode | undefined
  readonly transport?: CalendarTransport | undefined
  readonly publicBookingTransport?: PublicBookingTransport | undefined
  readonly onDownloadIcs?: ((filename: string, ics: string) => void) | undefined
}

function startOfUtcWeek(anchor: Date): Date {
  const day = anchor.getUTCDay()
  const mondayOffset = day === 0 ? -6 : 1 - day
  return new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate() + mondayOffset)
  )
}

function addUtcDays(base: Date, days: number): Date {
  return new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days)
  )
}

function formatDayIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

function formatTimeUtc(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

function toDatetimeLocalUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

function fromDatetimeLocalUtc(raw: string): string {
  if (raw.endsWith('Z')) return raw
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) {
    return `${raw}:00Z`
  }
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString()
}

function isForbiddenError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status?: unknown }).status === 403
  )
}

export function CalendarSurfaceView({
  organisationId,
  initialDate,
  initialMode = 'week',
  transport = defaultCalendarTransport,
  publicBookingTransport,
  onDownloadIcs,
}: CalendarSurfaceViewProps) {
  const { i18n } = useTranslation()
  const copy = calendarCopy(i18n.resolvedLanguage)

  const [gridMode, setGridMode] = useState<CalendarGridMode>(initialMode)
  const [cursorDate, setCursorDate] = useState<Date>(() => initialDate ?? new Date())
  const [activeDrawer, setActiveDrawer] = useState<ActiveDrawer>(null)

  const [events, setEvents] = useState<readonly CalendarEventItem[]>([])
  const [sources, setSources] = useState<readonly CaldavSourceItem[]>([])
  const [canManageSources, setCanManageSources] = useState<boolean>(true)
  const [bookingPages, setBookingPages] = useState<readonly BookingPageItem[]>([])
  const [previewSlug, setPreviewSlug] = useState<string | null>(null)

  const [loading, setLoading] = useState<boolean>(true)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Event creation state
  const eventTitleId = useId()
  const eventStartId = useId()
  const eventEndId = useId()
  const eventRecurrenceId = useId()
  const eventVisibilityId = useId()
  const eventVisioId = useId()
  const eventAgendaId = useId()

  const [eventTitle, setEventTitle] = useState<string>('')
  const [eventStart, setEventStart] = useState<string>(() => {
    const base = initialDate ?? new Date()
    const start = new Date(
      Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 9, 0)
    )
    return toDatetimeLocalUtc(start)
  })
  const [eventEnd, setEventEnd] = useState<string>(() => {
    const base = initialDate ?? new Date()
    const end = new Date(
      Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 10, 0)
    )
    return toDatetimeLocalUtc(end)
  })
  const [eventRrule, setEventRrule] = useState<string>('')
  const [eventVisibility, setEventVisibility] = useState<'workspace' | 'private'>('workspace')
  const [eventVisioUrl, setEventVisioUrl] = useState<string>('')
  const [eventAgendaUrl, setEventAgendaUrl] = useState<string>('')

  // CalDAV drawer state
  const calProviderId = useId()
  const calNameId = useId()
  const calUrlId = useId()
  const calUserId = useId()
  const calPassId = useId()

  const [calProvider, setCalProvider] = useState<
    'lasuite' | 'open_xchange' | 'nextcloud' | 'generic'
  >('lasuite')
  const [calName, setCalName] = useState<string>('')
  const [calUrl, setCalUrl] = useState<string>('')
  const [calUsername, setCalUsername] = useState<string>('')
  const [calPassword, setCalPassword] = useState<string>('')

  // Booking builder state
  const bkSlugId = useId()
  const bkTitleId = useId()
  const bkDurationId = useId()
  const bkBufferId = useId()
  const bkWeekdayId = useId()
  const bkStartId = useId()
  const bkEndId = useId()
  const bkVisioId = useId()

  const [bkSlug, setBkSlug] = useState<string>('')
  const [bkTitle, setBkTitle] = useState<string>('')
  const [bkDuration, setBkDuration] = useState<15 | 30 | 45 | 60>(30)
  const [bkBuffer, setBkBuffer] = useState<number>(10)
  const [bkWeekday, setBkWeekday] = useState<number>(0)
  const [bkWinStart, setBkWinStart] = useState<string>('09:00')
  const [bkWinEnd, setBkWinEnd] = useState<string>('17:00')
  const [bkVisioUrl, setBkVisioUrl] = useState<string>('')

  const gridDays = useMemo<readonly Date[]>(() => {
    if (gridMode === 'week') {
      const start = startOfUtcWeek(cursorDate)
      return Array.from({ length: 7 }, (_, i) => addUtcDays(start, i))
    }
    const firstOfMonth = new Date(
      Date.UTC(cursorDate.getUTCFullYear(), cursorDate.getUTCMonth(), 1)
    )
    const start = startOfUtcWeek(firstOfMonth)
    return Array.from({ length: 42 }, (_, i) => addUtcDays(start, i))
  }, [cursorDate, gridMode])

  const windowBounds = useMemo(() => {
    const first = gridDays[0]!
    const last = addUtcDays(gridDays[gridDays.length - 1]!, 1)
    return {
      from: first.toISOString(),
      to: last.toISOString(),
    }
  }, [gridDays])

  const errorText = copy.errorGeneric

  useEffect(() => {
    let cancelled = false
    const sourcesPromise = transport
      .listSources(organisationId)
      .then((rows) => ({ allowed: true as const, rows }))
      .catch((err: unknown) => {
        if (isForbiddenError(err)) {
          return { allowed: false as const, rows: [] as readonly CaldavSourceItem[] }
        }
        throw err
      })
    void Promise.all([
      transport.listEvents(organisationId, windowBounds),
      sourcesPromise,
      transport.listBookingPages(organisationId),
    ])
      .then(([evList, srcResult, pgList]) => {
        if (cancelled) return
        setEvents(evList)
        setSources(srcResult.rows)
        setCanManageSources(srcResult.allowed)
        if (!srcResult.allowed) {
          setActiveDrawer((prev) => (prev === 'caldav' ? null : prev))
        }
        setBookingPages(pgList)
        setErrorMessage(null)
      })
      .catch(() => {
        if (!cancelled) setErrorMessage(errorText)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [errorText, organisationId, transport, windowBounds])

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEventItem[]>()
    const winStart = gridDays[0]!
    const winEnd = addUtcDays(gridDays[gridDays.length - 1]!, 1)
    for (const ev of events) {
      if (ev.status === 'cancelled') continue
      const occDates = expandCalendarOccurrencesInWindow(ev, winStart, winEnd)
      const seenKeys = new Set<string>()
      for (const occ of occDates) {
        const key = formatDayIso(occ)
        if (seenKeys.has(key)) continue
        seenKeys.add(key)
        const bucket = map.get(key) ?? []
        bucket.push(ev)
        map.set(key, bucket)
      }
    }
    return map
  }, [events, gridDays])

  const periodHeading = useMemo(() => {
    const first = gridDays[0]!
    const last = gridDays[gridDays.length - 1]!
    if (gridMode === 'week') {
      return `${formatDayIso(first)} → ${formatDayIso(last)}`
    }
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${String(cursorDate.getUTCFullYear())}-${pad(cursorDate.getUTCMonth() + 1)}`
  }, [cursorDate, gridDays, gridMode])

  const shiftPeriod = (direction: -1 | 1) => {
    setCursorDate((prev) =>
      gridMode === 'week'
        ? addUtcDays(prev, direction * 7)
        : new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + direction, 1))
    )
  }

  const handleExportIcs = async () => {
    setErrorMessage(null)
    try {
      const exported = await transport.exportIcs(organisationId)
      if (onDownloadIcs !== undefined) {
        onDownloadIcs(exported.filename, exported.ics)
      } else {
        triggerIcsDownload(exported.filename, exported.ics)
      }
    } catch {
      setErrorMessage(copy.errorGeneric)
    }
  }

  const handleCreateEvent = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!eventTitle.trim()) return
    setErrorMessage(null)
    try {
      const created = await transport.createEvent(organisationId, {
        title: eventTitle.trim(),
        startsAt: fromDatetimeLocalUtc(eventStart),
        endsAt: fromDatetimeLocalUtc(eventEnd),
        visibility: eventVisibility,
        ...(eventRrule ? { rrule: eventRrule } : {}),
        ...(eventVisioUrl.trim() ? { visioUrl: eventVisioUrl.trim() } : {}),
        ...(eventAgendaUrl.trim() ? { agendaDocUrl: eventAgendaUrl.trim() } : {}),
      })
      setEvents((prev) => [...prev, created])
      setEventTitle('')
      setEventVisioUrl('')
      setEventAgendaUrl('')
      setActiveDrawer(null)
    } catch {
      setErrorMessage(copy.errorGeneric)
    }
  }

  const handleDeleteEvent = async (eventId: string) => {
    setErrorMessage(null)
    try {
      await transport.deleteEvent(organisationId, eventId)
      setEvents((prev) => prev.filter((item) => item.id !== eventId))
    } catch {
      setErrorMessage(copy.errorGeneric)
    }
  }

  const handleCreateCaldavSource = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!calName.trim() || !calUrl.trim() || !calUsername.trim() || !calPassword) return
    setErrorMessage(null)
    try {
      const created = await transport.createSource(organisationId, {
        name: calName.trim(),
        provider: calProvider,
        calendarUrl: calUrl.trim(),
        username: calUsername.trim(),
        password: calPassword,
      })
      setSources((prev) => [created, ...prev])
      setCalName('')
      setCalUrl('')
      setCalUsername('')
      setCalPassword('')
    } catch {
      setErrorMessage(copy.errorGeneric)
    }
  }

  const handleSyncSource = async (sourceId: string) => {
    setErrorMessage(null)
    setStatusMessage(null)
    try {
      const res = await transport.syncSource(organisationId, sourceId)
      setStatusMessage(copy.caldav.syncSummary(res.upserted, res.removed))
      const [evList, srcList] = await Promise.all([
        transport.listEvents(organisationId, windowBounds),
        transport.listSources(organisationId),
      ])
      setEvents(evList)
      setSources(srcList)
    } catch {
      setErrorMessage(copy.errorGeneric)
    }
  }

  const handleRemoveSource = async (sourceId: string) => {
    setErrorMessage(null)
    try {
      await transport.deleteSource(organisationId, sourceId)
      setSources((prev) => prev.filter((s) => s.id !== sourceId))
    } catch {
      setErrorMessage(copy.errorGeneric)
    }
  }

  const handleCreateBookingPage = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!bkSlug.trim() || !bkTitle.trim()) return
    setErrorMessage(null)
    try {
      const created = await transport.createBookingPage(organisationId, {
        slug: bkSlug.trim().toLowerCase(),
        title: bkTitle.trim(),
        durationMinutes: bkDuration,
        bufferMinutes: bkBuffer,
        availabilityWindows: [
          {
            weekday: bkWeekday,
            start: bkWinStart,
            end: bkWinEnd,
          },
        ],
        ...(bkVisioUrl.trim() ? { visioUrl: bkVisioUrl.trim() } : {}),
      })
      setBookingPages((prev) => [created, ...prev])
      setBkSlug('')
      setBkTitle('')
      setBkVisioUrl('')
    } catch {
      setErrorMessage(copy.errorGeneric)
    }
  }

  const handleDeactivateBookingPage = async (pageId: string, slug: string) => {
    setErrorMessage(null)
    try {
      await transport.deleteBookingPage(organisationId, pageId)
      setBookingPages((prev) => prev.filter((p) => p.id !== pageId))
      if (previewSlug === slug) setPreviewSlug(null)
    } catch {
      setErrorMessage(copy.errorGeneric)
    }
  }

  return (
    <section
      aria-label={copy.surfaceTitle}
      data-testid="calendar-surface-view"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-c-surface p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-c-border-soft pb-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-c-ink">{copy.surfaceTitle}</h1>
          <p className="text-sm font-regular text-c-ink-2">{copy.surfaceSubtitle}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label={copy.surfaceTitle} className="flex items-center gap-1">
            {(['week', 'month'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={gridMode === m}
                onClick={() => setGridMode(m)}
                className={cx(
                  'inline-flex min-h-8 items-center justify-center rounded-md border px-3 py-1 text-xs font-semibold focus-visible:ring focus-visible:outline-hidden',
                  TOUCH_TARGET,
                  gridMode === m
                    ? 'border-c-accent-ink bg-c-accent-soft text-c-accent-ink'
                    : 'border-c-border bg-c-surface text-c-ink-2 hover:bg-c-muted'
                )}
              >
                {copy.views[m]}
              </button>
            ))}
          </div>

          {canManageSources && (
            <button
              type="button"
              onClick={() => setActiveDrawer((prev) => (prev === 'caldav' ? null : 'caldav'))}
              aria-expanded={activeDrawer === 'caldav'}
              className={cx(
                'inline-flex min-h-8 items-center justify-center rounded-md border border-c-border bg-c-surface px-3 py-1 text-xs font-medium text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden',
                TOUCH_TARGET
              )}
            >
              {copy.actions.caldavDrawer}
            </button>
          )}

          <button
            type="button"
            onClick={() => setActiveDrawer((prev) => (prev === 'booking' ? null : 'booking'))}
            aria-expanded={activeDrawer === 'booking'}
            className={cx(
              'inline-flex min-h-8 items-center justify-center rounded-md border border-c-border bg-c-surface px-3 py-1 text-xs font-medium text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden',
              TOUCH_TARGET
            )}
          >
            {copy.actions.bookingDrawer}
          </button>

          <button
            type="button"
            onClick={handleExportIcs}
            className={cx(
              'inline-flex min-h-8 items-center justify-center rounded-md border border-c-border bg-c-muted px-3 py-1 text-xs font-semibold text-c-ink hover:bg-c-muted-2 focus-visible:ring focus-visible:outline-hidden',
              TOUCH_TARGET
            )}
          >
            {copy.actions.exportIcs}
          </button>

          <button
            type="button"
            onClick={() => setActiveDrawer((prev) => (prev === 'event' ? null : 'event'))}
            aria-expanded={activeDrawer === 'event'}
            className={cx(
              'inline-flex min-h-8 items-center justify-center rounded-md border border-c-action bg-c-action px-3 py-1 text-xs font-semibold text-c-on-inverse hover:bg-c-action-hover focus-visible:ring focus-visible:outline-hidden',
              TOUCH_TARGET
            )}
          >
            {copy.actions.newEvent}
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={copy.nav.previous}
            onClick={() => shiftPeriod(-1)}
            className={cx(
              'inline-flex min-h-8 items-center justify-center rounded-md border border-c-border bg-c-surface px-2 py-1 font-mono text-xs font-medium text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden',
              TOUCH_TARGET
            )}
          >
            ←
          </button>
          <button
            type="button"
            onClick={() => setCursorDate(initialDate ?? new Date())}
            className={cx(
              'inline-flex min-h-8 items-center justify-center rounded-md border border-c-border bg-c-surface px-3 py-1 text-xs font-medium text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden',
              TOUCH_TARGET
            )}
          >
            {copy.nav.today}
          </button>
          <button
            type="button"
            aria-label={copy.nav.next}
            onClick={() => shiftPeriod(1)}
            className={cx(
              'inline-flex min-h-8 items-center justify-center rounded-md border border-c-border bg-c-surface px-2 py-1 font-mono text-xs font-medium text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden',
              TOUCH_TARGET
            )}
          >
            →
          </button>
          <span
            data-testid="calendar-period-heading"
            className="font-mono text-sm font-medium text-c-ink"
          >
            {periodHeading}
          </span>
        </div>

        {statusMessage !== null && (
          <span
            role="status"
            className="rounded-md bg-c-ok-soft px-3 py-1 text-xs font-medium text-c-ok-ink"
          >
            {statusMessage}
          </span>
        )}
      </div>

      {errorMessage !== null && (
        <p
          role="alert"
          className="rounded-md bg-c-bad-soft px-3 py-2 text-xs font-medium text-c-bad-ink"
        >
          {errorMessage}
        </p>
      )}

      {activeDrawer === 'event' && (
        <section
          aria-label={copy.eventForm.heading}
          data-testid="calendar-event-drawer"
          className="flex flex-col gap-3 rounded-lg border border-c-border bg-c-muted p-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-c-ink">{copy.eventForm.heading}</h2>
            <button
              type="button"
              onClick={() => setActiveDrawer(null)}
              className="text-xs font-medium text-c-ink-2 hover:underline focus-visible:ring focus-visible:outline-hidden"
            >
              {copy.actions.closeDrawer}
            </button>
          </div>
          <form onSubmit={handleCreateEvent} className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1 md:col-span-2">
              <label htmlFor={eventTitleId} className="text-xs font-medium text-c-ink">
                {copy.eventForm.titleLabel}
              </label>
              <input
                id={eventTitleId}
                type="text"
                required
                maxLength={255}
                value={eventTitle}
                onChange={(e) => setEventTitle(e.target.value)}
                placeholder={copy.eventForm.titlePlaceholder}
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={eventStartId} className="text-xs font-medium text-c-ink">
                {copy.eventForm.startLabel}
              </label>
              <input
                id={eventStartId}
                type="datetime-local"
                required
                value={eventStart}
                onChange={(e) => setEventStart(e.target.value)}
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 font-mono text-xs text-c-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={eventEndId} className="text-xs font-medium text-c-ink">
                {copy.eventForm.endLabel}
              </label>
              <input
                id={eventEndId}
                type="datetime-local"
                required
                value={eventEnd}
                onChange={(e) => setEventEnd(e.target.value)}
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 font-mono text-xs text-c-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={eventRecurrenceId} className="text-xs font-medium text-c-ink">
                {copy.eventForm.recurrenceLabel}
              </label>
              <select
                id={eventRecurrenceId}
                value={eventRrule}
                onChange={(e) => setEventRrule(e.target.value)}
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
              >
                <option value="">{copy.eventForm.recurrenceNone}</option>
                <option value="FREQ=DAILY">{copy.eventForm.recurrenceDaily}</option>
                <option value="FREQ=WEEKLY">{copy.eventForm.recurrenceWeekly}</option>
                <option value="FREQ=MONTHLY">{copy.eventForm.recurrenceMonthly}</option>
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={eventVisibilityId} className="text-xs font-medium text-c-ink">
                {copy.eventForm.visibilityLabel}
              </label>
              <select
                id={eventVisibilityId}
                value={eventVisibility}
                onChange={(e) =>
                  setEventVisibility(e.target.value === 'private' ? 'private' : 'workspace')
                }
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
              >
                <option value="workspace">{copy.eventForm.visibilityWorkspace}</option>
                <option value="private">{copy.eventForm.visibilityPrivate}</option>
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={eventVisioId} className="text-xs font-medium text-c-ink">
                {copy.eventForm.visioLabel}
              </label>
              <input
                id={eventVisioId}
                type="url"
                value={eventVisioUrl}
                onChange={(e) => setEventVisioUrl(e.target.value)}
                placeholder={copy.eventForm.visioPlaceholder}
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={eventAgendaId} className="text-xs font-medium text-c-ink">
                {copy.eventForm.agendaLabel}
              </label>
              <input
                id={eventAgendaId}
                type="url"
                value={eventAgendaUrl}
                onChange={(e) => setEventAgendaUrl(e.target.value)}
                placeholder={copy.eventForm.agendaPlaceholder}
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex justify-end md:col-span-2">
              <button
                type="submit"
                className={cx(
                  'inline-flex min-h-8 items-center justify-center rounded-md border border-c-action bg-c-action px-4 py-1 text-xs font-semibold text-c-on-inverse hover:bg-c-action-hover focus-visible:ring focus-visible:outline-hidden',
                  TOUCH_TARGET
                )}
              >
                {copy.eventForm.submit}
              </button>
            </div>
          </form>
        </section>
      )}

      {canManageSources && activeDrawer === 'caldav' && (
        <section
          aria-label={copy.caldav.heading}
          data-testid="calendar-caldav-drawer"
          className="flex flex-col gap-4 rounded-lg border border-c-border bg-c-muted p-4"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold text-c-ink">{copy.caldav.heading}</h2>
              <p className="text-xs text-c-ink-2">{copy.caldav.subtitle}</p>
            </div>
            <button
              type="button"
              onClick={() => setActiveDrawer(null)}
              className="text-xs font-medium text-c-ink-2 hover:underline focus-visible:ring focus-visible:outline-hidden"
            >
              {copy.actions.closeDrawer}
            </button>
          </div>

          <div className="flex flex-col gap-2">
            {sources.length === 0 ? (
              <p className="text-xs text-c-ink-2">{copy.caldav.emptySources}</p>
            ) : (
              sources.map((src) => (
                <div
                  key={src.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-c-border bg-c-surface p-3"
                >
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <strong className="text-sm font-semibold text-c-ink">{src.name}</strong>
                      <span className="rounded-sm bg-c-accent-soft px-2 py-1 text-xs font-medium text-c-accent-ink">
                        {copy.caldav.providers[src.provider]}
                      </span>
                      <span className="rounded-sm bg-c-muted px-2 py-1 text-xs font-medium text-c-ink-2">
                        {src.hasSyncToken ? copy.caldav.syncedBadge : copy.caldav.pendingBadge}
                      </span>
                    </div>
                    <span className="font-mono text-xs text-c-ink-3">{src.calendarUrl}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleSyncSource(src.id)}
                      className={cx(
                        'inline-flex min-h-8 items-center justify-center rounded-md border border-c-action bg-c-action px-3 py-1 text-xs font-semibold text-c-on-inverse hover:bg-c-action-hover focus-visible:ring focus-visible:outline-hidden',
                        TOUCH_TARGET
                      )}
                    >
                      {copy.caldav.syncNow}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRemoveSource(src.id)}
                      className={cx(
                        'inline-flex min-h-8 items-center justify-center rounded-md border border-c-bad bg-c-bad-soft px-3 py-1 text-xs font-semibold text-c-bad-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden',
                        TOUCH_TARGET
                      )}
                    >
                      {copy.caldav.removeSource}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <form
            onSubmit={handleCreateCaldavSource}
            className="grid grid-cols-1 gap-3 border-t border-c-border pt-3 md:grid-cols-2"
          >
            <div className="flex flex-col gap-1">
              <label htmlFor={calProviderId} className="text-xs font-medium text-c-ink">
                {copy.caldav.providerLabel}
              </label>
              <select
                id={calProviderId}
                value={calProvider}
                onChange={(e) =>
                  setCalProvider(
                    e.target.value as 'lasuite' | 'open_xchange' | 'nextcloud' | 'generic'
                  )
                }
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
              >
                <option value="lasuite">{copy.caldav.providers.lasuite}</option>
                <option value="open_xchange">{copy.caldav.providers.open_xchange}</option>
                <option value="nextcloud">{copy.caldav.providers.nextcloud}</option>
                <option value="generic">{copy.caldav.providers.generic}</option>
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={calNameId} className="text-xs font-medium text-c-ink">
                {copy.caldav.nameLabel}
              </label>
              <input
                id={calNameId}
                type="text"
                required
                maxLength={128}
                value={calName}
                onChange={(e) => setCalName(e.target.value)}
                placeholder={copy.caldav.namePlaceholder}
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex flex-col gap-1 md:col-span-2">
              <label htmlFor={calUrlId} className="text-xs font-medium text-c-ink">
                {copy.caldav.urlLabel}
              </label>
              <input
                id={calUrlId}
                type="url"
                required
                maxLength={2048}
                value={calUrl}
                onChange={(e) => setCalUrl(e.target.value)}
                placeholder={copy.caldav.urlPlaceholder}
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 font-mono text-xs text-c-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={calUserId} className="text-xs font-medium text-c-ink">
                {copy.caldav.usernameLabel}
              </label>
              <input
                id={calUserId}
                type="text"
                required
                maxLength={255}
                value={calUsername}
                onChange={(e) => setCalUsername(e.target.value)}
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={calPassId} className="text-xs font-medium text-c-ink">
                {copy.caldav.passwordLabel}
              </label>
              <input
                id={calPassId}
                type="password"
                required
                maxLength={512}
                value={calPassword}
                onChange={(e) => setCalPassword(e.target.value)}
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex justify-end md:col-span-2">
              <button
                type="submit"
                className={cx(
                  'inline-flex min-h-8 items-center justify-center rounded-md border border-c-action bg-c-action px-4 py-1 text-xs font-semibold text-c-on-inverse hover:bg-c-action-hover focus-visible:ring focus-visible:outline-hidden',
                  TOUCH_TARGET
                )}
              >
                {copy.caldav.addSource}
              </button>
            </div>
          </form>
        </section>
      )}

      {activeDrawer === 'booking' && (
        <section
          aria-label={copy.bookingBuilder.heading}
          data-testid="calendar-booking-drawer"
          className="flex flex-col gap-4 rounded-lg border border-c-border bg-c-muted p-4"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold text-c-ink">{copy.bookingBuilder.heading}</h2>
              <p className="text-xs text-c-ink-2">{copy.bookingBuilder.subtitle}</p>
            </div>
            <button
              type="button"
              onClick={() => setActiveDrawer(null)}
              className="text-xs font-medium text-c-ink-2 hover:underline focus-visible:ring focus-visible:outline-hidden"
            >
              {copy.actions.closeDrawer}
            </button>
          </div>

          <div className="flex flex-col gap-2">
            {bookingPages.filter((p) => p.active).length === 0 ? (
              <p className="text-xs text-c-ink-2">{copy.bookingBuilder.emptyPages}</p>
            ) : (
              bookingPages
                .filter((p) => p.active)
                .map((pg) => (
                  <div
                    key={pg.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-c-border bg-c-surface p-3"
                  >
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <strong className="text-sm font-semibold text-c-ink">{pg.title}</strong>
                        <span className="rounded-sm bg-c-muted px-2 py-1 font-mono text-xs font-medium text-c-ink-2">
                          {`/booking/${pg.slug}`}
                        </span>
                        <span className="rounded-sm bg-c-accent-soft px-2 py-1 font-mono text-xs font-medium text-c-accent-ink">
                          {`${String(pg.durationMinutes)} min`}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setPreviewSlug((prev) => (prev === pg.slug ? null : pg.slug))
                        }
                        className={cx(
                          'inline-flex min-h-8 items-center justify-center rounded-md border border-c-border bg-c-muted px-3 py-1 text-xs font-medium text-c-ink hover:bg-c-muted-2 focus-visible:ring focus-visible:outline-hidden',
                          TOUCH_TARGET
                        )}
                      >
                        {copy.bookingBuilder.previewPublic}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeactivateBookingPage(pg.id, pg.slug)}
                        className={cx(
                          'inline-flex min-h-8 items-center justify-center rounded-md border border-c-bad bg-c-bad-soft px-3 py-1 text-xs font-semibold text-c-bad-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden',
                          TOUCH_TARGET
                        )}
                      >
                        {copy.bookingBuilder.deactivatePage}
                      </button>
                    </div>
                  </div>
                ))
            )}
          </div>

          {previewSlug !== null && (
            <Suspense
              fallback={
                <p role="status" className="py-2 text-xs text-c-ink-3">
                  {copy.loading}
                </p>
              }
            >
              <LazyBookingPublicPage
                bookingSlug={previewSlug}
                transport={publicBookingTransport}
                onDownloadIcs={onDownloadIcs}
              />
            </Suspense>
          )}

          <form
            onSubmit={handleCreateBookingPage}
            className="grid grid-cols-1 gap-3 border-t border-c-border pt-3 md:grid-cols-3"
          >
            <div className="flex flex-col gap-1">
              <label htmlFor={bkSlugId} className="text-xs font-medium text-c-ink">
                {copy.bookingBuilder.slugLabel}
              </label>
              <input
                id={bkSlugId}
                type="text"
                required
                minLength={3}
                maxLength={80}
                value={bkSlug}
                onChange={(e) => setBkSlug(e.target.value)}
                placeholder={copy.bookingBuilder.slugPlaceholder}
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 font-mono text-xs text-c-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex flex-col gap-1 md:col-span-2">
              <label htmlFor={bkTitleId} className="text-xs font-medium text-c-ink">
                {copy.bookingBuilder.titleLabel}
              </label>
              <input
                id={bkTitleId}
                type="text"
                required
                maxLength={160}
                value={bkTitle}
                onChange={(e) => setBkTitle(e.target.value)}
                placeholder={copy.bookingBuilder.titlePlaceholder}
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={bkDurationId} className="text-xs font-medium text-c-ink">
                {copy.bookingBuilder.durationLabel}
              </label>
              <select
                id={bkDurationId}
                value={bkDuration}
                onChange={(e) => setBkDuration(Number(e.target.value) as 15 | 30 | 45 | 60)}
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
              >
                <option value={15}>15 min</option>
                <option value={30}>30 min</option>
                <option value={45}>45 min</option>
                <option value={60}>60 min</option>
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={bkBufferId} className="text-xs font-medium text-c-ink">
                {copy.bookingBuilder.bufferLabel}
              </label>
              <input
                id={bkBufferId}
                type="number"
                min={0}
                max={120}
                value={bkBuffer}
                onChange={(e) => setBkBuffer(Math.max(0, Math.min(120, Number(e.target.value))))}
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 font-mono text-xs text-c-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={bkWeekdayId} className="text-xs font-medium text-c-ink">
                {copy.bookingBuilder.weekdayLabel}
              </label>
              <select
                id={bkWeekdayId}
                value={bkWeekday}
                onChange={(e) => setBkWeekday(Number(e.target.value))}
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
              >
                {copy.weekdaysLong.map((dayLabel, idx) => (
                  <option key={dayLabel} value={idx}>
                    {dayLabel}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={bkStartId} className="text-xs font-medium text-c-ink">
                {copy.bookingBuilder.startLabel}
              </label>
              <input
                id={bkStartId}
                type="time"
                required
                value={bkWinStart}
                onChange={(e) => setBkWinStart(e.target.value)}
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 font-mono text-xs text-c-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={bkEndId} className="text-xs font-medium text-c-ink">
                {copy.bookingBuilder.endLabel}
              </label>
              <input
                id={bkEndId}
                type="time"
                required
                value={bkWinEnd}
                onChange={(e) => setBkWinEnd(e.target.value)}
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 font-mono text-xs text-c-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={bkVisioId} className="text-xs font-medium text-c-ink">
                {copy.bookingBuilder.visioLabel}
              </label>
              <input
                id={bkVisioId}
                type="url"
                value={bkVisioUrl}
                onChange={(e) => setBkVisioUrl(e.target.value)}
                placeholder="https://visio.kodera.io/rendez-vous"
                className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex justify-end md:col-span-3">
              <button
                type="submit"
                className={cx(
                  'inline-flex min-h-8 items-center justify-center rounded-md border border-c-action bg-c-action px-4 py-1 text-xs font-semibold text-c-on-inverse hover:bg-c-action-hover focus-visible:ring focus-visible:outline-hidden',
                  TOUCH_TARGET
                )}
              >
                {copy.bookingBuilder.createPage}
              </button>
            </div>
          </form>
        </section>
      )}

      {loading ? (
        <p className="text-sm text-c-ink-2">{copy.loading}</p>
      ) : (
        <div
          data-testid={`calendar-grid-${gridMode}`}
          className="grid grid-cols-1 gap-2 md:grid-cols-7"
        >
          {copy.weekdaysShort.map((label) => (
            <div
              key={label}
              className="hidden rounded-sm bg-c-muted px-2 py-1 text-center text-xs font-semibold text-c-ink-2 md:block"
            >
              {label}
            </div>
          ))}

          {gridDays.map((day) => {
            const iso = formatDayIso(day)
            const dayEvents = eventsByDay.get(iso) ?? []
            const isOutsideMonth =
              gridMode === 'month' && day.getUTCMonth() !== cursorDate.getUTCMonth()
            return (
              <div
                key={iso}
                data-testid={`calendar-day-${iso}`}
                className={cx(
                  'flex min-h-12 flex-col gap-2 rounded-md border p-2',
                  isOutsideMonth
                    ? 'border-c-border-soft bg-c-muted text-c-ink-3'
                    : 'border-c-border bg-c-surface text-c-ink'
                )}
              >
                <div className="flex items-center justify-between gap-1 border-b border-c-border-soft pb-1">
                  <span className="font-mono text-xs font-medium">{String(day.getUTCDate())}</span>
                  <span className="text-xs text-c-ink-3 md:hidden">
                    {copy.weekdaysShort[(day.getUTCDay() + 6) % 7]}
                  </span>
                </div>

                {dayEvents.length === 0 ? (
                  gridMode === 'week' ? (
                    <span className="text-xs text-c-ink-3">{copy.emptyDay}</span>
                  ) : null
                ) : (
                  dayEvents.map((ev) => {
                    const safeVisio = safeHttpsHref(ev.visioUrl)
                    const safeAgenda = safeHttpsHref(ev.agendaDocUrl)
                    return (
                      <article
                        key={`${iso}-${ev.id}`}
                        className="flex flex-col gap-1 rounded-sm border border-c-border-soft bg-c-accent-soft p-2 text-xs text-c-ink"
                      >
                        <div className="flex items-start justify-between gap-1">
                          <strong className="font-semibold break-words text-c-accent-ink">
                            {ev.title}
                          </strong>
                          <button
                            type="button"
                            aria-label={`${copy.actions.deleteEvent} ${ev.title}`}
                            onClick={() => void handleDeleteEvent(ev.id)}
                            className="rounded-sm px-1 text-xs font-medium text-c-ink-2 hover:bg-c-surface focus-visible:ring focus-visible:outline-hidden"
                          >
                            ×
                          </button>
                        </div>
                        <span className="font-mono text-xs text-c-ink-2">
                          {`${formatTimeUtc(ev.startsAt)} – ${formatTimeUtc(ev.endsAt)}`}
                        </span>
                        <div className="flex flex-wrap items-center gap-1">
                          {ev.rrule && (
                            <span className="rounded-sm bg-c-surface px-1 font-mono text-xs text-c-ink-2">
                              {copy.badges.recurring}
                            </span>
                          )}
                          {ev.visibility === 'private' && (
                            <span className="rounded-sm bg-c-surface px-1 text-xs text-c-ink-2">
                              {copy.badges.privateEvent}
                            </span>
                          )}
                          {safeVisio !== null && (
                            <a
                              href={safeVisio}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-semibold text-c-accent-ink underline"
                            >
                              {copy.badges.visioLink}
                            </a>
                          )}
                          {safeAgenda !== null && (
                            <a
                              href={safeAgenda}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-medium text-c-ink underline"
                            >
                              {copy.badges.agendaDoc}
                            </a>
                          )}
                        </div>
                      </article>
                    )
                  })
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
