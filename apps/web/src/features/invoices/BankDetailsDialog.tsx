// The "Coordonnées bancaires" dialog (§4.3), reconciled against §6's own
// note rather than against the ASCII wireframe: "the bank-transfer details
// are not returned by the API … the console links to the PDF instead of
// restating them." The IBAN and the BIC never come from the Core API, so
// this dialog never invents them — the one real, already-known field is the
// transfer reference, which §8 fixes as "always the invoice number".
//
// Mounted nowhere for now (owner ruling 2026-09-24): a "Coordonnées
// bancaires" dialog with no IBAN in it was the payment fallback a customer
// reached when the payment link failed, and it gave them nothing to pay
// with. The list and the detail point to the PDF and to support instead
// (05-invoices.md §4.3), and this dialog returns — with the holder, the IBAN
// and the BIC — once contract 0.12.0 carries the issuer's bank details on
// the invoice. Kept, with its clipboard tests, for that return.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FocusTarget } from '../../ui/returnFocus'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { useInvoiceActionLease } from './useInvoiceActionLease'
import type { ReactNode } from 'react'
import { Button } from '../../ui/Button/Button'
import { CopyableField } from '../../ui/CopyableField/CopyableField'
import { Dialog } from '../../ui/Dialog/Dialog'

export interface BankDetailsDialogProps {
  invoiceNumber: string
  /** Both call sites open this fully controlled, from a separate row-menu
   * item or button — omit it rather than pass a dummy element `Dialog`
   * would otherwise render as an inert trigger in the DOM. */
  trigger?: ReactNode
  returnFocusTo?: FocusTarget
  onDownloadPdf: () => void
  pdfAvailable: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function BankDetailsDialog({
  invoiceNumber,
  trigger,
  returnFocusTo,
  onDownloadPdf,
  pdfAvailable,
  open,
  onOpenChange,
}: BankDetailsDialogProps) {
  const { t } = useTranslation()
  const [internalOpen, setInternalOpen] = useState(false)
  const visible = open ?? internalOpen
  const beginAction = useInvoiceActionLease(JSON.stringify([invoiceNumber, visible]))
  const [feedback, setFeedback] = useState<{ number: string; status: 'copied' | 'failed' }>()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(
    () => () => {
      clearTimeout(timer.current)
    },
    []
  )
  const changeOpen = (next: boolean) => {
    setInternalOpen(next)
    onOpenChange?.(next)
  }
  async function copyReference() {
    const isCurrent = beginAction()
    if (!visible || !isCurrent()) return
    clearTimeout(timer.current)
    setFeedback(undefined)
    try {
      await navigator.clipboard.writeText(invoiceNumber)
      if (!isCurrent()) return
      setFeedback({ number: invoiceNumber, status: 'copied' })
      timer.current = setTimeout(() => setFeedback(undefined), 1500)
    } catch {
      if (isCurrent()) setFeedback({ number: invoiceNumber, status: 'failed' })
    }
  }

  return (
    <Dialog
      open={visible}
      onOpenChange={changeOpen}
      {...(returnFocusTo === undefined ? {} : { returnFocusTo })}
      {...(trigger === undefined ? {} : { trigger })}
      title={t('console.invoices.bank.title')}
      closeLabel={t('console.common.action-close')}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => changeOpen(false)}>
            {t('console.common.action-close')}
          </Button>
          {pdfAvailable ? (
            <Button variant="primary" onClick={onDownloadPdf}>
              {t('console.invoices.detail.action-pdf')}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-c-ink-3">{t('console.invoices.bank.error-unavailable')}</p>
        <CopyableField
          label={t('console.invoices.bank.label-reference')}
          value={invoiceNumber}
          status={
            feedback?.number === invoiceNumber && feedback.status === 'copied' ? 'copied' : 'idle'
          }
          copyLabel={t('console.common.action-copy')}
          copiedLabel={t('console.common.toast-copied')}
          onCopy={() => {
            void copyReference()
          }}
        />
        {feedback?.number === invoiceNumber && feedback.status === 'failed' ? (
          <InlineAlert kind="error">{t('console.invoices.bank.error-copy')}</InlineAlert>
        ) : null}
        <p className="text-xs text-c-ink-3">
          {t('console.invoices.bank.hint-reference', { reference: invoiceNumber })}
        </p>
      </div>
    </Dialog>
  )
}
