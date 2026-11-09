import type { Meta, StoryObj } from '@storybook/react-vite'
import { Skeleton } from './Skeleton'

const meta = {
  title: 'Primitives/Skeleton',
  component: Skeleton,
  parameters: {
    docs: {
      description: {
        component: [
          'No keyboard map: a skeleton is not interactive.',
          '',
          'Decorative by default — `aria-hidden`. Pass `label` when nothing else on',
          'the screen already announces the wait, and a screen reader needs to hear',
          'it once, from a `role="status"` region wrapping the (still hidden) block.',
        ].join('\n'),
      },
    },
  },
} satisfies Meta<typeof Skeleton>

export default meta
type Story = StoryObj<typeof meta>

// 320 px, Tailwind's own `xs` max-width step converted to a bracket value
// throughout this file so the spacing guard can judge it — a story layout
// width, not a spacing step, standing in for whatever the screen composing
// `Skeleton` actually constrains it to.
export const Block: Story = {
  render: () => (
    <div className="max-w-[320px]">
      <Skeleton />
    </div>
  ),
}

export const Text: Story = {
  render: () => (
    <div className="flex max-w-[320px] flex-col gap-2">
      <Skeleton shape="text" />
      <Skeleton shape="text" className="w-5/6" />
      <Skeleton shape="text" className="w-2/3" />
    </div>
  ),
}

export const Circle: Story = {
  render: () => <Skeleton shape="circle" />,
}

export const Card: Story = {
  name: 'Composed on a card',
  render: () => (
    <div className="flex max-w-[320px] flex-col gap-3 rounded-lg border border-c-border bg-c-surface p-5">
      <div className="flex items-center gap-3">
        <Skeleton shape="circle" />
        <Skeleton shape="text" className="w-1/2" />
      </div>
      <Skeleton />
      <Skeleton className="w-2/3" />
    </div>
  ),
}

export const Labelled: Story = {
  args: { label: 'Chargement des factures…' },
  render: (args) => (
    <div className="max-w-[320px]">
      <Skeleton {...args} />
    </div>
  ),
}

export const Inverse: Story = {
  name: 'On an inverse card',
  render: () => (
    <div className="flex max-w-[320px] flex-col gap-3 rounded-lg bg-c-inverse p-5">
      <Skeleton tone="inverse" />
      <Skeleton tone="inverse" shape="text" className="w-2/3" />
    </div>
  ),
}
