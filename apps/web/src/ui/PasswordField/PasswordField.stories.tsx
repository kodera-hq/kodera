import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { PasswordField } from './PasswordField'

const meta = {
  title: 'Primitives/PasswordField',
  component: PasswordField,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches the field, then the reveal toggle. `Enter` and',
          '`Space` on the toggle switch between hidden and shown without moving',
          "focus off it. The toggle's own accessible name changes between",
          '`showLabel` and `hideLabel`, so what pressing it does next is already in',
          'the name a screen reader announces.',
        ].join('\n'),
      },
    },
  },
  args: {
    label: 'Mot de passe',
    showLabel: 'Afficher le mot de passe',
    hideLabel: 'Masquer le mot de passe',
  },
} satisfies Meta<typeof PasswordField>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithHelp: Story = {
  args: { help: '8 caractères minimum, avec un chiffre.' },
}

export const WithError: Story = {
  args: { defaultValue: 'abc', error: 'Trop court : 8 caractères minimum.' },
}

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'motdepasse' },
}

export const Revealed: Story = {
  parameters: {
    docs: {
      description: {
        story: 'The state after the toggle is pressed: `type="text"`, `aria-pressed="true"`.',
      },
    },
  },
  args: { defaultValue: 'motdepasse' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await userEvent.click(canvas.getByRole('button', { name: 'Afficher le mot de passe' }))

    await expect(canvas.getByLabelText('Mot de passe')).toHaveAttribute('type', 'text')
  },
}

export const FocusVisible: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.tab()

    await expect(within(canvasElement).getByLabelText('Mot de passe')).toHaveFocus()
  },
}
