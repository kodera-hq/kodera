import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Switch } from './Switch'

const meta = {
  title: 'Primitives/Switch',
  component: Switch,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches it, `Space` toggles it — same as `Checkbox`,',
          '`Enter` does not.',
        ].join('\n'),
      },
    },
  },
  args: {
    label: 'Notifications par e-mail',
  },
} satisfies Meta<typeof Switch>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Checked: Story = {
  args: { defaultChecked: true },
}

export const WithHelp: Story = {
  args: { help: 'Un résumé chaque lundi matin.' },
}

export const WithError: Story = {
  args: { error: 'Impossible d’activer pour le moment.' },
}

export const Disabled: Story = {
  args: { disabled: true },
}

export const DisabledChecked: Story = {
  args: { disabled: true, defaultChecked: true },
}

export const FocusVisible: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.tab()

    await expect(
      within(canvasElement).getByRole('switch', { name: 'Notifications par e-mail' })
    ).toHaveFocus()
  },
}
