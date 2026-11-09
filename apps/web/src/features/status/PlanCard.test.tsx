import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { PlanCard } from './PlanCard'

describe('PlanCard', () => {
  it('shows the pack and capacity tier codes and the next invoice date', () => {
    render(
      <PlanCard
        packCode="visio-docs"
        capacityTierCode="M"
        nextInvoiceAt="2027-03-01T00:00:00Z"
        canSeeInvoices={true}
        onSeeInvoices={vi.fn()}
      />
    )
    expect(screen.getByText('visio-docs')).toBeInTheDocument()
    expect(screen.getByText('M')).toBeInTheDocument()
    expect(screen.getByText(/Prochaine facture : 1 mars 2027/)).toBeInTheDocument()
  })

  it('hides the invoices link for a role that cannot see invoices', () => {
    render(
      <PlanCard
        packCode="visio-docs"
        capacityTierCode="M"
        nextInvoiceAt={undefined}
        canSeeInvoices={false}
        onSeeInvoices={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: 'Voir mes factures' })).not.toBeInTheDocument()
  })

  it('calls onSeeInvoices when the link is used', async () => {
    const user = userEvent.setup()
    const onSeeInvoices = vi.fn()
    render(
      <PlanCard
        packCode="visio-docs"
        capacityTierCode="M"
        nextInvoiceAt={undefined}
        canSeeInvoices={true}
        onSeeInvoices={onSeeInvoices}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Voir mes factures' }))
    expect(onSeeInvoices).toHaveBeenCalled()
  })
})
