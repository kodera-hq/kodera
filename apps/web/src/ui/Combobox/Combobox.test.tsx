import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Combobox } from './Combobox'

const OPTIONS = [
  { value: 'fr', label: 'France' },
  { value: 'de', label: 'Allemagne' },
  { value: 'be', label: 'Belgique', disabled: true },
]

const EMPTY_TEXT = 'Aucun pays ne correspond.'

describe('Combobox', () => {
  it('is reachable by its visible label, as a combobox that types', () => {
    render(<Combobox label="Pays" options={OPTIONS} emptyText={EMPTY_TEXT} />)

    const input = screen.getByRole('combobox', { name: 'Pays' })
    expect(input).toBeVisible()
    expect(input).toHaveAttribute('aria-autocomplete', 'list')
    expect(input).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens and lists every option on focus', async () => {
    const user = userEvent.setup()
    render(<Combobox label="Pays" options={OPTIONS} emptyText={EMPTY_TEXT} />)

    await user.click(screen.getByRole('combobox', { name: 'Pays' }))

    expect(await screen.findAllByRole('option')).toHaveLength(3)
  })

  it('filters the list as the person types — the typeahead', async () => {
    const user = userEvent.setup()
    render(<Combobox label="Pays" options={OPTIONS} emptyText={EMPTY_TEXT} />)

    await user.type(screen.getByRole('combobox', { name: 'Pays' }), 'all')

    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('Allemagne')
  })

  it('shows the empty-result text when nothing matches', async () => {
    const user = userEvent.setup()
    render(<Combobox label="Pays" options={OPTIONS} emptyText={EMPTY_TEXT} />)

    await user.type(screen.getByRole('combobox', { name: 'Pays' }), 'xyz')

    expect(await screen.findByText(EMPTY_TEXT)).toBeVisible()
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
  })

  it('moves the highlight with ArrowDown/ArrowUp and exposes it as aria-activedescendant', async () => {
    const user = userEvent.setup()
    render(<Combobox label="Pays" options={OPTIONS} emptyText={EMPTY_TEXT} />)

    const input = screen.getByRole('combobox', { name: 'Pays' })
    await user.click(input)
    await screen.findAllByRole('option')

    await user.keyboard('{ArrowDown}')
    const options = screen.getAllByRole('option')
    expect(input).toHaveAttribute('aria-activedescendant', options[0]?.id)

    await user.keyboard('{ArrowDown}')
    expect(input).toHaveAttribute('aria-activedescendant', options[1]?.id)

    await user.keyboard('{ArrowUp}')
    expect(input).toHaveAttribute('aria-activedescendant', options[0]?.id)
  })

  it('skips a disabled option when moving the highlight', async () => {
    const user = userEvent.setup()
    render(<Combobox label="Pays" options={OPTIONS} emptyText={EMPTY_TEXT} />)

    const input = screen.getByRole('combobox', { name: 'Pays' })
    await user.click(input)
    await screen.findAllByRole('option')

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')

    // Two enabled options only (France, Allemagne) — the third ArrowDown has
    // nothing to move onto and stays on the last one, never landing on Belgique.
    const options = screen.getAllByRole('option')
    expect(input).toHaveAttribute('aria-activedescendant', options[1]?.id)
  })

  it('jumps to the first and last option with Home and End', async () => {
    const user = userEvent.setup()
    render(<Combobox label="Pays" options={OPTIONS} emptyText={EMPTY_TEXT} />)

    const input = screen.getByRole('combobox', { name: 'Pays' })
    await user.click(input)
    const options = await screen.findAllByRole('option')

    await user.keyboard('{End}')
    expect(input).toHaveAttribute('aria-activedescendant', options[1]?.id)

    await user.keyboard('{Home}')
    expect(input).toHaveAttribute('aria-activedescendant', options[0]?.id)
  })

  it('chooses the highlighted option on Enter, fills the field and closes the list', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <Combobox
        label="Pays"
        options={OPTIONS}
        emptyText={EMPTY_TEXT}
        onValueChange={onValueChange}
      />
    )

    const input = screen.getByRole('combobox', { name: 'Pays' })
    await user.click(input)
    await screen.findAllByRole('option')

    await user.keyboard('{ArrowDown}{Enter}')

    expect(onValueChange).toHaveBeenCalledWith('fr')
    expect(input).toHaveValue('France')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('chooses an option on click', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <Combobox
        label="Pays"
        options={OPTIONS}
        emptyText={EMPTY_TEXT}
        onValueChange={onValueChange}
      />
    )

    await user.click(screen.getByRole('combobox', { name: 'Pays' }))
    await user.click(await screen.findByRole('option', { name: 'Allemagne' }))

    expect(onValueChange).toHaveBeenCalledWith('de')
    expect(screen.getByRole('combobox', { name: 'Pays' })).toHaveValue('Allemagne')
  })

  it('closes on Escape without choosing anything', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <Combobox
        label="Pays"
        options={OPTIONS}
        emptyText={EMPTY_TEXT}
        onValueChange={onValueChange}
      />
    )

    await user.click(screen.getByRole('combobox', { name: 'Pays' }))
    await screen.findAllByRole('option')

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('marks the field invalid and describes it with the error', () => {
    render(
      <Combobox label="Pays" options={OPTIONS} emptyText={EMPTY_TEXT} error="Choisissez un pays." />
    )

    const input = screen.getByRole('combobox', { name: 'Pays' })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Choisissez un pays.')
  })

  it('forwards its ref, so a form can move focus to the input', () => {
    const ref = createRef<HTMLInputElement>()
    render(<Combobox label="Pays" options={OPTIONS} emptyText={EMPTY_TEXT} ref={ref} />)

    ref.current?.focus()

    expect(screen.getByRole('combobox', { name: 'Pays' })).toHaveFocus()
  })
})
