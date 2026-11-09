import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Checkbox } from './Checkbox'

describe('Checkbox', () => {
  it('is reachable by its visible label', () => {
    render(<Checkbox label="Recevoir la newsletter" />)

    expect(screen.getByRole('checkbox', { name: 'Recevoir la newsletter' })).toBeVisible()
  })

  it('is unchecked by default and toggles on click', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(<Checkbox label="Recevoir la newsletter" onCheckedChange={onCheckedChange} />)

    const checkbox = screen.getByRole('checkbox', { name: 'Recevoir la newsletter' })
    expect(checkbox).toHaveAttribute('aria-checked', 'false')

    await user.click(checkbox)

    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  it('toggles with the keyboard, Tab then Space', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(<Checkbox label="Recevoir la newsletter" onCheckedChange={onCheckedChange} />)

    await user.tab()
    expect(screen.getByRole('checkbox', { name: 'Recevoir la newsletter' })).toHaveFocus()

    await user.keyboard(' ')

    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  it('shows the indeterminate state without it being checked or unchecked', () => {
    render(<Checkbox label="Tout sélectionner" checked="indeterminate" />)

    expect(screen.getByRole('checkbox', { name: 'Tout sélectionner' })).toHaveAttribute(
      'aria-checked',
      'mixed'
    )
  })

  it('marks the field invalid and describes it with the error', () => {
    render(
      <Checkbox label="J’accepte les conditions" error="Vous devez accepter pour continuer." />
    )

    const checkbox = screen.getByRole('checkbox', { name: 'J’accepte les conditions' })
    expect(checkbox).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Vous devez accepter pour continuer.')
  })

  it('describes the field with help text', () => {
    render(<Checkbox label="Recevoir la newsletter" help="Un e-mail par mois, résiliable." />)

    expect(
      screen.getByRole('checkbox', { name: 'Recevoir la newsletter' })
    ).toHaveAccessibleDescription('Un e-mail par mois, résiliable.')
  })

  it('is disabled when the caller disables it', () => {
    render(<Checkbox label="Recevoir la newsletter" disabled />)

    expect(screen.getByRole('checkbox', { name: 'Recevoir la newsletter' })).toBeDisabled()
  })

  it('forwards its ref, so a form can move focus to it', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<Checkbox label="Recevoir la newsletter" ref={ref} />)

    ref.current?.focus()

    expect(screen.getByRole('checkbox', { name: 'Recevoir la newsletter' })).toHaveFocus()
  })
})
