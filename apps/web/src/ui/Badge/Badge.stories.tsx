import type { Meta, StoryObj } from '@storybook/react-vite'
import { Badge } from './Badge'

const meta = {
  title: 'Primitives/Badge',
  component: Badge,
  parameters: {
    docs: {
      description: {
        component: [
          'No keyboard map: a badge is presentational content, never a control',
          'on its own. Placed inside a tab or a nav item, that control carries the',
          'accessible name and the badge rides along as part of it.',
        ].join('\n'),
      },
    },
  },
  args: { children: '3' },
} satisfies Meta<typeof Badge>

export default meta
type Story = StoryObj<typeof meta>

export const Neutral: Story = {}

export const Accent: Story = {
  args: { variant: 'accent', children: 'Nouveau' },
}

export const Count: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Badge>1</Badge>
      <Badge>12</Badge>
      <Badge>99+</Badge>
    </div>
  ),
}

export const OnANavItem: Story = {
  name: 'Composed on a nav item',
  render: () => (
    <span className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-md text-c-ink">
      Support
      <Badge variant="accent">2</Badge>
    </span>
  ),
}
