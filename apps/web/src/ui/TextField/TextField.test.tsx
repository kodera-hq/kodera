import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { TextField } from './TextField'

describe('TextField', () => {
  it('is reachable by its visible label', () => {
    render(<TextField label="Nom de l’organisation" />)

    expect(screen.getByLabelText('Nom de l’organisation')).toBeVisible()
  })

  it('gives two fields with the same label distinct ids', () => {
    // Two generated ids that collide make both labels point at the first
    // control, and nothing fails: the second field simply has no label.
    render(
      <>
        <TextField label="Domaine" />
        <TextField label="Domaine" />
      </>
    )

    const [first, second] = screen.getAllByLabelText('Domaine')
    expect(first?.id).not.toBe(second?.id)
  })

  it('reads its help text out with the field', () => {
    render(<TextField label="Domaine" help="Sans www." />)

    expect(screen.getByLabelText('Domaine')).toHaveAccessibleDescription('Sans www.')
  })

  it('marks the field invalid and describes it with the error', () => {
    render(<TextField label="Domaine" error="Ce nom est pris. Essayez « acme-construction »." />)

    const input = screen.getByLabelText('Domaine')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('Ce nom est pris. Essayez « acme-construction ».')
  })

  it('describes the field with the help AND the error when both are shown', () => {
    render(<TextField label="Domaine" help="Sans www." error="Ce nom est pris." />)

    expect(screen.getByLabelText('Domaine')).toHaveAccessibleDescription(
      'Sans www. Ce nom est pris.'
    )
  })

  it('carries no description and no invalid state when there is nothing to say', () => {
    render(<TextField label="Domaine" />)

    const input = screen.getByLabelText('Domaine')
    expect(input).not.toHaveAttribute('aria-describedby')
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  it('reads the suffix out with the field, since it completes the value', () => {
    // Hidden, the field announces "acme" while the screen says
    // "acme.visio.kodera.io", and the person cannot tell whether they are
    // meant to type the domain themselves.
    render(<TextField label="Sous-domaine" suffix=".visio.kodera.io" />)

    expect(screen.getByLabelText('Sous-domaine')).toHaveAccessibleDescription('.visio.kodera.io')
  })

  it('puts the suffix last, after the help and the error', () => {
    render(
      <TextField
        label="Sous-domaine"
        help="Lettres et tirets."
        error="Ce nom est pris."
        suffix=".visio.kodera.io"
      />
    )

    expect(screen.getByLabelText('Sous-domaine')).toHaveAccessibleDescription(
      'Lettres et tirets. Ce nom est pris. .visio.kodera.io'
    )
  })

  it('hides a suffix the caller marks as decorative', () => {
    render(<TextField label="Montant" suffix="€" decorative />)

    expect(screen.getByText('€')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByLabelText('Montant')).not.toHaveAttribute('aria-describedby')
  })

  it('is disabled and read-only when the caller says so', () => {
    render(
      <>
        <TextField label="Domaine" disabled />
        <TextField label="Identifiant" readOnly value="acme" onChange={() => {}} />
      </>
    )

    expect(screen.getByLabelText('Domaine')).toBeDisabled()
    expect(screen.getByLabelText('Identifiant')).toHaveAttribute('readonly')
  })

  it('forwards its ref, so a form can move focus to the first field in error', () => {
    const ref = createRef<HTMLInputElement>()
    render(<TextField label="Domaine" ref={ref} />)

    ref.current?.focus()

    expect(screen.getByLabelText('Domaine')).toHaveFocus()
  })

  it('reaches a focusable action by Tab right after the input', async () => {
    const user = userEvent.setup()
    render(<TextField label="Mot de passe" action={<button type="button">Afficher</button>} />)

    await user.tab()
    expect(screen.getByLabelText('Mot de passe')).toHaveFocus()

    await user.tab()
    expect(screen.getByRole('button', { name: 'Afficher' })).toHaveFocus()
  })

  it('leaves an action out of the field’s accessible description, unlike a suffix', () => {
    render(
      <TextField
        label="Mot de passe"
        help="8 caractères minimum."
        action={<button type="button">Afficher</button>}
      />
    )

    expect(screen.getByLabelText('Mot de passe')).toHaveAccessibleDescription(
      '8 caractères minimum.'
    )
  })
})
