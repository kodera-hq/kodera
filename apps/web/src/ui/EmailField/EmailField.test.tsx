import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { EmailField } from './EmailField'

describe('EmailField', () => {
  it('is a TextField typed and completed for an email address', () => {
    render(<EmailField label="Adresse e-mail" />)

    const input = screen.getByLabelText('Adresse e-mail')
    expect(input).toHaveAttribute('type', 'email')
    expect(input).toHaveAttribute('autocomplete', 'email')
  })

  it('lets the caller override autocomplete, for a login form asking for a username', () => {
    render(<EmailField label="Identifiant" autoComplete="username" />)

    expect(screen.getByLabelText('Identifiant')).toHaveAttribute('autocomplete', 'username')
  })

  it('carries TextField error and help through unchanged', () => {
    render(
      <EmailField
        label="Adresse e-mail"
        help="Utilisée pour la facturation."
        error="Adresse invalide."
      />
    )

    const input = screen.getByLabelText('Adresse e-mail')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('Utilisée pour la facturation. Adresse invalide.')
  })

  it('forwards its ref, so a form can move focus to it', () => {
    const ref = createRef<HTMLInputElement>()
    render(<EmailField label="Adresse e-mail" ref={ref} />)

    ref.current?.focus()

    expect(screen.getByLabelText('Adresse e-mail')).toHaveFocus()
  })

  it('keeps type="email" even if a stray prop bag tries to override it', () => {
    // `type` is omitted from `EmailFieldProps`, so this is not reachable
    // through the public type — the guarantee this test protects is the
    // runtime one, for a caller that spreads an untyped prop bag in.
    const StrayProps = { type: 'text' } as Record<string, unknown>
    render(<EmailField label="Adresse e-mail" {...StrayProps} />)

    expect(screen.getByLabelText('Adresse e-mail')).toHaveAttribute('type', 'email')
  })
})
