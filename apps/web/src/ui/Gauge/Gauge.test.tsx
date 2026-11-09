import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Gauge } from './Gauge'

describe('Gauge', () => {
  it('is a meter with the value and the label as text', () => {
    render(<Gauge label="Capacité de stockage" value={62} valueText="62 / 100" />)

    const meter = screen.getByRole('meter', { name: 'Capacité de stockage' })
    expect(meter).toHaveAttribute('aria-valuenow', '62')
    expect(meter).toHaveAttribute('aria-valuetext', '62 / 100')
    expect(screen.getByText('Capacité de stockage')).toBeInTheDocument()
    expect(screen.getByText('62 / 100')).toBeInTheDocument()
  })

  it('fills with the accent colour below 90%', () => {
    render(<Gauge label="Capacité" value={62} valueText="62 / 100" />)

    const meter = screen.getByRole('meter')
    expect(meter.querySelector('[data-gauge-fill]')).toHaveClass('bg-c-action')
  })

  it('fills amber and shows the status label at 90% and above', () => {
    render(
      <Gauge label="Capacité" value={92} valueText="92 / 100" statusLabel="Proche de la limite" />
    )

    const meter = screen.getByRole('meter')
    expect(meter.querySelector('[data-gauge-fill]')).toHaveClass('bg-c-warn')
    expect(screen.getByText('Proche de la limite')).toHaveClass('text-c-warn-ink')
  })

  it('fills red and shows the timestamp caption at 100%', () => {
    render(
      <Gauge
        label="Capacité"
        value={100}
        valueText="100 / 100"
        statusLabel="Limite atteinte"
        timestamp="Dernier refus à 14:32"
      />
    )

    const meter = screen.getByRole('meter')
    expect(meter.querySelector('[data-gauge-fill]')).toHaveClass('bg-c-bad')
    expect(screen.getByText('Limite atteinte')).toHaveClass('text-c-bad-ink')
    expect(screen.getByText('Dernier refus à 14:32')).toBeInTheDocument()
  })

  it('does not show a timestamp below 100%, even if one is passed', () => {
    render(
      <Gauge
        label="Capacité"
        value={92}
        valueText="92 / 100"
        statusLabel="Proche de la limite"
        timestamp="Dernier refus à 14:32"
      />
    )

    expect(screen.queryByText('Dernier refus à 14:32')).toBeNull()
  })

  it('shows the action slot only once the gauge is at or above 90%', () => {
    const { rerender } = render(
      <Gauge
        label="Capacité"
        value={62}
        valueText="62 / 100"
        action={<button type="button">Augmenter</button>}
      />
    )
    expect(screen.queryByRole('button', { name: 'Augmenter' })).toBeNull()

    rerender(
      <Gauge
        label="Capacité"
        value={92}
        valueText="92 / 100"
        statusLabel="Proche de la limite"
        action={<button type="button">Augmenter</button>}
      />
    )
    expect(screen.getByRole('button', { name: 'Augmenter' })).toBeInTheDocument()
  })
})
