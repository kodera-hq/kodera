import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { Badge } from './Badge'

describe('Badge', () => {
  it('renders the caller-supplied content', () => {
    render(<Badge>12</Badge>)

    expect(screen.getByText('12')).toBeInTheDocument()
  })

  it('defaults to the neutral variant', () => {
    render(<Badge data-testid="badge">3</Badge>)

    expect(screen.getByTestId('badge')).toHaveClass('bg-c-muted')
  })

  it('switches to the accent variant', () => {
    render(
      <Badge variant="accent" data-testid="badge">
        Nouveau
      </Badge>
    )

    expect(screen.getByTestId('badge')).toHaveClass('bg-c-accent-soft')
  })

  it('forwards its ref', () => {
    const ref = createRef<HTMLSpanElement>()
    render(<Badge ref={ref}>1</Badge>)

    expect(ref.current).not.toBeNull()
  })

  it('concatenates the caller class with the variant classes', () => {
    render(
      <Badge className="ml-2" data-testid="badge">
        1
      </Badge>
    )

    expect(screen.getByTestId('badge')).toHaveClass('ml-2')
  })
})
