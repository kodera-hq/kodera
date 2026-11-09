import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'
import { DropdownMenu } from './DropdownMenu'

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
  title: 'Primitives/DropdownMenu',
  component: DropdownMenu,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches the trigger; `Enter`, `Space` or `ArrowDown`',
          'opens it and moves focus to the first item — a plain click opens it',
          'without moving focus, the WAI-ARIA menu button pattern.',
          '`ArrowUp`/`ArrowDown` move between items, skipping separators and',
          'disabled ones; typing a letter jumps to the next item starting with',
          'it. `Enter`/`Space` selects the focused item and closes; `Escape`',
          'closes without selecting and returns focus to the trigger.',
        ].join('\n'),
      },
    },
  },
  // Every story below drives its own `render`, so these never appear on
  // screen — they exist because `trigger`/`label`/`items` are required props.
  args: { trigger: <button type="button" />, label: 'Menu', items: [] },
} satisfies Meta<typeof DropdownMenu>

export default meta
type Story = StoryObj<typeof meta>

export const RowActions: Story = {
  name: 'Table row ··· menu',
  args: {},
  render: () => (
    <InlinePortal>
      {(container) => (
        <DropdownMenu
          container={container}
          label="Actions pour Camille Dubois"
          trigger={
            <button
              type="button"
              aria-label="Actions pour Camille Dubois"
              className="flex h-8 w-8 items-center justify-center rounded-sm text-c-ink-3 hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden"
            >
              ···
            </button>
          }
          items={[
            { label: 'Modifier', onSelect: () => {} },
            { label: 'Renvoyer l’invitation', onSelect: () => {} },
            { type: 'separator' },
            { label: 'Retirer cette personne', onSelect: () => {}, destructive: true },
          ]}
        />
      )}
    </InlinePortal>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Actions pour Camille Dubois' }))

    await expect(canvas.getByRole('menuitem', { name: 'Modifier' })).toBeInTheDocument()
    await expect(
      canvas.getByRole('menuitem', { name: 'Retirer cette personne' })
    ).toBeInTheDocument()
  },
}

export const WithDisabledItem: Story = {
  name: 'With a disabled item',
  args: {},
  render: () => (
    <InlinePortal>
      {(container) => (
        <DropdownMenu
          container={container}
          label="Actions pour un domaine en attente"
          trigger={
            <button
              type="button"
              aria-label="Actions"
              className="flex h-8 w-8 items-center justify-center rounded-sm text-c-ink-3 hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden"
            >
              ···
            </button>
          }
          items={[
            { label: 'Vérifier maintenant', onSelect: () => {}, disabled: true },
            { label: 'Copier les enregistrements DNS', onSelect: () => {} },
            { type: 'separator' },
            { label: 'Retirer ce domaine', onSelect: () => {}, destructive: true },
          ]}
        />
      )}
    </InlinePortal>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Actions' }))

    await expect(canvas.getByRole('menuitem', { name: 'Vérifier maintenant' })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
  },
}
