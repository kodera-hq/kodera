// "Votre formule" (docs/specs/02-status.md §4.2). The subscription's own
// fields the screen's Core API table names — `pack_code`, `capacity_tier_code`,
// `billing_period`, `next_invoice_at` — carry no human-readable plan NAME
// (no field like the design's "Business + Docs" exists in `Subscription`,
// and the catalog/plans lookup this screen would need to translate a code
// into that name is not one of this screen's calls per §6). Rather than
// invent a code → name table client-side, the card shows the coded fields
// the response actually carries, as the technical values they are — mono,
// the same treatment a value the customer copies gets (`docs/specs/
// README.md`'s glossary note) — alongside the one figure that IS a plain
// sentence: the next invoice date.

import { useTranslation } from 'react-i18next'
import { formatDate } from '@/i18n/format'
import { Button } from '@/ui/Button/Button'
import { Card, CardBody, CardHeader } from '@/ui/Card/Card'
import { DefinitionList } from '@/ui/DefinitionList/DefinitionList'

export interface PlanCardProps {
  packCode: string
  capacityTierCode: string
  nextInvoiceAt: string | undefined
  onSeeInvoices: () => void
  /** `billing`, `owner` and `admin` read invoices; `member` does not
   * (docs/specs/README.md §5's role note) — the link renders only when the
   * caller says the role allows it. */
  canSeeInvoices: boolean
}

export function PlanCard({
  packCode,
  capacityTierCode,
  nextInvoiceAt,
  onSeeInvoices,
  canSeeInvoices,
}: PlanCardProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'en' ? 'en' : 'fr'

  return (
    <Card>
      <CardHeader>
        <h2 className="text-md font-semibold text-c-ink">
          {t('console.status.overview.title-plan')}
        </h2>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <DefinitionList
          items={[
            {
              term: t('console.status.overview.label-plan-pack'),
              description: <span className="font-mono">{packCode}</span>,
            },
            {
              term: t('console.status.overview.label-plan-tier'),
              description: <span className="font-mono">{capacityTierCode}</span>,
            },
          ]}
        />
        {nextInvoiceAt === undefined ? null : (
          <p className="text-sm text-c-ink">
            {t('console.status.overview.label-next-invoice', {
              date: formatDate(nextInvoiceAt, locale),
            })}
          </p>
        )}
        {canSeeInvoices ? (
          <div>
            <Button variant="tertiary" size="sm" onClick={onSeeInvoices}>
              {t('console.status.overview.action-see-invoices')}
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}
