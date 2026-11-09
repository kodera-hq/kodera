import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { IncidentDrawer } from './IncidentDrawer'

describe('IncidentDrawer', () => {
  it('shows the since and next-update times and the updates in order', () => {
    render(
      <IncidentDrawer
        open={true}
        onOpenChange={vi.fn()}
        componentLabel="Appels vidéo"
        since="2026-12-03T13:10:00Z"
        nextUpdateAt="2026-12-03T14:30:00Z"
        impactKey="incident.impact.calls_drop"
        updates={[
          { at: '2026-12-03T13:25:00Z', bodyKey: 'incident.update.identified' },
          { at: '2026-12-03T13:40:00Z', bodyKey: 'incident.update.fixing' },
        ]}
        isError={false}
        onOpenTicket={vi.fn()}
      />
    )

    expect(screen.getByRole('heading', { name: 'Appels vidéo perturbé' })).toBeInTheDocument()
    const terms = screen.getAllByRole('term').map((el) => el.textContent)
    expect(terms).toEqual(['14:25', '14:40'])
  })

  it('falls back to a generic sentence for a body key the catalogue does not register', () => {
    render(
      <IncidentDrawer
        open={true}
        onOpenChange={vi.fn()}
        componentLabel="Appels vidéo"
        since={undefined}
        nextUpdateAt={undefined}
        impactKey="incident.impact.calls_drop"
        updates={[{ at: '2026-12-03T13:25:00Z', bodyKey: 'incident.unknown.key' }]}
        isError={false}
        onOpenTicket={vi.fn()}
      />
    )
    expect(screen.getByText('Mise à jour en cours.')).toBeInTheDocument()
  })

  it('shows the empty-updates message when nothing has been published yet', () => {
    render(
      <IncidentDrawer
        open={true}
        onOpenChange={vi.fn()}
        componentLabel="Appels vidéo"
        since={undefined}
        nextUpdateAt={undefined}
        impactKey={undefined}
        updates={[]}
        isError={false}
        onOpenTicket={vi.fn()}
      />
    )
    expect(
      screen.getByText('Nous mettons cette page à jour dès que nous en savons plus.')
    ).toBeInTheDocument()
  })

  it('shows an error, and no external status link, when the incident detail fails', () => {
    render(
      <IncidentDrawer
        open={true}
        onOpenChange={vi.fn()}
        componentLabel="Appels vidéo"
        since={undefined}
        nextUpdateAt={undefined}
        impactKey={undefined}
        updates={[]}
        isError={true}
        onOpenTicket={vi.fn()}
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Le détail de l'incident n'est pas disponible pour le moment. Réessayez dans quelques minutes."
    )
    // Owner ruling 2026-09-24: no external status page; the drawer's one way
    // out is the ticket action (Aide).
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('calls onOpenTicket from the footer action', async () => {
    const user = userEvent.setup()
    const onOpenTicket = vi.fn()
    render(
      <IncidentDrawer
        open={true}
        onOpenChange={vi.fn()}
        componentLabel="Appels vidéo"
        since={undefined}
        nextUpdateAt={undefined}
        impactKey={undefined}
        updates={[]}
        isError={false}
        onOpenTicket={onOpenTicket}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Ouvrir un ticket' }))
    expect(onOpenTicket).toHaveBeenCalled()
  })
})
