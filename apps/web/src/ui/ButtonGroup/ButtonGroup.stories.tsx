import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Button } from '../Button/Button'
import { ButtonGroup } from './ButtonGroup'

const meta = {
  title: 'Primitives/ButtonGroup',
  component: ButtonGroup,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: no roving tabindex. `Tab` visits every button in the group in',
          'order, exactly as if there were no wrapper — this is a set of independent',
          'actions, not one composite widget. `RadioGroup` is the primitive for',
          '"one of these"; this one is "any of these, on their own".',
        ].join('\n'),
      },
    },
  },
  args: {
    'aria-label': 'Actions',
  },
} satisfies Meta<typeof ButtonGroup>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: (args) => (
    <ButtonGroup {...args}>
      <Button variant="secondary">Modifier</Button>
      <Button variant="secondary">Dupliquer</Button>
      <Button variant="destructive">Supprimer</Button>
    </ButtonGroup>
  ),
}

export const Attached: Story = {
  args: { attached: true, 'aria-label': 'Vue' },
  render: (args) => (
    <ButtonGroup {...args}>
      <Button variant="secondary">Jour</Button>
      <Button variant="secondary">Semaine</Button>
      <Button variant="secondary">Mois</Button>
    </ButtonGroup>
  ),
}

export const Vertical: Story = {
  args: { orientation: 'vertical', 'aria-label': 'Actions' },
  render: (args) => (
    <ButtonGroup {...args}>
      <Button variant="secondary">Modifier</Button>
      <Button variant="secondary">Archiver</Button>
      <Button variant="destructive">Supprimer</Button>
    </ButtonGroup>
  ),
}

export const FocusVisible: Story = {
  render: (args) => (
    <ButtonGroup {...args}>
      <Button variant="secondary">Modifier</Button>
      <Button variant="secondary">Dupliquer</Button>
    </ButtonGroup>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.tab()

    await expect(within(canvasElement).getByRole('button', { name: 'Modifier' })).toHaveFocus()
  },
}
