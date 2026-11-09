import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Checkbox } from './Checkbox'

const meta = {
  title: 'Primitives/Checkbox',
  component: Checkbox,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches it, `Space` toggles it. `Enter` does not — the',
          'native checkbox behaviour, so it never doubles as a form submit.',
        ].join('\n'),
      },
    },
  },
  args: {
    label: 'Recevoir la newsletter mensuelle',
  },
} satisfies Meta<typeof Checkbox>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Checked: Story = {
  args: { defaultChecked: true },
}

export const Indeterminate: Story = {
  args: { label: 'Tout sélectionner', checked: 'indeterminate' },
  parameters: {
    docs: {
      description: {
        story: 'Neither checked nor unchecked — some, not all, of a set is selected.',
      },
    },
  },
}

export const WithHelp: Story = {
  args: { help: 'Un e-mail par mois, résiliable à tout moment.' },
}

export const WithError: Story = {
  args: {
    label: 'J’accepte les conditions générales',
    error: 'Vous devez accepter pour continuer.',
  },
}

export const Disabled: Story = {
  args: { disabled: true },
}

export const FocusVisible: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.tab()

    await expect(
      within(canvasElement).getByRole('checkbox', { name: 'Recevoir la newsletter mensuelle' })
    ).toHaveFocus()
  },
}
