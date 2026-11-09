import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Tabs } from './Tabs'

const items = [
  { value: 'people', label: 'Personnes', content: <p>Liste des personnes</p> },
  { value: 'domains', label: 'Domaines', content: <p>Liste des domaines</p> },
  { value: 'invoices', label: 'Factures', content: <p>Liste des factures</p>, disabled: true },
]

describe('Tabs', () => {
  it('shows the panel for the controlled value', () => {
    render(<Tabs ariaLabel="Sections" items={items} value="people" onValueChange={() => {}} />)

    expect(screen.getByText('Liste des personnes')).toBeVisible()
    expect(screen.queryByText('Liste des domaines')).toBeNull()
  })

  it('marks the active tab selected', () => {
    render(<Tabs ariaLabel="Sections" items={items} value="domains" onValueChange={() => {}} />)

    expect(screen.getByRole('tab', { name: 'Domaines' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Personnes' })).toHaveAttribute('aria-selected', 'false')
  })

  it('calls onValueChange when a tab is clicked, without changing the value itself', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<Tabs ariaLabel="Sections" items={items} value="people" onValueChange={onValueChange} />)

    await user.click(screen.getByRole('tab', { name: 'Domaines' }))

    expect(onValueChange).toHaveBeenCalledWith('domains')
    // Controlled: the panel does not change until the caller feeds the new
    // value back in as `value` — that is what "URL-controlled" means here.
    expect(screen.getByText('Liste des personnes')).toBeVisible()
  })

  it('moves focus and selection with the arrow keys', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<Tabs ariaLabel="Sections" items={items} value="people" onValueChange={onValueChange} />)

    screen.getByRole('tab', { name: 'Personnes' }).focus()
    await user.keyboard('{ArrowRight}')

    expect(screen.getByRole('tab', { name: 'Domaines' })).toHaveFocus()
    expect(onValueChange).toHaveBeenCalledWith('domains')
  })

  it('skips a disabled tab', () => {
    render(<Tabs ariaLabel="Sections" items={items} value="people" onValueChange={() => {}} />)

    expect(screen.getByRole('tab', { name: 'Factures' })).toBeDisabled()
  })
})
