import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from '../Button/Button'
import { EmptyState } from './EmptyState'

const meta = {
  title: 'Primitives/EmptyState',
  component: EmptyState,
  parameters: {
    docs: {
      description: {
        component: [
          'No keyboard map of its own — `Tab` reaches the action button below,',
          'which carries its own.',
          '',
          'One primary action, never a row of choices (COMPONENTS.md).',
        ].join('\n'),
      },
    },
  },
  args: {
    title: 'Aucune personne invitée',
    body: 'Invitez votre équipe pour commencer.',
  },
} satisfies Meta<typeof EmptyState>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const BelowPageHeading: Story = {
  args: { headingLevel: 2 },
}

export const WithIcon: Story = {
  args: {
    icon: (
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor">
        <path d="M12 5v14M5 12h14" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ),
  },
}

export const WithAction: Story = {
  args: {
    icon: (
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor">
        <path d="M12 5v14M5 12h14" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ),
    action: <Button>Inviter des personnes</Button>,
  },
}
