import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { StatusPill } from './StatusPill'

describe('StatusPill', () => {
  it('shows the word — colour never carries a state alone', () => {
    render(<StatusPill state="success">Active</StatusPill>)

    expect(screen.getByText('Active')).toBeInTheDocument()
  })

  it('is not a live region — a status changing on a table row is not an interruption', () => {
    render(<StatusPill state="success">Active</StatusPill>)

    expect(screen.queryByRole('status')).toBeNull()
  })

  it('draws a dot for every state except planned', () => {
    const { rerender, container } = render(<StatusPill state="success">Active</StatusPill>)
    expect(container.querySelector('[data-pill-dot]')).not.toBeNull()

    rerender(<StatusPill state="planned">Prévu · T2</StatusPill>)
    expect(container.querySelector('[data-pill-dot]')).toBeNull()
  })

  it('hides the dot from assistive technology, since the word is what is announced', () => {
    const { container } = render(<StatusPill state="danger">Incident</StatusPill>)

    expect(container.querySelector('[data-pill-dot]')).toHaveAttribute('aria-hidden', 'true')
  })

  it('marks the planned state with a dashed border instead of a fill', () => {
    render(<StatusPill state="planned">Prévu · T2</StatusPill>)

    expect(screen.getByText('Prévu · T2')).toHaveClass('border-dashed')
  })

  it('forwards its ref', () => {
    const ref = createRef<HTMLSpanElement>()
    render(
      <StatusPill state="neutral" ref={ref}>
        En attente
      </StatusPill>
    )

    expect(ref.current).not.toBeNull()
  })

  it('concatenates the caller class with the state classes', () => {
    render(
      <StatusPill state="info" className="ml-2">
        Provisionnement
      </StatusPill>
    )

    expect(screen.getByText('Provisionnement')).toHaveClass('ml-2')
  })
})
