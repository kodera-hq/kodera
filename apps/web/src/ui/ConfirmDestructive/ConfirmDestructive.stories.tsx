import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'
import { Button } from '../Button/Button'
import { ConfirmDestructive } from './ConfirmDestructive'

// Same reasoning as `Dialog.stories.tsx`: Radix portals this content to
// `document.body` by default, outside the story's own render container that
// `src/ui/stories-a11y.test.tsx` scans. `ConfirmDestructive` forwards no
// `container` prop of its own — it always renders `Dialog`, which does — so
// these stories reach through it the same way `Dialog`'s do.
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
  title: 'Primitives/ConfirmDestructive',
  component: ConfirmDestructive,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: identical to `Dialog` — `Escape` and the close control',
          'cancel without confirming, same as the Cancel button, and focus returns',
          'to the trigger (`returnFocusTo` is forwarded for the `defaultOpen` case).',
          '',
          '`requireTypedConfirmation` disables the destructive action until the',
          'typed value matches exactly — for actions a Cancel/Confirm pair is not',
          'enough for, like deleting the organisation itself.',
        ].join('\n'),
      },
    },
  },
} satisfies Meta<typeof ConfirmDestructive>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    title: 'Retirer Camille Dubois ?',
    consequence: 'Cette personne perd immédiatement l’accès à l’espace.',
    cancelLabel: 'Annuler',
    confirmLabel: 'Retirer',
    closeLabel: 'Fermer',
    onConfirm: () => {},
  },
  render: (args) => (
    <InlinePortal>
      {(container) => (
        <ConfirmDestructive
          {...args}
          container={container}
          trigger={<Button variant="destructive">Retirer</Button>}
        />
      )}
    </InlinePortal>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Retirer' }))

    await expect(
      canvas.getByRole('dialog', { name: 'Retirer Camille Dubois ?' })
    ).toBeInTheDocument()
  },
}

export const TypedConfirmation: Story = {
  name: 'Requires typing to confirm',
  args: {
    title: 'Supprimer acme-construction ?',
    consequence: 'Cette action supprime définitivement l’organisation et tout son contenu.',
    cancelLabel: 'Annuler',
    confirmLabel: 'Supprimer définitivement',
    closeLabel: 'Fermer',
    onConfirm: () => {},
    requireTypedConfirmation: true,
    confirmationValue: 'acme-construction',
    confirmationLabel: 'Tapez « acme-construction » pour confirmer',
  },
  render: (args) => (
    <InlinePortal>
      {(container) => (
        <ConfirmDestructive
          {...args}
          container={container}
          trigger={<Button variant="destructive">Supprimer l’organisation</Button>}
        />
      )}
    </InlinePortal>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Supprimer l’organisation' }))

    const dialog = within(canvas.getByRole('dialog'))
    await expect(dialog.getByRole('button', { name: 'Supprimer définitivement' })).toBeDisabled()
  },
}
