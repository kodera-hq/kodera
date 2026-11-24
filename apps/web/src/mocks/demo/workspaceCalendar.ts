// The demo's answers to smart calendar events, CalDAV sources, and sovereign booking pages
// (Core API 0.56.0), aligned with the Groupe Vercelli seed so no base-handler ACME fixture leaks.

import type { components } from '@/api/schema'
import { http, HttpResponse, type HttpHandler } from 'msw/http'
import * as seed from './seed'

type CalendarEventItem = components['schemas']['CalendarEvent']
type CalendarEventList = components['schemas']['CalendarEventList']
type CalendarIcsExport = components['schemas']['CalendarIcsExport']
type CaldavSourceItem = components['schemas']['CaldavSource']
type CaldavSourceList = components['schemas']['CaldavSourceList']
type CaldavSyncResult = components['schemas']['CaldavSyncResult']
type BookingPageItem = components['schemas']['BookingPage']
type BookingPageList = components['schemas']['BookingPageList']
type PublicBookingPage = components['schemas']['PublicBookingPage']
type PublicBookingReservation = components['schemas']['PublicBookingReservation']
type PublicBookingCancelResult = components['schemas']['PublicBookingCancelResult']

export const WORKSPACE_CALENDAR_DEMO_ROUTES: readonly string[] = [
  'GET /organisations/:organisation_id/workspace/calendar/events',
  'POST /organisations/:organisation_id/workspace/calendar/events',
  'DELETE /organisations/:organisation_id/workspace/calendar/events/:event_id',
  'GET /organisations/:organisation_id/workspace/calendar/events.ics',
  'GET /organisations/:organisation_id/workspace/calendar/sources',
  'POST /organisations/:organisation_id/workspace/calendar/sources',
  'POST /organisations/:organisation_id/workspace/calendar/sources/:source_id/actions/sync',
  'DELETE /organisations/:organisation_id/workspace/calendar/sources/:source_id',
  'GET /organisations/:organisation_id/workspace/calendar/booking-pages',
  'POST /organisations/:organisation_id/workspace/calendar/booking-pages',
  'DELETE /organisations/:organisation_id/workspace/calendar/booking-pages/:booking_page_id',
  'GET /booking/:booking_slug',
  'POST /booking/:booking_slug/reservations',
  'POST /booking/:booking_slug/reservations/:reservation_id/actions/cancel',
]

const DEMO_EVENT_ID = '01950000-0000-7000-8000-000000000951'
const DEMO_SOURCE_ID = '01950000-0000-7000-8000-000000000952'
const DEMO_BOOKING_ID = '01950000-0000-7000-8000-000000000953'
const DEMO_RESERVATION_ID = '01950000-0000-7000-8000-000000000954'
const DEMO_BOOKING_SLUG = 'point-direction-vercelli'

function defaultDemoEvent(now: Date): CalendarEventItem {
  const start = new Date(now.getTime() + 2 * 60 * 60 * 1000)
  start.setUTCMinutes(0, 0, 0)
  const end = new Date(start.getTime() + 45 * 60 * 1000)
  const owner = seed.memberships(now)[0]
  return {
    id: DEMO_EVENT_ID,
    uid: `${DEMO_EVENT_ID}@kodera.calendar`,
    title: 'Comité de direction Groupe Vercelli',
    description: 'Synchronisation hebdomadaire direction et opérations.',
    location: 'Siège Lyon — Salle Rhône',
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    timezone: 'Europe/Paris',
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    status: 'confirmed',
    visibility: 'workspace',
    attendees: [
      {
        email: owner?.email ?? `m.vercelli@${seed.DEMO_EMAIL_DOMAIN}`,
        name: owner?.display_name ?? 'Marco Vercelli',
        partstat: 'ACCEPTED',
        role: 'CHAIR',
      },
    ],
    alarmMinutesBefore: 15,
    visioUrl: 'https://visio.kodera.io/direction-vercelli',
    agendaDocUrl: '',
    sourceId: null,
    revision: 1,
    updatedAt: now.toISOString(),
  }
}

function defaultDemoSource(now: Date): CaldavSourceItem {
  return {
    id: DEMO_SOURCE_ID,
    name: 'Agenda La Suite Numérique — Vercelli',
    provider: 'lasuite',
    calendarUrl: `https://agenda.${seed.DEMO_EMAIL_DOMAIN}/caldav/direction/`,
    principalUsername: `direction@${seed.DEMO_EMAIL_DOMAIN}`,
    enabled: true,
    hasSyncToken: true,
    lastSyncedAt: now.toISOString(),
    lastErrorCode: null,
    createdAt: now.toISOString(),
  }
}

function defaultDemoBookingPage(now: Date): BookingPageItem {
  return {
    id: DEMO_BOOKING_ID,
    slug: DEMO_BOOKING_SLUG,
    title: 'Échange Direction — Groupe Vercelli',
    description: 'Créneau souverain de 30 minutes avec salle Kodera Visio dédiée.',
    timezone: 'Europe/Paris',
    durationMinutes: 30,
    bufferMinutes: 10,
    availabilityWindows: [
      { weekday: 0, start: '09:00', end: '17:00' },
      { weekday: 2, start: '09:00', end: '17:00' },
      { weekday: 3, start: '14:00', end: '18:00' },
    ],
    visioUrl: 'https://visio.kodera.io/point-vercelli',
    agendaDocUrl: '',
    active: true,
    revision: 1,
    createdAt: now.toISOString(),
  }
}

export function workspaceCalendarDemoHandlers(
  base: string,
  headers: () => Record<string, string>
): HttpHandler[] {
  const calendarBase = `${base}/organisations/:organisation_id/workspace/calendar`

  return [
    http.get(`${calendarBase}/events`, () => {
      const body: CalendarEventList = { data: [defaultDemoEvent(new Date())] }
      return HttpResponse.json(body, { status: 200, headers: headers() })
    }),

    http.post(`${calendarBase}/events`, async ({ request }) => {
      const now = new Date()
      const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const baseEvent = defaultDemoEvent(now)
      const created: CalendarEventItem = {
        ...baseEvent,
        id: '01950000-0000-7000-8000-000000000955',
        uid: '01950000-0000-7000-8000-000000000955@kodera.calendar',
        title: typeof raw['title'] === 'string' && raw['title'] ? raw['title'] : baseEvent.title,
        description: typeof raw['description'] === 'string' ? raw['description'] : '',
        location: typeof raw['location'] === 'string' ? raw['location'] : '',
        startsAt: typeof raw['startsAt'] === 'string' ? raw['startsAt'] : baseEvent.startsAt,
        endsAt: typeof raw['endsAt'] === 'string' ? raw['endsAt'] : baseEvent.endsAt,
        timezone: typeof raw['timezone'] === 'string' ? raw['timezone'] : 'Europe/Paris',
        rrule: typeof raw['rrule'] === 'string' ? raw['rrule'] : '',
        visibility:
          raw['visibility'] === 'private' || raw['visibility'] === 'busy_only'
            ? raw['visibility']
            : 'workspace',
        visioUrl: typeof raw['visioUrl'] === 'string' ? raw['visioUrl'] : '',
        agendaDocUrl: typeof raw['agendaDocUrl'] === 'string' ? raw['agendaDocUrl'] : '',
      }
      return HttpResponse.json(created, {
        status: 201,
        headers: { ...headers(), ETag: '"1"' },
      })
    }),

    http.delete(`${calendarBase}/events/:event_id`, () => {
      return new HttpResponse(null, { status: 204, headers: headers() })
    }),

    http.get(`${calendarBase}/events.ics`, () => {
      const body: CalendarIcsExport = {
        filename: 'groupe-vercelli-calendar.ics',
        ics: [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'PRODID:-//Kodera//Sovereign Smart Calendar//EN',
          'CALSCALE:GREGORIAN',
          'METHOD:PUBLISH',
          'BEGIN:VEVENT',
          `UID:${DEMO_EVENT_ID}@kodera.calendar`,
          'DTSTAMP:20260601T080000Z',
          'DTSTART:20260608T090000Z',
          'DTEND:20260608T094500Z',
          'SUMMARY:Comité de direction Groupe Vercelli',
          'STATUS:CONFIRMED',
          'CLASS:PUBLIC',
          'END:VEVENT',
          'END:VCALENDAR',
          '',
        ].join('\r\n'),
      }
      return HttpResponse.json(body, { status: 200, headers: headers() })
    }),

    http.get(`${calendarBase}/sources`, () => {
      const body: CaldavSourceList = { data: [defaultDemoSource(new Date())] }
      return HttpResponse.json(body, { status: 200, headers: headers() })
    }),

    http.post(`${calendarBase}/sources`, async ({ request }) => {
      const now = new Date()
      const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const baseSource = defaultDemoSource(now)
      const provider =
        raw['provider'] === 'open_xchange' ||
        raw['provider'] === 'nextcloud' ||
        raw['provider'] === 'generic'
          ? raw['provider']
          : 'lasuite'
      const created: CaldavSourceItem = {
        ...baseSource,
        id: '01950000-0000-7000-8000-000000000956',
        name: typeof raw['name'] === 'string' && raw['name'] ? raw['name'] : baseSource.name,
        provider,
        calendarUrl:
          typeof raw['calendarUrl'] === 'string' && raw['calendarUrl']
            ? raw['calendarUrl']
            : baseSource.calendarUrl,
        principalUsername:
          typeof raw['username'] === 'string' && raw['username']
            ? raw['username']
            : baseSource.principalUsername,
        hasSyncToken: false,
        lastSyncedAt: null,
      }
      return HttpResponse.json(created, { status: 201, headers: headers() })
    }),

    http.post(`${calendarBase}/sources/:source_id/actions/sync`, ({ params }) => {
      const sourceId =
        typeof params['source_id'] === 'string' ? params['source_id'] : DEMO_SOURCE_ID
      const body: CaldavSyncResult = {
        sourceId,
        upserted: 2,
        removed: 0,
        fullResync: false,
        syncedAt: new Date().toISOString(),
      }
      return HttpResponse.json(body, { status: 200, headers: headers() })
    }),

    http.delete(`${calendarBase}/sources/:source_id`, () => {
      return new HttpResponse(null, { status: 204, headers: headers() })
    }),

    http.get(`${calendarBase}/booking-pages`, () => {
      const body: BookingPageList = { data: [defaultDemoBookingPage(new Date())] }
      return HttpResponse.json(body, { status: 200, headers: headers() })
    }),

    http.post(`${calendarBase}/booking-pages`, async ({ request }) => {
      const now = new Date()
      const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const basePage = defaultDemoBookingPage(now)
      const dur = raw['durationMinutes']
      const durationMinutes: 15 | 30 | 45 | 60 =
        dur === 15 || dur === 30 || dur === 45 || dur === 60 ? dur : 30
      const created: BookingPageItem = {
        ...basePage,
        id: '01950000-0000-7000-8000-000000000957',
        slug: typeof raw['slug'] === 'string' && raw['slug'] ? raw['slug'] : basePage.slug,
        title: typeof raw['title'] === 'string' && raw['title'] ? raw['title'] : basePage.title,
        description: typeof raw['description'] === 'string' ? raw['description'] : '',
        durationMinutes,
        bufferMinutes: typeof raw['bufferMinutes'] === 'number' ? raw['bufferMinutes'] : 10,
      }
      return HttpResponse.json(created, { status: 201, headers: headers() })
    }),

    http.delete(`${calendarBase}/booking-pages/:booking_page_id`, () => {
      return new HttpResponse(null, { status: 204, headers: headers() })
    }),

    http.get(`${base}/booking/:booking_slug`, ({ params }) => {
      const now = new Date()
      const slot1Start = new Date(now.getTime() + 24 * 60 * 60 * 1000)
      slot1Start.setUTCHours(9, 0, 0, 0)
      const slot1End = new Date(slot1Start.getTime() + 30 * 60 * 1000)
      const slot2Start = new Date(slot1Start.getTime() + 60 * 60 * 1000)
      const slot2End = new Date(slot2Start.getTime() + 30 * 60 * 1000)
      const slug =
        typeof params['booking_slug'] === 'string' ? params['booking_slug'] : DEMO_BOOKING_SLUG
      const body: PublicBookingPage = {
        slug,
        title: 'Échange Direction — Groupe Vercelli',
        description: 'Créneau souverain de 30 minutes avec salle Kodera Visio dédiée.',
        timezone: 'Europe/Paris',
        durationMinutes: 30,
        visioAvailable: true,
        slots: [
          { startsAt: slot1Start.toISOString(), endsAt: slot1End.toISOString() },
          { startsAt: slot2Start.toISOString(), endsAt: slot2End.toISOString() },
        ],
      }
      return HttpResponse.json(body, { status: 200, headers: headers() })
    }),

    http.post(`${base}/booking/:booking_slug/reservations`, async ({ params, request }) => {
      const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const slug =
        typeof params['booking_slug'] === 'string' ? params['booking_slug'] : DEMO_BOOKING_SLUG
      const startsAt =
        typeof raw['startsAt'] === 'string'
          ? raw['startsAt']
          : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      const endsAt = new Date(new Date(startsAt).getTime() + 30 * 60 * 1000).toISOString()
      const body: PublicBookingReservation = {
        reservationId: DEMO_RESERVATION_ID,
        slug,
        title: 'Échange Direction — Groupe Vercelli',
        startsAt,
        endsAt,
        timezone: 'Europe/Paris',
        visioUrl: 'https://visio.kodera.io/point-vercelli',
        agendaDocUrl: '',
        status: 'confirmed',
        cancellationToken: 'bkc_vercelli_demo_token_0123456789abcdef',
        ics: [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'PRODID:-//Kodera//Sovereign Smart Calendar//EN',
          'CALSCALE:GREGORIAN',
          'METHOD:REQUEST',
          'BEGIN:VEVENT',
          `UID:booking-${DEMO_RESERVATION_ID}@kodera.calendar`,
          'DTSTAMP:20260601T080000Z',
          'DTSTART:20260608T090000Z',
          'DTEND:20260608T093000Z',
          'SUMMARY:Échange Direction — Groupe Vercelli',
          'STATUS:CONFIRMED',
          'END:VEVENT',
          'END:VCALENDAR',
          '',
        ].join('\r\n'),
      }
      return HttpResponse.json(body, { status: 201, headers: headers() })
    }),

    http.post(
      `${base}/booking/:booking_slug/reservations/:reservation_id/actions/cancel`,
      ({ params }) => {
        const reservationId =
          typeof params['reservation_id'] === 'string'
            ? params['reservation_id']
            : DEMO_RESERVATION_ID
        const body: PublicBookingCancelResult = {
          reservationId,
          status: 'cancelled',
          cancelledAt: new Date().toISOString(),
          ics: [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Kodera//Sovereign Smart Calendar//EN',
            'CALSCALE:GREGORIAN',
            'METHOD:CANCEL',
            'BEGIN:VEVENT',
            `UID:booking-${reservationId}@kodera.calendar`,
            'DTSTAMP:20260601T080000Z',
            'DTSTART:20260608T090000Z',
            'DTEND:20260608T093000Z',
            'SUMMARY:Échange Direction — Groupe Vercelli',
            'STATUS:CANCELLED',
            'SEQUENCE:1',
            'END:VEVENT',
            'END:VCALENDAR',
            '',
          ].join('\r\n'),
        }
        return HttpResponse.json(body, { status: 200, headers: headers() })
      }
    ),
  ]
}
