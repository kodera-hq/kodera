// `plan` — 01-order.md §4.1: headcount in, a recommended tier out, the
// buyer free to override it. Each card is one capacity tier, titled by the plan
// the catalogue sells it under (the price row's `plan_code`), with that plan's
// own description. The recommendation (`recommendation.ts`) is stated as a
// sentence on screen so the buyer can check it. Price and capacity figures are
// rendered as the catalogue returns them, but for one display: a yearly total
// shown as its monthly equivalent, with the total under it (§4.1).

import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatMoney } from '../../i18n/format'
import type { MessageKey } from '../../i18n'
import { Banner } from '../../ui/Banner/Banner'
import { Button } from '../../ui/Button/Button'
import { Checkbox } from '../../ui/Checkbox/Checkbox'
import { EmptyState } from '../../ui/EmptyState/EmptyState'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import { PlanCard } from '../../ui/PlanCard/PlanCard'
import { PlanPrice } from '../../ui/PlanPrice/PlanPrice'
import { RadioGroup } from '../../ui/RadioGroup/RadioGroup'
import { Skeleton } from '../../ui/Skeleton/Skeleton'
import { SummaryPanel } from '../../ui/SummaryPanel/SummaryPanel'
import { TextField } from '../../ui/TextField/TextField'
import type { BillingPeriod, Pack } from './api'
import {
  cataloguePrice,
  planOfPrice,
  useCapacityTiersQuery,
  useOrganisationOwnerQuery,
  usePacksQuery,
  usePlansQuery,
  usePricesQuery,
} from './api'
import type { OrderDraft } from './draft'
import { headcountRangeFor, largestCoveredHeadcount, recommendTier } from './recommendation'
import { headcountSchema } from './schemas'

export type OrderRole = 'org_owner' | 'org_admin' | 'member'

export interface PlanStepProps {
  draft: OrderDraft
  update: (patch: Partial<OrderDraft>) => void
  role: OrderRole
  organisationId: string | undefined
  onContinue: () => void
  onRequestQuote: () => void
}

function docsPackOf(packs: Pack[]): Pack | undefined {
  return packs.find((pack) => pack.available && pack.apps.includes('docs'))
}

function basePackOf(packs: Pack[]): Pack | undefined {
  return packs.find((pack) => pack.available && !pack.apps.includes('docs')) ?? packs[0]
}

const DEBOUNCE_MS = 600

/**
 * The cards' grid, by the column's own width (a container query), never the viewport's. Four
 * tiers go two by two, then four across once each card holds its widest unbreakable line (a
 * four-digit amount in `PlanPrice`, about 110 px at a 16 px root) plus 44 px of padding and
 * border: 45rem; three go three across. One card per row below 30rem.
 * `order-plan-card-fit.spec.ts` measures it, at the width where four first stand across.
 */
function gridColumns(count: number): string {
  // In rem, so the thresholds grow with the reader's default font size as the text does.
  return count === 4
    ? '[@container(min-width:30rem)]:grid-cols-2 [@container(min-width:45rem)]:grid-cols-4'
    : '[@container(min-width:30rem)]:grid-cols-3'
}

export function PlanStep({
  draft,
  update,
  role,
  organisationId,
  onContinue,
  onRequestQuote,
}: PlanStepProps) {
  const { t } = useTranslation()
  const legendId = useId()

  const packsQuery = usePacksQuery()
  const tiersQuery = useCapacityTiersQuery()
  const plansQuery = usePlansQuery()
  const packs = packsQuery.data ?? []
  const plans = plansQuery.data ?? []
  const tiers = useMemo(
    () =>
      [...(tiersQuery.data ?? [])]
        .filter((tier) => tier.available)
        .sort((a, b) => a.concurrent_participants_included - b.concurrent_participants_included),
    [tiersQuery.data]
  )

  const basePack = basePackOf(packs)
  const docsPack = docsPackOf(packs)
  // Both packs' prices, both periods: a card may be drawn from either pack (a plan that
  // includes Docs is sold under the Docs pack), and ticking Docs then draws from the cache.
  const priceReads = [
    usePricesQuery(basePack?.code, 'yearly'),
    usePricesQuery(basePack?.code, 'monthly'),
    usePricesQuery(docsPack?.code, 'yearly'),
    usePricesQuery(docsPack?.code, 'monthly'),
  ]
  const prices = priceReads.flatMap((read) => read.data ?? [])
  const packOfRead = (index: number) => (index < 2 ? basePack : docsPack)
  // Every read a pack needs has answered. Until then nothing is concluded from a missing row:
  // a row not there yet, or a read that failed, is not a tier the catalogue does not sell.
  const pricesSettled = priceReads.every(
    (read, index) => packOfRead(index) === undefined || read.isSuccess
  )
  // A read with nothing to show: a background refetch that fails over cached rows keeps them.
  const pricesFailed = priceReads.some(
    (read, index) => packOfRead(index) !== undefined && read.isError && read.data === undefined
  )
  const priceOf = (pack: Pack | undefined, tierCode: string, period: BillingPeriod) =>
    cataloguePrice(prices, pack?.code, tierCode, period)

  /**
   * Docs comes with this tier's plan at no extra cost: the catalogue sells the tier with Docs,
   * and either not without it (Business Plus once Docs ships) or at the same price (Enterprise).
   * The paid Docs option is then not offered for it, and the order takes the Docs pack.
   */
  const includesDocs = (tierCode: string): boolean => {
    if (docsPack === undefined || !pricesSettled) return false
    return (['yearly', 'monthly'] as const).some((period) => {
      const withDocs = priceOf(docsPack, tierCode, period)
      if (withDocs === undefined) return false
      const without = priceOf(basePack, tierCode, period)
      return (
        without === undefined ||
        (without.amount_excl_vat.amount_minor === withDocs.amount_excl_vat.amount_minor &&
          without.amount_excl_vat.currency === withDocs.amount_excl_vat.currency)
      )
    })
  }

  const chosenIncludesDocs =
    draft.capacityTierCode !== undefined && includesDocs(draft.capacityTierCode)
  // The paid option, as the person left it: the Docs pack chosen for a plan that does not
  // include it.
  const docsAddon =
    docsPack !== undefined && draft.packCode === docsPack.code && !chosenIncludesDocs

  /** The pack a tier's card is priced from: the Docs pack when Docs is ticked or included. */
  const packFor = (tierCode: string) =>
    (docsAddon || includesDocs(tierCode)) && docsPack !== undefined ? docsPack : basePack

  /** The row a tier's card shows: the chosen period's, or the other period's when the catalogue
   * sells the tier in that one only (Enterprise is yearly only). */
  const shownPrice = (tierCode: string) => {
    const pack = packFor(tierCode)
    const other = draft.billingPeriod === 'yearly' ? 'monthly' : 'yearly'
    return priceOf(pack, tierCode, draft.billingPeriod) ?? priceOf(pack, tierCode, other)
  }

  /** A tier the catalogue sells in one period only, the period it is sold in; else undefined. */
  const onlyPeriod = (tierCode: string): BillingPeriod | undefined => {
    if (!pricesSettled) return undefined
    const pack = packFor(tierCode)
    const yearly = priceOf(pack, tierCode, 'yearly') !== undefined
    const monthly = priceOf(pack, tierCode, 'monthly') !== undefined
    return yearly === monthly ? undefined : yearly ? 'yearly' : 'monthly'
  }

  const [headcountInput, setHeadcountInput] = useState(
    draft.headcount === undefined ? '' : String(draft.headcount)
  )
  const [headcountError, setHeadcountError] = useState<string>()
  const [announcement, setAnnouncement] = useState('')
  const [planError, setPlanError] = useState<string>()

  const recommended =
    draft.headcount === undefined ? undefined : recommendTier(draft.headcount, tiers)

  // The cards and the recommendation wait for their prices: a card's title comes from its price
  // row, and drawn before them every card would read its tier, then its plan, and the sentence
  // would be announced twice. Only they wait: the fields and the Docs option stay where they are.
  const pricesPending = priceReads.some(
    (read, index) => packOfRead(index) !== undefined && read.isPending
  )

  const recommendedName =
    recommended === undefined
      ? undefined
      : (planOfPrice(shownPrice(recommended.code), plans)?.name ?? recommended.name)

  const ownerQuery = useOrganisationOwnerQuery(role !== 'org_owner' ? organisationId : undefined)

  // Debounced live-region announcement (01-order.md §10: "changing the
  // headcount announces the new recommendation once, debounced 600 ms").
  useEffect(() => {
    const headcount = draft.headcount
    if (headcount === undefined || tiers.length === 0 || pricesPending) return
    const timer = window.setTimeout(() => {
      setAnnouncement(
        recommended === undefined
          ? t('console.order.plan.status-recommendation-quote', { count: headcount })
          : t('console.order.plan.status-recommendation', {
              plan: recommendedName,
              ...headcountRangeFor(recommended, tiers),
            })
      )
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommended?.code, recommendedName, draft.headcount, tiers.length, pricesPending])

  // The order as the catalogue sells it, once the prices are in: a tier chosen while they were
  // loading, or a draft restored from an earlier visit, takes the Docs pack its plan includes and
  // the one period it is sold in. Never the reverse: a Docs option the person ticked stays.
  useEffect(() => {
    if (!pricesSettled || draft.capacityTierCode === undefined) return
    const tierCode = draft.capacityTierCode
    const period = onlyPeriod(tierCode)
    const patch: Partial<OrderDraft> = {
      ...(includesDocs(tierCode) && docsPack !== undefined && draft.packCode !== docsPack.code
        ? { packCode: docsPack.code }
        : {}),
      ...(period !== undefined && period !== draft.billingPeriod ? { billingPeriod: period } : {}),
    }
    if (Object.keys(patch).length > 0) update(patch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pricesSettled, draft.capacityTierCode, draft.packCode, draft.billingPeriod, prices.length])

  function commitHeadcount(raw: string) {
    if (raw.trim() === '') {
      setHeadcountError(undefined)
      update({ headcount: undefined })
      return
    }
    const parsed = Number(raw)
    const result = headcountSchema.safeParse(parsed)
    if (!result.success) {
      setHeadcountError(t(result.error.issues[0]!.message as MessageKey))
      return
    }
    setHeadcountError(undefined)
    update({ headcount: result.data })
    if (draft.capacityTierCode === undefined) {
      const next = recommendTier(result.data, tiers)
      if (next !== undefined) chooseTier(next.code)
    }
  }

  /** A tier, with the pack and period its order needs: the Docs pack when the plan includes Docs,
   * the period it is sold in when it is sold in one only. Leaving a plan that included Docs
   * leaves the paid option unticked: nobody pays for Docs they did not tick. */
  function chooseTier(tierCode: string) {
    setPlanError(undefined)
    const pack = includesDocs(tierCode) || docsAddon ? (docsPack ?? basePack) : basePack
    const period = onlyPeriod(tierCode)
    update({
      capacityTierCode: tierCode,
      ...(pack === undefined ? {} : { packCode: pack.code }),
      ...(period === undefined ? {} : { billingPeriod: period }),
    })
  }

  function handleContinue() {
    if (draft.capacityTierCode === undefined) {
      setPlanError(t('console.order.plan.error-plan-required'))
      return
    }
    // The pack the card was priced from; the period is kept right by the effect above.
    const pack = packFor(draft.capacityTierCode)
    if (pack !== undefined && draft.packCode !== pack.code) update({ packCode: pack.code })
    onContinue()
  }

  if (role !== 'org_owner') {
    return (
      <Banner
        kind="info"
        headline={t('console.order._.error-role', { owner: ownerQuery.data ?? '—' })}
      />
    )
  }

  if (packsQuery.isError || tiersQuery.isError || plansQuery.isError || pricesFailed) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold text-c-ink">{t('console.order.plan.title')}</h1>
        <Banner
          kind="incident"
          headline={t('console.common.error-unavailable')}
          action={
            <Button
              onClick={() => {
                void packsQuery.refetch()
                void tiersQuery.refetch()
                void plansQuery.refetch()
                for (const read of priceReads) void read.refetch()
              }}
            >
              {t('console.common.action-retry')}
            </Button>
          }
        />
      </div>
    )
  }

  if (packsQuery.isLoading || tiersQuery.isLoading || plansQuery.isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton shape="block" className="h-[256px]" />
        <Skeleton shape="block" className="h-[256px]" />
        <Skeleton shape="block" className="h-[256px]" />
      </div>
    )
  }

  if (tiers.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold text-c-ink">{t('console.order.plan.title')}</h1>
        <EmptyState headingLevel={2} title={t('console.order.plan.empty-catalogue')} body="" />
      </div>
    )
  }

  // The same catalogue-derived figure the recommendation stops at.
  const cutoff = largestCoveredHeadcount(tiers)

  // The chosen tier as its order will be priced: the row its card shows, in the pack it needs.
  const chosenPrice =
    draft.capacityTierCode === undefined ? undefined : shownPrice(draft.capacityTierCode)
  const chosenPack =
    draft.capacityTierCode === undefined ? undefined : packFor(draft.capacityTierCode)
  const summaryRows =
    chosenPack === undefined || chosenPrice === undefined
      ? []
      : [{ label: chosenPack.name, value: formatMoney(chosenPrice.amount_excl_vat, 'fr') }]
  const chosenPlanName =
    draft.capacityTierCode === undefined
      ? undefined
      : (planOfPrice(chosenPrice, plans)?.name ??
        tiers.find((tier) => tier.code === draft.capacityTierCode)?.name)
  const yearlyOnly =
    draft.capacityTierCode !== undefined && onlyPeriod(draft.capacityTierCode) === 'yearly'

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px] narrow:grid-cols-1">
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-xl font-semibold text-c-ink">{t('console.order.plan.title')}</h1>
          <p className="mt-1 text-sm text-c-ink-3">{t('console.order.plan.subtitle')}</p>
        </div>

        <div className="max-w-[320px]">
          <TextField
            label={t('console.order.plan.label-headcount')}
            help={t('console.order.plan.hint-headcount')}
            {...(headcountError === undefined ? {} : { error: headcountError })}
            inputMode="numeric"
            type="number"
            min={1}
            max={100_000}
            value={headcountInput}
            onChange={(event) => setHeadcountInput(event.target.value)}
            onBlur={() => commitHeadcount(headcountInput)}
          />
        </div>

        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>

        {draft.headcount === undefined || pricesPending ? null : recommended !== undefined ? (
          <InlineAlert kind="info">
            {t('console.order.plan.status-recommendation', {
              plan: recommendedName,
              ...headcountRangeFor(recommended, tiers),
            })}
          </InlineAlert>
        ) : (
          // No tier covers the peak (01-order.md §1): no card is recommended,
          // and the quote is the way forward. The cards stay selectable.
          <div className="flex flex-col items-start gap-3">
            <InlineAlert kind="info">
              {t('console.order.plan.status-recommendation-quote', { count: draft.headcount })}
            </InlineAlert>
            <Button variant="secondary" onClick={onRequestQuote}>
              {t('console.order.plan.action-quote')}
            </Button>
          </div>
        )}

        {/* The cards share this column with the summary and the shell's sidebar, so
            the width they get is not the viewport's: measured on the mock build, the
            column is 269 px wide at a 640 px viewport, 503 px at 900, 284 px at 1024
            and 539 px at 1280. A viewport breakpoint drew three cards with 37 px of
            content each at 640 and at 1024. `gridColumns` decides from the column. */}
        <fieldset className="[container-type:inline-size] flex flex-col gap-2">
          <legend id={legendId} className="sr-only">
            {t('console.order.plan.title')}
          </legend>
          {pricesPending ? (
            <div className={`grid gap-4 ${gridColumns(tiers.length)}`}>
              {tiers.map((tier) => (
                <Skeleton key={tier.code} shape="block" className="h-[256px]" />
              ))}
            </div>
          ) : (
            <RadioGroupPrimitive.Root
              aria-labelledby={legendId}
              {...(draft.capacityTierCode === undefined ? {} : { value: draft.capacityTierCode })}
              onValueChange={chooseTier}
              className={`grid gap-4 ${gridColumns(tiers.length)}`}
            >
              {tiers.map((tier) => {
                const isRecommended = recommended?.code === tier.code
                const plan = planOfPrice(shownPrice(tier.code), plans)
                const name = plan?.name ?? tier.name
                // Null or empty means the catalogue has no text for this plan: nothing is drawn.
                const description = plan?.description ?? ''
                const descriptionId = `${legendId}-${tier.code}-description`
                const range = headcountRangeFor(tier, tiers)
                const row = shownPrice(tier.code)
                // A yearly row is the annual total. The card shows what it costs a month,
                // the total divided by twelve and rounded down to the cent, as the grid
                // states it (« 161 € par mois, facturé annuellement »), and the total under it.
                const headline =
                  row === undefined
                    ? undefined
                    : row.billing_period === 'yearly'
                      ? {
                          ...row.amount_excl_vat,
                          amount_minor: Math.floor(row.amount_excl_vat.amount_minor / 12),
                        }
                      : row.amount_excl_vat
                const priceKey: MessageKey =
                  row?.billing_period === 'yearly'
                    ? 'console.order.plan.label-price-annual'
                    : 'console.order.plan.label-price-monthly'
                const selected = draft.capacityTierCode === tier.code
                const priceText = headline === undefined ? '' : formatMoney(headline, 'fr')
                const capacityText = t('console.order.plan.hint-capacity', {
                  count: tier.concurrent_participants_included,
                })

                return (
                  <RadioGroupPrimitive.Item
                    key={tier.code}
                    value={tier.code}
                    asChild
                    aria-label={t('console.order.plan.a11y-card-name', {
                      plan: name,
                      // Billed annually, the name carries the annual total too: the line that
                      // shows it sits inside the radio, which assistive technology does not read.
                      price:
                        priceText === ''
                          ? name
                          : row?.billing_period === 'yearly'
                            ? `${t(priceKey, { amount: priceText })}, ${t(
                                'console.order.plan.label-price-annual-total',
                                { amount: formatMoney(row.amount_excl_vat, 'fr') }
                              )}`
                            : t(priceKey, { amount: priceText }),
                      capacity: capacityText,
                    })}
                    // A radio's children are not read: the plan's text reaches it this way.
                    {...(description === '' ? {} : { 'aria-describedby': descriptionId })}
                    className="rounded-lg text-left outline-hidden focus-visible:ring"
                  >
                    <button type="button">
                      <PlanCard
                        chosen={selected}
                        title={name}
                        titleAs="span"
                        {...(description === '' ? {} : { description, descriptionId })}
                        {...(isRecommended
                          ? {
                              recommended: true as const,
                              // The buyer's own headcount, not the tier's
                              // capacity: "100 personnes" on a card chosen for
                              // 120 people read as the card's size, and it is not.
                              recommendedLabel: t('console.order.plan.status-recommended', {
                                count: draft.headcount ?? 0,
                              }),
                            }
                          : { recommended: false as const })}
                        // COMPONENTS.md "Tier card": the amount alone as the headline with its
                        // period as a 12 px suffix. Billed annually, the 12 px sub-line is the
                        // annual total, the amount actually invoiced.
                        priceLine={
                          <PlanPrice
                            amount={priceText === '' ? '—' : priceText}
                            {...(row === undefined
                              ? {}
                              : row.billing_period === 'yearly'
                                ? {
                                    per: t(
                                      'console.order.plan.label-price-per-month-billed-annually'
                                    ),
                                    note: t('console.order.plan.label-price-annual-total', {
                                      amount: formatMoney(row.amount_excl_vat, 'fr'),
                                    }),
                                  }
                                : { per: t('console.order.plan.label-price-per-month') })}
                          />
                        }
                        features={[
                          t('console.order.plan.label-designed-for', {
                            min: range.min,
                            max: range.max,
                          }),
                          capacityText,
                        ]}
                        action={
                          <span
                            aria-hidden="true"
                            className="text-sm font-medium text-c-accent-ink"
                          >
                            {selected
                              ? t('console.order.plan.status-chosen')
                              : t('console.order.plan.action-choose', { plan: name })}
                          </span>
                        }
                      />
                    </button>
                  </RadioGroupPrimitive.Item>
                )
              })}
            </RadioGroupPrimitive.Root>
          )}
          {planError === undefined ? null : (
            <p role="alert" className="text-xs text-c-bad-ink">
              {planError}
            </p>
          )}
        </fieldset>

        <p>
          <LinkButton
            variant="tertiary"
            href="#"
            onClick={(event) => {
              event.preventDefault()
              onRequestQuote()
            }}
          >
            {cutoff === undefined
              ? t('console.order.plan.action-quote')
              : t('console.order.plan.action-enterprise', { max: cutoff })}
          </LinkButton>
        </p>

        <div className="flex flex-col gap-3">
          <h2 className="text-md font-semibold text-c-ink">
            {t('console.order.plan.title-addons')}
          </h2>
          {docsPack === undefined ? null : chosenIncludesDocs ? (
            // The plan already includes Docs: no paid option to tick.
            <p className="text-sm text-c-ink-2">
              {t('console.order.plan.status-docs-included', { plan: chosenPlanName ?? '' })}
            </p>
          ) : (
            <Checkbox
              label={t('console.order.plan.label-addon-docs')}
              checked={docsAddon}
              onCheckedChange={(checked) => {
                const nextPack = checked === true ? docsPack : basePack
                if (nextPack !== undefined) update({ packCode: nextPack.code })
              }}
            />
          )}
          <Checkbox
            label={t('console.order.plan.label-ngo')}
            help={t('console.order.plan.hint-ngo-verified')}
            checked={draft.ngoRate}
            onCheckedChange={(checked) => update({ ngoRate: checked === true })}
          />
        </div>

        <RadioGroup
          label={t('console.order.plan.label-billing-period')}
          orientation="horizontal"
          value={draft.billingPeriod}
          onValueChange={(value) => update({ billingPeriod: value as 'monthly' | 'yearly' })}
          options={[
            {
              value: 'monthly',
              label: t('console.order.plan.label-monthly'),
              disabled: yearlyOnly,
            },
            { value: 'yearly', label: t('console.order.plan.label-annual') },
          ]}
        />
        {yearlyOnly ? (
          <p className="-mt-3 text-sm text-c-ink-2">
            {t('console.order.plan.hint-yearly-only', { plan: chosenPlanName ?? '' })}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <SummaryPanel
          title={t('console.order.summary.title')}
          rows={summaryRows}
          total={{
            label: t(
              // Before a tier is chosen, the period the person has set.
              (chosenPrice?.billing_period ?? draft.billingPeriod) === 'yearly'
                ? 'console.order.summary.label-billed-annually'
                : 'console.order.summary.label-total-monthly'
            ),
            value: summaryRows[0]?.value ?? '—',
          }}
        />
        <Button onClick={handleContinue}>{t('console.common.action-continue')}</Button>
      </div>
    </div>
  )
}
