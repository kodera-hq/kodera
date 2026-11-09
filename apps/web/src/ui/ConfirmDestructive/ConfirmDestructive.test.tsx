import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDestructive } from './ConfirmDestructive'

describe('ConfirmDestructive', () => {
  it('names the object and the consequence', async () => {
    const user = userEvent.setup()
    render(
      <ConfirmDestructive
        trigger={<button type="button">Retirer</button>}
        title="Retirer Camille Dubois ?"
        consequence="Cette personne perd immédiatement l’accès à l’espace."
        cancelLabel="Annuler"
        confirmLabel="Retirer"
        closeLabel="Fermer"
        onConfirm={() => {}}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Retirer' }))

    expect(screen.getByRole('dialog', { name: 'Retirer Camille Dubois ?' })).toBeInTheDocument()
    expect(
      screen.getByText('Cette personne perd immédiatement l’accès à l’espace.')
    ).toBeInTheDocument()
  })

  it('calls onConfirm and closes when the destructive action is pressed', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      <ConfirmDestructive
        trigger={<button type="button">Retirer</button>}
        title="Retirer Camille Dubois ?"
        consequence="Cette personne perd immédiatement l’accès."
        cancelLabel="Annuler"
        confirmLabel="Retirer"
        closeLabel="Fermer"
        onConfirm={onConfirm}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Retirer' }))
    // Two buttons now share the name "Retirer": the trigger, inert behind the
    // dialog, and the confirm action inside it — scope the query to the
    // dialog so it is unambiguously the second one.
    const dialog = within(screen.getByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: 'Retirer' }))

    expect(onConfirm).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes without confirming when Cancel is pressed', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      <ConfirmDestructive
        trigger={<button type="button">Retirer</button>}
        title="Retirer Camille Dubois ?"
        consequence="Cette personne perd immédiatement l’accès."
        cancelLabel="Annuler"
        confirmLabel="Retirer"
        closeLabel="Fermer"
        onConfirm={onConfirm}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Retirer' }))
    await user.click(screen.getByRole('button', { name: 'Annuler' }))

    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the destructive action disabled until the typed confirmation matches', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      <ConfirmDestructive
        trigger={<button type="button">Supprimer l’organisation</button>}
        title="Supprimer acme-construction ?"
        consequence="Cette action est définitive."
        cancelLabel="Annuler"
        confirmLabel="Supprimer"
        closeLabel="Fermer"
        onConfirm={onConfirm}
        requireTypedConfirmation
        confirmationValue="acme-construction"
        confirmationLabel="Tapez « acme-construction » pour confirmer"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Supprimer l’organisation' }))
    const confirmButton = screen.getByRole('button', { name: 'Supprimer' })
    expect(confirmButton).toBeDisabled()

    const input = screen.getByLabelText('Tapez « acme-construction » pour confirmer')
    await user.type(input, 'acme-construction')

    expect(confirmButton).toBeEnabled()

    await user.click(confirmButton)
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('resets the typed confirmation after closing', async () => {
    const user = userEvent.setup()
    render(
      <ConfirmDestructive
        trigger={<button type="button">Ouvrir la confirmation</button>}
        title="Supprimer ?"
        consequence="Définitif."
        cancelLabel="Annuler"
        confirmLabel="Supprimer"
        closeLabel="Fermer"
        onConfirm={() => {}}
        requireTypedConfirmation
        confirmationValue="acme"
        confirmationLabel="Tapez « acme »"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Ouvrir la confirmation' }))
    await user.type(screen.getByLabelText('Tapez « acme »'), 'acme')
    await user.click(screen.getByRole('button', { name: 'Annuler' }))

    await user.click(screen.getByRole('button', { name: 'Ouvrir la confirmation' }))
    expect(screen.getByLabelText('Tapez « acme »')).toHaveValue('')
  })

  it('forwards `returnFocusTo` to the dialog it is built on', async () => {
    // The one way this opens without a trigger is `defaultOpen`; the control
    // that led here is then the only sensible place for focus to go back to.
    function Screen() {
      const returnRef = useRef<HTMLButtonElement | null>(null)
      return (
        <>
          <button type="button" ref={returnRef}>
            Paramètres
          </button>
          <ConfirmDestructive
            defaultOpen
            returnFocusTo={returnRef}
            title="Supprimer l’organisation ?"
            consequence="Toutes les données sont perdues."
            cancelLabel="Annuler"
            confirmLabel="Supprimer"
            closeLabel="Fermer"
            onConfirm={() => {}}
          />
        </>
      )
    }
    const user = userEvent.setup()
    render(<Screen />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Paramètres' })).toHaveFocus()
  })
  it('can start focus on the heading, never on the destructive action (03-people.md §10)', async () => {
    const user = userEvent.setup()
    render(
      <ConfirmDestructive
        trigger={<button type="button">Retirer</button>}
        title="Retirer Marc Petit ?"
        consequence="Marc Petit ne pourra plus se connecter."
        cancelLabel="Annuler"
        confirmLabel="Retirer Marc Petit"
        closeLabel="Fermer"
        initialFocus="title"
        onConfirm={() => {}}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Retirer' }))

    expect(screen.getByRole('heading', { name: 'Retirer Marc Petit ?' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
