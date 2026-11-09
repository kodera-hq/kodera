// The warning is nonmodal until expiry (00-shell-and-login.md §4.7).
// Only the expired state blocks the page and moves focus to reconnect.
// Announcements retain the approved exact120/30-second policy.
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionExpiryDialog } from '../auth/sessionExpiry'
import { Button } from '../ui/Button/Button'
import { Dialog } from '../ui/Dialog/Dialog'
import { CloseIcon } from '../ui/icons/Close'
import { TOUCH_TARGET } from '../ui/touchTarget'
import { cx } from '../ui/cx'
import { FOCUS_GROUND_ELEVATED } from '../ui/focusGround'

export function SessionExpiryDialog() {
  const { t } = useTranslation()
  const { expiring, remainingS, extend, dismiss, signOutNow, signInAgain } =
    useSessionExpiryDialog()
  const expired = expiring && remainingS === 0
  const warning = expiring && !expired
  const signInAgainButton = useRef<HTMLButtonElement>(null)
  const warningPanel = useRef<HTMLElement>(null)
  const focusInWarning = useRef(false)
  const titleId = useId()
  const descriptionId = useId()

  const isExpired = useEffectEvent(() => expired)

  useLayoutEffect(() => {
    if (!warning) return
    const panel = warningPanel.current
    const prior = document.activeElement
    return () => {
      // Never move independent background focus; expiry owns reconnect focus.
      if (
        !isExpired() &&
        panel !== null &&
        (panel?.contains(document.activeElement) ||
          (document.activeElement === document.body && focusInWarning.current)) &&
        prior instanceof HTMLElement &&
        prior.isConnected &&
        !panel.contains(prior)
      ) {
        prior.focus()
      }
    }
  }, [warning])

  useEffect(() => {
    if (expired) signInAgainButton.current?.focus()
  }, [expired])

  useEffect(() => {
    if (!warning) return
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      dismiss()
    }
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [warning, dismiss])

  if (!expiring) return null

  const minutes = Math.ceil(remainingS / 60)
  const announcement =
    remainingS === 120 || remainingS === 30
      ? t('console.shell.session.a11y-countdown', { seconds: remainingS })
      : ''

  if (!expired) {
    return (
      <section
        ref={warningPanel}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onFocusCapture={() => {
          focusInWarning.current = true
        }}
        onBlurCapture={(event) => {
          focusInWarning.current = event.currentTarget.contains(event.relatedTarget as Node | null)
        }}
        className={cx(
          'relative mx-4 my-4 max-w-[576px] rounded-lg border border-c-border bg-c-elevated p-6 shadow-pop shadow-c-shadow-2',
          FOCUS_GROUND_ELEVATED
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-semibold text-c-ink">
            {t('console.shell.session.title-expiring')}
          </h2>
          <button
            type="button"
            aria-label={t('console.common.action-close')}
            onClick={dismiss}
            className={cx(
              '-mt-2 -mr-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-sm text-c-ink-3 opacity-70 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring focus-visible:outline-hidden',
              TOUCH_TARGET
            )}
          >
            <CloseIcon />
          </button>
        </div>
        <p id={descriptionId} className="mt-2 text-sm text-c-ink-3">
          {t('console.shell.session.subtitle-expiring', { minutes })}
        </p>
        <p className="sr-only" aria-live="assertive">
          {announcement}
        </p>
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={signOutNow}>
            {t('console.shell.session.action-sign-out')}
          </Button>
          <Button onClick={extend}>{t('console.shell.session.action-stay')}</Button>
        </div>
      </section>
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) extend()
      }}
      dismissible={false}
      title={t('console.shell.session.title-expired')}
      description={t('console.shell.session.error-expired')}
      closeLabel={t('console.common.action-close')}
      footer={
        <Button ref={signInAgainButton} onClick={signInAgain}>
          {t('console.shell.session.action-sign-in-again')}
        </Button>
      }
    >
      <p className="sr-only" aria-live="assertive">
        {announcement}
      </p>
    </Dialog>
  )
}
