import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { PasswordField } from './PasswordField'

const LABELS = {
  showLabel: 'Afficher le mot de passe',
  hideLabel: 'Masquer le mot de passe',
}

describe('PasswordField', () => {
  it('hides the value by default', () => {
    render(<PasswordField label="Mot de passe" {...LABELS} />)

    expect(screen.getByLabelText('Mot de passe')).toHaveAttribute('type', 'password')
  })

  it('reveals the value when the toggle is pressed, and says so', async () => {
    const user = userEvent.setup()
    render(<PasswordField label="Mot de passe" {...LABELS} />)

    const toggle = screen.getByRole('button', { name: 'Afficher le mot de passe' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    await user.click(toggle)

    expect(screen.getByLabelText('Mot de passe')).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Masquer le mot de passe' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('hides the value again on a second press', async () => {
    const user = userEvent.setup()
    render(<PasswordField label="Mot de passe" {...LABELS} />)

    const toggle = screen.getByRole('button', { name: 'Afficher le mot de passe' })
    await user.click(toggle)
    await user.click(screen.getByRole('button', { name: 'Masquer le mot de passe' }))

    expect(screen.getByLabelText('Mot de passe')).toHaveAttribute('type', 'password')
  })

  it('is reachable by Tab and toggled by Enter, without leaving the field', async () => {
    const user = userEvent.setup()
    render(<PasswordField label="Mot de passe" {...LABELS} />)

    await user.tab()
    expect(screen.getByLabelText('Mot de passe')).toHaveFocus()

    await user.tab()
    expect(screen.getByRole('button', { name: 'Afficher le mot de passe' })).toHaveFocus()

    await user.keyboard('{Enter}')

    expect(screen.getByLabelText('Mot de passe')).toHaveAttribute('type', 'text')
  })

  it('describes the field with help and error, same as TextField', () => {
    render(
      <PasswordField
        label="Mot de passe"
        {...LABELS}
        help="8 caractères minimum."
        error="Trop court."
      />
    )

    const input = screen.getByLabelText('Mot de passe')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('8 caractères minimum. Trop court.')
    // No `role="alert"`: composed through `TextField`, this is now genuinely
    // the same error line — found via `aria-describedby` when the field is
    // reached, not announced through a live region (`FieldError.tsx`
    // documents why `TextField`-family fields differ from `Select`,
    // `Checkbox` and the rest of this unit on that one point).
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Trop court.')).toBeVisible()
  })

  it('keeps aria-invalid when the field has an error, even against a conflicting caller prop', () => {
    // `aria-invalid` is a valid prop here (`InputHTMLAttributes`) — a stray
    // one from elsewhere must not silence the invalid state `error` sets.
    render(
      <PasswordField label="Mot de passe" {...LABELS} error="Trop court." aria-invalid="false" />
    )

    expect(screen.getByLabelText('Mot de passe')).toHaveAttribute('aria-invalid', 'true')
  })

  it('disables the input and the toggle together', () => {
    render(<PasswordField label="Mot de passe" {...LABELS} disabled />)

    expect(screen.getByLabelText('Mot de passe')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Afficher le mot de passe' })).toBeDisabled()
  })

  it('forwards its ref, so a form can move focus to it', () => {
    const ref = createRef<HTMLInputElement>()
    render(<PasswordField label="Mot de passe" {...LABELS} ref={ref} />)

    ref.current?.focus()

    expect(screen.getByLabelText('Mot de passe')).toHaveFocus()
  })
})
