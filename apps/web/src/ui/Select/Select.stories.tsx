import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, screen, userEvent, within } from 'storybook/test'
import { Select } from './Select'

const ROLE_OPTIONS = [
  { value: 'admin', label: 'Administrateur' },
  { value: 'member', label: 'Membre' },
  { value: 'billing', label: 'Facturation', disabled: true },
]

const meta = {
  title: 'Primitives/Select',
  component: Select,
  parameters: {
    docs: {
      description: {
        component: [
          'A closed list, chosen from — Radix keyboard behaviour, unmodified:',
          '`Space`, `Enter` or `ArrowDown` open it; typing a letter jumps to the next',
          'option starting with it; `ArrowUp` / `ArrowDown` move the highlighted',
          'option; `Enter` chooses it; `Escape` closes without choosing.',
          '',
          '`Combobox` is the sibling primitive for a list filtered by typing.',
        ].join('\n'),
      },
    },
  },
  args: {
    label: 'Rôle',
    placeholder: 'Choisir un rôle',
    options: ROLE_OPTIONS,
  },
} satisfies Meta<typeof Select>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithHelp: Story = {
  args: { help: 'Détermine les permissions de la personne.' },
}

export const WithError: Story = {
  args: { error: 'Choisissez un rôle.' },
}

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'member' },
}

export const Sizes: Story = {
  render: (args) => (
    // `w-[256px]`: a story layout width, arbitrary because no preset step
    // reaches this far — not a colour, so the token guard is unaffected.
    <div className="flex w-[256px] flex-col gap-4">
      <Select {...args} size="md" label="Standard" />
      <Select {...args} size="lg" label="Grand" />
    </div>
  ),
}

export const Open: Story = {
  parameters: {
    docs: {
      description: {
        story: 'The listbox open, with the disabled option unreachable by keyboard or pointer.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await userEvent.click(canvas.getByRole('combobox', { name: 'Rôle' }))

    // Radix portals the listbox onto `document.body`, outside `canvasElement`.
    await expect(await screen.findByRole('listbox')).toBeVisible()
  },
}

export const FocusVisible: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.tab()

    await expect(within(canvasElement).getByRole('combobox', { name: 'Rôle' })).toHaveFocus()
  },
}
