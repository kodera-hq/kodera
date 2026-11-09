import type { Meta, StoryObj } from '@storybook/react-vite'
import { useRef, useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'
import { Button } from '../Button/Button'
import { Dialog } from './Dialog'

// `src/ui/stories-a11y.test.tsx` runs `axe.run(container, …)` against the
// element `render()` returns, and Radix portals its content to
// `document.body` by default — a sibling of that container, not a
// descendant, so a portalled dialog would never be scanned. `Dialog` accepts
// a `container` prop forwarded straight to Radix's own `Dialog.Portal`
// (docs/dev/TESTING.md §3 asks the portal case be covered one of two ways,
// documented rather than silently working around the gate): this renders the
// portal content *inside* the story's own tree instead of moving the gate.
// A product screen never passes `container` — Radix's `document.body` default
// stands.
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
  title: 'Primitives/Dialog',
  component: Dialog,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: opening moves focus to the close control; `Tab`/`Shift+Tab`',
          'cycle through the content only, never back out to the page. `Escape`',
          'closes and returns focus to the trigger — or, for a dialog opened',
          'without one (`open` driven by the screen, no `trigger`), to the',
          'element the `returnFocusTo` ref holds at close time. Without either,',
          'focus lands on `body`.',
        ].join('\n'),
      },
    },
  },
  // Every story below drives its own `render`, so these never appear on
  // screen — they exist because `title`/`closeLabel` are required props and
  // a `Meta` needs `args` that satisfy the component's own type.
  args: { title: 'Titre', closeLabel: 'Fermer', children: null },
} satisfies Meta<typeof Dialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {},
  render: () => (
    <InlinePortal>
      {(container) => (
        <Dialog
          container={container}
          trigger={<Button>Modifier le domaine</Button>}
          title="Modifier le domaine"
          description="Le sous-domaine devient effectif sous quelques minutes."
          closeLabel="Fermer"
          footer={
            <>
              <Button variant="secondary">Annuler</Button>
              <Button>Enregistrer</Button>
            </>
          }
        >
          <p className="text-sm text-c-ink-3">Contenu du formulaire.</p>
        </Dialog>
      )}
    </InlinePortal>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Modifier le domaine' }))

    await expect(canvas.getByRole('dialog', { name: 'Modifier le domaine' })).toBeInTheDocument()
  },
}

export const Small: Story = {
  name: 'sm (420 px)',
  args: {},
  render: () => (
    <InlinePortal>
      {(container) => (
        <Dialog
          container={container}
          size="sm"
          trigger={<Button variant="destructive">Retirer cette personne</Button>}
          title="Retirer Camille Dubois ?"
          description="Cette personne perd immédiatement l’accès à l’espace."
          closeLabel="Fermer"
          footer={
            <>
              <Button variant="secondary">Annuler</Button>
              <Button variant="destructive">Retirer</Button>
            </>
          }
        >
          <p className="text-sm text-c-ink-3">Cette action ne peut pas être annulée.</p>
        </Dialog>
      )}
    </InlinePortal>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Retirer cette personne' }))

    await expect(canvas.getByRole('dialog')).toBeInTheDocument()
  },
}

export const NoDescription: Story = {
  args: {},
  render: () => (
    <InlinePortal>
      {(container) => (
        <Dialog
          container={container}
          trigger={<Button>Ouvrir</Button>}
          title="Titre seul"
          closeLabel="Fermer"
        >
          <p className="text-sm text-c-ink-3">Pas de ligne de description ici.</p>
        </Dialog>
      )}
    </InlinePortal>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Ouvrir' }))

    await expect(canvas.getByRole('dialog')).toBeInTheDocument()
  },
}

// One way forward and no way back — the expired session. No close control is
// drawn, `Escape` and a press outside do nothing, and opening lands on the one
// action.
export const NotDismissible: Story = {
  name: 'dismissible={false}',
  args: {},
  render: () => (
    <InlinePortal>
      {(container) => (
        <Dialog
          container={container}
          dismissible={false}
          size="sm"
          trigger={<Button variant="secondary">Laisser la session expirer</Button>}
          title="Votre session a expiré"
          description="Reconnectez-vous pour reprendre là où vous en étiez."
          closeLabel="Fermer"
          footer={<Button>Se reconnecter</Button>}
        >
          {null}
        </Dialog>
      )}
    </InlinePortal>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Laisser la session expirer' }))
    const dialog = canvas.getByRole('dialog', { name: 'Votre session a expiré' })

    await expect(canvas.queryByRole('button', { name: 'Fermer' })).not.toBeInTheDocument()
    await expect(canvas.getByRole('button', { name: 'Se reconnecter' })).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    await expect(dialog).toBeInTheDocument()
  },
}

// A dialog the screen opens itself: no `trigger`, so Radix has nothing to
// return focus to on close. The screen records the opener when it opens the
// dialog and hands the ref to `returnFocusTo` — read at close, so the same
// dialog opened from a second button would return to that one instead.
function ProgrammaticDialog({ container }: { container: HTMLDivElement | null }) {
  const [open, setOpen] = useState(false)
  const openerRef = useRef<HTMLButtonElement | null>(null)
  return (
    <>
      <Button
        ref={openerRef}
        variant="secondary"
        onClick={() => {
          setOpen(true)
        }}
      >
        Voir les coordonnées bancaires
      </Button>
      <Dialog
        container={container}
        open={open}
        onOpenChange={setOpen}
        returnFocusTo={openerRef}
        size="sm"
        title="Coordonnées bancaires"
        closeLabel="Fermer"
        footer={
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Fermer
          </Button>
        }
      >
        <p className="text-sm text-c-ink-3">Référence du virement : F-2026-0042.</p>
      </Dialog>
    </>
  )
}

export const ReturnFocus: Story = {
  name: 'returnFocusTo (no trigger)',
  args: {},
  render: () => (
    <InlinePortal>{(container) => <ProgrammaticDialog container={container} />}</InlinePortal>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const opener = canvas.getByRole('button', { name: 'Voir les coordonnées bancaires' })
    await userEvent.click(opener)
    await expect(canvas.getByRole('dialog', { name: 'Coordonnées bancaires' })).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')

    await expect(canvas.queryByRole('dialog')).not.toBeInTheDocument()
    await expect(opener).toHaveFocus()
  },
}
