import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { z } from 'zod'
import { Button } from '../Button/Button'
import { Form } from './Form'
import { FormField } from './FormField'

const schema = z.object({
  name: z.string().min(1, 'Le nom est requis.'),
  email: z.string().min(1, 'L’adresse est requise.').email('Cette adresse n’est pas valide.'),
})

function SignupForm() {
  return (
    <Form
      schema={schema}
      defaultValues={{ name: '', email: '' }}
      onSubmit={() => {
        /* the caller's own submit handler goes here — a Core API call, in the console */
      }}
      // `w-[320px]`: a story layout width, arbitrary because no preset step
      // reaches this far — not a colour, so the token guard is unaffected.
      className="flex w-[320px] flex-col gap-4"
    >
      <FormField name="name" label="Nom complet" />
      <FormField name="email" label="Adresse e-mail" />
      <Button type="submit">Créer le compte</Button>
    </Form>
  )
}

const meta = {
  title: 'Primitives/Form',
  component: SignupForm,
  parameters: {
    docs: {
      description: {
        component: [
          '`FormProvider` plus one `zodResolver` wrapper, and `FormField` — a',
          "`TextField` wired to a field's validation state through",
          '`register(name)`.',
          '',
          'Keyboard: `Enter` inside a field submits, same as any HTML form. On an',
          "invalid submit, focus moves to the first invalid field — react-hook-form's",
          'own `shouldFocusError`, not code this unit adds.',
        ].join('\n'),
      },
    },
  },
} satisfies Meta<typeof SignupForm>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const SubmitError: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Submitted empty: both fields invalid, focus lands on the first one — `Nom complet`.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await userEvent.click(canvas.getByRole('button', { name: 'Créer le compte' }))

    await expect(canvas.getByLabelText('Nom complet')).toHaveFocus()
    await expect(canvas.getByText('Le nom est requis.')).toBeVisible()
  },
}

export const FocusVisible: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.tab()

    await expect(within(canvasElement).getByLabelText('Nom complet')).toHaveFocus()
  },
}
