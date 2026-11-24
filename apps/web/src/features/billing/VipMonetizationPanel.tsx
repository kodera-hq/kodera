// Volet B — Paid VIP Servers & Channels via Stripe Connect + Annual DAC7 Summary panel.
// Web/Desktop Checkout only (0% mobile store commission), Linear Dark Precision tokens,
// zero inline style attributes, and strict Art. L221-28 B2C withdrawal waiver gating.

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatMoney, formatPercent } from '../../i18n/format'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody, CardHeader } from '../../ui/Card/Card'
import { Checkbox } from '../../ui/Checkbox/Checkbox'
import { DefinitionList } from '../../ui/DefinitionList/DefinitionList'
import { StatusPill, type StatusPillState } from '../../ui/StatusPill/StatusPill'
import { resolveBillingLocale } from './billingMessages'
import {
  boostVipCopy,
  computeCommunityVatQuote,
  evaluateDac7Status,
  SUPPORTED_BILLING_COUNTRIES,
} from './boostVipMessages'

export type ConnectOnboardingState =
  | 'intent_recorded'
  | 'account_created'
  | 'onboarding_link_issued'
  | 'restricted'
  | 'active'
  | 'outcome_unknown'
  | 'disabled'

export interface Dac7QuarterView {
  quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4'
  transactionCount: number
  netConsiderationMinor: number
}

export interface Dac7CreatorSummaryView {
  reportingYear: number
  transactionCount: number
  netConsiderationMinor: number
  platformFeesMinor: number
  taxesWithheldMinor: number
  tinSealed: boolean
  quarters?: readonly Dac7QuarterView[] | undefined
}

export interface VipTierConfigDraft {
  name: string
  priceExclVatMinor: number
  grantedRoleName: string
  gatedChannels: readonly string[]
}

export interface VipPassCheckoutIntent {
  tierName: string
  buyerCountry: string
  grossExclVatMinor: number
  vatRateBp: number
  vatMinor: number
  totalInclVatMinor: number
  applicationFeeMinor: number
  creatorNetMinor: number
  withdrawalWaiverAccepted: boolean
  withdrawalWaiverAt: string
  withdrawalWaiverStatement: string
}

export interface VipMonetizationPanelProps {
  connectState?: ConnectOnboardingState | undefined
  stripeConnectAccountId?: string | null | undefined
  platformFeeBps?: number | undefined
  negativeBalanceMinor?: number | undefined
  initialTier?: VipTierConfigDraft | undefined
  dac7Summary?: Dac7CreatorSummaryView | undefined
  defaultBuyerCountry?: string | undefined
  onResumeConnectOnboarding?: (() => void) | undefined
  onSaveVipTier?: ((tier: VipTierConfigDraft) => void) | undefined
  onStartVipCheckout?: ((intent: VipPassCheckoutIntent) => void) | undefined
  onDownloadDac7Report?: ((format: 'json' | 'xml') => void) | undefined
}

const DEFAULT_TIER: VipTierConfigDraft = {
  name: 'VIP Backstage Pass',
  priceExclVatMinor: 1000,
  grantedRoleName: 'vip-member',
  gatedChannels: ['vip-lounge', 'vip-stage-audio'],
}

const DEFAULT_DAC7: Dac7CreatorSummaryView = {
  reportingYear: 2026,
  transactionCount: 0,
  netConsiderationMinor: 0,
  platformFeesMinor: 0,
  taxesWithheldMinor: 0,
  tinSealed: false,
}

export function VipMonetizationPanel({
  connectState = 'intent_recorded',
  stripeConnectAccountId = null,
  platformFeeBps = 1000,
  negativeBalanceMinor = 0,
  initialTier = DEFAULT_TIER,
  dac7Summary = DEFAULT_DAC7,
  defaultBuyerCountry = 'FR',
  onResumeConnectOnboarding,
  onSaveVipTier,
  onStartVipCheckout,
  onDownloadDac7Report,
}: VipMonetizationPanelProps) {
  const { i18n } = useTranslation()
  const locale = resolveBillingLocale(i18n.resolvedLanguage)
  const copy = boostVipCopy(i18n.resolvedLanguage)

  const tierNameId = useId()
  const tierPriceId = useId()
  const buyerCountryId = useId()

  const [tierName, setTierName] = useState<string>(initialTier.name)
  const [tierPriceMinor, setTierPriceMinor] = useState<number>(initialTier.priceExclVatMinor)
  const [buyerCountry, setBuyerCountry] = useState<string>(defaultBuyerCountry.toUpperCase())
  const [waiverAccepted, setWaiverAccepted] = useState<boolean>(false)
  const [waiverAt, setWaiverAt] = useState<string | null>(null)

  const validNetMinor = Math.max(100, Math.trunc(tierPriceMinor) || 100)
  const quote = computeCommunityVatQuote({
    netMinor: validNetMinor,
    country: buyerCountry,
    customerKind: 'b2c',
  })
  const platformFeeMinor = Math.floor((quote.netMinor * platformFeeBps) / 10_000)
  const creatorNetMinor = quote.netMinor - platformFeeMinor

  const dac7Eval = evaluateDac7Status({
    transactionCount: dac7Summary.transactionCount,
    netConsiderationMinor: dac7Summary.netConsiderationMinor,
  })

  const connectPillState: StatusPillState =
    connectState === 'active'
      ? 'success'
      : connectState === 'restricted' || connectState === 'outcome_unknown'
        ? 'warning'
        : 'neutral'

  const canAcceptCharges = connectState === 'active'
  const canCheckout = canAcceptCharges && waiverAccepted && waiverAt !== null

  function handleWaiverChange(checked: boolean | 'indeterminate') {
    const next = checked === true
    setWaiverAccepted(next)
    setWaiverAt(next ? new Date().toISOString() : null)
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <h3 className="text-md font-semibold text-c-ink">{copy.voletBTitle}</h3>
            <p className="text-xs text-c-ink-3">{copy.voletBSubtitle}</p>
          </div>
          <StatusPill state="neutral">{copy.webCheckoutBadge}</StatusPill>
        </div>
      </CardHeader>

      <CardBody className="flex flex-col gap-4">
        <section
          aria-label={copy.connectStatusLabel}
          className="flex flex-col gap-2 rounded-md border border-c-border-soft bg-c-sunken p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-c-ink-3">{copy.connectStatusLabel}</span>
              {stripeConnectAccountId ? (
                <span className="font-mono text-xs text-c-ink-2">{stripeConnectAccountId}</span>
              ) : null}
            </div>
            <StatusPill state={connectPillState}>{copy.connectStates[connectState]}</StatusPill>
          </div>

          {connectState === 'outcome_unknown' ? (
            <p className="rounded-md border border-c-border bg-c-warn-soft p-2 text-xs text-c-warn-ink">
              {copy.connectOutcomeUnknownWarning}
            </p>
          ) : null}

          {negativeBalanceMinor > 0 ? (
            <p className="rounded-md border border-c-border bg-c-bad-soft p-2 font-mono text-xs text-c-bad-ink">
              {copy.negativeBalanceWarning(
                formatMoney({ amount_minor: negativeBalanceMinor, currency: 'EUR' }, locale)
              )}
            </p>
          ) : null}

          {connectState !== 'active' ? (
            <div className="flex justify-end">
              <Button
                variant="secondary"
                disabled={connectState === 'outcome_unknown' || connectState === 'disabled'}
                onClick={() => onResumeConnectOnboarding?.()}
              >
                {copy.connectResumeCta}
              </Button>
            </div>
          ) : null}
        </section>

        <section
          aria-label={copy.tierConfigTitle}
          className="flex flex-col gap-3 rounded-md border border-c-border-soft bg-c-sunken p-3"
        >
          <h4 className="text-xs font-semibold text-c-ink-3">{copy.tierConfigTitle}</h4>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor={tierNameId} className="text-xs font-medium text-c-ink-2">
                {copy.tierNameLabel}
              </label>
              <input
                id={tierNameId}
                type="text"
                value={tierName}
                onChange={(e) => setTierName(e.target.value)}
                className="rounded-md border border-c-border-input bg-c-surface p-2 text-sm text-c-ink"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={tierPriceId} className="text-xs font-medium text-c-ink-2">
                {copy.tierPriceLabel}
              </label>
              <input
                id={tierPriceId}
                type="number"
                min={100}
                step={50}
                value={tierPriceMinor}
                onChange={(e) => setTierPriceMinor(Number(e.target.value))}
                className="rounded-md border border-c-border-input bg-c-surface p-2 font-mono text-sm text-c-ink"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-c-ink-3">
            <span>
              {copy.tierRoleLabel}: <strong className="font-mono text-c-ink">{initialTier.grantedRoleName}</strong>
            </span>
            <span>
              {copy.tierChannelsLabel}:{' '}
              <strong className="font-mono text-c-ink">{initialTier.gatedChannels.join(', ')}</strong>
            </span>
          </div>

          <div className="flex justify-end">
            <Button
              variant="secondary"
              disabled={!canAcceptCharges || tierName.trim().length === 0}
              onClick={() =>
                onSaveVipTier?.({
                  name: tierName.trim(),
                  priceExclVatMinor: validNetMinor,
                  grantedRoleName: initialTier.grantedRoleName,
                  gatedChannels: initialTier.gatedChannels,
                })
              }
            >
              {copy.saveTierCta}
            </Button>
          </div>
        </section>

        <section
          aria-label={copy.memberPassTitle}
          className="flex flex-col gap-3 rounded-md border border-c-border-soft bg-c-sunken p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-semibold text-c-ink-3">{copy.memberPassTitle}</h4>
            <StatusPill state="neutral">{copy.regimeLabels[quote.regimeCode]}</StatusPill>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={buyerCountryId} className="text-xs font-medium text-c-ink-2">
              {copy.countryLabel}
            </label>
            <select
              id={buyerCountryId}
              value={buyerCountry}
              onChange={(e) => setBuyerCountry(e.target.value)}
              className="rounded-md border border-c-border-input bg-c-surface p-2 text-sm text-c-ink"
            >
              {SUPPORTED_BILLING_COUNTRIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
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
              {
                term: `${copy.platformFeeLabel} (${formatPercent(platformFeeBps / 100, locale)})`,
                description: (
                  <span className="font-mono tabular-nums text-c-ink-2">
                    {formatMoney({ amount_minor: platformFeeMinor, currency: 'EUR' }, locale)}
                  </span>
                ),
              },
              {
                term: copy.creatorNetLabel,
                description: (
                  <span className="font-mono font-medium tabular-nums text-c-ok-ink">
                    {formatMoney({ amount_minor: creatorNetMinor, currency: 'EUR' }, locale)}
                  </span>
                ),
              },
            ]}
          />

          {quote.legalMention ? (
            <p className="text-xs text-c-ink-3">{quote.legalMention}</p>
          ) : null}

          <Checkbox
            checked={waiverAccepted}
            onCheckedChange={handleWaiverChange}
            label={copy.waiverLabel}
            help={copy.waiverHelp}
          />

          <div className="flex justify-end">
            <Button
              disabled={!canCheckout}
              onClick={() => {
                if (!waiverAccepted || waiverAt === null) return
                onStartVipCheckout?.({
                  tierName: tierName.trim() || initialTier.name,
                  buyerCountry,
                  grossExclVatMinor: quote.netMinor,
                  vatRateBp: quote.vatRateBp,
                  vatMinor: quote.vatMinor,
                  totalInclVatMinor: quote.grossMinor,
                  applicationFeeMinor: platformFeeMinor,
                  creatorNetMinor,
                  withdrawalWaiverAccepted: true,
                  withdrawalWaiverAt: waiverAt,
                  withdrawalWaiverStatement: copy.waiverLabel,
                })
              }}
            >
              {copy.vipCheckoutCta}
            </Button>
          </div>
        </section>

        <section
          aria-label={copy.dac7Title}
          className="flex flex-col gap-3 border-t border-c-border-soft pt-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-col gap-1">
              <h4 className="text-xs font-semibold text-c-ink">
                {copy.dac7Title} · {dac7Summary.reportingYear}
              </h4>
              <p className="text-xs text-c-ink-3">{copy.dac7Subtitle}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill state={dac7Summary.tinSealed ? 'success' : 'warning'}>
                {dac7Summary.tinSealed ? copy.dac7TinSealedBadge : copy.dac7TinMissingBadge}
              </StatusPill>
              <StatusPill state={dac7Eval.reportable ? 'info' : 'neutral'}>
                {dac7Eval.reportable ? copy.dac7ReportableBadge : copy.dac7BelowThresholdBadge}
              </StatusPill>
            </div>
          </div>

          <DefinitionList
            items={[
              {
                term: copy.dac7TransactionsLabel,
                description: (
                  <span className="font-mono tabular-nums">{dac7Summary.transactionCount} / 30</span>
                ),
              },
              {
                term: copy.dac7ConsiderationLabel,
                description: (
                  <span className="font-mono tabular-nums">
                    {formatMoney(
                      { amount_minor: dac7Summary.netConsiderationMinor, currency: 'EUR' },
                      locale
                    )}
                  </span>
                ),
              },
              {
                term: copy.dac7FeesLabel,
                description: (
                  <span className="font-mono tabular-nums">
                    {formatMoney(
                      { amount_minor: dac7Summary.platformFeesMinor, currency: 'EUR' },
                      locale
                    )}
                  </span>
                ),
              },
              {
                term: copy.dac7TaxesLabel,
                description: (
                  <span className="font-mono tabular-nums">
                    {formatMoney(
                      { amount_minor: dac7Summary.taxesWithheldMinor, currency: 'EUR' },
                      locale
                    )}
                  </span>
                ),
              },
            ]}
          />

          {dac7Summary.quarters && dac7Summary.quarters.length > 0 ? (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {dac7Summary.quarters.map((q) => (
                <li
                  key={q.quarter}
                  className="rounded-md border border-c-border-soft bg-c-sunken p-2 font-mono text-xs tabular-nums text-c-ink-2"
                >
                  <span className="font-semibold text-c-ink">{q.quarter}</span> · {q.transactionCount} tx ·{' '}
                  {formatMoney(
                    { amount_minor: q.netConsiderationMinor, currency: 'EUR' },
                    locale
                  )}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => onDownloadDac7Report?.('json')}>
              {copy.dac7DownloadJsonCta}
            </Button>
            <Button variant="secondary" onClick={() => onDownloadDac7Report?.('xml')}>
              {copy.dac7DownloadXmlCta}
            </Button>
          </div>
        </section>
      </CardBody>
    </Card>
  )
}
