// Renders the unified `workspace` pack applications (`messaging`, `visio`, `docs`),
// Core capacity guides (`seats_included`, `concurrent_participants_included`,
// `storage_included_bytes`), and immutable Core `PriceSnapshot` minor-unit totals
// without any client-side VAT computation or inline style attributes.

import { useTranslation } from 'react-i18next'
import { formatMoney, formatPercent } from '../../i18n/format'
import { Card, CardBody, CardHeader } from '../../ui/Card/Card'
import { DefinitionList } from '../../ui/DefinitionList/DefinitionList'
import { StatusPill } from '../../ui/StatusPill/StatusPill'
import { billingCopy, resolveBillingLocale } from './billingMessages'
import {
  formatByteCapacity,
  UNIFIED_WORKSPACE_PACK_CODE,
  type AppCode,
  type CapacityTier,
  type Pack,
  type PriceSnapshot,
} from './workspaceOffer'

export interface WorkspacePackSummaryCardProps {
  packCode: string
  pack?: Pack | null | undefined
  capacityTier?: CapacityTier | null | undefined
  priceSnapshot?: PriceSnapshot | null | undefined
}

const DEFAULT_UNIFIED_APPS: readonly AppCode[] = ['messaging', 'visio', 'docs']

export function WorkspacePackSummaryCard({
  packCode,
  pack,
  capacityTier,
  priceSnapshot,
}: WorkspacePackSummaryCardProps) {
  const { i18n } = useTranslation()
  const locale = resolveBillingLocale(i18n.resolvedLanguage)
  const copy = billingCopy(i18n.resolvedLanguage)

  const isUnifiedWorkspace =
    packCode === UNIFIED_WORKSPACE_PACK_CODE || pack?.code === UNIFIED_WORKSPACE_PACK_CODE
  const apps: readonly AppCode[] =
    pack?.apps ?? (isUnifiedWorkspace ? DEFAULT_UNIFIED_APPS : [])

  if (apps.length === 0 && capacityTier == null && priceSnapshot == null) {
    return null
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-md font-semibold text-c-ink">{copy.offerTitle}</h2>
          {isUnifiedWorkspace ? (
            <StatusPill state="info">{copy.offerUnifiedBadge}</StatusPill>
          ) : null}
        </div>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        {apps.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold text-c-ink-3">{copy.includedAppsLabel}</p>
            <ul className="flex flex-wrap gap-2" aria-label={copy.includedAppsLabel}>
              {apps.map((app) => (
                <li
                  key={app}
                  className="rounded-full border border-c-border bg-c-sunken px-3 py-1 text-xs font-medium text-c-ink"
                >
                  {copy.appNames[app] ?? app}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {capacityTier != null ? (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <li className="rounded-md border border-c-border-soft bg-c-sunken p-3 text-sm font-medium text-c-ink">
              {copy.seatsIncluded(capacityTier.seats_included)}
            </li>
            <li className="rounded-md border border-c-border-soft bg-c-sunken p-3 text-sm font-medium text-c-ink">
              {copy.concurrentParticipantsIncluded(
                capacityTier.concurrent_participants_included
              )}
            </li>
            <li className="rounded-md border border-c-border-soft bg-c-sunken p-3 text-sm font-medium text-c-ink">
              {copy.storageIncluded(
                formatByteCapacity(capacityTier.storage_included_bytes, locale)
              )}
            </li>
          </ul>
        ) : null}

        {priceSnapshot != null ? (
          <div className="flex flex-col gap-2 border-t border-c-border-soft pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-c-ink-3">{copy.snapshotPricingTitle}</p>
              <StatusPill state="neutral">
                {copy.taxRegimes[priceSnapshot.vat_regime]}
              </StatusPill>
            </div>
            <DefinitionList
              items={[
                {
                  term: copy.totalExclVat,
                  description: (
                    <span className="font-mono tabular-nums">
                      {formatMoney(priceSnapshot.total_excl_vat, locale)}
                    </span>
                  ),
                },
                {
                  term: copy.vatAmountLabel(
                    formatPercent(priceSnapshot.vat_rate_bp / 100, locale)
                  ),
                  description: (
                    <span className="font-mono tabular-nums">
                      {formatMoney(priceSnapshot.vat_amount, locale)}
                    </span>
                  ),
                },
                {
                  term: copy.totalInclVat,
                  description: (
                    <span className="font-mono tabular-nums">
                      {formatMoney(priceSnapshot.total_incl_vat, locale)}
                    </span>
                  ),
                },
              ]}
            />
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}
