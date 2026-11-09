import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Spinner } from './Spinner'

describe('Spinner', () => {
  it('announces the wait when it is given a label', () => {
    // A `status` is a live region: what a screen reader reads is its CONTENT,
    // not an accessible name, which is why the label is text inside it and not
    // an `aria-label` that would replace that content.
    render(<Spinner label="Chargement" />)

    expect(screen.getByRole('status')).toHaveTextContent('Chargement')
  })

  it('is invisible to assistive technology when it has no label', () => {
    // The decorative case. A spinner inside a control that already announces
    // the wait must not announce it a second time, in different words.
    const { container } = render(<Spinner />)

    expect(screen.queryByRole('status')).toBeNull()
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  })
})
