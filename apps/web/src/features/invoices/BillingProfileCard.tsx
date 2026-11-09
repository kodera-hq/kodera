import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardBody } from '../../ui/Card/Card'
import { Button } from '../../ui/Button/Button'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { Skeleton } from '../../ui/Skeleton/Skeleton'
import { useBillingProfileQuery } from './queries'

export function BillingProfileCard({ organisationId }: { organisationId: string }) {
  const { t } = useTranslation()
  const titleId = useId()
  const query = useBillingProfileQuery(organisationId)
  return (
    <section aria-labelledby={titleId}>
      <Card>
        <CardBody className="flex flex-col gap-3 p-4">
          <h2 id={titleId} className="text-md font-semibold text-c-ink">
            {t('console.invoices.summary.title-address')}
          </h2>
          {query.isLoading ? (
            <Skeleton shape="text" label={t('console.invoices.summary.loading-address')} />
          ) : query.isError ? (
            <>
              <InlineAlert kind="error">{t('console.common.error-unavailable')}</InlineAlert>
              <Button
                variant="secondary"
                size="sm"
                className="self-start"
                onClick={() => void query.refetch()}
              >
                {t('console.common.action-retry')}
              </Button>
            </>
          ) : query.data == null ? null : (
            <div className="flex flex-col gap-1 text-sm break-words text-c-ink-2">
              <p className="font-semibold">{query.data.name}</p>
              {query.data.address === null ? (
                <p>{t('console.invoices.summary.empty-address')}</p>
              ) : (
                <>
                  <p>{query.data.address.line1}</p>
                  {query.data.address.line2 ? <p>{query.data.address.line2}</p> : null}
                  <p>
                    {query.data.address.postal_code} {query.data.address.city}
                  </p>
                  <p>{query.data.address.country}</p>
                </>
              )}
            </div>
          )}
        </CardBody>
      </Card>
    </section>
  )
}
