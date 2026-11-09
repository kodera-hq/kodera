import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'
import { Button } from '../Button/Button'
import { TextField } from '../TextField/TextField'
import { Popover } from './Popover'

// Same reasoning as `Dialog.stories.tsx`: a `container` prop keeps the
// portalled content inside the story's own render tree so the a11y gate's
// `axe.run(container, …)` actually scans it.
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
  title: 'Primitives/Popover',
  component: Popover,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches the trigger, `Enter`/`Space` opens it and',
          'moves focus into the content. `Escape` closes and returns focus to',
          'the trigger; an outside click closes it too.',
          '',
          'Not modal — the page behind it stays interactive, unlike `Dialog`.',
        ].join('\n'),
      },
    },
  },
  // Every story below drives its own `render`, so these never appear on
  // screen — they exist because `trigger`/`label`/`children` are required
  // props.
  args: { trigger: <button type="button" />, label: 'Popover', children: null },
} satisfies Meta<typeof Popover>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {},
  render: () => (
    <InlinePortal>
      {(container) => (
        <Popover
          container={container}
          label="Filtrer"
          trigger={<Button variant="secondary">Filtrer</Button>}
        >
          <div className="flex flex-col gap-3">
            <TextField label="Nom" placeholder="acme-construction" />
            <Button size="sm">Appliquer</Button>
          </div>
        </Popover>
      )}
    </InlinePortal>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Filtrer' }))

    await expect(canvas.getByLabelText('Nom')).toBeInTheDocument()
  },
}

export const RightAligned: Story = {
  name: 'align="end"',
  args: {},
  render: () => (
    <InlinePortal>
      {(container) => (
        <Popover
          container={container}
          align="end"
          label="Plus d’options"
          trigger={<Button variant="secondary">Plus d’options</Button>}
        >
          <p className="text-sm text-c-ink-3">Contenu du popover.</p>
        </Popover>
      )}
    </InlinePortal>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Plus d’options' }))

    await expect(canvas.getByText('Contenu du popover.')).toBeInTheDocument()
  },
}
