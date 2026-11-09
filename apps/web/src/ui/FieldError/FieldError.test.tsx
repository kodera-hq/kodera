import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { FieldError } from './FieldError'

describe('FieldError', () => {
  it('announces the message as an alert', () => {
    render(<FieldError>Ce nom est déjà pris.</FieldError>)

    expect(screen.getByRole('alert')).toHaveTextContent('Ce nom est déjà pris.')
  })

  it('carries the id a control passes it, so aria-describedby can reach it', () => {
    render(<FieldError id="domain-error">Ce nom est déjà pris.</FieldError>)

    expect(screen.getByRole('alert')).toHaveAttribute('id', 'domain-error')
  })

  it('renders nothing when there is no message, rather than an empty alert', () => {
    // An alert with nothing in it still fires a live-region announcement of
    // silence the moment it mounts — worse than not rendering at all.
    const { container } = render(<FieldError />)

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders nothing for an empty string either', () => {
    const { container } = render(<FieldError>{''}</FieldError>)

    expect(container).toBeEmptyDOMElement()
  })

  it('keeps role="alert" even if a caller passes a conflicting role', () => {
    // `role` is a valid prop here (`HTMLAttributes`) — a caller passing one,
    // by mistake or by copying a prop bag from elsewhere, must not silence
    // the one thing this primitive exists to guarantee.
    render(<FieldError role="note">Ce nom est déjà pris.</FieldError>)

    expect(screen.getByRole('alert')).toHaveTextContent('Ce nom est déjà pris.')
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('forwards its ref to the alert paragraph', () => {
    const ref = createRef<HTMLParagraphElement>()
    render(<FieldError ref={ref}>Ce nom est déjà pris.</FieldError>)

    expect(ref.current).toBe(screen.getByRole('alert'))
  })
})
