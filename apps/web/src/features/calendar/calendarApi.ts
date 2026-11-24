import { coreApi } from '@/api/client'
import type { components } from '@/api/schema'

export type CalendarEventItem = components['schemas']['CalendarEvent']
export type CalendarEventCreateInput = components['schemas']['CalendarEventCreateRequest']
export type CalendarIcsExportEnvelope = components['schemas']['CalendarIcsExport']
export type CaldavSourceItem = components['schemas']['CaldavSource']
export type CaldavSourceCreateInput = components['schemas']['CaldavSourceCreateRequest']
export type CaldavSyncResultPayload = components['schemas']['CaldavSyncResult']
export type BookingAvailabilityWindowItem = components['schemas']['BookingAvailabilityWindow']
export type BookingPageItem = components['schemas']['BookingPage']
export type BookingPageCreateInput = components['schemas']['BookingPageCreateRequest']
export type PublicBookingSlotItem = components['schemas']['PublicBookingSlot']
export type PublicBookingPagePayload = components['schemas']['PublicBookingPage']
export type PublicBookingReserveInput = components['schemas']['PublicBookingReserveRequest']
export type PublicBookingReservationPayload = components['schemas']['PublicBookingReservation']
export type PublicBookingCancelResultPayload = components['schemas']['PublicBookingCancelResult']

export interface CalendarTransport {
  listEvents: (
    organisationId: string,
    window?: { readonly from?: string | undefined; readonly to?: string | undefined }
  ) => Promise<readonly CalendarEventItem[]>
  createEvent: (
    organisationId: string,
    body: CalendarEventCreateInput
  ) => Promise<CalendarEventItem>
  deleteEvent: (organisationId: string, eventId: string) => Promise<void>
  exportIcs: (organisationId: string) => Promise<CalendarIcsExportEnvelope>
  listSources: (organisationId: string) => Promise<readonly CaldavSourceItem[]>
  createSource: (
    organisationId: string,
    body: CaldavSourceCreateInput
  ) => Promise<CaldavSourceItem>
  syncSource: (organisationId: string, sourceId: string) => Promise<CaldavSyncResultPayload>
  deleteSource: (organisationId: string, sourceId: string) => Promise<void>
  listBookingPages: (organisationId: string) => Promise<readonly BookingPageItem[]>
  createBookingPage: (
    organisationId: string,
    body: BookingPageCreateInput
  ) => Promise<BookingPageItem>
  deleteBookingPage: (organisationId: string, bookingPageId: string) => Promise<void>
}

export interface PublicBookingTransport {
  getPage: (
    bookingSlug: string,
    window?: { readonly from?: string | undefined; readonly to?: string | undefined }
  ) => Promise<PublicBookingPagePayload>
  reserveSlot: (
    bookingSlug: string,
    body: PublicBookingReserveInput
  ) => Promise<PublicBookingReservationPayload>
  cancelReservation: (
    bookingSlug: string,
    reservationId: string,
    cancellationToken: string
  ) => Promise<PublicBookingCancelResultPayload>
}

function nextIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `idem-${String(Date.now())}-${Math.random().toString(36).slice(2, 12)}`
}

export const defaultCalendarTransport: CalendarTransport = {
  async listEvents(organisationId, window) {
    const query: { from?: string; to?: string } = {}
    if (window?.from !== undefined) query.from = window.from
    if (window?.to !== undefined) query.to = window.to
    const { data } = await coreApi().GET(
      '/organisations/{organisation_id}/workspace/calendar/events',
      {
        params: {
          path: { organisation_id: organisationId },
          query,
        },
      }
    )
    return data?.data ?? []
  },

  async createEvent(organisationId, body) {
    const { data } = await coreApi().POST(
      '/organisations/{organisation_id}/workspace/calendar/events',
      {
        params: {
          path: { organisation_id: organisationId },
          header: { 'Idempotency-Key': nextIdempotencyKey() },
        },
        body,
      }
    )
    if (data === undefined) throw new Error('missing calendar event payload')
    return data
  },

  async deleteEvent(organisationId, eventId) {
    await coreApi().DELETE(
      '/organisations/{organisation_id}/workspace/calendar/events/{event_id}',
      {
        params: {
          path: { organisation_id: organisationId, event_id: eventId },
        },
      }
    )
  },

  async exportIcs(organisationId) {
    const { data } = await coreApi().GET(
      '/organisations/{organisation_id}/workspace/calendar/events.ics',
      {
        params: { path: { organisation_id: organisationId } },
      }
    )
    if (data === undefined) throw new Error('missing calendar ics payload')
    if (typeof data === 'string') {
      return { filename: 'kodera-workspace-calendar.ics', ics: data }
    }
    return data
  },

  async listSources(organisationId) {
    const { data } = await coreApi().GET(
      '/organisations/{organisation_id}/workspace/calendar/sources',
      {
        params: { path: { organisation_id: organisationId } },
      }
    )
    return data?.data ?? []
  },

  async createSource(organisationId, body) {
    const { data } = await coreApi().POST(
      '/organisations/{organisation_id}/workspace/calendar/sources',
      {
        params: {
          path: { organisation_id: organisationId },
          header: { 'Idempotency-Key': nextIdempotencyKey() },
        },
        body,
      }
    )
    if (data === undefined) throw new Error('missing caldav source payload')
    return data
  },

  async syncSource(organisationId, sourceId) {
    const { data } = await coreApi().POST(
      '/organisations/{organisation_id}/workspace/calendar/sources/{source_id}/actions/sync',
      {
        params: {
          path: { organisation_id: organisationId, source_id: sourceId },
          header: { 'Idempotency-Key': nextIdempotencyKey() },
        },
      }
    )
    if (data === undefined) throw new Error('missing caldav sync payload')
    return data
  },

  async deleteSource(organisationId, sourceId) {
    await coreApi().DELETE(
      '/organisations/{organisation_id}/workspace/calendar/sources/{source_id}',
      {
        params: {
          path: { organisation_id: organisationId, source_id: sourceId },
        },
      }
    )
  },

  async listBookingPages(organisationId) {
    const { data } = await coreApi().GET(
      '/organisations/{organisation_id}/workspace/calendar/booking-pages',
      {
        params: { path: { organisation_id: organisationId } },
      }
    )
    return data?.data ?? []
  },

  async createBookingPage(organisationId, body) {
    const { data } = await coreApi().POST(
      '/organisations/{organisation_id}/workspace/calendar/booking-pages',
      {
        params: {
          path: { organisation_id: organisationId },
          header: { 'Idempotency-Key': nextIdempotencyKey() },
        },
        body,
      }
    )
    if (data === undefined) throw new Error('missing booking page payload')
    return data
  },

  async deleteBookingPage(organisationId, bookingPageId) {
    await coreApi().DELETE(
      '/organisations/{organisation_id}/workspace/calendar/booking-pages/{booking_page_id}',
      {
        params: {
          path: { organisation_id: organisationId, booking_page_id: bookingPageId },
        },
      }
    )
  },
}

export const defaultPublicBookingTransport: PublicBookingTransport = {
  async getPage(bookingSlug, window) {
    const query: { from?: string; to?: string } = {}
    if (window?.from !== undefined) query.from = window.from
    if (window?.to !== undefined) query.to = window.to
    const { data } = await coreApi().GET('/booking/{booking_slug}', {
      params: {
        path: { booking_slug: bookingSlug },
        query,
      },
    })
    if (data === undefined) throw new Error('missing public booking page')
    return data
  },

  async reserveSlot(bookingSlug, body) {
    const { data } = await coreApi().POST('/booking/{booking_slug}/reservations', {
      params: {
        path: { booking_slug: bookingSlug },
        header: { 'Idempotency-Key': nextIdempotencyKey() },
      },
      body,
    })
    if (data === undefined) throw new Error('missing reservation payload')
    return data
  },

  async cancelReservation(bookingSlug, reservationId, cancellationToken) {
    const { data } = await coreApi().POST(
      '/booking/{booking_slug}/reservations/{reservation_id}/actions/cancel',
      {
        params: {
          path: { booking_slug: bookingSlug, reservation_id: reservationId },
          header: { 'Idempotency-Key': nextIdempotencyKey() },
        },
        body: { cancellationToken },
      }
    )
    if (data === undefined) throw new Error('missing cancellation payload')
    return data
  },
}

export function safeHttpsHref(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > 2048) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
      return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

const RRULE_WEEKDAYS: Readonly<Record<string, number>> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
}

function parseIcsUntilUtc(raw: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(raw.trim().toUpperCase())
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2]) - 1
  const day = Number(m[3])
  const hour = m[4] ? Number(m[4]) : 23
  const min = m[5] ? Number(m[5]) : 59
  const sec = m[6] ? Number(m[6]) : 59
  const d = new Date(Date.UTC(year, month, day, hour, min, sec))
  return Number.isNaN(d.getTime()) ? null : d
}

export function expandCalendarOccurrencesInWindow(
  ev: CalendarEventItem,
  windowStart: Date,
  windowEnd: Date
): Date[] {
  const baseStart = new Date(ev.startsAt)
  const baseEnd = new Date(ev.endsAt)
  if (Number.isNaN(baseStart.getTime()) || Number.isNaN(baseEnd.getTime())) return []
  const durationMs = Math.max(60_000, baseEnd.getTime() - baseStart.getTime())

  const rawRule = ev.rrule.trim()
  if (!rawRule) {
    if (baseStart < windowEnd && baseEnd > windowStart) {
      return [baseStart]
    }
    return []
  }

  const cleaned = rawRule.toUpperCase().startsWith('RRULE:')
    ? rawRule.slice(6).trim().toUpperCase()
    : rawRule.toUpperCase()
  const parts = new Map<string, string>()
  for (const seg of cleaned.split(';')) {
    const eq = seg.indexOf('=')
    if (eq > 0) {
      parts.set(seg.slice(0, eq).trim(), seg.slice(eq + 1).trim())
    }
  }

  const freq = parts.get('FREQ')
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') {
    return baseStart < windowEnd && baseEnd > windowStart ? [baseStart] : []
  }
  const interval = Math.max(1, Math.min(366, Number(parts.get('INTERVAL') ?? '1') || 1))
  const maxCount = parts.has('COUNT')
    ? Math.max(1, Math.min(366, Number(parts.get('COUNT')) || 366))
    : 366
  const untilDate = parts.has('UNTIL') ? parseIcsUntilUtc(parts.get('UNTIL')!) : null
  const byDaySet = parts.has('BYDAY')
    ? new Set(
        parts
          .get('BYDAY')!
          .split(',')
          .map((code) => RRULE_WEEKDAYS[code.trim().slice(-2)])
          .filter((n): n is number => n !== undefined)
      )
    : null
  const byMonthDaySet = parts.has('BYMONTHDAY')
    ? new Set(
        parts
          .get('BYMONTHDAY')!
          .split(',')
          .map((v) => Number(v.trim()))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= 31)
      )
    : null

  const occurrences: Date[] = []
  let emitted = 0
  let step = 0

  while (emitted < maxCount && step < 732) {
    if (freq === 'DAILY') {
      const occ = new Date(baseStart.getTime() + step * interval * 86_400_000)
      if (untilDate && occ > untilDate) break
      if (occ >= windowEnd) break
      emitted += 1
      if (occ.getTime() + durationMs > windowStart.getTime()) {
        occurrences.push(occ)
      }
    } else if (freq === 'WEEKLY') {
      const targetDays =
        byDaySet && byDaySet.size > 0
          ? [...byDaySet].sort((a, b) => a - b)
          : [baseStart.getUTCDay()]
      const baseMondayOffset = baseStart.getUTCDay() === 0 ? -6 : 1 - baseStart.getUTCDay()
      const weekMonday = new Date(
        Date.UTC(
          baseStart.getUTCFullYear(),
          baseStart.getUTCMonth(),
          baseStart.getUTCDate() + baseMondayOffset + step * interval * 7,
          baseStart.getUTCHours(),
          baseStart.getUTCMinutes(),
          baseStart.getUTCSeconds()
        )
      )
      if (weekMonday >= windowEnd && step > 0) break
      for (const wd of targetDays) {
        const offsetFromMon = wd === 0 ? 6 : wd - 1
        const occ = new Date(weekMonday.getTime() + offsetFromMon * 86_400_000)
        if (occ < baseStart) continue
        if (untilDate && occ > untilDate) {
          step = 9999
          break
        }
        emitted += 1
        if (occ < windowEnd && occ.getTime() + durationMs > windowStart.getTime()) {
          occurrences.push(occ)
        }
        if (emitted >= maxCount) break
      }
    } else if (freq === 'MONTHLY') {
      const totalMonths = baseStart.getUTCFullYear() * 12 + baseStart.getUTCMonth() + step * interval
      const yr = Math.floor(totalMonths / 12)
      const mo = totalMonths % 12
      const daysInMonth = new Date(Date.UTC(yr, mo + 1, 0)).getUTCDate()
      const targetMonthDays =
        byMonthDaySet && byMonthDaySet.size > 0
          ? [...byMonthDaySet].sort((a, b) => a - b)
          : [baseStart.getUTCDate()]
      for (const dom of targetMonthDays) {
        if (dom > daysInMonth) continue
        const occ = new Date(
          Date.UTC(
            yr,
            mo,
            dom,
            baseStart.getUTCHours(),
            baseStart.getUTCMinutes(),
            baseStart.getUTCSeconds()
          )
        )
        if (occ < baseStart) continue
        if (untilDate && occ > untilDate) {
          step = 9999
          break
        }
        if (occ >= windowEnd && step > 0) {
          step = 9999
          break
        }
        emitted += 1
        if (occ < windowEnd && occ.getTime() + durationMs > windowStart.getTime()) {
          occurrences.push(occ)
        }
        if (emitted >= maxCount) break
      }
    }
    step += 1
  }
  return occurrences
}

export function triggerIcsDownload(filename: string, icsContent: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return
  if (typeof URL.createObjectURL !== 'function') return
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_') || 'calendar.ics'
  const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' })
  const objectUrl = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = safeName
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
