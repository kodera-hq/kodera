import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TimelineDivider } from './TimelineDivider'

describe('TimelineDivider', () => {
  it('draws a day in the quiet ink, between soft rules', () => {
    const { container } = render(<TimelineDivider>Aujourd’hui</TimelineDivider>)
    const divider = container.firstElementChild!
    expect(divider).toHaveClass('text-c-ink-3', 'text-xs', 'font-semibold')
    const rules = divider.querySelectorAll('[aria-hidden="true"]')
    expect(rules).toHaveLength(2)
    rules.forEach((rule) => expect(rule).toHaveClass('bg-c-border-soft', 'h-px'))
  })

  it('draws « Nouveaux messages » in the accent ink, rules included', () => {
    const { container } = render(<TimelineDivider tone="new">Nouveaux messages</TimelineDivider>)
    const divider = container.firstElementChild!
    expect(divider).toHaveClass('text-c-accent-ink')
    expect(divider).not.toHaveClass('text-c-ink-3')
    divider
      .querySelectorAll('[aria-hidden="true"]')
      .forEach((rule) => expect(rule).toHaveClass('bg-c-accent-ink'))
  })

  it('keeps its label readable: plain text, not a separator whose content is skipped', () => {
    render(<TimelineDivider tone="new">Nouveaux messages</TimelineDivider>)
    expect(screen.queryByRole('separator')).toBeNull()
    expect(screen.getByText('Nouveaux messages')).not.toHaveAttribute('aria-hidden')
  })
})
