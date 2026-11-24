import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { VipMonetizationPanel, type VipPassCheckoutIntent } from './VipMonetizationPanel'

afterEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('fr')
  })
})

describe('VipMonetizationPanel (Volet B — Stripe Connect & DAC7)', () => {
  it('blocks blind onboarding retries when Connect outcome is unknown and surfaces creator negative balance', () => {
    const { container } = render(
      <VipMonetizationPanel
        connectState="outcome_unknown"
        negativeBalanceMinor={2400}
      />
    )

    expect(container.querySelector('[style]')).toBeNull()
    expect(screen.getByText(/Aucune relance aveugle/)).toBeInTheDocument()
    expect(screen.getByText(/Solde négatif créateur/)).toBeInTheDocument()

    const resumeBtn = screen.getByRole('button', {
      name: /Poursuivre l’onboarding Stripe Connect/,
    })
    expect(resumeBtn).toBeDisabled()
  })

  it('computes Connect fee split, gates B2C VIP pass checkout on 14-day waiver, and flags DAC7 thresholds', async () => {
    const user = userEvent.setup()
    const onVipCheckout = vi.fn<(intent: VipPassCheckoutIntent) => void>()
    const onDownloadDac7 = vi.fn<(format: 'json' | 'xml') => void>()

    render(
      <VipMonetizationPanel
        connectState="active"
        stripeConnectAccountId="acct_creator01"
        platformFeeBps={1000}
        defaultBuyerCountry="DE"
        dac7Summary={{
          reportingYear: 2026,
          transactionCount: 30,
          netConsiderationMinor: 215_000,
          platformFeesMinor: 21_500,
          taxesWithheldMinor: 40_850,
          tinSealed: true,
          quarters: [
            { quarter: 'Q1', transactionCount: 8, netConsiderationMinor: 50_000 },
            { quarter: 'Q2', transactionCount: 7, netConsiderationMinor: 50_000 },
            { quarter: 'Q3', transactionCount: 7, netConsiderationMinor: 55_000 },
            { quarter: 'Q4', transactionCount: 8, netConsiderationMinor: 60_000 },
          ],
        }}
        onStartVipCheckout={onVipCheckout}
        onDownloadDac7Report={onDownloadDac7}
      />
    )

    expect(screen.getByText('acct_creator01')).toBeInTheDocument()
    expect(screen.getByText(/Seuil DAC7 atteint · Déclarable/)).toBeInTheDocument()
    expect(screen.getByText(/NIF scellé AES-256-GCM/)).toBeInTheDocument()
    expect(screen.getByText('30 / 30')).toBeInTheDocument()

    const vipCheckoutBtn = screen.getByRole('button', {
      name: /Souscrire au Pass VIP sur le Web/,
    })
    expect(vipCheckoutBtn).toBeDisabled()

    const waiverCheckbox = screen.getByRole('checkbox', {
      name: /renonce expressément à mon droit de rétractation de 14 jours/,
    })
    await user.click(waiverCheckbox)
    expect(vipCheckoutBtn).toBeEnabled()

    await user.click(vipCheckoutBtn)
    expect(onVipCheckout).toHaveBeenCalledOnce()
    // 10.00 EUR HT -> DE 19% OSS VAT = 1.90 EUR -> 11.90 EUR TTC; 10% platform fee = 1.00 EUR; creator net = 9.00 EUR
    expect(onVipCheckout.mock.calls[0]![0]).toMatchObject({
      buyerCountry: 'DE',
      grossExclVatMinor: 1000,
      vatRateBp: 1900,
      vatMinor: 190,
      totalInclVatMinor: 1190,
      applicationFeeMinor: 100,
      creatorNetMinor: 900,
      withdrawalWaiverAccepted: true,
    })

    await user.click(screen.getByRole('button', { name: /Télécharger le rapport JSON DAC7/ }))
    await user.click(screen.getByRole('button', { name: /Télécharger le rapport XML DAC7/ }))
    expect(onDownloadDac7.mock.calls).toEqual([['json'], ['xml']])
  })
})
