import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MetricCard } from './MetricCard'

describe('MetricCard', () => {
  it('shows the label and the value', () => {
    render(<MetricCard label="Personnes actives" value="42" />)

    expect(screen.getByText('Personnes actives')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
  })

  it('renders the value in mono with tabular numerals', () => {
    render(<MetricCard label="Personnes actives" value="42" />)

    expect(screen.getByText('42')).toHaveClass('font-mono')
  })

  it('renders an optional caption', () => {
    render(<MetricCard label="Personnes actives" value="42" caption="sur 50 places" />)

    expect(screen.getByText('sur 50 places')).toBeInTheDocument()
  })

  it('omits the caption when none is given', () => {
    render(<MetricCard label="Personnes actives" value="42" />)

    expect(screen.queryByText('sur 50 places')).toBeNull()
  })

  it('shows an upward delta in the success colour', () => {
    render(
      <MetricCard label="Factures payées" value="12" delta={{ value: '+3', direction: 'up' }} />
    )

    expect(screen.getByText('+3')).toHaveClass('text-c-ok-ink')
  })

  it('shows a downward delta in the danger colour', () => {
    render(
      <MetricCard label="Tickets ouverts" value="2" delta={{ value: '-1', direction: 'down' }} />
    )

    expect(screen.getByText('-1')).toHaveClass('text-c-bad-ink')
  })

  it('shows a neutral delta without a status colour', () => {
    render(<MetricCard label="Domaines" value="4" delta={{ value: '±0', direction: 'neutral' }} />)

    const delta = screen.getByText('±0')
    expect(delta).not.toHaveClass('text-c-ok-ink')
    expect(delta).not.toHaveClass('text-c-bad-ink')
  })

  it('switches to the inverse tone', () => {
    render(<MetricCard label="Solde" value="1 200 €" tone="inverse" />)

    expect(screen.getByText('1 200 €').closest('[class*="bg-c-inverse"]')).not.toBeNull()
  })
})
