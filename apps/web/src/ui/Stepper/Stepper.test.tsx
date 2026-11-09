import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Stepper } from './Stepper'

const steps = [
  { label: 'Organisation créée', status: 'done' as const },
  { label: 'Domaine vérifié', status: 'current' as const },
  { label: 'Personnes invitées', status: 'upcoming' as const },
]

describe('Stepper', () => {
  it('renders every step label', () => {
    render(<Stepper steps={steps} />)

    expect(screen.getByText('Organisation créée')).toBeInTheDocument()
    expect(screen.getByText('Domaine vérifié')).toBeInTheDocument()
    expect(screen.getByText('Personnes invitées')).toBeInTheDocument()
  })

  it('marks only the current step with aria-current="step"', () => {
    render(<Stepper steps={steps} />)

    const current = screen.getByText('Domaine vérifié').closest('li')
    expect(current).toHaveAttribute('aria-current', 'step')

    const done = screen.getByText('Organisation créée').closest('li')
    const upcoming = screen.getByText('Personnes invitées').closest('li')
    expect(done).not.toHaveAttribute('aria-current')
    expect(upcoming).not.toHaveAttribute('aria-current')
  })

  it('lays out horizontally by default', () => {
    const { container } = render(<Stepper steps={steps} />)

    expect(container.querySelector('ol')).toHaveClass('items-center')
  })

  it('lays out vertically when asked to', () => {
    const { container } = render(<Stepper steps={steps} orientation="vertical" />)

    expect(container.querySelector('ol')).toHaveClass('flex-col')
  })
})
