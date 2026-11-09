import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Dialog } from './Dialog'

function setup() {
  const onOpenChange = vi.fn()
  render(
    <Dialog
      trigger={<button type="button">Retirer cette personne</button>}
      title="Retirer Camille Dubois ?"
      description="Cette personne perd immédiatement l’accès."
      closeLabel="Fermer"
      onOpenChange={onOpenChange}
    >
      <p>Contenu du dialogue.</p>
    </Dialog>
  )
  return { onOpenChange }
}

describe('Dialog', () => {
  it('opens from its trigger and is named by its title', async () => {
    const user = userEvent.setup()
    setup()

    await user.click(screen.getByRole('button', { name: 'Retirer cette personne' }))

    expect(screen.getByRole('dialog', { name: 'Retirer Camille Dubois ?' })).toBeInTheDocument()
  })

  it('describes itself with the description text', async () => {
    const user = userEvent.setup()
    setup()

    await user.click(screen.getByRole('button', { name: 'Retirer cette personne' }))

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAccessibleDescription('Cette personne perd immédiatement l’accès.')
  })

  it('traps focus inside the content — Tab cannot reach the trigger behind it', async () => {
    const user = userEvent.setup()
    setup()

    await user.click(screen.getByRole('button', { name: 'Retirer cette personne' }))
    const dialog = screen.getByRole('dialog')
    const closeButton = screen.getByRole('button', { name: 'Fermer' })

    expect(closeButton).toHaveFocus()

    // Cycle far enough to wrap at least once; every focused element must
    // still be inside the dialog the whole way round.
    for (let i = 0; i < 6; i += 1) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    const { onOpenChange } = setup()
    const trigger = screen.getByRole('button', { name: 'Retirer cette personne' })

    await user.click(trigger)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  // A dialog opened programmatically — no `trigger`, `open` driven by the
  // screen from a button Radix knows nothing about (the invoices bank-details
  // case: one dialog, two possible openers). Radix's own restore targets its
  // trigger ref, which is null here, so without `returnFocusTo` focus would
  // land on `body` on close.
  function ProgrammaticScreen({ returnFocus }: { returnFocus: boolean }) {
    const [open, setOpen] = useState(false)
    const openerRef = useRef<HTMLButtonElement | null>(null)
    return (
      <>
        <button type="button" ref={openerRef} onClick={() => setOpen(true)}>
          Voir les coordonnées bancaires
        </button>
        <Dialog
          open={open}
          onOpenChange={setOpen}
          {...(returnFocus ? { returnFocusTo: openerRef } : {})}
          title="Coordonnées bancaires"
          closeLabel="Fermer"
        >
          <p>Référence du virement.</p>
        </Dialog>
      </>
    )
  }

  it('returns focus to `returnFocusTo` on Escape when it has no trigger', async () => {
    const user = userEvent.setup()
    render(<ProgrammaticScreen returnFocus />)
    const opener = screen.getByRole('button', { name: 'Voir les coordonnées bancaires' })

    await user.click(opener)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(opener).not.toHaveFocus()

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
  })

  it('without `returnFocusTo`, a trigger-less dialog leaves focus on body — the gap the prop closes', async () => {
    const user = userEvent.setup()
    render(<ProgrammaticScreen returnFocus={false} />)
    const opener = screen.getByRole('button', { name: 'Voir les coordonnées bancaires' })

    await user.click(opener)
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).not.toHaveFocus()
    expect(document.body).toHaveFocus()
  })

  it('opens on the field a ref names, and on the close control when that ref is empty', async () => {
    const user = userEvent.setup()
    function FieldFirst({ attach }: { attach: boolean }) {
      const field = useRef<HTMLInputElement>(null)
      return (
        <Dialog
          trigger={<button type="button">Rechercher</button>}
          title="Aller à un salon"
          closeLabel="Fermer"
          initialFocus={field}
        >
          {attach ? <input ref={field} aria-label="Nom du salon" /> : <p>Rien à saisir.</p>}
        </Dialog>
      )
    }
    const { unmount } = render(<FieldFirst attach />)
    await user.click(screen.getByRole('button', { name: 'Rechercher' }))
    expect(screen.getByRole('textbox', { name: 'Nom du salon' })).toHaveFocus()
    unmount()

    render(<FieldFirst attach={false} />)
    await user.click(screen.getByRole('button', { name: 'Rechercher' }))
    expect(screen.getByRole('button', { name: 'Fermer' })).toHaveFocus()
  })

  it('closes from its own close control', async () => {
    const user = userEvent.setup()
    setup()

    await user.click(screen.getByRole('button', { name: 'Retirer cette personne' }))
    await user.click(screen.getByRole('button', { name: 'Fermer' }))

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // A dialog with one way forward and no way back: the expired session
  // (docs/specs/00-shell-and-login.md §4.7). Its close control was drawn and
  // focused, and did nothing.
  function OneWayOut({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
    return (
      <>
        <button type="button">Derrière le dialogue</button>
        <Dialog
          open
          onOpenChange={onOpenChange}
          dismissible={false}
          title="Votre session a expiré"
          closeLabel="Fermer"
          footer={<button type="button">Se reconnecter</button>}
        >
          <p>Contenu.</p>
        </Dialog>
      </>
    )
  }

  it('draws no close control when it cannot be dismissed, and opens on its one action', () => {
    render(<OneWayOut onOpenChange={() => {}} />)

    const dialog = screen.getByRole('dialog', { name: 'Votre session a expiré' })
    expect(screen.queryByRole('button', { name: 'Fermer' })).toBeNull()
    expect(dialog.querySelectorAll('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Se reconnecter' })).toHaveFocus()
  })

  // One test per refusal, so that each of the two handlers has a test that
  // fails without it.
  it('ignores Escape when it cannot be dismissed', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<OneWayOut onOpenChange={onOpenChange} />)

    await user.keyboard('{Escape}')

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('ignores a press outside when it cannot be dismissed', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<OneWayOut onOpenChange={onOpenChange} />)

    // The page behind a modal dialog takes no pointer events: a press outside
    // lands on the overlay, the element drawn just before the dialog's frame.
    const overlay = screen.getByRole('dialog').parentElement!.previousElementSibling!
    await user.pointer({ keys: '[MouseLeft]', target: overlay })

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('renders the footer the caller passes', async () => {
    const user = userEvent.setup()
    render(
      <Dialog
        trigger={<button type="button">Ouvrir</button>}
        title="Titre"
        closeLabel="Fermer"
        footer={<button type="button">Confirmer</button>}
      >
        <p>Contenu.</p>
      </Dialog>
    )

    await user.click(screen.getByRole('button', { name: 'Ouvrir' }))

    expect(screen.getByRole('button', { name: 'Confirmer' })).toBeInTheDocument()
  })
})
