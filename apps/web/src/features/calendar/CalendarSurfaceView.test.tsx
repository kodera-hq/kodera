import { ApiProblem } from '@/api/client'
import { StudioNavigation } from '@/features/workspace/StudioNavigation'
import '@/i18n'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { BookingPublicPage } from './BookingPublicPage'
import { CalendarSurfaceView } from './CalendarSurfaceView'
import type {
  BookingPageItem,
  CaldavSourceItem,
  CalendarEventItem,
  CalendarTransport,
  PublicBookingTransport,
} from './calendarApi'

const ANCHOR_DATE = new Date('2026-06-08T08:00:00Z')

function buildMockCalendarTransport(): {
  transport: CalendarTransport
  events: CalendarEventItem[]
  sources: CaldavSourceItem[]
  pages: BookingPageItem[]
} {
  const events: CalendarEventItem[] = [
    {
      id: '00000000-0000-7000-8000-000000000101',
      uid: 'ev-101@kodera.calendar',
      title: 'Synchronisation produit hebdomadaire',
      description: 'Arbitrages produit',
      location: 'Salle Givre',
      startsAt: '2026-06-08T09:00:00Z',
      endsAt: '2026-06-08T09:45:00Z',
      timezone: 'Europe/Paris',
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      status: 'confirmed',
      visibility: 'workspace',
      attendees: [],
      alarmMinutesBefore: 15,
      visioUrl: 'https://visio.kodera.io/hebdo-produit',
      agendaDocUrl: 'https://console.kodera.io/docs/ordre-du-jour',
      sourceId: null,
      revision: 1,
      updatedAt: '2026-06-01T08:00:00Z',
    },
  ]
  const sources: CaldavSourceItem[] = []
  const pages: BookingPageItem[] = []

  const transport: CalendarTransport = {
    listEvents: vi.fn(async () => [...events]),
    createEvent: vi.fn(async (_orgId, body) => {
      const created: CalendarEventItem = {
        id: '00000000-0000-7000-8000-000000000199',
        uid: 'ev-199@kodera.calendar',
        title: body.title,
        description: body.description ?? '',
        location: body.location ?? '',
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        timezone: body.timezone ?? 'Europe/Paris',
        rrule: body.rrule ?? '',
        status: 'confirmed',
        visibility: body.visibility ?? 'workspace',
        attendees: [],
        alarmMinutesBefore: 15,
        visioUrl: body.visioUrl ?? '',
        agendaDocUrl: body.agendaDocUrl ?? '',
        sourceId: null,
        revision: 1,
        updatedAt: '2026-06-08T08:00:00Z',
      }
      events.push(created)
      return created
    }),
    deleteEvent: vi.fn(async (_orgId, eventId) => {
      const idx = events.findIndex((e) => e.id === eventId)
      if (idx >= 0) events.splice(idx, 1)
    }),
    exportIcs: vi.fn(async () => ({
      filename: 'kodera-workspace-calendar.ics',
      ics: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Kodera//Sovereign Smart Calendar//EN\r\nEND:VCALENDAR\r\n',
    })),
    listSources: vi.fn(async () => [...sources]),
    createSource: vi.fn(async (_orgId, body) => {
      const created: CaldavSourceItem = {
        id: '00000000-0000-7000-8000-000000000201',
        name: body.name,
        provider: body.provider ?? 'lasuite',
        calendarUrl: body.calendarUrl,
        principalUsername: body.username,
        enabled: true,
        hasSyncToken: false,
        lastSyncedAt: null,
        lastErrorCode: null,
        createdAt: '2026-06-08T08:00:00Z',
      }
      sources.push(created)
      return created
    }),
    syncSource: vi.fn(async (_orgId, sourceId) => {
      const target = sources.find((s) => s.id === sourceId)
      if (target) {
        ;(target as { hasSyncToken: boolean }).hasSyncToken = true
      }
      return {
        sourceId,
        upserted: 4,
        removed: 1,
        fullResync: false,
        syncedAt: '2026-06-08T08:15:00Z',
      }
    }),
    deleteSource: vi.fn(async (_orgId, sourceId) => {
      const idx = sources.findIndex((s) => s.id === sourceId)
      if (idx >= 0) sources.splice(idx, 1)
    }),
    listBookingPages: vi.fn(async () => [...pages]),
    createBookingPage: vi.fn(async (_orgId, body) => {
      const created: BookingPageItem = {
        id: '00000000-0000-7000-8000-000000000301',
        slug: body.slug,
        title: body.title,
        description: body.description ?? '',
        timezone: body.timezone ?? 'Europe/Paris',
        durationMinutes: body.durationMinutes ?? 30,
        bufferMinutes: body.bufferMinutes ?? 10,
        availabilityWindows: [...body.availabilityWindows],
        visioUrl: body.visioUrl ?? '',
        agendaDocUrl: body.agendaDocUrl ?? '',
        active: true,
        revision: 1,
        createdAt: '2026-06-08T08:00:00Z',
      }
      pages.push(created)
      return created
    }),
    deleteBookingPage: vi.fn(async (_orgId, pageId) => {
      const idx = pages.findIndex((p) => p.id === pageId)
      if (idx >= 0) pages.splice(idx, 1)
    }),
  }

  return { transport, events, sources, pages }
}

describe('CalendarSurfaceView & BookingPublicPage', () => {
  it('renders week/month grids, creates events, exports .ics, and emits zero inline styles', async () => {
    const user = userEvent.setup()
    const { transport } = buildMockCalendarTransport()
    const onDownloadIcs = vi.fn()

    const { container } = render(
      <CalendarSurfaceView
        organisationId="00000000-0000-7000-8000-000000000001"
        initialDate={ANCHOR_DATE}
        transport={transport}
        onDownloadIcs={onDownloadIcs}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('calendar-grid-week')).toBeInTheDocument()
    })
    expect(screen.getByText('Synchronisation produit hebdomadaire')).toBeInTheDocument()
    expect(screen.getByText('Récurrent')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Rejoindre Visio' })).toHaveAttribute(
      'href',
      'https://visio.kodera.io/hebdo-produit'
    )

    // Switch to month grid (6 full weeks = 42 day cells) and back to week grid
    await user.click(screen.getByRole('button', { name: 'Mois' }))
    const monthGrid = screen.getByTestId('calendar-grid-month')
    expect(monthGrid).toBeInTheDocument()
    expect(monthGrid.querySelectorAll('[data-testid^="calendar-day-"]')).toHaveLength(42)
    await user.click(screen.getByRole('button', { name: 'Semaine' }))
    expect(screen.getByTestId('calendar-grid-week')).toBeInTheDocument()

    // Create a new event
    await user.click(screen.getByRole('button', { name: 'Nouvel événement' }))
    await user.type(screen.getByLabelText('Titre de l’événement'), 'Revue sécurité CalDAV')
    await user.selectOptions(screen.getByLabelText('Récurrence'), 'FREQ=WEEKLY')
    await user.click(screen.getByRole('button', { name: 'Enregistrer l’événement' }))

    await waitFor(() => {
      expect(screen.getByText('Revue sécurité CalDAV')).toBeInTheDocument()
    })

    // Export .ics feed
    await user.click(screen.getByRole('button', { name: 'Exporter .ics' }))
    await waitFor(() => {
      expect(onDownloadIcs).toHaveBeenCalledWith(
        'kodera-workspace-calendar.ics',
        expect.stringContaining('BEGIN:VCALENDAR')
      )
    })

    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })

  it('configures a La Suite Numerique CalDAV source, syncs incremental delta, and builds booking links', async () => {
    const user = userEvent.setup()
    const { transport } = buildMockCalendarTransport()

    const { container } = render(
      <CalendarSurfaceView
        organisationId="00000000-0000-7000-8000-000000000001"
        initialDate={ANCHOR_DATE}
        transport={transport}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('calendar-grid-week')).toBeInTheDocument()
    })

    // Open CalDAV drawer & add La Suite source
    await user.click(screen.getByRole('button', { name: 'Sources CalDAV' }))
    expect(screen.getByTestId('calendar-caldav-drawer')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Nom de la source'), 'Agenda DINUM')
    await user.type(
      screen.getByLabelText('URL HTTPS de la collection CalDAV'),
      'https://agenda.numerique.gouv.fr/caldav/equipe/'
    )
    await user.type(screen.getByLabelText('Identifiant principal'), 'equipe@kodera.io')
    await user.type(screen.getByLabelText('Mot de passe d’application'), 'jeton-applicatif')
    await user.click(screen.getByRole('button', { name: 'Connecter la source' }))

    await waitFor(() => {
      expect(screen.getByText('Agenda DINUM')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Synchroniser' }))
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        'Synchronisation terminée : 4 mis à jour, 1 annulé(s).'
      )
    })

    // Open Booking drawer & create sovereign booking page
    await user.click(screen.getByRole('button', { name: 'Pages de réservation' }))
    expect(screen.getByTestId('calendar-booking-drawer')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Identifiant public (slug)'), 'point-architecture-kodera')
    await user.type(screen.getByLabelText('Titre public de la page'), 'Point architecture 30 min')
    await user.click(screen.getByRole('button', { name: 'Créer la page de réservation' }))

    await waitFor(() => {
      expect(screen.getByText('Point architecture 30 min')).toBeInTheDocument()
    })
    expect(screen.getByText('/booking/point-architecture-kodera')).toBeInTheDocument()
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })

  it('reserves and cancels a slot on BookingPublicPage with .ics invite download and zero PII', async () => {
    const user = userEvent.setup()
    const onDownloadIcs = vi.fn()
    const publicTransport: PublicBookingTransport = {
      getPage: vi.fn(async () => ({
        slug: 'point-architecture-kodera',
        title: 'Point architecture souveraine',
        description: 'Créneau de 30 minutes avec salle Visio dédiée.',
        timezone: 'Europe/Paris',
        durationMinutes: 30 as const,
        visioAvailable: true,
        slots: [
          { startsAt: '2026-06-08T10:00:00Z', endsAt: '2026-06-08T10:30:00Z' },
          { startsAt: '2026-06-08T11:00:00Z', endsAt: '2026-06-08T11:30:00Z' },
        ],
      })),
      reserveSlot: vi.fn(async (_slug: string, body) => ({
        reservationId: '00000000-0000-7000-8000-000000000401',
        slug: 'point-architecture-kodera',
        title: 'Point architecture souveraine',
        startsAt: body.startsAt,
        endsAt: '2026-06-08T11:30:00Z',
        timezone: 'Europe/Paris',
        visioUrl: 'https://visio.kodera.io/point-architecture',
        agendaDocUrl: '',
        status: 'confirmed' as const,
        cancellationToken: 'synthetic-caldav-placeholder',
        ics: 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n',
      })),
      cancelReservation: vi.fn(async (_slug: string, reservationId: string) => ({
        reservationId,
        status: 'cancelled' as const,
        cancelledAt: '2026-06-08T08:30:00Z',
        ics: 'BEGIN:VCALENDAR\r\nMETHOD:CANCEL\r\nEND:VCALENDAR\r\n',
      })),
    }

    const { container } = render(
      <BookingPublicPage
        bookingSlug="point-architecture-kodera"
        transport={publicTransport}
        onDownloadIcs={onDownloadIcs}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('Point architecture souveraine')).toBeInTheDocument()
    })

    // Select second slot and submit reservation
    await user.click(screen.getByRole('button', { name: '11:00 – 11:30 UTC' }))
    await user.type(screen.getByLabelText('Votre nom'), 'Nadia Benali')
    await user.type(screen.getByLabelText('Votre adresse courriel'), 'nadia@kodera.io')
    await user.click(screen.getByRole('button', { name: 'Confirmer la réservation' }))

    await waitFor(() => {
      expect(screen.getByTestId('booking-confirmation-card')).toBeInTheDocument()
    })
    expect(screen.getByTestId('booking-cancellation-token')).toHaveTextContent(
      'synthetic-caldav-placeholder'
    )

    await user.click(screen.getByRole('button', { name: 'Télécharger l’invitation .ics' }))
    expect(onDownloadIcs).toHaveBeenCalledWith(
      'kodera-invite-point-architecture-kodera.ics',
      expect.stringContaining('METHOD:REQUEST')
    )

    // Cancel reservation using cancellation token
    await user.click(screen.getByRole('button', { name: 'Confirmer l’annulation' }))
    await waitFor(() => {
      expect(screen.getByTestId('booking-cancelled-banner')).toBeInTheDocument()
    })

    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })

  it('wires calendar mode into StudioNavigation tools section', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    render(
      <StudioNavigation
        section="tools"
        mode="calendar"
        rooms={[]}
        onChoose={() => null}
        onChange={onChange}
      />
    )

    const calendarBtn = screen.getByRole('button', { name: 'Agenda' })
    expect(calendarBtn).toHaveAttribute('aria-current', 'page')
    await user.click(calendarBtn)
    expect(onChange).toHaveBeenCalledWith('calendar')
  })

  it('expands recurring BYDAY events across week cells and refuses non-HTTPS visio/agenda links', async () => {
    const { transport, events } = buildMockCalendarTransport()
    events.splice(
      0,
      events.length,
      {
        id: '00000000-0000-7000-8000-000000000777',
        uid: 'ev-777@kodera.calendar',
        title: 'Point bi-hebdomadaire MO+WE',
        description: '',
        location: '',
        startsAt: '2026-06-08T09:00:00Z',
        endsAt: '2026-06-08T09:30:00Z',
        timezone: 'UTC',
        rrule: 'FREQ=WEEKLY;BYDAY=MO,WE',
        status: 'confirmed',
        visibility: 'workspace',
        attendees: [],
        alarmMinutesBefore: null,
        visioUrl: 'javascript:alert(1)',
        agendaDocUrl: 'http://insecure.example/doc',
        sourceId: null,
        revision: 1,
        updatedAt: '2026-06-08T08:00:00Z',
      }
    )

    render(
      <CalendarSurfaceView
        organisationId="00000000-0000-7000-8000-000000000001"
        initialDate={ANCHOR_DATE}
        transport={transport}
      />
    )

    await waitFor(() => {
      expect(screen.getAllByText('Point bi-hebdomadaire MO+WE')).toHaveLength(2)
    })
    expect(screen.getByTestId('calendar-day-2026-06-08')).toHaveTextContent(
      'Point bi-hebdomadaire MO+WE'
    )
    expect(screen.getByTestId('calendar-day-2026-06-10')).toHaveTextContent(
      'Point bi-hebdomadaire MO+WE'
    )
    expect(screen.queryByRole('link', { name: 'Rejoindre Visio' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Ordre du jour Yjs' })).toBeNull()
  })

  it('gracefully degrades when listSources returns HTTP 403 for non-admin members while still surfacing 5xx errors', async () => {
    const user = userEvent.setup()
    const { transport, pages } = buildMockCalendarTransport()
    pages.push({
      id: '00000000-0000-7000-8000-000000000333',
      slug: 'point-membre-equipe',
      title: 'Point membre 30 min',
      description: '',
      timezone: 'Europe/Paris',
      durationMinutes: 30,
      bufferMinutes: 10,
      availabilityWindows: [{ weekday: 0, start: '09:00', end: '12:00' }],
      visioUrl: '',
      agendaDocUrl: '',
      active: true,
      revision: 1,
      createdAt: '2026-06-08T08:00:00Z',
    })
    transport.listSources = vi.fn(async () => {
      throw new ApiProblem({
        type: 'https://kodera.io/problems/forbidden',
        status: 403,
        title: 'Forbidden',
      })
    })

    const { unmount } = render(
      <CalendarSurfaceView
        organisationId="00000000-0000-7000-8000-000000000001"
        initialDate={ANCHOR_DATE}
        transport={transport}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('Synchronisation produit hebdomadaire')).toBeInTheDocument()
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sources CalDAV' })).toBeNull()
    expect(screen.queryByTestId('calendar-caldav-drawer')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Pages de réservation' }))
    expect(screen.getByText('Point membre 30 min')).toBeInTheDocument()
    unmount()

    // Non-403 failures on listSources still surface the error banner
    const { transport: failingTransport } = buildMockCalendarTransport()
    failingTransport.listSources = vi.fn(async () => {
      throw new ApiProblem({
        type: 'https://kodera.io/problems/service-unavailable',
        status: 503,
        title: 'Service Unavailable',
      })
    })
    render(
      <CalendarSurfaceView
        organisationId="00000000-0000-7000-8000-000000000001"
        initialDate={ANCHOR_DATE}
        transport={failingTransport}
      />
    )
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
  })
})
