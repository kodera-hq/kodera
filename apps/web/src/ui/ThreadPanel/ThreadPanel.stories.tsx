import type { Meta, StoryObj } from '@storybook/react-vite'
import { TimelineMessage } from '../TimelineMessage/TimelineMessage'
import { ThreadPanel } from './ThreadPanel'

const meta = {
  title: 'Primitives/ThreadPanel',
  component: ThreadPanel,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: [
          'The thread beside a channel: a named `complementary` landmark, `shell-dock-width`',
          'wide and full width on the phone. The shell only; the caller fills the slots.',
          '',
          'Keyboard: `Tab` reaches the close button, then the replies region (it scrolls),',
          'then the composer. `Escape` anywhere inside closes and returns focus.',
        ].join('\n'),
      },
    },
  },
  args: {
    label: 'Fil de discussion',
    title: 'Fil de discussion',
    channel: '# projet-atlas',
    closeLabel: 'Fermer le fil',
    onClose: () => {},
    repliesLabel: 'Réponses',
    parent: (
      <TimelineMessage
        author="Claire Dubois"
        dateTime="2026-10-22T09:31:00+02:00"
        timeLabel="09:31"
      >
        <p>Proposition de mise en ligne : jeudi à 7 h.</p>
      </TimelineMessage>
    ),
    children: (
      <>
        <TimelineMessage
          author="Paul Ferrand"
          dateTime="2026-10-22T09:33:00+02:00"
          timeLabel="09:33"
        >
          <p>Jeudi 7 h me va. Je gèle les déploiements mercredi à 18 h.</p>
        </TimelineMessage>
        <TimelineMessage
          author="Nadia Chevalier"
          dateTime="2026-10-22T09:35:00+02:00"
          timeLabel="09:35"
        >
          <p>D’accord, à condition que la remarque sécurité soit corrigée mardi.</p>
        </TimelineMessage>
      </>
    ),
  },
  decorators: [
    (Story) => (
      // A story's demo container, not a design step (src/ui/README.md).
      <div className="flex h-[560px] justify-end bg-c-page">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ThreadPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithComposer: Story = {
  args: {
    composer: (
      <label className="flex flex-col gap-1 text-xs text-c-ink-2">
        Répondre dans le fil
        <textarea
          rows={2}
          className="w-full resize-none rounded-md border border-c-border-input bg-c-surface px-3 py-2 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
        />
      </label>
    ),
  },
}
