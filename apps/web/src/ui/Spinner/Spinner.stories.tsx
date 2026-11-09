import type { Meta, StoryObj } from '@storybook/react-vite'
import { Spinner } from './Spinner'

const meta = {
  title: 'Primitives/Spinner',
  component: Spinner,
  parameters: {
    docs: {
      description: {
        component: [
          'Not keyboard reachable: a spinner is a report, not a control.',
          '',
          'With a `label` it is a live `status` and a screen reader reads that text.',
          'Without one it is decorative and hidden — which is what `Button` uses, since',
          'the button already keeps its own name and sets `aria-busy`.',
          '',
          'A loading CARD shows skeleton blocks instead (COMPONENTS.md); this is only',
          'for a wait that lives inside a control.',
        ].join('\n'),
      },
    },
  },
} satisfies Meta<typeof Spinner>

export default meta
type Story = StoryObj<typeof meta>

export const Announced: Story = {
  args: { label: 'Chargement des organisations' },
}

export const Decorative: Story = {}

export const Sizes: Story = {
  render: (args) => (
    <div className="flex items-center gap-4 text-c-action">
      <Spinner {...args} size="sm" />
      <Spinner {...args} size="md" />
      <Spinner {...args} size="lg" />
    </div>
  ),
}
