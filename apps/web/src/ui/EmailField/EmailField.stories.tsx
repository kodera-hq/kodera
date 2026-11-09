import type { Meta, StoryObj } from '@storybook/react-vite'
import { EmailField } from './EmailField'

const meta = {
  title: 'Primitives/EmailField',
  component: EmailField,
  parameters: {
    docs: {
      description: {
        component: [
          '`TextField` typed and completed for an email address. Keyboard and',
          "error behaviour are `TextField`'s — see that primitive's story.",
          '`autoComplete` defaults to `email`; a login form asking for the address',
          'as the sign-in identifier overrides it with `username`.',
        ].join('\n'),
      },
    },
  },
  args: {
    label: 'Adresse e-mail',
  },
} satisfies Meta<typeof EmailField>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const AsUsername: Story = {
  args: { label: 'Identifiant', autoComplete: 'username' },
}

export const WithError: Story = {
  args: {
    defaultValue: 'acme construction',
    error: 'Cette adresse n’est pas valide.',
  },
}

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'contact@acme-construction.fr' },
}
