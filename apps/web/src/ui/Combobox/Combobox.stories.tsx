import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, screen, userEvent, within } from 'storybook/test'
import { Combobox } from './Combobox'

const COUNTRY_OPTIONS = [
  { value: 'fr', label: 'France' },
  { value: 'de', label: 'Allemagne' },
  { value: 'be', label: 'Belgique', disabled: true },
]

const meta = {
  title: 'Primitives/Combobox',
  component: Combobox,
  parameters: {
    docs: {
      description: {
        component: [
          'A list filtered by typing, built on `Popover` rather than `Select` — the',
          'ARIA 1.2 combobox pattern, where focus stays on the input the whole time.',
          '',
          'Keyboard: `ArrowDown` opens the list if closed, then moves the highlight',
          'down; `ArrowUp` moves it up; `Home` / `End` jump to the first / last option',
          'the current filter leaves enabled; `Enter` chooses the highlighted option,',
          'fills the field with its label and closes the list; `Escape` closes without',
          'choosing. Typing filters the list and re-opens it.',
        ].join('\n'),
      },
    },
  },
  args: {
    label: 'Pays',
    placeholder: 'Rechercher un pays',
    options: COUNTRY_OPTIONS,
    emptyText: 'Aucun pays ne correspond.',
  },
} satisfies Meta<typeof Combobox>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithHelp: Story = {
  args: { help: 'Utilisé pour la facturation et la TVA.' },
}

export const WithError: Story = {
  args: { error: 'Choisissez un pays dans la liste.' },
}

export const Disabled: Story = {
  args: { disabled: true },
}

export const Open: Story = {
  parameters: {
    docs: {
      description: {
        story: 'The list open on focus, with the disabled option struck through and unreachable.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await userEvent.click(canvas.getByRole('combobox', { name: 'Pays' }))

    // Radix portals the list onto `document.body`, outside `canvasElement`.
    await expect(await screen.findByRole('listbox')).toBeVisible()
  },
}

export const EmptyResult: Story = {
  parameters: {
    docs: {
      description: {
        story: 'What the typed text matches nothing looks like — `emptyText`, never a bare list.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await userEvent.type(canvas.getByRole('combobox', { name: 'Pays' }), 'xyz')

    await expect(await screen.findByText('Aucun pays ne correspond.')).toBeVisible()
  },
}

export const FocusVisible: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.tab()

    await expect(within(canvasElement).getByRole('combobox', { name: 'Pays' })).toHaveFocus()
  },
}
