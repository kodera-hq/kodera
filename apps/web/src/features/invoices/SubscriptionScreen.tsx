// `subscription` (docs/specs/05-invoices.md §4.4). Reads `price_snapshot`,
// `next_invoice_at` and `current_period_end` directly from the Core
// subscription snapshot, plus optional unified `workspace` pack applications
// and `CapacityTier` capacity guides from `/catalog/packs` and
// `/catalog/capacity-tiers` (without unmeasured SLA/uptime numbers).

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatMoney } from '../../i18n/format'
import { Breadcrumb } from '../../ui/Breadcrumb/Breadcrumb'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody } from '../../ui/Card/Card'
import { DefinitionList } from '../../ui/DefinitionList/DefinitionList'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { Skeleton } from '../../ui/Skeleton/Skeleton'
import { orgRoute } from '../../app/org-route'
import { WorkspacePackSummaryCard } from '../billing/WorkspacePackSummaryCard'
import {
  fetchSubscriptionCatalogueContext,
  type CapacityTier,
  type Pack,
} from './facturxApi'
import { InvoicesAreaGuard } from './InvoicesAreaGuard'
import { useActiveSubscriptionQuery } from './queries'
import { invoicesSubscriptionRoute } from './routes'
import { useLocale } from './useLocale'
import { HelpLink } from '../support/HelpLink'
import { PAGE_TITLE } from '../../ui/pageTitle'

export interface SubscriptionScreenProps {
  initialPack?: Pack | null | undefined
  initialCapacityTier?: CapacityTier | null | undefined
}

function SubscriptionContent({
  initialPack,
  initialCapacityTier,
}: SubscriptionScreenProps) {
  const { t } = useTranslation()
  const locale = useLocale()
  const { org } = invoicesSubscriptionRoute.useParams()
  const { membership } = orgRoute.useLoaderData()
  const query = useActiveSubscriptionQuery(membership.organisation.id)

  const [fetchedPack, setFetchedPack] = useState<Pack | null>(null)
  const [fetchedCapacityTier, setFetchedCapacityTier] = useState<CapacityTier | null>(null)

  const packCode = query.data?.pack_code
  const capacityTierCode = query.data?.capacity_tier_code

  useEffect(() => {
    if (initialPack !== undefined || initialCapacityTier !== undefined) return
    if (!packCode || !capacityTierCode) return
    let active = true
    try {
      void fetchSubscriptionCatalogueContext(packCode, capacityTierCode).then(
        (resolved) => {
          if (!active) return
          setFetchedPack(resolved.pack)
          setFetchedCapacityTier(resolved.capacityTier)
        },
        () => {
          // Catalogue guide enrichment is optional; the snapshot card remains intact.
        }
      )
    } catch {
      // Unconfigured unit-test environments omit background catalogue enrichment.
    }
    return () => {
      active = false
    }
  }, [capacityTierCode, initialCapacityTier, initialPack, packCode])

  const pack = initialPack !== undefined ? initialPack : fetchedPack
  const capacityTier =
    initialCapacityTier !== undefined ? initialCapacityTier : fetchedCapacityTier

  return (
    <div className="flex flex-1 flex-col gap-6">
      <Breadcrumb
        ariaLabel={t('console.invoices._.a11y-breadcrumb')}
        items={[
          { label: t('console.invoices.list.title'), href: `/${org}/invoices` },
          { label: t('console.invoices.subscription.title') },
        ]}
      />
      <h1 className={PAGE_TITLE}>{t('console.invoices.subscription.title')}</h1>

      {query.isLoading ? (
        <Card>
          <CardBody className="flex flex-col gap-3">
            <Skeleton shape="text" label={t('console.invoices._.a11y-loading')} />
            <Skeleton shape="text" />
            <Skeleton shape="text" />
          </CardBody>
        </Card>
      ) : query.isError ? (
        <Card>
          <CardBody className="flex flex-col gap-3">
            <InlineAlert kind="error">{t('console.common.error-unavailable')}</InlineAlert>
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              onClick={() => void query.refetch()}
            >
              {t('console.common.action-retry')}
            </Button>
          </CardBody>
        </Card>
      ) : query.data == null ? (
        <InlineAlert kind="info">{t('console.invoices.subscription.empty-active')}</InlineAlert>
      ) : (
        <>
          <Card>
            <CardBody className="flex flex-col gap-4">
              <p className="text-sm text-c-ink-3">
                {t('console.invoices.list.label-subscription', {
                  plan: query.data.plan_code ?? query.data.pack_code,
                  period: t(
                    query.data.billing_period === 'monthly'
                      ? 'console.invoices.list.label-period-monthly'
                      : 'console.invoices.list.label-period-yearly'
                  ),
                })}
              </p>
              <DefinitionList
                items={[
                  {
                    term: t(
                      query.data.billing_period === 'monthly'
                        ? 'console.invoices.list.label-monthly-ex-vat'
                        : 'console.invoices.list.label-annual-ex-vat'
                    ),
                    description: (
                      <span className="font-mono tabular-nums">
                        {formatMoney(query.data.price_snapshot.total_excl_vat, locale)}
                      </span>
                    ),
                  },
                  ...(query.data.next_invoice_at
                    ? [
                        {
                          term: t('console.invoices.list.label-next-charge'),
                          description: formatDate(query.data.next_invoice_at, locale),
                        },
                      ]
                    : []),
                  {
                    term: t('console.invoices.subscription.label-commitment'),
                    description: formatDate(query.data.current_period_end, locale),
                  },
                ]}
              />
              <p className="text-xs text-c-ink-3">
                {t('console.invoices.subscription.hint-price-changes')}
              </p>
              <HelpLink
                org={org}
                search={{ topic: 'change-plan' }}
                variant="secondary"
                className="self-start"
              >
                {t('console.invoices.list.action-change-plan')}
              </HelpLink>
            </CardBody>
          </Card>

          <WorkspacePackSummaryCard
            packCode={query.data.pack_code}
            pack={pack}
            capacityTier={capacityTier}
            priceSnapshot={query.data.price_snapshot}
          />
        </>
      )}
    </div>
  )
}

export function SubscriptionScreen(props: SubscriptionScreenProps = {}) {
  return (
    <InvoicesAreaGuard>
      <SubscriptionContent {...props} />
    </InvoicesAreaGuard>
  )
}
