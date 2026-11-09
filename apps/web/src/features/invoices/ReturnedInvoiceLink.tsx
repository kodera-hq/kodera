import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LinkButton } from '../../ui/LinkButton/LinkButton'

export interface ReturnedInvoiceAction {
  url: string
  expires_at: string
  kind: 'payment' | 'pdf'
  isCurrent: () => boolean
}

/** A user activation remains available independently of the automatic tab attempt. */
export function ReturnedInvoiceLink({ action }: { action: ReturnedInvoiceAction | undefined }) {
  return action === undefined ? null : (
    <CurrentInvoiceLink key={JSON.stringify([action.url, action.expires_at])} action={action} />
  )
}

function CurrentInvoiceLink({ action }: { action: ReturnedInvoiceAction }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const remaining = Date.parse(action.expires_at) - Date.now()
    if (!Number.isFinite(remaining) || remaining <= 0) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(remaining + 1, 2147483647))
    return () => clearTimeout(timer)
  }, [action])
  if (!action.isCurrent() || !(Date.parse(action.expires_at) > now)) return null
  return (
    <LinkButton
      variant="secondary"
      className="self-start"
      href={action.url}
      target="_blank"
      onClick={(event) => {
        if (!action.isCurrent() || !(Date.parse(action.expires_at) > Date.now()))
          event.preventDefault()
      }}
    >
      {t(
        action.kind === 'payment'
          ? 'console.invoices.detail.action-open-payment'
          : 'console.invoices.detail.action-pdf'
      )}
    </LinkButton>
  )
}
