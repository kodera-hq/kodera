import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiProblem } from '../../api/client'
import { formatDate } from '../../i18n/format'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody } from '../../ui/Card/Card'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { Skeleton } from '../../ui/Skeleton/Skeleton'
import { StatusPill, type StatusPillState } from '../../ui/StatusPill/StatusPill'
import { TextField } from '../../ui/TextField/TextField'
import { billingCopy, resolveBillingLocale } from '../billing/billingMessages'
import {
  fetchBillingVatStatus,
  validateBillingVat,
  type BillingVatStatus,
} from './facturxApi'
import { useBillingProfileQuery } from './queries'
import type { VatRegime } from './vatRegime'

const VIES_PILL_STATE: Record<BillingVatStatus['status'], StatusPillState> = {
  valid: 'success',
  unavailable: 'warning',
  invalid: 'danger',
  not_checked: 'neutral',
}

const ISO_COUNTRY = /^[A-Z]{2}$/

export interface BillingProfileCardProps {
  organisationId: string
  vatStatus?: BillingVatStatus | null | undefined
  loadVatStatus?: boolean | undefined
  canValidateVat?: boolean | undefined
  taxRegime?: VatRegime | undefined
}

export function BillingProfileCard({
  organisationId,
  vatStatus: providedVatStatus,
  loadVatStatus = false,
  canValidateVat = false,
  taxRegime,
}: BillingProfileCardProps) {
  const { t, i18n } = useTranslation()
  const locale = resolveBillingLocale(i18n.resolvedLanguage)
  const copy = billingCopy(i18n.resolvedLanguage)
  const titleId = useId()
  const query = useBillingProfileQuery(organisationId)

  const [fetchedVatStatus, setFetchedVatStatus] = useState<BillingVatStatus | null>(null)
  const [countryInput, setCountryInput] = useState('')
  const [vatNumberInput, setVatNumberInput] = useState('')
  const [validating, setValidating] = useState(false)
  const [validationMessage, setValidationMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!loadVatStatus || providedVatStatus !== undefined) return
    let active = true
    try {
      void fetchBillingVatStatus(organisationId).then(
        (status) => {
          if (!active) return
          setFetchedVatStatus(status)
          if (status.country_code) setCountryInput(status.country_code)
          if (status.vat_number) setVatNumberInput(status.vat_number)
        },
        (error: unknown) => {
          if (!active) return
          if (error instanceof ApiProblem && error.status === 503) {
            setFetchedVatStatus({
              vat_number: null,
              country_code: null,
              status: 'unavailable',
              checked_at: null,
              next_check_at: null,
              evidence_id: null,
            })
          }
        }
      )
    } catch {
      // Unconfigured test environments without VITE_CORE_API_URL omit optional VIES reads.
    }
    return () => {
      active = false
    }
  }, [loadVatStatus, organisationId, providedVatStatus])

  const effectiveVatStatus =
    providedVatStatus !== undefined ? providedVatStatus : fetchedVatStatus

  async function handleValidateVat(event: React.FormEvent) {
    event.preventDefault()
    if (validating) return
    const normalizedCountry = countryInput.trim().toUpperCase()
    const normalizedNumber = vatNumberInput.trim().replace(/\s+/g, '').toUpperCase()
    if (!ISO_COUNTRY.test(normalizedCountry) || normalizedNumber.length < 4) {
      setValidationMessage(copy.viesValidateInputError)
      return
    }
    setValidating(true)
    setValidationMessage(null)
    try {
      const updated = await validateBillingVat(organisationId, {
        country_code: normalizedCountry,
        vat_number: normalizedNumber,
      })
      setFetchedVatStatus(updated)
      setCountryInput(updated.country_code ?? normalizedCountry)
      setVatNumberInput(updated.vat_number ?? normalizedNumber)
    } catch (error) {
      if (error instanceof ApiProblem && error.status === 503) {
        setFetchedVatStatus({
          country_code: normalizedCountry,
          vat_number: normalizedNumber,
          status: 'unavailable',
          checked_at: null,
          next_check_at: null,
          evidence_id: null,
        })
      } else {
        setValidationMessage(copy.viesValidateFailed)
      }
    } finally {
      setValidating(false)
    }
  }

  const displayedVatStatus =
    fetchedVatStatus !== null && providedVatStatus !== undefined && validating === false
      ? fetchedVatStatus
      : effectiveVatStatus

  return (
    <section aria-labelledby={titleId}>
      <Card>
        <CardBody className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id={titleId} className="text-md font-semibold text-c-ink">
              {t('console.invoices.summary.title-address')}
            </h2>
            {taxRegime !== undefined ? (
              <StatusPill state="neutral">{copy.taxRegimes[taxRegime]}</StatusPill>
            ) : null}
          </div>
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

          {displayedVatStatus != null && !query.isError ? (
            <div className="flex flex-col gap-3 border-t border-c-border-soft pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-c-ink-3">
                  {copy.viesSectionTitle}
                </span>
                <StatusPill state={VIES_PILL_STATE[displayedVatStatus.status]}>
                  {copy.viesBadges[displayedVatStatus.status]}
                </StatusPill>
              </div>

              {displayedVatStatus.vat_number ? (
                <p className="font-mono text-sm text-c-ink">
                  {displayedVatStatus.country_code ? `${displayedVatStatus.country_code} · ` : ''}
                  {displayedVatStatus.vat_number}
                </p>
              ) : null}

              {displayedVatStatus.status === 'unavailable' ? (
                <InlineAlert kind="warning">{copy.viesHoldNotice}</InlineAlert>
              ) : displayedVatStatus.status === 'invalid' ? (
                <InlineAlert kind="error">{copy.viesInvalidNotice}</InlineAlert>
              ) : displayedVatStatus.status === 'valid' ? (
                <p className="text-xs text-c-ink-2">{copy.viesValidDetail}</p>
              ) : (
                <p className="text-xs text-c-ink-3">{copy.viesNotCheckedDetail}</p>
              )}

              {displayedVatStatus.checked_at ||
              displayedVatStatus.next_check_at ||
              displayedVatStatus.evidence_id ? (
                <dl className="flex flex-col gap-1 text-xs text-c-ink-3">
                  {displayedVatStatus.checked_at ? (
                    <div className="flex flex-wrap justify-between gap-2">
                      <dt>{copy.viesCheckedAtLabel}</dt>
                      <dd className="font-mono text-c-ink-2">
                        {formatDate(displayedVatStatus.checked_at, locale)}
                      </dd>
                    </div>
                  ) : null}
                  {displayedVatStatus.next_check_at ? (
                    <div className="flex flex-wrap justify-between gap-2">
                      <dt>{copy.viesNextCheckAtLabel}</dt>
                      <dd className="font-mono text-c-ink-2">
                        {formatDate(displayedVatStatus.next_check_at, locale)}
                      </dd>
                    </div>
                  ) : null}
                  {displayedVatStatus.evidence_id ? (
                    <div className="flex flex-wrap justify-between gap-2">
                      <dt>{copy.viesEvidenceIdLabel}</dt>
                      <dd className="font-mono text-c-ink-2">{displayedVatStatus.evidence_id}</dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}

              {canValidateVat ? (
                <form
                  className="flex flex-col gap-3 border-t border-c-border-soft pt-3"
                  onSubmit={(event) => void handleValidateVat(event)}
                >
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <TextField
                      label={copy.viesCountryLabel}
                      maxLength={2}
                      value={countryInput}
                      onChange={(event) => setCountryInput(event.target.value)}
                    />
                    <TextField
                      label={copy.viesVatNumberLabel}
                      maxLength={32}
                      value={vatNumberInput}
                      onChange={(event) => setVatNumberInput(event.target.value)}
                    />
                  </div>
                  {validationMessage ? (
                    <p role="alert" className="text-xs text-c-bad-ink">
                      {validationMessage}
                    </p>
                  ) : null}
                  <Button
                    type="submit"
                    variant="secondary"
                    size="sm"
                    className="self-start"
                    loading={validating}
                  >
                    {copy.viesValidateAction}
                  </Button>
                </form>
              ) : null}
            </div>
          ) : null}
        </CardBody>
      </Card>
    </section>
  )
}
