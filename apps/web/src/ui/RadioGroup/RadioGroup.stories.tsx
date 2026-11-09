import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { RadioGroup } from './RadioGroup'

const BILLING_OPTIONS = [
  { value: 'monthly', label: 'Mensuel' },
  { value: 'annual', label: 'Annuel — 2 mois offerts' },
  { value: 'lifetime', label: 'À vie', disabled: true },
]

const meta = {
  title: 'Primitives/RadioGroup',
  component: RadioGroup,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches the group once — a roving tabindex, the same',
          'shape as native radios. `ArrowDown` / `ArrowRight` move to and choose the',
          'next option, `ArrowUp` / `ArrowLeft` the previous one. There is no',
          'separate "select" key: moving the roving focus is choosing.',
        ].join('\n'),
      },
    },
  },
  args: {
    label: 'Formule de facturation',
    options: BILLING_OPTIONS,
  },
} satisfies Meta<typeof RadioGroup>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: { defaultValue: 'monthly' },
}

export const Horizontal: Story = {
  args: { defaultValue: 'monthly', orientation: 'horizontal' },
}

export const WithHelp: Story = {
  args: { defaultValue: 'monthly', help: 'Résiliable à tout moment.' },
}

export const WithError: Story = {
  args: { error: 'Choisissez une formule.' },
}

export const Disabled: Story = {
  args: { defaultValue: 'monthly', disabled: true },
}

export const FocusVisible: Story = {
  args: { defaultValue: 'monthly' },
  play: async ({ canvasElement }) => {
    await userEvent.tab()

    await expect(within(canvasElement).getByRole('radio', { name: 'Mensuel' })).toHaveFocus()
  },
}
