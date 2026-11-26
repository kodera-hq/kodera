import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { authAdapter } from '../../auth/oidc'
import { hasReturnTo, rememberReturnTo } from '../../auth/return-to'
import { keepLanguagePreference } from '../../i18n/languagePreference'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody } from '../../ui/Card/Card'
import { cx } from '../../ui/cx'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { KoderaMark } from '../../ui/icons/KoderaMark'
import { LINK_TEXT } from '../../ui/linkText'
import { communityCopy } from './communityMessages'
import { isDesktopBundledOrigin } from '../../auth/desktopOidc'
import { DesktopCreateWorkspaceButton } from './DesktopCreateWorkspaceButton'

export function CommunityWelcome() {
  const { i18n } = useTranslation()
  const copy = communityCopy(i18n.resolvedLanguage)
  const [pending, setPending] = useState(false)
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)
  const [failed, setFailed] = useState(false)
  async function enter(registration: boolean) {
    if (pending || creatingWorkspace) return
    setPending(true)
    setFailed(false)
    try {
      if (!hasReturnTo()) rememberReturnTo('/community/workspace')
      await authAdapter.signIn('community', { registration })
    } catch {
      setPending(false)
      setFailed(true)
    }
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-c-page p-6 narrow:p-4">
      <Card className="w-full max-w-shell-document-min-width">
        <CardBody className="flex flex-col gap-6 p-6">
          <KoderaMark className="h-10 w-10 text-c-ink" />
          <div className="flex flex-col gap-3">
            <h1 className="text-2xl font-semibold text-c-ink">{copy.title}</h1>
            <p className="text-md text-c-ink-2">{copy.subtitle}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button disabled={pending || creatingWorkspace} onClick={() => void enter(false)}>
              {copy.signIn}
            </Button>
            {isDesktopBundledOrigin() ? (
              <DesktopCreateWorkspaceButton
                fullWidth={false}
                disabled={pending}
                onPendingChange={setCreatingWorkspace}
              />
            ) : (
              <Button variant="secondary" disabled={pending} onClick={() => void enter(true)}>
                {copy.signUp}
              </Button>
            )}
          </div>
          <p className="text-sm text-c-ink-3">{copy.hint}</p>
          <Link
            disabled={pending || creatingWorkspace}
            aria-disabled={pending || creatingWorkspace}
            to="/login"
            search={{ mode: 'tenant' }}
            className={cx(
              'self-start rounded-sm text-sm focus-visible:ring focus-visible:outline-hidden',
              LINK_TEXT.inline
            )}
          >
            {copy.dedicatedOrgSignIn}
          </Link>
          {pending ? (
            <p role="status" className="text-sm text-c-ink-2">
              {copy.pending}
            </p>
          ) : null}
          {failed ? <InlineAlert kind="error">{copy.error}</InlineAlert> : null}
          <div className="flex gap-2">
            {(['fr', 'en'] as const).map((language) => (
              <Button
                key={language}
                size="sm"
                variant="tertiary"
                // The language in use reads as chosen without relying on colour alone.
                className="aria-pressed:font-semibold aria-pressed:text-c-ink aria-pressed:underline"
                aria-pressed={i18n.resolvedLanguage?.startsWith(language) === true}
                onClick={() => {
                  keepLanguagePreference(language)
                  void i18n.changeLanguage(language)
                }}
              >
                {language.toUpperCase()}
              </Button>
            ))}
          </div>
        </CardBody>
      </Card>
    </main>
  )
}
