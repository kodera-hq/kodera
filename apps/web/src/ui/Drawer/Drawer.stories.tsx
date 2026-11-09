import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'
import { Button } from '../Button/Button'
import { Drawer } from './Drawer'

// Same reasoning as `Dialog.stories.tsx`: a `container` prop keeps the
// portalled panel inside the story's own render tree so the a11y gate's
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
  title: 'Primitives/Drawer',
  component: Drawer,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: identical to `Dialog` — opening moves focus to the close',
          'control, `Tab`/`Shift+Tab` stay inside the panel, `Escape` closes and',
          'returns focus to the trigger, or to `returnFocusTo` for a panel opened',
          'without one.',
          '',
          'For a task too long for a centred dialog, with the page behind it',
          'still visible as context.',
        ].join('\n'),
      },
    },
  },
  args: { title: 'Titre', closeLabel: 'Fermer', children: null },
} satisfies Meta<typeof Drawer>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {},
  render: () => (
    <InlinePortal>
      {(container) => (
        <Drawer
          container={container}
          trigger={<Button>Voir les détails</Button>}
          title="Détails du domaine"
          description="visio.acme-construction.kodera.io"
          closeLabel="Fermer"
          footer={
            <>
              <Button variant="secondary">Fermer</Button>
              <Button>Enregistrer</Button>
            </>
          }
        >
          <p className="text-sm text-c-ink-3">Contenu du panneau.</p>
        </Drawer>
      )}
    </InlinePortal>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Voir les détails' }))

    await expect(canvas.getByRole('dialog', { name: 'Détails du domaine' })).toBeInTheDocument()
  },
}

export const Small: Story = {
  name: 'sm (360 px)',
  args: {},
  render: () => (
    <InlinePortal>
      {(container) => (
        <Drawer
          container={container}
          size="sm"
          trigger={<Button variant="secondary">Filtrer</Button>}
          title="Filtres"
          closeLabel="Fermer"
        >
          <p className="text-sm text-c-ink-3">Contenu du panneau.</p>
        </Drawer>
      )}
    </InlinePortal>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Filtrer' }))

    await expect(canvas.getByRole('dialog')).toBeInTheDocument()
  },
}

export const Large: Story = {
  name: 'lg (640 px)',
  args: {},
  render: () => (
    <InlinePortal>
      {(container) => (
        <Drawer
          container={container}
          size="lg"
          trigger={<Button>Ajouter une personne</Button>}
          title="Ajouter une personne"
          closeLabel="Fermer"
          footer={
            <>
              <Button variant="secondary">Annuler</Button>
              <Button>Inviter</Button>
            </>
          }
        >
          <p className="text-sm text-c-ink-3">Formulaire complet.</p>
        </Drawer>
      )}
    </InlinePortal>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Ajouter une personne' }))

    await expect(canvas.getByRole('dialog')).toBeInTheDocument()
  },
}
