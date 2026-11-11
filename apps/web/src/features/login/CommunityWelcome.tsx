import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { authAdapter } from '../../auth/oidc'
import { rememberReturnTo } from '../../auth/return-to'
import { keepLanguagePreference } from '../../i18n/languagePreference'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody } from '../../ui/Card/Card'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { KoderaMark } from '../../ui/icons/KoderaMark'
import { communityCopy } from './communityMessages'

export function CommunityWelcome() {
  const { i18n } = useTranslation()
  const copy = communityCopy(i18n.resolvedLanguage)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  async function enter(registration: boolean) {
    if (pending) return
    setPending(true)
    setFailed(false)
    try {
      rememberReturnTo('/community/workspace')
      await authAdapter.signIn('community', { registration })
    } catch {
      setPending(false)
      setFailed(true)
    }
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-c-surface p-6 narrow:p-4">
      <Card className="w-full max-w-shell-document-min-width">
        <CardBody className="flex flex-col gap-6 p-6">
          <KoderaMark className="h-10 w-10 text-c-ink" />
          <div className="flex flex-col gap-3">
            <h1 className="text-2xl font-semibold text-c-ink">{copy.title}</h1>
            <p className="text-md text-c-ink-2">{copy.subtitle}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button disabled={pending} onClick={() => void enter(false)}>
              {copy.signIn}
            </Button>
            <Button variant="secondary" disabled={pending} onClick={() => void enter(true)}>
              {copy.signUp}
            </Button>
          </div>
          <p className="text-sm text-c-ink-3">{copy.hint}</p>
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
                aria-pressed={i18n.resolvedLanguage?.startsWith(language)}
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
