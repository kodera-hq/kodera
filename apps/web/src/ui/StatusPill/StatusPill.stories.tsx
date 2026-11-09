import type { Meta, StoryObj } from '@storybook/react-vite'
import { StatusPill } from './StatusPill'

const meta = {
  title: 'Primitives/StatusPill',
  component: StatusPill,
  parameters: {
    docs: {
      description: {
        component: [
          'No keyboard map: a status pill is read, not activated.',
          '',
          'Word and colour together, never colour alone (AGENTS.md). Every fill',
          'reads its text at the `-600` step on the `-100` tint; `-500` is the dot',
          'only. `planned` carries neither fill nor dot — a dashed border marks it.',
        ].join('\n'),
      },
    },
  },
} satisfies Meta<typeof StatusPill>

export default meta
type Story = StoryObj<typeof meta>

export const Success: Story = {
  args: { state: 'success', children: 'Active' },
}

export const Info: Story = {
  args: { state: 'info', children: 'Provisionnement' },
}

export const Warning: Story = {
  args: { state: 'warning', children: 'Capacité 92 %' },
}

export const Danger: Story = {
  args: { state: 'danger', children: 'Incident' },
}

export const Neutral: Story = {
  args: { state: 'neutral', children: 'En attente' },
}

export const Planned: Story = {
  args: { state: 'planned', children: 'Prévu · T2 2027' },
}

export const AllStates: Story = {
  name: 'All states',
  args: { state: 'success', children: 'Active' },
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <StatusPill state="success">Active</StatusPill>
      <StatusPill state="info">Provisionnement</StatusPill>
      <StatusPill state="warning">Capacité 92 %</StatusPill>
      <StatusPill state="danger">Incident</StatusPill>
      <StatusPill state="neutral">En attente</StatusPill>
      <StatusPill state="planned">Prévu · T2 2027</StatusPill>
    </div>
  ),
}
