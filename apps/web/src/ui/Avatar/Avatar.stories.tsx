import type { Meta, StoryObj } from '@storybook/react-vite'
import { Avatar } from './Avatar'

const meta = {
  title: 'Primitives/Avatar',
  component: Avatar,
  args: {
    name: 'Henri Duflot',
  },
} satisfies Meta<typeof Avatar>

export default meta
type Story = StoryObj<typeof meta>

export const Admin: Story = {
  args: { variant: 'admin' },
}

export const Member: Story = {
  args: { variant: 'member', name: 'Bruno Petit' },
}

export const Pending: Story = {
  args: { variant: 'pending', name: 'Carla Dupuis' },
}

export const WithImage: Story = {
  args: {
    // Reachable without a network request the console is not allowed to
    // make (ADR-0003): a 1×1 transparent PNG, inline.
    src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  },
}

export const ExtraSmall: Story = {
  args: { size: 'xs', name: 'Paul Ferrand' },
}

export const SingleWordName: Story = {
  args: { name: 'Prestataire' },
}
