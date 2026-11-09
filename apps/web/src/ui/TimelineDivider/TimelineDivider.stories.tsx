import type { Meta, StoryObj } from '@storybook/react-vite'
import { TimelineDivider } from './TimelineDivider'

const meta = {
  title: 'Primitives/TimelineDivider',
  component: TimelineDivider,
  parameters: {
    docs: {
      description: {
        component: [
          'No keyboard map: a divider is text in the log, never a control.',
          'A screen reader reads its label in order with the messages around it.',
        ].join('\n'),
      },
    },
  },
  args: { children: 'Aujourd’hui' },
} satisfies Meta<typeof TimelineDivider>

export default meta
type Story = StoryObj<typeof meta>

export const Day: Story = {}

export const NewMessages: Story = {
  args: { tone: 'new', children: 'Nouveaux messages' },
}

export const InAFeed: Story = {
  render: () => (
    <div className="flex w-[480px] flex-col gap-2">
      <TimelineDivider>Hier</TimelineDivider>
      <p className="text-sm text-c-ink">Un message d’hier.</p>
      <TimelineDivider>Aujourd’hui</TimelineDivider>
      <p className="text-sm text-c-ink">Un message lu.</p>
      <TimelineDivider tone="new">Nouveaux messages</TimelineDivider>
      <p className="text-sm text-c-ink">Un message pas encore lu.</p>
    </div>
  ),
}
