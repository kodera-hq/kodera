import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from '../Button/Button'
import { Gauge } from './Gauge'

const meta = {
  title: 'Primitives/Gauge',
  component: Gauge,
  parameters: {
    docs: {
      description: {
        component: [
          'Not interactive — a meter is read, not operated, so there is no',
          'keyboard map beyond whatever `action` slot a caller adds next to',
          'it.',
          '',
          'The value is always paired with `valueText` and, from 90%, a',
          '`statusLabel`: colour never carries the state on its own',
          '(DESIGN_SYSTEM.md §2).',
        ].join('\n'),
      },
    },
  },
  decorators: [
    (Story) => (
      // Demo container width only, no token for 320px.
      <div className="w-[320px]">
        <Story />
      </div>
    ),
  ],
  args: {
    label: 'Capacité de stockage',
  },
} satisfies Meta<typeof Gauge>

export default meta
type Story = StoryObj<typeof meta>

export const Normal: Story = {
  args: { value: 62, valueText: '62 / 100' },
}

export const NearLimit: Story = {
  args: { value: 92, valueText: '92 / 100', statusLabel: 'Proche de la limite' },
}

export const NearLimitWithAction: Story = {
  args: {
    value: 92,
    valueText: '92 / 100',
    statusLabel: 'Proche de la limite',
    action: <Button size="sm">Augmenter la capacité</Button>,
  },
}

export const AtLimit: Story = {
  args: {
    value: 100,
    valueText: '100 / 100',
    statusLabel: 'Limite atteinte',
    timestamp: 'Dernier refus à 14:32',
    action: <Button size="sm">Augmenter la capacité</Button>,
  },
}
