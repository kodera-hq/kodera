import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DropdownMenu } from './DropdownMenu'
import type { DropdownMenuProps } from './DropdownMenu'

function setup(overrides: Partial<DropdownMenuProps> = {}) {
  const onSelectEdit = vi.fn()
  const onSelectRemove = vi.fn()
  const utils = render(
    <DropdownMenu
      trigger={<button type="button">···</button>}
      label="Actions pour Camille Dubois"
      items={[
        { label: 'Modifier', onSelect: onSelectEdit },
        { type: 'separator' },
        { label: 'Retirer', onSelect: onSelectRemove, destructive: true },
      ]}
      {...overrides}
    />
  )
  return { ...utils, onSelectEdit, onSelectRemove }
}

describe('DropdownMenu', () => {
  it('opens from its trigger and lists its items', async () => {
    const user = userEvent.setup()
    setup()

    await user.click(screen.getByRole('button', { name: '···' }))

    expect(screen.getByRole('menuitem', { name: 'Modifier' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Retirer' })).toBeInTheDocument()
  })

  it('renders a separator between item groups', async () => {
    const user = userEvent.setup()
    setup()

    await user.click(screen.getByRole('button', { name: '···' }))

    expect(screen.getByRole('separator')).toBeInTheDocument()
  })

  it('opens by keyboard and moves focus to the first item', async () => {
    const user = userEvent.setup()
    setup()

    await user.tab()
    expect(screen.getByRole('button', { name: '···' })).toHaveFocus()

    await user.keyboard('{Enter}')

    expect(screen.getByRole('menuitem', { name: 'Modifier' })).toHaveFocus()
  })

  it('moves focus to the next item with ArrowDown, skipping the separator', async () => {
    const user = userEvent.setup()
    setup()

    // Opened by keyboard, which — unlike a click — moves focus straight to
    // the first item (the WAI-ARIA menu button pattern Radix follows).
    await user.tab()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('menuitem', { name: 'Modifier' })).toHaveFocus()

    await user.keyboard('{ArrowDown}')

    expect(screen.getByRole('menuitem', { name: 'Retirer' })).toHaveFocus()
  })

  it('selects the focused item on Enter and closes', async () => {
    const user = userEvent.setup()
    const { onSelectEdit } = setup()

    await user.tab()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('menuitem', { name: 'Modifier' })).toHaveFocus()

    await user.keyboard('{Enter}')

    expect(onSelectEdit).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it('closes on Escape and returns focus to the trigger, without selecting anything', async () => {
    const user = userEvent.setup()
    const { onSelectEdit, onSelectRemove } = setup()
    const trigger = screen.getByRole('button', { name: '···' })

    await user.click(trigger)
    await user.keyboard('{Escape}')

    expect(onSelectEdit).not.toHaveBeenCalled()
    expect(onSelectRemove).not.toHaveBeenCalled()
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('marks the destructive item so it can be styled apart from the rest', async () => {
    const user = userEvent.setup()
    setup()

    await user.click(screen.getByRole('button', { name: '···' }))

    expect(screen.getByRole('menuitem', { name: 'Retirer' })).toHaveAttribute('data-destructive')
    expect(screen.getByRole('menuitem', { name: 'Modifier' })).not.toHaveAttribute(
      'data-destructive'
    )
  })

  it('skips a disabled item during keyboard navigation', async () => {
    const user = userEvent.setup()
    setup({
      items: [
        { label: 'Modifier', onSelect: vi.fn() },
        { label: 'Suspendre', onSelect: vi.fn(), disabled: true },
        { label: 'Retirer', onSelect: vi.fn(), destructive: true },
      ],
    })

    await user.tab()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('menuitem', { name: 'Modifier' })).toHaveFocus()

    await user.keyboard('{ArrowDown}')

    expect(screen.getByRole('menuitem', { name: 'Retirer' })).toHaveFocus()
  })

  it('jumps to the item starting with the typed letter (typeahead)', async () => {
    const user = userEvent.setup()
    setup()

    await user.tab()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('menuitem', { name: 'Modifier' })).toHaveFocus()

    await user.keyboard('r')

    expect(screen.getByRole('menuitem', { name: 'Retirer' })).toHaveFocus()
  })

  it('forwards its ref to the menu content, once open', async () => {
    const user = userEvent.setup()
    const ref = createRef<HTMLDivElement>()
    render(
      <DropdownMenu
        ref={ref}
        trigger={<button type="button">···</button>}
        label="Actions"
        items={[{ label: 'Modifier', onSelect: vi.fn() }]}
      />
    )

    expect(ref.current).toBeNull()

    await user.click(screen.getByRole('button', { name: '···' }))

    expect(screen.getByRole('menu')).toBe(ref.current)
  })
})
