import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { WorkspaceBoostPanel, type BoostCheckoutIntent } from './WorkspaceBoostPanel'

afterEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('fr')
  })
})

describe('WorkspaceBoostPanel (Volet A)', () => {
  it('enforces B2C Art. L221-28 14-day withdrawal waiver before enabling Web checkout and computes EU OSS VAT', async () => {
    const user = userEvent.setup()
    const onCheckout = vi.fn<(intent: BoostCheckoutIntent) => void>()

    const { container } = render(
      <WorkspaceBoostPanel
        defaultCountry="FI"
        defaultCustomerKind="b2c"
        activeCredits={[
          {
            id: 'cred-1',
            packName: 'Guild Boost',
            invoiceNumber: 'KODERA-2026-00042',
            creditNoteNumber: 'AV-KODERA-2026-00001',
            grantedMinor: 3000,
            consumedMinor: 400,
            refundedMinor: 1500,
            remainingMinor: 1100,
            state: 'active',
          },
        ]}
        onStartBoostCheckout={onCheckout}
      />
    )

    // Zero inline style attributes anywhere in rendered DOM
    expect(container.querySelector('[style]')).toBeNull()

    // Select Guild Boost (29.00 EUR HT -> 25.5% FI OSS VAT = 7.40 EUR -> 36.40 EUR TTC)
    await user.click(screen.getByRole('button', { name: /Guild Boost/ }))
    expect(screen.getByText(/Guichet unique UE OSS/)).toBeInTheDocument()
    expect(screen.getByText(/art\. 259 D CGI/)).toBeInTheDocument()

    const checkoutBtn = screen.getByRole('button', {
      name: /Régler et activer le Boost sur le Web/,
    })
    expect(checkoutBtn).toBeDisabled()

    // Accept mandatory B2C 14-day withdrawal waiver
    const waiverCheckbox = screen.getByRole('checkbox', {
      name: /renonce expressément à mon droit de rétractation de 14 jours/,
    })
    await user.click(waiverCheckbox)
    expect(checkoutBtn).toBeEnabled()

    await user.click(checkoutBtn)
    expect(onCheckout).toHaveBeenCalledOnce()
    const submitted = onCheckout.mock.calls[0]![0]
    expect(submitted).toMatchObject({
      packCode: 'boost-community',
      customerKind: 'b2c',
      country: 'FI',
      netMinor: 2900,
      vatRateBp: 2550,
      vatMinor: 740,
      grossMinor: 3640,
      withdrawalWaiverAccepted: true,
    })
    expect(submitted.withdrawalWaiverAt).toEqual(expect.any(String))

    // Active credit ledger displays Factur-X 380 invoice and 381 refund credit note
    expect(screen.getByText(/KODERA-2026-00042/)).toBeInTheDocument()
    expect(screen.getByText(/AV-KODERA-2026-00001/)).toBeInTheDocument()
  })

  it('switches cleanly to English and allows B2B checkout without B2C consumer waiver', async () => {
    await act(async () => {
      await i18n.changeLanguage('en')
    })
    const user = userEvent.setup()
    const onCheckout = vi.fn<(intent: BoostCheckoutIntent) => void>()

    render(
      <WorkspaceBoostPanel
        defaultCountry="CH"
        defaultCustomerKind="b2b"
        onStartBoostCheckout={onCheckout}
      />
    )

    expect(screen.getByText(/Outside European Union/)).toBeInTheDocument()
    const checkoutBtn = screen.getByRole('button', {
      name: /Checkout and activate Boost on Web/,
    })
    expect(checkoutBtn).toBeEnabled()
    await user.click(checkoutBtn)
    expect(onCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        customerKind: 'b2b',
        country: 'CH',
        vatRateBp: 0,
        vatMinor: 0,
        withdrawalWaiverAccepted: false,
      })
    )
  })
})
