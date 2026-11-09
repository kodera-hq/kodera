import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Button } from '../Button/Button'
import { Form } from './Form'
import { FormField } from './FormField'

const schema = z.object({
  email: z.string().min(1, 'L’adresse est requise.').email('Adresse invalide.'),
  name: z.string().min(1, 'Le nom est requis.'),
})

function SignupForm({
  onSubmit,
  mode,
}: {
  onSubmit: (data: unknown) => void
  mode?: 'onSubmit' | 'onChange'
}) {
  return (
    <Form schema={schema} defaultValues={{ email: '', name: '' }} onSubmit={onSubmit} mode={mode}>
      <FormField name="name" label="Nom" />
      <FormField name="email" label="Adresse e-mail" />
      <Button type="submit">Créer le compte</Button>
    </Form>
  )
}

describe('Form', () => {
  it('submits the validated data on a valid form', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<SignupForm onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('Nom'), 'Ada Lovelace')
    await user.type(screen.getByLabelText('Adresse e-mail'), 'ada@acme-construction.fr')
    await user.click(screen.getByRole('button', { name: 'Créer le compte' }))

    expect(onSubmit).toHaveBeenCalledWith(
      { name: 'Ada Lovelace', email: 'ada@acme-construction.fr' },
      expect.anything()
    )
  })

  it('does not submit an invalid form, and shows the error on the field', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<SignupForm onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('Nom'), 'Ada Lovelace')
    await user.type(screen.getByLabelText('Adresse e-mail'), 'pas-une-adresse')
    await user.click(screen.getByRole('button', { name: 'Créer le compte' }))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Adresse e-mail')).toHaveAccessibleDescription('Adresse invalide.')
  })

  it('focuses the first invalid field on a failed submit', async () => {
    const user = userEvent.setup()
    render(<SignupForm onSubmit={vi.fn()} />)

    // Both fields empty: `name` is registered first, so it is the first
    // invalid field and the one focus lands on — not the submit button, which
    // is where a person would otherwise be stranded after pressing it.
    await user.click(screen.getByRole('button', { name: 'Créer le compte' }))

    expect(await screen.findByLabelText('Nom')).toHaveFocus()
  })

  it('submits on Enter inside a field, without a mouse ever touching the button', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<SignupForm onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('Nom'), 'Ada Lovelace')
    await user.type(screen.getByLabelText('Adresse e-mail'), 'ada@acme-construction.fr{Enter}')

    expect(onSubmit).toHaveBeenCalled()
  })

  it('validates on change when mode is onChange, before any submit', async () => {
    const user = userEvent.setup()
    render(<SignupForm onSubmit={vi.fn()} mode="onChange" />)

    await user.type(screen.getByLabelText('Adresse e-mail'), 'pas-une-adresse')
    await user.tab()

    expect(await screen.findByText('Adresse invalide.')).toBeVisible()
  })

  it('reads a nested field’s error at its own dot path, not an ancestor’s', async () => {
    // `formState.errors` mirrors the schema's own shape: a message set on
    // `billing.address.city` lives at `errors.billing.address.city`, not on
    // `errors.billing` or `errors.billing.address` — `FormField`'s lookup has
    // to walk the full path rather than stop at the first object it finds.
    const nestedSchema = z.object({
      billing: z.object({
        address: z.object({
          city: z.string().min(1, 'La ville est requise.'),
        }),
      }),
    })
    const user = userEvent.setup()
    render(
      <Form
        schema={nestedSchema}
        defaultValues={{ billing: { address: { city: '' } } }}
        onSubmit={vi.fn()}
      >
        <FormField name="billing.address.city" label="Ville" />
        <Button type="submit">Envoyer</Button>
      </Form>
    )

    await user.click(screen.getByRole('button', { name: 'Envoyer' }))

    expect(await screen.findByLabelText('Ville')).toHaveAccessibleDescription(
      'La ville est requise.'
    )
  })
})
