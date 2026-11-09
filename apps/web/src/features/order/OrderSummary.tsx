import { useTranslation } from 'react-i18next'
import { formatMoney } from '../../i18n/format'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { SummaryPanel } from '../../ui/SummaryPanel/SummaryPanel'
import {
  cataloguePrice,
  planOfPrice,
  useCapacityTiersQuery,
  usePacksQuery,
  usePlansQuery,
  usePricesQuery,
} from './api'
import type { OrderDraft } from './draft'

/** Editable selections, priced exactly as their catalogue billing period reports. */
export function OrderSummary({ draft }: { draft: OrderDraft }) {
  const { t } = useTranslation()
  const packs = usePacksQuery()
  const tiers = useCapacityTiersQuery()
  const plans = usePlansQuery()
  const prices = usePricesQuery(draft.packCode, draft.billingPeriod)
  const pack = packs.data?.find((row) => row.code === draft.packCode && row.available)
  const tier = tiers.data?.find((row) => row.code === draft.capacityTierCode && row.available)
  const compatible =
    pack !== undefined &&
    tier !== undefined &&
    pack.capacity_tier_codes?.includes(tier.code) === true
  const price = compatible
    ? cataloguePrice(prices.data ?? [], pack.code, tier.code, draft.billingPeriod)
    : undefined
  // The plan the selected price is sold under, as the plan step titles its card.
  const planName = planOfPrice(price, plans.data ?? [])?.name
  const loading = packs.isLoading || tiers.isLoading || plans.isLoading || prices.isLoading
  const failed =
    packs.isError ||
    tiers.isError ||
    plans.isError ||
    prices.isError ||
    (!loading && price === undefined)

  return (
    <aside aria-label={t('console.order.summary.title')} className="flex flex-col gap-3">
      <SummaryPanel
        title={t('console.order.summary.title')}
        rows={compatible ? [{ label: pack.name, value: planName ?? tier.name }] : []}
        total={{
          label: t(
            draft.billingPeriod === 'yearly'
              ? 'console.order.summary.label-billed-annually'
              : 'console.order.summary.label-total-monthly'
          ),
          value: price === undefined || failed ? '—' : formatMoney(price.amount_excl_vat, 'fr'),
        }}
      />
      {loading ? (
        <p role="status" className="text-sm text-c-ink-3">
          {t('console.common.a11y-loading')}
        </p>
      ) : failed ? (
        <InlineAlert kind="error">{t('console.common.error-unavailable')}</InlineAlert>
      ) : null}
    </aside>
  )
}
