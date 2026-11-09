import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'
import { Tooltip } from './Tooltip'

// Same reasoning as `Dialog.stories.tsx`: Radix portals the tooltip content
// to `document.body` by default. `container` keeps it inside the story's own
// render tree so the a11y gate's `axe.run(container, …)` scans it too.
function InlinePortal({
  children,
}: {
  children: (container: HTMLDivElement | null) => React.ReactNode
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  return (
    <div>
      <div ref={setNode} />
      {children(node)}
    </div>
  )
}

const meta = {
  title: 'Primitives/Tooltip',
  component: Tooltip,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: shown on focus exactly as on hover — `Tab` reaches the',
          'trigger and the tooltip appears; moving focus away hides it. No',
          'separate keyboard path is needed.',
          '',
          'Never the only carrier of an instruction — the trigger keeps its own',
          'accessible name; this adds detail.',
        ].join('\n'),
      },
    },
  },
  // `render` supplies the real trigger element in every story below; this
  // exists only because `children` is a required prop and `Meta` needs `args`
  // that satisfy it.
  args: { children: <button type="button" /> },
} satisfies Meta<typeof Tooltip>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: { content: 'Copié dans le presse-papiers' },
  render: (args) => (
    <InlinePortal>
      {(container) => (
        <Tooltip {...args} container={container}>
          <button
            type="button"
            aria-label="Copier"
            className="flex h-10 w-10 items-center justify-center rounded-sm border border-c-ink-4"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor">
              <rect x="5" y="5" width="8" height="8" rx="1" strokeWidth="1.4" />
              <path d="M3 11V4a1 1 0 0 1 1-1h7" strokeWidth="1.4" />
            </svg>
          </button>
        </Tooltip>
      )}
    </InlinePortal>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.tab()

    await expect(canvas.getByRole('button', { name: 'Copier' })).toHaveFocus()
    await expect(canvas.getByRole('tooltip')).toHaveTextContent('Copié dans le presse-papiers')
  },
}

export const Bottom: Story = {
  args: { content: 'Aujourd’hui, 14:32', side: 'bottom' },
  render: (args) => (
    <InlinePortal>
      {(container) => (
        <Tooltip {...args} container={container}>
          <button
            type="button"
            className="font-mono text-sm text-c-ink underline decoration-dotted"
          >
            il y a 2 minutes
          </button>
        </Tooltip>
      )}
    </InlinePortal>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.tab()

    await expect(canvas.getByRole('tooltip')).toHaveTextContent('Aujourd’hui, 14:32')
  },
}
