import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from '../Button/Button'
import { DropdownMenu } from '../DropdownMenu/DropdownMenu'
import { TimelineMessage } from './TimelineMessage'

const meta = {
  title: 'Primitives/TimelineMessage',
  component: TimelineMessage,
  parameters: {
    docs: {
      description: {
        component: [
          'One message in a channel’s timeline: an `article` named by its author and time.',
          '',
          'Keyboard: `Tab` reaches each reaction (`Enter`/`Space` toggles it), then the',
          'thread button, then the action disclosure beside the body. It shows on hover, on',
          'focus within the message and while one of its menus is open, and always on a',
          'screen with no hover or in forced colours; faded, it keeps its space and its tab stop.',
        ].join('\n'),
      },
    },
  },
  args: {
    author: 'Claire Dubois',
    dateTime: '2026-10-22T09:31:00+02:00',
    timeLabel: '09:31',
    children: (
      <p>Proposition de mise en ligne : jeudi à 7 h, avant l’ouverture du service client.</p>
    ),
  },
  decorators: [
    (Story) => (
      // A story's demo container, not a design step (src/ui/README.md).
      <div role="log" aria-label="Messages de #projet-atlas" className="w-[640px] bg-c-surface p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TimelineMessage>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Edited: Story = { args: { edited: '(modifié)' } }

export const Reply: Story = {
  args: {
    reply: { label: 'En réponse à', author: 'Paul Ferrand', excerpt: 'Jeudi 7 h me va.' },
  },
}

export const Reactions: Story = {
  args: {
    reactions: [
      {
        key: '👍',
        emoji: '👍',
        count: 3,
        mine: true,
        label: '👍 3, vous avez réagi',
        onToggle: () => {},
      },
      { key: '🙏', emoji: '🙏', count: 1, mine: false, label: '🙏 1', onToggle: () => {} },
    ],
  },
}

export const Thread: Story = {
  args: {
    thread: {
      label: '6 réponses',
      onOpen: () => {},
      expanded: false,
      lastReply: 'dernière il y a 4 min',
      participants: [
        { id: '@paul', name: 'Paul Ferrand' },
        { id: '@nadia', name: 'Nadia Chevalier' },
        { id: '@ines', name: 'Inès Kaci' },
      ],
    },
  },
}

export const Deleted: Story = { args: { deleted: 'Message supprimé' } }

export const Sending: Story = { args: { delivery: { state: 'sending', label: 'Envoi en cours' } } }

export const Failed: Story = {
  args: {
    delivery: {
      state: 'failed',
      label: 'Échec de l’envoi',
      retryLabel: 'Réessayer',
      onRetry: () => {},
    },
  },
}

export const AddReaction: Story = {
  args: {
    reactions: [
      {
        key: '👍',
        emoji: '👍',
        count: 3,
        mine: false,
        label: '👍 3',
        onToggle: () => {},
      },
    ],
    addReaction: (
      <button
        type="button"
        aria-label="Ajouter une réaction"
        className="inline-flex h-6 items-center rounded-full border border-c-border bg-c-surface px-2 text-xs text-c-ink-3 hover:text-c-ink focus-visible:ring focus-visible:outline-hidden"
      >
        +
      </button>
    ),
  },
}

export const Focused: Story = {
  args: { focused: true, thread: { label: '6 réponses', onOpen: () => {}, expanded: true } },
}

export const Mention: Story = {
  args: {
    mention: 'vous mentionne',
    children: <p>@Inès Kaci pouvez-vous confirmer l’accès du support dès mercredi soir ?</p>,
  },
}

export const Grouped: Story = {
  render: (args) => (
    <>
      <TimelineMessage {...args} />
      <TimelineMessage {...args} compact dateTime="2026-10-22T09:32:00+02:00" timeLabel="09:32">
        <p>Le message aux clients part la veille à 17 h.</p>
      </TimelineMessage>
    </>
  ),
}

export const WithActions: Story = {
  args: {
    actions: (
      <DropdownMenu
        label="Actions sur le message"
        trigger={
          <Button variant="tertiary" size="sm" aria-label="Actions sur le message">
            ···
          </Button>
        }
        items={[{ label: 'Répondre', onSelect: () => {} }]}
      />
    ),
  },
}
