import type { Meta, StoryObj } from '@storybook/react-vite'
import { Avatar } from '../Avatar/Avatar'
import { ChannelRow } from './ChannelRow'

const meta = {
  title: 'Primitives/ChannelRow',
  component: ChannelRow,
  parameters: {
    docs: {
      description: {
        component: [
          'A text channel in Espace’s sidebar: 32 px, 44 px on the phone. A link; `asChild`',
          'wraps the router’s `Link`. Every state is read in the name, in the caller’s words.',
          '',
          'Keyboard: `Tab` reaches the row, `Enter` follows it.',
        ].join('\n'),
      },
    },
  },
  args: { name: 'général', href: '#general' },
  decorators: [
    (Story) => (
      // A story's demo container, not a design step (src/ui/README.md).
      <ul className="w-[264px] bg-c-sunken p-2">
        <Story />
      </ul>
    ),
  ],
} satisfies Meta<typeof ChannelRow>

export default meta
type Story = StoryObj<typeof meta>

export const Idle: Story = {}

export const Selected: Story = { args: { name: 'projet-atlas', selected: true } }

export const Unread: Story = { args: { name: 'support-clients', unread: 'non lu' } }

export const Mentions: Story = {
  args: { name: 'support-clients', unread: 'non lu', mentions: { count: 3, label: '3 mentions' } },
}

export const ReadOnly: Story = { args: { name: 'annonces', readOnly: 'lecture seule' } }

export const SelectedWithEveryState: Story = {
  args: {
    name: 'un-canal-au-nom-très-long-qui-déborde',
    selected: true,
    readOnly: 'lecture seule',
    mentions: { count: 12, label: '12 mentions' },
  },
}

export const DirectMessage: Story = {
  args: {
    name: 'Nadia Chevalier',
    href: '#dm-nadia',
    unread: 'non lu',
    mentions: { count: 1, label: '1 message' },
    leading: <Avatar name="Nadia Chevalier" size="xs" aria-hidden="true" />,
  },
}
