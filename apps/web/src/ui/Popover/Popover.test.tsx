import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Popover } from './Popover'

describe('Popover', () => {
  it('opens from its trigger and shows its content', async () => {
    const user = userEvent.setup()
    render(
      <Popover trigger={<button type="button">Filtrer</button>} label="Filtrer">
        <p>Contenu du filtre.</p>
      </Popover>
    )

    expect(screen.queryByText('Contenu du filtre.')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Filtrer' }))

    expect(screen.getByText('Contenu du filtre.')).toBeInTheDocument()
  })

  it('names its content — Radix renders role="dialog" on it unconditionally', async () => {
    const user = userEvent.setup()
    render(
      <Popover trigger={<button type="button">Filtrer</button>} label="Filtrer les résultats">
        <p>Contenu du filtre.</p>
      </Popover>
    )

    await user.click(screen.getByRole('button', { name: 'Filtrer' }))

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Filtrer les résultats')
  })

  it('is reachable and opens by keyboard alone', async () => {
    const user = userEvent.setup()
    render(
      <Popover trigger={<button type="button">Filtrer</button>} label="Filtrer">
        <p>Contenu du filtre.</p>
      </Popover>
    )

    await user.tab()
    expect(screen.getByRole('button', { name: 'Filtrer' })).toHaveFocus()

    await user.keyboard('{Enter}')

    expect(screen.getByText('Contenu du filtre.')).toBeInTheDocument()
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(
      <Popover
        trigger={<button type="button">Filtrer</button>}
        label="Filtrer"
        onOpenChange={onOpenChange}
      >
        <p>Contenu du filtre.</p>
      </Popover>
    )
    const trigger = screen.getByRole('button', { name: 'Filtrer' })

    await user.click(trigger)
    await user.keyboard('{Escape}')

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByText('Contenu du filtre.')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('closes on an outside click', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <Popover trigger={<button type="button">Filtrer</button>} label="Filtrer">
          <p>Contenu du filtre.</p>
        </Popover>
        <button type="button">Ailleurs</button>
      </div>
    )

    await user.click(screen.getByRole('button', { name: 'Filtrer' }))
    await user.click(screen.getByRole('button', { name: 'Ailleurs' }))

    expect(screen.queryByText('Contenu du filtre.')).toBeNull()
  })
})
