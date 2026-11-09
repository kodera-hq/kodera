import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { CapacityCard } from './CapacityCard'

describe('CapacityCard', () => {
  it('reads the gauge as people out of people, not a bare percentage', () => {
    render(
      <CapacityCard
        canOrder
        participants={{ used: 17, included: 50, pct: 34 }}
        thresholdPct={90}
        upgradePrompt={false}
        onSeePlans={vi.fn()}
        onTalkToUs={vi.fn()}
      />
    )
    expect(
      screen.getByRole('meter', {
        name: (_, el) => el.getAttribute('aria-valuetext')?.includes('17') === true,
      })
    ).toBeInTheDocument()
  })

  it('shows no upgrade message or buttons when the server does not ask for one', () => {
    render(
      <CapacityCard
        canOrder
        participants={{ used: 46, included: 50, pct: 92 }}
        thresholdPct={90}
        upgradePrompt={false}
        onSeePlans={vi.fn()}
        onTalkToUs={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: 'Voir les formules' })).not.toBeInTheDocument()
  })

  it('states what happens at the cap before offering the plans link, at 92%', () => {
    render(
      <CapacityCard
        canOrder
        participants={{ used: 46, included: 50, pct: 92 }}
        thresholdPct={90}
        upgradePrompt={true}
        onSeePlans={vi.fn()}
        onTalkToUs={vi.fn()}
      />
    )
    expect(screen.getByText('Proche de la limite')).toBeInTheDocument()
    expect(
      screen.getByText(/nouvelles connexions sont refusées jusqu'à ce qu'une place se libère/)
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Voir les formules' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Nous en parler' })).toBeInTheDocument()
  })

  it('shows the capacity-reached message at 100%', () => {
    render(
      <CapacityCard
        canOrder
        participants={{ used: 50, included: 50, pct: 100 }}
        thresholdPct={90}
        upgradePrompt={true}
        onSeePlans={vi.fn()}
        onTalkToUs={vi.fn()}
      />
    )
    expect(
      screen.getByText(/La limite de 50 personnes en même temps est atteinte/)
    ).toBeInTheDocument()
    expect(screen.queryByText('Proche de la limite')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Voir les formules' })).toBeInTheDocument()
  })

  it('hides the gauge entirely when there is no limit to measure against', () => {
    const { container } = render(
      <CapacityCard
        canOrder
        participants={{ used: 0, included: 0, pct: 0 }}
        thresholdPct={90}
        upgradePrompt={false}
        onSeePlans={vi.fn()}
        onTalkToUs={vi.fn()}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
