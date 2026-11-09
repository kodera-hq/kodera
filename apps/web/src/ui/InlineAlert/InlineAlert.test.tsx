import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { InlineAlert } from './InlineAlert'

describe('InlineAlert', () => {
  it('renders the caller-supplied message', () => {
    render(<InlineAlert kind="error">Le nom de domaine est déjà utilisé.</InlineAlert>)

    expect(screen.getByText('Le nom de domaine est déjà utilisé.')).toBeInTheDocument()
  })

  it('is an alert for an error — worth interrupting for, inside a form', () => {
    render(<InlineAlert kind="error">Erreur</InlineAlert>)

    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('keeps its role even if a caller-forwarded prop tries to override it', () => {
    // `InlineAlertProps` extends the div's own HTML attributes, `role`
    // included — the kind's own role has to win, or an error stops
    // interrupting right next to the field it explains.
    render(
      <InlineAlert kind="error" role="status">
        Erreur
      </InlineAlert>
    )

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('is a status region for info and success', () => {
    const { rerender } = render(<InlineAlert kind="info">Info</InlineAlert>)
    expect(screen.getByRole('status')).toBeInTheDocument()

    rerender(<InlineAlert kind="success">OK</InlineAlert>)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('leaves the announcing to the live region a caller keeps it in', () => {
    render(
      <div role="status" data-testid="region">
        <InlineAlert kind="warning" inLiveRegion>
          Attention
        </InlineAlert>
      </div>
    )

    // One region, the caller's: the alert adds no second one inside it.
    expect(screen.getAllByRole('status')).toEqual([screen.getByTestId('region')])
    expect(screen.getByTestId('region')).toHaveTextContent('Attention')
  })

  it('forwards its ref', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <InlineAlert kind="info" ref={ref}>
        Info
      </InlineAlert>
    )

    expect(ref.current).not.toBeNull()
  })

  it('concatenates the caller class with the kind classes', () => {
    render(
      <InlineAlert kind="info" className="mt-2" data-testid="alert">
        Info
      </InlineAlert>
    )

    expect(screen.getByTestId('alert')).toHaveClass('mt-2')
  })
})
