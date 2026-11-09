import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'
import { Tabs } from './Tabs'
import type { TabItem } from './Tabs'

const items: TabItem[] = [
  {
    value: 'people',
    label: 'Personnes',
    content: <p className="text-sm text-c-ink">Liste des personnes de l'organisation.</p>,
  },
  {
    value: 'domains',
    label: 'Domaines',
    content: <p className="text-sm text-c-ink">Liste des domaines vérifiés.</p>,
  },
  {
    value: 'invoices',
    label: 'Factures',
    content: <p className="text-sm text-c-ink">Historique des factures.</p>,
    disabled: true,
  },
]

function ControlledTabs({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial)
  return (
    <Tabs ariaLabel="Sections du compte" items={items} value={value} onValueChange={setValue} />
  )
}

const meta = {
  title: 'Primitives/Tabs',
  component: Tabs,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches the list once, landing on the active tab.',
          '`ArrowLeft`/`ArrowRight` move focus and activate the tab under it —',
          'this is a set of views, so changing focus is the action. `Home` and',
          '`End` jump to the first and last enabled tab. A `disabled` tab is',
          'skipped by the arrow keys entirely.',
          '',
          'Controlled by `value`/`onValueChange`: a screen keeps `?tab=` in the',
          'URL and passes it straight through, so the back button and the',
          'panel never disagree.',
        ].join('\n'),
      },
    },
  },
  // Every story below replaces the render entirely with a controlled
  // wrapper; this only satisfies the props `Tabs` requires.
  args: {
    items,
    value: 'people',
    onValueChange: () => {},
    ariaLabel: 'Sections du compte',
  },
} satisfies Meta<typeof Tabs>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => <ControlledTabs initial="people" />,
}

export const SecondTabActive: Story = {
  render: () => <ControlledTabs initial="domains" />,
}

export const KeyboardArrowNavigation: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'The same `play` the headless accessibility gate replays: `Tab` to the list, then `ArrowRight` to the next tab.',
      },
    },
  },
  render: () => <ControlledTabs initial="people" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.tab()
    await userEvent.keyboard('{ArrowRight}')

    await expect(canvas.getByRole('tab', { name: 'Domaines' })).toHaveFocus()
    await expect(canvas.getByRole('tab', { name: 'Domaines' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  },
}
