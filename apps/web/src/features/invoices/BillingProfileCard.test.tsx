import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { BillingProfileCard } from './BillingProfileCard'
import type { BillingProfile } from './billingProfile'

const fixture = vi.hoisted(() => ({
  data: undefined as BillingProfile | undefined,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}))
vi.mock('./queries', () => ({ useBillingProfileQuery: () => fixture }))
beforeEach(() => {
  fixture.data = undefined
  fixture.isLoading = false
  fixture.isError = false
  fixture.refetch.mockReset()
})

describe('Billing profile card', () => {
  it('announces loading without pretending the address is missing', () => {
    fixture.isLoading = true
    render(<BillingProfileCard organisationId="org-1" />)
    expect(screen.getByLabelText('Chargement de l’adresse de facturation')).toBeInTheDocument()
    expect(screen.queryByText('Adresse de facturation non renseignée.')).toBeNull()
  })
  it('shows an explicit empty state when Core serves no address', () => {
    fixture.data = { name: 'ACME SAS', address: null }
    render(<BillingProfileCard organisationId="org-1" />)
    expect(screen.getByText('ACME SAS')).toBeVisible()
    expect(screen.getByText('Adresse de facturation non renseignée.')).toBeVisible()
  })
  it('renders served address lines without an inert edit control', () => {
    fixture.data = {
      name: 'ACME SAS',
      address: {
        line1: '12 rue de la Paix',
        line2: 'Étage 2',
        postal_code: '75002',
        city: 'Paris',
        country: 'FR',
      },
    }
    render(<BillingProfileCard organisationId="org-1" />)
    for (const line of ['ACME SAS', '12 rue de la Paix', 'Étage 2', '75002 Paris', 'FR'])
      expect(screen.getByText(line)).toBeVisible()
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('hides cached profile details on failure and retries only the profile', async () => {
    fixture.data = { name: 'Old profile', address: null }
    fixture.isError = true
    render(<BillingProfileCard organisationId="org-1" />)
    expect(screen.queryByText('Old profile')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(fixture.refetch).toHaveBeenCalledOnce()
  })
})
