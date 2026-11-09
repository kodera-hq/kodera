import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlanPrice } from './PlanPrice'

describe('PlanPrice', () => {
  it('shows the amount large in the sans face with tabular figures, the period at 12 px and the note', () => {
    render(<PlanPrice amount="134 €" per="/mois" note="149 € par mois sans engagement" />)
    const amount = screen.getByText('134 €')
    expect(amount).toHaveClass('text-3xl', 'font-bold', 'leading-tight', 'tabular-nums')
    expect(amount).not.toHaveClass('font-mono')
    expect(screen.getByText('/mois')).toHaveClass('text-xs', 'text-c-ink-3')
    expect(screen.getByText('149 € par mois sans engagement')).toBeInTheDocument()
  })

  it('draws neither the period nor the note when there is none', () => {
    const { container } = render(<PlanPrice amount="—" />)
    expect(container.querySelectorAll('p')).toHaveLength(1)
    expect(container.querySelector('p')?.children).toHaveLength(1)
  })
})
