import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Select } from './Select'

const OPTIONS = [
  { value: 'admin', label: 'Administrateur' },
  { value: 'member', label: 'Membre' },
  { value: 'billing', label: 'Facturation', disabled: true },
]

describe('Select', () => {
  it('is reachable by its visible label', () => {
    render(<Select label="Rôle" options={OPTIONS} placeholder="Choisir un rôle" />)

    expect(screen.getByRole('combobox', { name: 'Rôle' })).toBeVisible()
  })

  it('shows the placeholder until a value is chosen', () => {
    render(<Select label="Rôle" options={OPTIONS} placeholder="Choisir un rôle" />)

    expect(screen.getByRole('combobox', { name: 'Rôle' })).toHaveTextContent('Choisir un rôle')
  })

  it('opens on click, lists every option, and chooses one on click', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <Select
        label="Rôle"
        options={OPTIONS}
        placeholder="Choisir un rôle"
        onValueChange={onValueChange}
      />
    )

    await user.click(screen.getByRole('combobox', { name: 'Rôle' }))

    const option = await screen.findByRole('option', { name: 'Membre' })
    await user.click(option)

    expect(onValueChange).toHaveBeenCalledWith('member')
  })

  it('opens with the keyboard and chooses with the keyboard', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <Select
        label="Rôle"
        options={OPTIONS}
        placeholder="Choisir un rôle"
        onValueChange={onValueChange}
      />
    )

    await user.tab()
    expect(screen.getByRole('combobox', { name: 'Rôle' })).toHaveFocus()

    // `Enter` opens with the first option already highlighted; one `ArrowDown`
    // moves the highlight to the second, and the `Enter` after that chooses it.
    await user.keyboard('{Enter}')
    await screen.findByRole('listbox')

    await user.keyboard('{ArrowDown}{Enter}')

    expect(onValueChange).toHaveBeenCalledWith('member')
  })

  it('closes on Escape without choosing anything', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<Select label="Rôle" options={OPTIONS} onValueChange={onValueChange} />)

    await user.click(screen.getByRole('combobox', { name: 'Rôle' }))
    await screen.findByRole('listbox')

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('skips a disabled option between enabled options during keyboard selection', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <Select
        label="Rôle"
        options={[
          { value: 'admin', label: 'Administrateur' },
          { value: 'billing', label: 'Facturation', disabled: true },
          { value: 'member', label: 'Membre' },
        ]}
        defaultValue="admin"
        onValueChange={onValueChange}
      />
    )

    await user.tab()
    await user.keyboard('{Enter}')
    await screen.findByRole('listbox')
    await user.keyboard('{ArrowDown}{Enter}')

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('member')
    expect(screen.getByRole('combobox', { name: 'Rôle' })).toHaveTextContent('Membre')
  })

  it('refuses pointer selection of a disabled option while enabled selection still works', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <Select label="Rôle" options={OPTIONS} defaultValue="admin" onValueChange={onValueChange} />
    )

    const trigger = screen.getByRole('combobox', { name: 'Rôle' })
    await user.click(trigger)
    const disabledOption = await screen.findByRole('option', { name: 'Facturation' })
    await user.click(disabledOption)

    expect(onValueChange).not.toHaveBeenCalled()
    expect(trigger).toHaveTextContent('Administrateur')
    expect(disabledOption).toHaveAttribute('aria-disabled', 'true')

    await user.click(screen.getByRole('option', { name: 'Membre' }))

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('member')
    expect(screen.getByRole('combobox', { name: 'Rôle' })).toHaveTextContent('Membre')
  })

  it('marks the field invalid and describes it with the error', () => {
    render(<Select label="Rôle" options={OPTIONS} error="Choisissez un rôle." />)

    const combobox = screen.getByRole('combobox', { name: 'Rôle' })
    expect(combobox).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Choisissez un rôle.')
    expect(combobox).toHaveAccessibleDescription('Choisissez un rôle.')
  })

  it('describes help and error together, then keeps only help when the error clears', () => {
    const { rerender } = render(
      <Select
        label="Rôle"
        options={OPTIONS}
        help="Détermine les permissions."
        error="Choisissez un rôle."
      />
    )

    const combobox = screen.getByRole('combobox', { name: 'Rôle' })
    expect(combobox).toHaveAccessibleDescription('Détermine les permissions. Choisissez un rôle.')
    expect(combobox).toHaveAttribute('aria-invalid', 'true')

    rerender(<Select label="Rôle" options={OPTIONS} help="Détermine les permissions." />)

    expect(screen.getByRole('combobox', { name: 'Rôle' })).toBe(combobox)
    expect(combobox).toHaveAccessibleDescription('Détermine les permissions.')
    expect(combobox).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('describes the field with help text', () => {
    render(<Select label="Rôle" options={OPTIONS} help="Détermine les permissions." />)

    expect(screen.getByRole('combobox', { name: 'Rôle' })).toHaveAccessibleDescription(
      'Détermine les permissions.'
    )
  })

  it('is disabled when the caller disables it, and Tab skips it', async () => {
    const user = userEvent.setup()
    render(
      <>
        <button type="button">Avant</button>
        <Select label="Rôle" options={OPTIONS} disabled />
        <button type="button">Après</button>
      </>
    )

    const trigger = screen.getByRole('combobox', { name: 'Rôle' })
    expect(trigger).toHaveAttribute('data-disabled')
    expect(trigger).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Avant' }))
    await user.tab()

    // A native `disabled` attribute on the trigger, not decoration alone —
    // `data-disabled` is what the styling hooks into, `disabled` is what
    // keeps a disabled control out of the Tab order in the first place.
    expect(screen.getByRole('button', { name: 'Après' })).toHaveFocus()
  })

  it('forwards its ref, so a form can move focus to the trigger', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<Select label="Rôle" options={OPTIONS} ref={ref} />)

    ref.current?.focus()

    expect(screen.getByRole('combobox', { name: 'Rôle' })).toHaveFocus()
  })
})
