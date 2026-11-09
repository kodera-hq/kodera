import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Banner } from './Banner'

describe('Banner', () => {
  it('renders the headline', () => {
    render(<Banner kind="info" headline="La facture de janvier est prête." />)

    expect(screen.getByText('La facture de janvier est prête.')).toBeInTheDocument()
  })

  it('renders the detail line when the caller gives one', () => {
    render(
      <Banner
        kind="info"
        headline="La facture de janvier est prête."
        detail="Elle est prélevée le 5."
      />
    )

    expect(screen.getByText('Elle est prélevée le 5.')).toBeInTheDocument()
  })

  it('renders the action the caller passes', () => {
    render(
      <Banner
        kind="info"
        headline="Domaine à vérifier"
        action={<button type="button">Vérifier</button>}
      />
    )

    expect(screen.getByRole('button', { name: 'Vérifier' })).toBeInTheDocument()
  })

  it('is a status region for info, maintenance and success — not an interruption', () => {
    render(<Banner kind="info" headline="Info" />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('is an alert for an incident — the one kind worth interrupting for', () => {
    render(<Banner kind="incident" headline="Incident en cours" />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('keeps its role even if a caller-forwarded prop tries to override it', () => {
    // `BannerProps` extends the div's own HTML attributes, `role` included —
    // a caller spreading extra props through could pass one without meaning
    // to. The kind's own role has to win, or an incident stops interrupting.
    render(<Banner kind="incident" headline="Incident en cours" role="status" />)

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows no dismiss control unless the caller asks for one', () => {
    render(<Banner kind="info" headline="Info" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('dismisses through a named control when the caller opts in', async () => {
    const onDismiss = vi.fn()
    render(
      <Banner
        kind="info"
        headline="Info"
        dismissible
        dismissLabel="Fermer ce message"
        onDismiss={onDismiss}
      />
    )

    const dismiss = screen.getByRole('button', { name: 'Fermer ce message' })
    dismiss.click()

    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('forwards its ref', () => {
    const ref = createRef<HTMLDivElement>()
    render(<Banner kind="info" headline="Info" ref={ref} />)

    expect(ref.current).not.toBeNull()
  })

  it('concatenates the caller class with the kind classes', () => {
    render(<Banner kind="info" headline="Info" className="mt-4" data-testid="banner" />)

    expect(screen.getByTestId('banner')).toHaveClass('mt-4')
  })
})
