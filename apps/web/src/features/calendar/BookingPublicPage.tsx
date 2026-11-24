import { cx } from '@/ui/cx'
import { TOUCH_TARGET } from '@/ui/touchTarget'
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  defaultPublicBookingTransport,
  safeHttpsHref,
  triggerIcsDownload,
  type PublicBookingCancelResultPayload,
  type PublicBookingPagePayload,
  type PublicBookingReservationPayload,
  type PublicBookingSlotItem,
  type PublicBookingTransport,
} from './calendarApi'
import { calendarCopy } from './calendarMessages'

export interface BookingPublicPageProps {
  readonly bookingSlug: string
  readonly transport?: PublicBookingTransport | undefined
  readonly onDownloadIcs?: ((filename: string, ics: string) => void) | undefined
}

function formatSlotTimeRange(slot: PublicBookingSlotItem): string {
  const s = new Date(slot.startsAt)
  const e = new Date(slot.endsAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())} – ${pad(e.getUTCHours())}:${pad(e.getUTCMinutes())} UTC`
}

function formatDayHeading(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

export function BookingPublicPage({
  bookingSlug,
  transport = defaultPublicBookingTransport,
  onDownloadIcs,
}: BookingPublicPageProps) {
  const { i18n } = useTranslation()
  const copy = calendarCopy(i18n.resolvedLanguage)
  const pub = copy.publicBooking

  const guestNameId = useId()
  const guestEmailId = useId()
  const guestNotesId = useId()
  const cancelTokenInputId = useId()

  const [page, setPage] = useState<PublicBookingPagePayload | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedSlot, setSelectedSlot] = useState<PublicBookingSlotItem | null>(null)

  const [guestName, setGuestName] = useState<string>('')
  const [guestEmail, setGuestEmail] = useState<string>('')
  const [guestNotes, setGuestNotes] = useState<string>('')
  const [submitting, setSubmitting] = useState<boolean>(false)

  const [reservation, setReservation] = useState<PublicBookingReservationPayload | null>(null)
  const [cancelTokenInput, setCancelTokenInput] = useState<string>('')
  const [cancelResult, setCancelResult] = useState<PublicBookingCancelResultPayload | null>(null)

  const downloadIcs = useCallback(
    (filename: string, ics: string) => {
      if (onDownloadIcs !== undefined) {
        onDownloadIcs(filename, ics)
      } else {
        triggerIcsDownload(filename, ics)
      }
    },
    [onDownloadIcs]
  )

  const errorText = copy.errorGeneric

  useEffect(() => {
    let cancelled = false
    void transport
      .getPage(bookingSlug)
      .then((data) => {
        if (cancelled) return
        setPage(data)
        setSelectedSlot(data.slots[0] ?? null)
        setError(null)
      })
      .catch(() => {
        if (cancelled) return
        setError(errorText)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [bookingSlug, errorText, transport])

  const groupedSlots = useMemo(() => {
    const groups = new Map<string, PublicBookingSlotItem[]>()
    for (const slot of page?.slots ?? []) {
      const dayKey = formatDayHeading(slot.startsAt)
      const list = groups.get(dayKey) ?? []
      list.push(slot)
      groups.set(dayKey, list)
    }
    return [...groups.entries()]
  }, [page])

  const handleReserve = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (selectedSlot === null || !guestName.trim() || !guestEmail.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const created = await transport.reserveSlot(bookingSlug, {
        startsAt: selectedSlot.startsAt,
        guestName: guestName.trim(),
        guestEmail: guestEmail.trim(),
        ...(guestNotes.trim() ? { guestNotes: guestNotes.trim() } : {}),
      })
      setReservation(created)
      setCancelTokenInput(created.cancellationToken)
      setCancelResult(null)
    } catch {
      setError(copy.errorGeneric)
    } finally {
      setSubmitting(false)
    }
  }

  const handleCancel = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (reservation === null || !cancelTokenInput.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const cancelled = await transport.cancelReservation(
        bookingSlug,
        reservation.reservationId,
        cancelTokenInput.trim()
      )
      setCancelResult(cancelled)
    } catch {
      setError(copy.errorGeneric)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section
      aria-label={pub.regionLabel}
      data-testid="booking-public-page"
      className="flex flex-col gap-4 rounded-lg border border-c-border bg-c-surface p-4"
    >
      {loading ? (
        <p className="text-sm text-c-ink-2">{copy.loading}</p>
      ) : page === null ? (
        <p role="alert" className="text-sm font-medium text-c-bad-ink">
          {error ?? copy.errorGeneric}
        </p>
      ) : (
        <>
          <header className="flex flex-wrap items-start justify-between gap-3 border-b border-c-border-soft pb-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold text-c-ink">{page.title}</h2>
              {page.description && (
                <p className="text-sm font-regular text-c-ink-2">{page.description}</p>
              )}
              <p className="text-xs text-c-ink-3">{pub.subtitleZeroPii}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-sm bg-c-muted px-2 py-1 font-mono text-xs font-medium text-c-ink">
                {pub.durationBadge(page.durationMinutes)}
              </span>
              <span className="rounded-sm bg-c-muted px-2 py-1 font-mono text-xs font-medium text-c-ink-2">
                {page.timezone}
              </span>
              {page.visioAvailable && (
                <span className="rounded-sm bg-c-accent-soft px-2 py-1 text-xs font-semibold text-c-accent-ink">
                  {pub.visioIncluded}
                </span>
              )}
            </div>
          </header>

          {error !== null && (
            <p role="alert" className="rounded-md bg-c-bad-soft px-3 py-2 text-xs font-medium text-c-bad-ink">
              {error}
            </p>
          )}

          {reservation !== null ? (
            <div
              data-testid="booking-confirmation-card"
              className="flex flex-col gap-3 rounded-md border border-c-ok-border bg-c-ok-soft p-4"
            >
              <h3 className="text-base font-semibold text-c-ok-ink">{pub.confirmedHeading}</h3>
              <p className="font-mono text-xs text-c-ink">
                {formatDayHeading(reservation.startsAt)} ·{' '}
                {formatSlotTimeRange({
                  startsAt: reservation.startsAt,
                  endsAt: reservation.endsAt,
                })}
              </p>

              <div className="flex flex-col gap-1 rounded-md border border-c-border bg-c-surface p-3">
                <span className="text-xs font-medium text-c-ink-2">
                  {pub.cancellationTokenLabel}
                </span>
                <code
                  data-testid="booking-cancellation-token"
                  className="font-mono text-xs font-medium break-all text-c-ink"
                >
                  {reservation.cancellationToken}
                </code>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    downloadIcs(`kodera-invite-${reservation.slug}.ics`, reservation.ics)
                  }
                  className={cx(
                    'inline-flex min-h-8 items-center justify-center rounded-md border border-transparent bg-c-action px-3 py-1 text-xs font-semibold text-c-on-inverse hover:bg-c-action-hover focus-visible:ring focus-visible:outline-hidden',
                    TOUCH_TARGET
                  )}
                >
                  {pub.downloadInvite}
                </button>
                {safeHttpsHref(reservation.visioUrl) !== null && (
                  <a
                    href={safeHttpsHref(reservation.visioUrl)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-8 items-center justify-center rounded-md border border-c-border bg-c-surface px-3 py-1 text-xs font-semibold text-c-accent-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden"
                  >
                    {copy.badges.visioLink}
                  </a>
                )}
              </div>

              {cancelResult !== null ? (
                <div
                  data-testid="booking-cancelled-banner"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-c-border bg-c-surface p-3"
                >
                  <span className="text-xs font-medium text-c-ink">{pub.cancelledNotice}</span>
                  <button
                    type="button"
                    onClick={() =>
                      downloadIcs(`kodera-cancel-${reservation.slug}.ics`, cancelResult.ics)
                    }
                    className={cx(
                      'inline-flex min-h-8 items-center justify-center rounded-md border border-c-border bg-c-muted px-3 py-1 text-xs font-medium text-c-ink hover:bg-c-muted-2 focus-visible:ring focus-visible:outline-hidden',
                      TOUCH_TARGET
                    )}
                  >
                    {pub.downloadCancelIcs}
                  </button>
                </div>
              ) : (
                <form
                  onSubmit={handleCancel}
                  className="flex flex-wrap items-end gap-2 border-t border-c-border pt-3"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <label
                      htmlFor={cancelTokenInputId}
                      className="text-xs font-medium text-c-ink-2"
                    >
                      {pub.cancelTokenInputLabel}
                    </label>
                    <input
                      id={cancelTokenInputId}
                      type="text"
                      required
                      value={cancelTokenInput}
                      onChange={(e) => setCancelTokenInput(e.target.value)}
                      className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 font-mono text-xs text-c-ink focus-visible:ring focus-visible:outline-hidden"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={submitting}
                    className={cx(
                      'inline-flex min-h-8 items-center justify-center rounded-md border border-c-bad bg-c-bad-soft px-3 py-1 text-xs font-semibold text-c-bad-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden disabled:opacity-50',
                      TOUCH_TARGET
                    )}
                  >
                    {pub.cancelAction}
                  </button>
                </form>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold text-c-ink">{pub.availableSlotsHeading}</h3>
                {groupedSlots.length === 0 ? (
                  <p className="text-sm text-c-ink-2">{pub.noSlotsAvailable}</p>
                ) : (
                  groupedSlots.map(([day, slots]) => (
                    <div key={day} className="flex flex-col gap-2">
                      <span className="font-mono text-xs font-medium text-c-ink-2">{day}</span>
                      <div className="flex flex-wrap gap-2">
                        {slots.map((slot) => {
                          const isSelected = selectedSlot?.startsAt === slot.startsAt
                          return (
                            <button
                              key={slot.startsAt}
                              type="button"
                              aria-pressed={isSelected}
                              onClick={() => setSelectedSlot(slot)}
                              className={cx(
                                'inline-flex min-h-8 items-center justify-center rounded-md border px-3 py-1 font-mono text-xs font-medium focus-visible:ring focus-visible:outline-hidden',
                                TOUCH_TARGET,
                                isSelected
                                  ? 'border-c-accent-ink bg-c-accent-soft text-c-accent-ink'
                                  : 'border-c-border bg-c-surface text-c-ink hover:bg-c-muted'
                              )}
                            >
                              {formatSlotTimeRange(slot)}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>

              <form
                onSubmit={handleReserve}
                className="flex flex-col gap-3 rounded-md border border-c-border-soft bg-c-muted p-3"
              >
                <div className="flex flex-col gap-1">
                  <label htmlFor={guestNameId} className="text-xs font-medium text-c-ink">
                    {pub.guestNameLabel}
                  </label>
                  <input
                    id={guestNameId}
                    type="text"
                    required
                    maxLength={160}
                    value={guestName}
                    onChange={(e) => setGuestName(e.target.value)}
                    className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label htmlFor={guestEmailId} className="text-xs font-medium text-c-ink">
                    {pub.guestEmailLabel}
                  </label>
                  <input
                    id={guestEmailId}
                    type="email"
                    required
                    maxLength={254}
                    value={guestEmail}
                    onChange={(e) => setGuestEmail(e.target.value)}
                    className="min-h-8 rounded-md border border-c-border-input bg-c-surface px-3 py-1 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label htmlFor={guestNotesId} className="text-xs font-medium text-c-ink">
                    {pub.guestNotesLabel}
                  </label>
                  <textarea
                    id={guestNotesId}
                    rows={2}
                    maxLength={1024}
                    value={guestNotes}
                    onChange={(e) => setGuestNotes(e.target.value)}
                    className="rounded-md border border-c-border-input bg-c-surface px-3 py-2 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
                  />
                </div>

                <button
                  type="submit"
                  disabled={submitting || selectedSlot === null}
                  className={cx(
                    'inline-flex min-h-10 items-center justify-center rounded-md border border-transparent bg-c-action px-4 py-2 text-sm font-semibold text-c-on-inverse hover:bg-c-action-hover focus-visible:ring focus-visible:outline-hidden disabled:opacity-50',
                    TOUCH_TARGET
                  )}
                >
                  {pub.confirmSlot}
                </button>
              </form>
            </div>
          )}
        </>
      )}
    </section>
  )
}
