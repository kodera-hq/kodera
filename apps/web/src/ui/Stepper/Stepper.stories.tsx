import type { Meta, StoryObj } from '@storybook/react-vite'
import { Stepper } from './Stepper'

const steps = [
  { label: 'Organisation créée', status: 'done' as const },
  { label: 'Domaine vérifié', status: 'current' as const },
  { label: 'Personnes invitées', status: 'upcoming' as const },
  { label: 'Facturation configurée', status: 'upcoming' as const },
]

const meta = {
  title: 'Primitives/Stepper',
  component: Stepper,
  parameters: {
    docs: {
      description: {
        component: [
          'A status display, not a control: no keyboard behaviour of its',
          'own. The current step carries `aria-current="step"`.',
        ].join('\n'),
      },
    },
  },
  args: { steps },
} satisfies Meta<typeof Stepper>

export default meta
type Story = StoryObj<typeof meta>

export const Horizontal: Story = {}

export const Vertical: Story = {
  args: { orientation: 'vertical' },
  decorators: [
    (Story) => (
      // Demo container width only, no token for 224px.
      <div className="w-[224px]">
        <Story />
      </div>
    ),
  ],
}

export const AllDone: Story = {
  args: {
    steps: steps.map((step) => ({ ...step, status: 'done' as const })),
  },
}
