import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Breadcrumb } from './Breadcrumb'

const items = [
  { label: 'Organisation', href: '/organisation' },
  { label: 'Personnes', href: '/organisation/personnes' },
  { label: 'Henri Duflot' },
]

describe('Breadcrumb', () => {
  it('is a navigation landmark with the caller label', () => {
    render(<Breadcrumb ariaLabel="Fil d’Ariane" items={items} />)

    expect(screen.getByRole('navigation', { name: 'Fil d’Ariane' })).toBeInTheDocument()
  })

  it('renders every earlier item as a link', () => {
    render(<Breadcrumb ariaLabel="Fil d’Ariane" items={items} />)

    expect(screen.getByRole('link', { name: 'Organisation' })).toHaveAttribute(
      'href',
      '/organisation'
    )
    expect(screen.getByRole('link', { name: 'Personnes' })).toHaveAttribute(
      'href',
      '/organisation/personnes'
    )
  })

  it('marks the last item as the current page and not a link', () => {
    render(<Breadcrumb ariaLabel="Fil d’Ariane" items={items} />)

    const current = screen.getByText('Henri Duflot')
    expect(current).toHaveAttribute('aria-current', 'page')
    expect(within(current.closest('li') as HTMLElement).queryByRole('link')).toBeNull()
  })

  it('lets keyboard focus reach a link and shows the focus ring on it', async () => {
    const user = userEvent.setup()
    render(<Breadcrumb ariaLabel="Fil d’Ariane" items={items} />)

    await user.tab()

    const link = screen.getByRole('link', { name: 'Organisation' })
    expect(link).toHaveFocus()
    expect(link).toHaveClass('focus-visible:ring')
  })

  it('puts every direct child of the list inside an li, separators included', () => {
    render(<Breadcrumb ariaLabel="Fil d’Ariane" items={items} />)

    // An `ol` may hold only `li` (plus `script`/`template`). A separator
    // rendered as a bare `span` between two items is markup a list is not
    // allowed to carry, and the `aria-hidden` that makes it decorative is
    // also what stops axe's `list` rule from reporting it — so the
    // structure has to be asserted here, on the real DOM, rather than left to
    // the story gate. `Stepper` keeps its own decorative connector inside the
    // `li`; this does the same.
    const list = screen.getByRole('list')

    expect([...list.children].map((child) => child.tagName)).toEqual(['LI', 'LI', 'LI'])
    expect(list.querySelectorAll(':scope > li > [aria-hidden="true"]')).toHaveLength(2)
  })

  it('hides the separators from assistive technology', () => {
    render(<Breadcrumb ariaLabel="Fil d’Ariane" items={items} />)

    const nav = screen.getByRole('navigation')
    const hiddenSeparators = nav.querySelectorAll('[aria-hidden="true"]')
    expect(hiddenSeparators.length).toBeGreaterThan(0)
  })
})
