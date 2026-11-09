import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PriceLine } from './PriceLine'

describe('PriceLine', () => {
  it('renders the label and the preformatted amount, verbatim', () => {
    render(<PriceLine label="Abonnement Visio" amount="29,00 €" />)

    expect(screen.getByText('Abonnement Visio')).toBeInTheDocument()
    expect(screen.getByText('29,00 €')).toBeInTheDocument()
  })

  it('does not reformat the amount it is given', () => {
    // The point of this test is negative: whatever string the caller passes
    // is what is on screen, digit for digit and separator for separator —
    // this primitive has no `Intl.NumberFormat` call to get wrong.
    render(<PriceLine label="Solde" amount="1 234,56 €" />)

    expect(screen.getByText('1 234,56 €')).toBeInTheDocument()
  })

  it('renders the amount in mono', () => {
    render(<PriceLine label="Abonnement Visio" amount="29,00 €" />)

    expect(screen.getByText('29,00 €')).toHaveClass('font-mono')
  })

  it('renders an optional caption next to the amount', () => {
    render(<PriceLine label="Abonnement Visio" amount="29,00 €" caption="/ mois" />)

    expect(screen.getByText('/ mois')).toBeInTheDocument()
  })

  it('omits the caption when none is given', () => {
    render(<PriceLine label="Abonnement Visio" amount="29,00 €" />)

    expect(screen.queryByText('/ mois')).toBeNull()
  })

  it('emphasises the amount when asked to', () => {
    render(<PriceLine label="Total annuel" amount="348,00 €" emphasis />)

    expect(screen.getByText('348,00 €')).toHaveClass('text-2xl')
  })
})
