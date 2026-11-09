import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { RadioGroup } from './RadioGroup'

const OPTIONS = [
  { value: 'monthly', label: 'Mensuel' },
  { value: 'annual', label: 'Annuel' },
  { value: 'lifetime', label: 'À vie', disabled: true },
]

describe('RadioGroup', () => {
  it('groups its options under one accessible name', () => {
    render(<RadioGroup label="Facturation" options={OPTIONS} />)

    expect(screen.getByRole('radiogroup', { name: 'Facturation' })).toBeVisible()
    expect(screen.getByRole('radio', { name: 'Mensuel' })).toBeVisible()
    expect(screen.getByRole('radio', { name: 'Annuel' })).toBeVisible()
  })

  it('chooses one option on click, and nothing else stays checked', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<RadioGroup label="Facturation" options={OPTIONS} onValueChange={onValueChange} />)

    await user.click(screen.getByRole('radio', { name: 'Annuel' }))

    expect(onValueChange).toHaveBeenCalledWith('annual')
    expect(screen.getByRole('radio', { name: 'Annuel' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Mensuel' })).toHaveAttribute('aria-checked', 'false')
  })

  it('moves the choice with the arrow keys — roving tabindex, one Tab stop for the group', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <RadioGroup
        label="Facturation"
        options={OPTIONS}
        defaultValue="monthly"
        onValueChange={onValueChange}
      />
    )

    await user.tab()
    expect(screen.getByRole('radio', { name: 'Mensuel' })).toHaveFocus()

    // Radix moves the roving focus on a macrotask (`setTimeout`) and only
    // selects the option it lands on if the arrow key is still physically
    // down when that runs. Pressing and releasing in one `user.keyboard`
    // call fires both events back to back, before that timeout has a chance
    // to run — so the key is held (`{ArrowDown>}`) until the move and the
    // selection it triggers are both done, then released.
    await user.keyboard('{ArrowDown>}')
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Annuel' })).toHaveFocus())
    await user.keyboard('{/ArrowDown}')

    expect(onValueChange).toHaveBeenCalledWith('annual')
  })

  it('marks the group invalid and describes it with the error', () => {
    render(<RadioGroup label="Facturation" options={OPTIONS} error="Choisissez une formule." />)

    expect(screen.getByRole('alert')).toHaveTextContent('Choisissez une formule.')
  })

  it('describes the group with help text', () => {
    render(<RadioGroup label="Facturation" options={OPTIONS} help="Résiliable à tout moment." />)

    expect(screen.getByText('Résiliable à tout moment.')).toBeVisible()
  })

  it('disables every option when the caller disables the group', () => {
    render(<RadioGroup label="Facturation" options={OPTIONS} disabled />)

    expect(screen.getByRole('radio', { name: 'Mensuel' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Annuel' })).toBeDisabled()
  })

  it('keeps a single option disabled, set on the option itself', () => {
    render(<RadioGroup label="Facturation" options={OPTIONS} />)

    expect(screen.getByRole('radio', { name: 'À vie' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Mensuel' })).not.toBeDisabled()
  })

  it('forwards its ref to the radiogroup element', () => {
    // The group itself carries no tabindex — Radix puts the roving tabindex on
    // the options, one Tab stop for the whole group, same as native radios.
    const ref = createRef<HTMLDivElement>()
    render(<RadioGroup label="Facturation" options={OPTIONS} ref={ref} />)

    expect(ref.current).toBe(screen.getByRole('radiogroup', { name: 'Facturation' }))
  })
})
