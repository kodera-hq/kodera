import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { OrgSwitcher } from './OrgSwitcher'

describe('OrgSwitcher', () => {
  it('shows the organisation name and slug as static text with one membership', () => {
    render(<OrgSwitcher organisation={{ name: 'ACME SAS', slug: 'acme-sa' }} />)
    expect(screen.getByText('ACME SAS')).toBeInTheDocument()
    expect(screen.getByText('acme-sa')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('still renders as static text when memberships carries exactly one entry (§4.6)', () => {
    render(
      <OrgSwitcher
        organisation={{ name: 'ACME SAS', slug: 'acme-sa' }}
        memberships={[{ slug: 'acme-sa', name: 'ACME SAS', current: true }]}
      />
    )
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  // The tenant's own mark, beside the tenant's own name — the split this
  // change is about: the MAKER's mark is in the module rail, constant for
  // every customer, and the CUSTOMER's is here, where it changes per tenant.
  it('renders no organisation mark when none is given — which is every real build', () => {
    render(<OrgSwitcher organisation={{ name: 'ACME SAS', slug: 'acme-sa' }} />)
    // No field of the Core contract carries one (`src/app/demoBranding.ts`),
    // so an organisation with no mark must render cleanly rather than leave a
    // broken image behind.
    expect(document.querySelector('img')).toBeNull()
  })

  it('draws the organisation mark beside the name, unnamed so the name is read once', () => {
    render(
      <OrgSwitcher
        organisation={{ name: 'Groupe Vercelli', slug: 'vercelli' }}
        mark="data:image/svg+xml,demo"
      />
    )
    const mark = document.querySelector('img')
    expect(mark).toHaveAttribute('src', 'data:image/svg+xml,demo')
    expect(mark).toHaveAttribute('alt', '')
    expect(screen.getByText('Groupe Vercelli')).toBeInTheDocument()
    // Decorative, so it adds no second announcement of the organisation.
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('keeps the mark beside the current organisation in the menu case too', () => {
    render(
      <OrgSwitcher
        organisation={{ name: 'Groupe Vercelli', slug: 'vercelli' }}
        memberships={[
          { slug: 'vercelli', name: 'Groupe Vercelli', current: true },
          { slug: 'vercelli-nord', name: 'Vercelli Nord', current: false },
        ]}
        mark="data:image/svg+xml,demo"
      />
    )
    expect(document.querySelector('img')).toHaveAttribute('src', 'data:image/svg+xml,demo')
  })

  it('renders a searchable menu with two or more memberships', async () => {
    const user = userEvent.setup()
    render(
      <OrgSwitcher
        organisation={{ name: 'ACME Construction', slug: 'acme-sa' }}
        memberships={[
          { slug: 'acme-sa', name: 'ACME Construction', current: true },
          { slug: 'acme-holding', name: 'ACME Holding', current: false },
        ]}
      />
    )

    const combobox = screen.getByRole('combobox', { name: 'Organisation' })
    await user.click(combobox)

    expect(await screen.findAllByRole('option')).toHaveLength(2)
  })

  it('names the current organisation in its own option, not by colour alone', async () => {
    const user = userEvent.setup()
    render(
      <OrgSwitcher
        organisation={{ name: 'ACME Construction', slug: 'acme-sa' }}
        memberships={[
          { slug: 'acme-sa', name: 'ACME Construction', current: true },
          { slug: 'acme-holding', name: 'ACME Holding', current: false },
        ]}
      />
    )

    await user.click(screen.getByRole('combobox', { name: 'Organisation' }))
    const options = await screen.findAllByRole('option')
    expect(options[0]).toHaveTextContent('Organisation actuelle')
    expect(options[1]).not.toHaveTextContent('Organisation actuelle')
  })

  it('calls onSwitch with the chosen slug when a different organisation is picked', async () => {
    const user = userEvent.setup()
    const onSwitch = vi.fn()
    render(
      <OrgSwitcher
        organisation={{ name: 'ACME Construction', slug: 'acme-sa' }}
        memberships={[
          { slug: 'acme-sa', name: 'ACME Construction', current: true },
          { slug: 'acme-holding', name: 'ACME Holding', current: false },
        ]}
        onSwitch={onSwitch}
      />
    )

    await user.click(screen.getByRole('combobox', { name: 'Organisation' }))
    const options = await screen.findAllByRole('option')
    await user.click(options[1]!)

    expect(onSwitch).toHaveBeenCalledWith('acme-holding')
  })

  it('does not call onSwitch when the current organisation is re-selected', async () => {
    const user = userEvent.setup()
    const onSwitch = vi.fn()
    render(
      <OrgSwitcher
        organisation={{ name: 'ACME Construction', slug: 'acme-sa' }}
        memberships={[
          { slug: 'acme-sa', name: 'ACME Construction', current: true },
          { slug: 'acme-holding', name: 'ACME Holding', current: false },
        ]}
        onSwitch={onSwitch}
      />
    )

    await user.click(screen.getByRole('combobox', { name: 'Organisation' }))
    const options = await screen.findAllByRole('option')
    await user.click(options[0]!)

    expect(onSwitch).not.toHaveBeenCalled()
  })
})
