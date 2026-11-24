// Volet A — Community Workspace Boosts & Samourai Coop Hosting Credits panel.
// Web/Desktop Checkout only (0% mobile store commission), Linear Dark Precision tokens,
// zero inline style attributes, and strict Art. L221-28 B2C withdrawal waiver gating.

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatMoney, formatPercent } from '../../i18n/format'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody, CardHeader } from '../../ui/Card/Card'
import { Checkbox } from '../../ui/Checkbox/Checkbox'
import { cx } from '../../ui/cx'
import { DefinitionList } from '../../ui/DefinitionList/DefinitionList'
import { StatusPill } from '../../ui/StatusPill/StatusPill'
import { resolveBillingLocale } from './billingMessages'
import {
  boostVipCopy,
  computeCommunityVatQuote,
  SUPPORTED_BILLING_COUNTRIES,
  type CustomerKind,
} from './boostVipMessages'

export interface BoostPackOption {
  code: string
  name: string
  netMinor: number
  creditMinor: number
  seatsDelta: number
  storageGib: number
}

export interface ActiveHostingCreditEntry {
  id: string
  packName: string
  invoiceNumber: string
  creditNoteNumber?: string | undefined
  grantedMinor: number
  consumedMinor: number
  refundedMinor: number
  remainingMinor: number
  state: 'active' | 'depleted' | 'expired' | 'revoked'
}

export interface BoostCheckoutIntent {
  packCode: string
  customerKind: CustomerKind
  country: string
  netMinor: number
  vatRateBp: number
  vatMinor: number
  grossMinor: number
  withdrawalWaiverAccepted: boolean
  withdrawalWaiverAt: string | null
  withdrawalWaiverStatement: string | null
}

export interface WorkspaceBoostPanelProps {
  packs?: readonly BoostPackOption[] | undefined
  activeCredits?: readonly ActiveHostingCreditEntry[] | undefined
  defaultCountry?: string | undefined
  defaultCustomerKind?: CustomerKind | undefined
  onStartBoostCheckout?: ((intent: BoostCheckoutIntent) => void) | undefined
}

export const DEFAULT_BOOST_PACKS: readonly BoostPackOption[] = [
  {
    code: 'boost-starter',
    name: 'Starter Boost',
    netMinor: 990,
    creditMinor: 1000,
    seatsDelta: 10,
    storageGib: 10,
  },
  {
    code: 'boost-community',
    name: 'Guild Boost',
    netMinor: 2900,
    creditMinor: 3000,
    seatsDelta: 35,
    storageGib: 50,
  },
  {
    code: 'boost-sovereign',
    name: 'Sovereign Boost',
    netMinor: 7900,
    creditMinor: 8500,
    seatsDelta: 100,
    storageGib: 200,
  },
]

export function WorkspaceBoostPanel({
  packs = DEFAULT_BOOST_PACKS,
  activeCredits = [],
  defaultCountry = 'FR',
  defaultCustomerKind = 'b2c',
  onStartBoostCheckout,
}: WorkspaceBoostPanelProps) {
  const { i18n } = useTranslation()
  const locale = resolveBillingLocale(i18n.resolvedLanguage)
  const copy = boostVipCopy(i18n.resolvedLanguage)
  const kindSelectId = useId()
  const countrySelectId = useId()

  const firstPack = packs[0] ?? DEFAULT_BOOST_PACKS[0]!
  const [selectedPackCode, setSelectedPackCode] = useState<string>(firstPack.code)
  const [customerKind, setCustomerKind] = useState<CustomerKind>(defaultCustomerKind)
  const [country, setCountry] = useState<string>(defaultCountry.toUpperCase())
  const [waiverAccepted, setWaiverAccepted] = useState<boolean>(false)
  const [waiverTimestamp, setWaiverTimestamp] = useState<string | null>(null)
  const [showWaiverError, setShowWaiverError] = useState<boolean>(false)

  const selectedPack = packs.find((item) => item.code === selectedPackCode) ?? firstPack
  const quote = computeCommunityVatQuote({
    netMinor: selectedPack.netMinor,
    country,
    customerKind,
  })
  const requiresWaiver = customerKind === 'b2c'
  const canCheckout = !requiresWaiver || (waiverAccepted && waiverTimestamp !== null)

  function handleWaiverToggle(checked: boolean | 'indeterminate') {
    const next = checked === true
    setWaiverAccepted(next)
    setWaiverTimestamp(next ? new Date().toISOString() : null)
    if (next) {
      setShowWaiverError(false)
    }
  }

  function handleCheckout() {
    if (requiresWaiver && (!waiverAccepted || waiverTimestamp === null)) {
      setShowWaiverError(true)
      return
    }
    onStartBoostCheckout?.({
      packCode: selectedPack.code,
      customerKind,
      country,
      netMinor: quote.netMinor,
      vatRateBp: quote.vatRateBp,
      vatMinor: quote.vatMinor,
      grossMinor: quote.grossMinor,
      withdrawalWaiverAccepted: requiresWaiver ? waiverAccepted : false,
      withdrawalWaiverAt: requiresWaiver ? waiverTimestamp : null,
      withdrawalWaiverStatement: requiresWaiver ? copy.waiverLabel : null,
    })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <h3 className="text-md font-semibold text-c-ink">{copy.voletATitle}</h3>
            <p className="text-xs text-c-ink-3">{copy.voletASubtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill state="info">{copy.facturxAuthorityBadge}</StatusPill>
            <StatusPill state="neutral">{copy.webCheckoutBadge}</StatusPill>
          </div>
        </div>
      </CardHeader>

      <CardBody className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-semibold text-c-ink-3">{copy.packSelectLabel}</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {packs.map((pack) => {
              const isSelected = pack.code === selectedPack.code
              return (
                <button
                  key={pack.code}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => setSelectedPackCode(pack.code)}
                  className={cx(
                    'flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors',
                    isSelected
                      ? 'border-c-accent-ink bg-c-accent-soft text-c-ink'
                      : 'border-c-border bg-c-sunken text-c-ink hover:bg-c-muted'
                  )}
                >
                  <span className="text-sm font-semibold">{pack.name}</span>
                  <span className="font-mono text-sm tabular-nums text-c-ink-2">
                    {formatMoney({ amount_minor: pack.netMinor, currency: 'EUR' }, locale)} HT
                  </span>
                  <span className="text-xs text-c-ink-3">
                    {copy.boostBenefits(pack.seatsDelta, pack.storageGib)}
                  </span>
                  <span className="text-xs font-medium text-c-accent-ink">
                    {copy.hostingCreditIncluded}:{' '}
                    {formatMoney({ amount_minor: pack.creditMinor, currency: 'EUR' }, locale)}
                  </span>
                </button>
              )
            })}
          </div>
        </fieldset>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={kindSelectId} className="text-xs font-semibold text-c-ink-3">
              {copy.customerKindLabel}
            </label>
            <select
              id={kindSelectId}
              value={customerKind}
              onChange={(e) => {
                setCustomerKind(e.target.value as CustomerKind)
                setShowWaiverError(false)
              }}
              className="rounded-md border border-c-border-input bg-c-surface p-2 text-sm text-c-ink"
            >
              <option value="b2c">{copy.customerKinds.b2c}</option>
              <option value="b2b">{copy.customerKinds.b2b}</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={countrySelectId} className="text-xs font-semibold text-c-ink-3">
              {copy.countryLabel}
            </label>
            <select
              id={countrySelectId}
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="rounded-md border border-c-border-input bg-c-surface p-2 text-sm text-c-ink"
            >
              {SUPPORTED_BILLING_COUNTRIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-col gap-2 rounded-md border border-c-border-soft bg-c-sunken p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-c-ink-3">{copy.quoteBreakdownTitle}</span>
            <StatusPill state="neutral">{copy.regimeLabels[quote.regimeCode]}</StatusPill>
          </div>
          <DefinitionList
            items={[
              {
                term: copy.netExclVat,
                description: (
                  <span className="font-mono tabular-nums">
                    {formatMoney({ amount_minor: quote.netMinor, currency: 'EUR' }, locale)}
                  </span>
                ),
              },
              {
                term: copy.vatLine(formatPercent(quote.vatRateBp / 100, locale)),
                description: (
                  <span className="font-mono tabular-nums">
                    {formatMoney({ amount_minor: quote.vatMinor, currency: 'EUR' }, locale)}
                  </span>
                ),
              },
              {
                term: copy.totalInclVat,
                description: (
                  <span className="font-mono font-semibold tabular-nums text-c-ink">
                    {formatMoney({ amount_minor: quote.grossMinor, currency: 'EUR' }, locale)}
                  </span>
                ),
              },
            ]}
          />
          {quote.legalMention ? (
            <p className="text-xs text-c-ink-3">{quote.legalMention}</p>
          ) : null}
        </div>

        {requiresWaiver ? (
          <Checkbox
            checked={waiverAccepted}
            onCheckedChange={handleWaiverToggle}
            label={copy.waiverLabel}
            help={copy.waiverHelp}
            {...(showWaiverError ? { error: copy.waiverError } : {})}
          />
        ) : null}

        <div className="flex justify-end">
          <Button disabled={!canCheckout} onClick={handleCheckout}>
            {copy.boostCheckoutCta}
          </Button>
        </div>

        <div className="flex flex-col gap-2 border-t border-c-border-soft pt-3">
          <h4 className="text-xs font-semibold text-c-ink-3">{copy.activeLedgerTitle}</h4>
          {activeCredits.length === 0 ? (
            <p className="text-xs text-c-ink-3">{copy.emptyLedger}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {activeCredits.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-c-border-soft bg-c-sunken p-3 text-xs"
                >
                  <div className="flex flex-col gap-1">
                    <span className="font-semibold text-c-ink">{entry.packName}</span>
                    <span className="font-mono text-c-ink-3">
                      380: {entry.invoiceNumber}
                      {entry.creditNoteNumber ? ` · 381: ${entry.creditNoteNumber}` : ''}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 font-mono tabular-nums">
                    <span className="text-c-ink">
                      {copy.creditRemaining}:{' '}
                      {formatMoney({ amount_minor: entry.remainingMinor, currency: 'EUR' }, locale)}
                    </span>
                    <span className="text-c-ink-3">
                      {copy.creditConsumed}:{' '}
                      {formatMoney({ amount_minor: entry.consumedMinor, currency: 'EUR' }, locale)}
                    </span>
                    {entry.refundedMinor > 0 ? (
                      <span className="text-c-warn-ink">
                        {copy.creditRefunded}:{' '}
                        {formatMoney(
                          { amount_minor: entry.refundedMinor, currency: 'EUR' },
                          locale
                        )}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
