import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Drawer } from './Drawer'

function setup() {
  const onOpenChange = vi.fn()
  render(
    <Drawer
      trigger={<button type="button">Voir les détails</button>}
      title="Détails du domaine"
      description="visio.acme-construction.kodera.io"
      closeLabel="Fermer"
      onOpenChange={onOpenChange}
    >
      <p>Contenu du panneau.</p>
    </Drawer>
  )
  return { onOpenChange }
}

describe('Drawer', () => {
  it('opens from its trigger and is named by its title', async () => {
    const user = userEvent.setup()
    setup()

    await user.click(screen.getByRole('button', { name: 'Voir les détails' }))

    expect(screen.getByRole('dialog', { name: 'Détails du domaine' })).toBeInTheDocument()
  })

  it('traps focus inside the panel', async () => {
    const user = userEvent.setup()
    setup()

    await user.click(screen.getByRole('button', { name: 'Voir les détails' }))
    const dialog = screen.getByRole('dialog')

    expect(screen.getByRole('button', { name: 'Fermer' })).toHaveFocus()

    for (let i = 0; i < 6; i += 1) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })

  it('returns focus to `returnFocusTo` on Escape when it has no trigger', async () => {
    // Same gap as `Dialog`'s: a panel opened programmatically has no Radix
    // trigger to return to — see Dialog.test.tsx for the trigger-less case
    // without the prop.
    function ProgrammaticScreen() {
      const [open, setOpen] = useState(false)
      const openerRef = useRef<HTMLButtonElement | null>(null)
      return (
        <>
          <button type="button" ref={openerRef} onClick={() => setOpen(true)}>
            Relances
          </button>
          <Drawer
            open={open}
            onOpenChange={setOpen}
            returnFocusTo={openerRef}
            title="Relances"
            closeLabel="Fermer"
          >
            <p>Contenu du panneau.</p>
          </Drawer>
        </>
      )
    }
    const user = userEvent.setup()
    render(<ProgrammaticScreen />)
    const opener = screen.getByRole('button', { name: 'Relances' })

    await user.click(opener)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    const { onOpenChange } = setup()
    const trigger = screen.getByRole('button', { name: 'Voir les détails' })

    await user.click(trigger)
    await user.keyboard('{Escape}')

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('closes from its own close control', async () => {
    const user = userEvent.setup()
    setup()

    await user.click(screen.getByRole('button', { name: 'Voir les détails' }))
    await user.click(screen.getByRole('button', { name: 'Fermer' }))

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders the footer the caller passes', async () => {
    const user = userEvent.setup()
    render(
      <Drawer
        trigger={<button type="button">Ouvrir</button>}
        title="Titre"
        closeLabel="Fermer"
        footer={<button type="button">Enregistrer</button>}
      >
        <p>Contenu.</p>
      </Drawer>
    )

    await user.click(screen.getByRole('button', { name: 'Ouvrir' }))

    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeInTheDocument()
  })
})
