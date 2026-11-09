// The mock identity provider's own page (ADR-0007): stands in for Keycloak's
// hosted login screen when `src/mocks/auth.ts` points `authorization_endpoint`
// here instead. Reached only through `src/app/mock-idp-route.tsx`, itself
// dynamically imported by `src/app/routeTree.ts` behind a literal build-time
// condition so this module ships in a mock build only — see the comment
// there for why it isn't `mockIdpEnabled` (`mock-idp-gate.ts`) that decides.
//
// `search` and `navigate` default to the real browser, overridable so the
// redirect itself never has to run in a test: `buildCallbackUrl` is the pure
// part, exported and tested on its own.

import { useEffect, useRef } from 'react'
import { isDemoActive } from '../app/interactiveDemo'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button/Button'
import { Card, CardBody } from '../ui/Card/Card'

/**
 * `redirect_uri`, `state` and the mock authorization code, assembled exactly
 * as a real authorization server's redirect would carry them — `undefined`
 * when there is no `redirect_uri` to send anything back to, which the caller
 * treats as "nothing to do" rather than throwing out of a click handler.
 */
export function buildCallbackUrl(search: string): string | undefined {
  const params = new URLSearchParams(search)
  const redirectUri = params.get('redirect_uri')
  if (redirectUri === null) return undefined
  const target = new URL(redirectUri)
  target.searchParams.set('code', 'mock-authorization-code')
  const state = params.get('state')
  if (state !== null) target.searchParams.set('state', state)
  return target.toString()
}

export interface MockIdpAuthorizePageProps {
  search?: string
  navigate?: (url: string) => void
}

function navigateToCallback(url: string): void {
  window.location.href = url
}

export function MockIdpAuthorizePage({
  search = window.location.search,
  navigate = navigateToCallback,
}: MockIdpAuthorizePageProps) {
  const { t } = useTranslation()
  const params = new URLSearchParams(search)
  const realm = params.get('realm') ?? ''
  const automatic = isDemoActive(realm) || params.get('prompt') === 'none'
  const redirected = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!automatic) return
    const url = buildCallbackUrl(search)
    if (url === undefined || redirected.current === url) return
    redirected.current = url
    navigate(url)
  }, [automatic, search, navigate])

  const continueSignIn = () => {
    const url = buildCallbackUrl(search)
    if (url !== undefined) navigate(url)
  }

  if (automatic) return null

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-[360px] text-center">
        <CardBody>
          <h1 className="text-lg font-semibold text-c-ink">
            {t('console.mockidp._.title', { realm })}
          </h1>
          <div className="mt-4">
            <Button onClick={continueSignIn}>{t('console.common.action-continue')}</Button>
          </div>
        </CardBody>
      </Card>
    </main>
  )
}
