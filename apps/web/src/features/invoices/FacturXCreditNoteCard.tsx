// Renders a Core `CreditNote` (`facturx_type_code: '381'`, `AV-...` gapless series)
// linked to a credited invoice, with immutable minor-unit snapshot amounts, SHA-256
// artifact digest, and authenticated Factur-X PDF/A-3 + EN 16931 XML downloads.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatMoney, formatPercent } from '../../i18n/format'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody, CardHeader } from '../../ui/Card/Card'
import { DefinitionList } from '../../ui/DefinitionList/DefinitionList'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { StatusPill } from '../../ui/StatusPill/StatusPill'
import { useToast } from '../../ui/Toast/Toast'
import { billingCopy, resolveBillingLocale } from '../billing/billingMessages'
import {
  fetchCreditNote,
  fetchCreditNoteDownloadLink,
  type CreditNote,
} from './facturxApi'

export interface FacturXCreditNoteCardProps {
  creditNoteId: string
  organisationId: string
  invoiceId: string
  initialCreditNote?: CreditNote | null | undefined
  onDownloadOpened?: ((url: string, expiresAt: string) => void) | undefined
}

export function FacturXCreditNoteCard({
  creditNoteId,
  organisationId,
  invoiceId,
  initialCreditNote,
  onDownloadOpened,
}: FacturXCreditNoteCardProps) {
  const { i18n } = useTranslation()
  const locale = resolveBillingLocale(i18n.resolvedLanguage)
  const copy = billingCopy(i18n.resolvedLanguage)
  const notify = useToast()

  const [fetchedCreditNote, setFetchedCreditNote] = useState<CreditNote | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [downloadingFormat, setDownloadingFormat] = useState<'pdf' | 'xml' | null>(null)

  useEffect(() => {
    if (initialCreditNote !== undefined) return
    let active = true
    try {
      void fetchCreditNote(creditNoteId, { organisationId, invoiceId }).then(
        (loaded) => {
          if (!active) return
          setLoadError(false)
          setFetchedCreditNote(loaded)
        },
        () => {
          if (active) setLoadError(true)
        }
      )
    } catch {
      // Unconfigured unit-test environments omit background credit-note reads.
    }
    return () => {
      active = false
    }
  }, [creditNoteId, initialCreditNote, invoiceId, organisationId])

  const creditNote =
    initialCreditNote !== undefined ? initialCreditNote : fetchedCreditNote

  async function handleDownload(format: 'pdf' | 'xml') {
    if (!creditNote || downloadingFormat !== null) return
    setDownloadingFormat(format)
    try {
      const link = await fetchCreditNoteDownloadLink(creditNote.id, format)
      onDownloadOpened?.(link.url, link.expires_at)
      window.open(link.url, '_blank', 'noopener,noreferrer')
    } catch {
      notify({ kind: 'error', title: copy.creditNoteDownloadFailed })
    } finally {
      setDownloadingFormat(null)
    }
  }

  if (loadError) {
    return (
      <Card>
        <CardBody>
          <InlineAlert kind="error">{copy.creditNoteLoadFailed}</InlineAlert>
        </CardBody>
      </Card>
    )
  }

  if (creditNote === null) return null

  const digest = creditNote.artifacts?.pdf?.sha256 ?? creditNote.snapshot_sha256
  const filename = creditNote.artifacts?.pdf?.filename
  const xmlAvailable =
    creditNote.xml_available === true || creditNote.artifacts?.xml !== undefined
  const vatRateBp = creditNote.lines[0]?.vat_rate_bp ?? 0

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-md font-semibold text-c-ink">
            {copy.creditNoteTitle(creditNote.number)}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill state="info">{copy.facturxCreditNoteBadge}</StatusPill>
            <StatusPill state="neutral">{copy.taxRegimes[creditNote.vat_regime]}</StatusPill>
          </div>
        </div>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <DefinitionList
          items={[
            {
              term: copy.facturxDocRefLabel,
              description: <span className="font-mono">{creditNote.number}</span>,
            },
            {
              term: copy.creditNoteLinkedInvoiceLabel,
              description: <span className="font-mono">{creditNote.invoice_number}</span>,
            },
            {
              term: copy.creditNoteIssuedLabel,
              description: formatDate(creditNote.issued_at, locale),
            },
            {
              term: copy.creditNoteReasonLabel,
              description: copy.creditNoteReasons[creditNote.reason],
            },
            ...(filename
              ? [
                  {
                    term: copy.facturxFilenameLabel,
                    description: <span className="font-mono text-xs">{filename}</span>,
                  },
                ]
              : []),
            ...(digest
              ? [
                  {
                    term: copy.facturxSha256Label,
                    description: (
                      <span className="font-mono text-xs break-all">{digest}</span>
                    ),
                  },
                ]
              : []),
            {
              term: copy.totalExclVat,
              description: (
                <span className="font-mono tabular-nums">
                  {formatMoney(creditNote.total_excl_vat, locale)}
                </span>
              ),
            },
            {
              term: copy.vatAmountLabel(formatPercent(vatRateBp / 100, locale)),
              description: (
                <span className="font-mono tabular-nums">
                  {formatMoney(creditNote.vat_amount, locale)}
                </span>
              ),
            },
            {
              term: copy.totalInclVat,
              description: (
                <span className="font-mono tabular-nums">
                  {formatMoney(creditNote.total_incl_vat, locale)}
                </span>
              ),
            },
          ]}
        />

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            loading={downloadingFormat === 'pdf'}
            onClick={() => void handleDownload('pdf')}
          >
            {copy.creditNoteDownloadPdf}
          </Button>
          {xmlAvailable ? (
            <Button
              variant="secondary"
              loading={downloadingFormat === 'xml'}
              onClick={() => void handleDownload('xml')}
            >
              {copy.creditNoteDownloadXml}
            </Button>
          ) : null}
        </div>
      </CardBody>
    </Card>
  )
}
