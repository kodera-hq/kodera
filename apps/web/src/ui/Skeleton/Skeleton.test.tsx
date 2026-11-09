import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { Skeleton } from './Skeleton'

describe('Skeleton', () => {
  it('is hidden from assistive technology when it carries no loading text', () => {
    render(<Skeleton data-testid="block" />)

    const block = screen.getByTestId('block')
    expect(block).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('announces the caller-supplied loading text through a status region', () => {
    render(<Skeleton label="Chargement des factures…" />)

    const status = screen.getByRole('status')
    expect(status).toHaveAccessibleName('Chargement des factures…')
  })

  it('keeps the visible block decorative even when a label is present', () => {
    // A screen reader must hear the label once, not the block and the label
    // both — the block itself stays out of the accessibility tree.
    render(<Skeleton label="Chargement…" data-testid="labelled" />)

    // The block is not the element carrying data-testid in this shape — the
    // outer status region is. Query it and confirm its inner block is hidden.
    const status = screen.getByRole('status')
    const decorative = status.querySelector('[aria-hidden="true"]')
    expect(decorative).not.toBeNull()
  })

  it('stays hidden even if a caller-forwarded prop tries to un-hide it', () => {
    // `SkeletonProps` extends the span's own HTML attributes, `aria-hidden`
    // included — a caller composing this into a wrapper could pass one
    // through without meaning to. The decorative guarantee has to win.
    render(<Skeleton aria-hidden={false} data-testid="block" />)

    expect(screen.getByTestId('block')).toHaveAttribute('aria-hidden', 'true')
  })

  it('keeps its role and its accessible name even if a caller-forwarded prop tries to override them', () => {
    render(
      <Skeleton label="Chargement des factures…" role="alert" aria-labelledby="somewhere-else" />
    )

    const status = screen.getByRole('status')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(status).toHaveAccessibleName('Chargement des factures…')
  })

  it('never spins — it is a static block, not a Spinner', () => {
    render(<Skeleton data-testid="block" />)

    expect(screen.getByTestId('block').className).not.toContain('animate-spin')
  })

  it('forwards its ref', () => {
    const ref = createRef<HTMLSpanElement>()
    render(<Skeleton ref={ref} />)

    expect(ref.current).not.toBeNull()
  })

  it('concatenates the caller class with the shape classes', () => {
    render(<Skeleton className="w-8" data-testid="block" />)

    expect(screen.getByTestId('block')).toHaveClass('w-8')
  })
  it.each([
    ['default', 'bg-c-muted-2', 'bg-c-inverse-2'],
    ['inverse', 'bg-c-inverse-2', 'bg-c-muted-2'],
  ] as const)(
    'paints the %s tone on the block, with and without a label',
    (tone, wanted, other) => {
      const { unmount } = render(<Skeleton tone={tone} data-testid="block" />)
      expect(screen.getByTestId('block')).toHaveClass(wanted)
      expect(screen.getByTestId('block')).not.toHaveClass(other)
      unmount()

      render(<Skeleton tone={tone} label="Chargement…" />)
      const block = screen.getByRole('status').querySelector('[aria-hidden="true"]')
      expect(block).toHaveClass(wanted)
      expect(block).not.toHaveClass(other)
    }
  )
})
