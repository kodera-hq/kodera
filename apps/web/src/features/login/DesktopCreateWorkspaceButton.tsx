import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isDesktopBundledOrigin } from '../../auth/desktopOidc'
import { beginDesktopWorkspaceCreation } from '../../auth/desktopWorkspaceCreation'
import { Button } from '../../ui/Button/Button'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'

export function DesktopCreateWorkspaceButton({
  disabled,
  fullWidth = true,
  onPendingChange,
}: {
  disabled: boolean
  fullWidth?: boolean
  onPendingChange: (pending: boolean) => void
}) {
  const { t } = useTranslation()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const active = useRef(false)
  if (!isDesktopBundledOrigin()) return null

  async function createWorkspace() {
    if (active.current || disabled) return
    active.current = true
    setPending(true)
    setFailed(false)
    onPendingChange(true)
    try {
      await beginDesktopWorkspaceCreation()
    } catch {
      setFailed(true)
    } finally {
      active.current = false
      setPending(false)
      onPendingChange(false)
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        className={fullWidth ? 'w-full' : undefined}
        loading={pending}
        disabled={disabled && !pending}
        onClick={() => void createWorkspace()}
      >
        {t('console.login.realm.action-create-workspace')}
      </Button>
      {pending ? (
        <p role="status" className="text-sm text-c-ink-2">
          {t('console.login.realm.status-opening-sign-in')}
        </p>
      ) : null}
      {failed ? (
        <InlineAlert kind="error">{t('console.login.realm.error-sign-in')}</InlineAlert>
      ) : null}
    </>
  )
}
